/**
 * Operating the webhook outbox: inspection, and getting a stalled or dead
 * delivery moving again.
 *
 * The real room, the real capture triggers, the real outbox and the real
 * delivery pass; only the network is a stub. The tests that matter here are
 * not the plumbing but the guarantees a retry must not break:
 *
 *   - a retry re-sends the original event, it does not capture a new one;
 *   - ordering per endpoint survives it, including the uncomfortable part —
 *     a revived old event holds up that endpoint's newer ones;
 *   - one endpoint's retry cannot disturb another;
 *   - an acknowledged delivery is never re-sent;
 *   - a committed write is never affected;
 *   - inspection carries no row values.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { encodeTrustedRoleClaim, TRUSTED_CLAIM_HEADER } from "../src/verify";
import { model, schema, t } from "../src/schema";
import type { Env } from "../src/types";
import {
  WEBHOOK_MAX_AGE_MS,
  type WebhookAttemptResult,
  type WebhookOptions,
  type WebhookRequest,
  type WebhookTransport,
} from "../src/engine/webhooks";
import type { WebhookDeliveryView, WebhookReport, RetryOutcome } from "../src/engine/webhook-ops";
import { FakeR2Bucket } from "./fixtures/test-support";
import { FakeRoomContext } from "./fixtures/room-harness";

class MockDurableObject<EnvShape> {
  protected ctx: DurableObjectState;
  protected env: EnvShape;
  constructor(ctx: DurableObjectState, env: EnvShape) {
    this.ctx = ctx;
    this.env = env;
  }
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");

const ID = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";
const KEY_SECRET = "webhook-ops-personal-key-secret-32chars";
const PRIVATE = "ada@private.test";
const SECRET_TITLE = "LEAKCHECK-TITLE";

const appSchema = schema({
  note: model({
    title: t.string(),
    owner: t.string().personal({ subject: "self" }),
  }),
  task: model({ title: t.string(), done: t.boolean().optional() }),
});

function claim(role: number = WORKSPACE_ROLE_LEVELS.DEVELOPER): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "user-1", workspaceId: ID, role: role as RoleClaim["role"], exp: now + 3600, iat: now };
}

let sent: WebhookRequest[] = [];
let reply: (request: WebhookRequest, index: number) => WebhookAttemptResult | Promise<WebhookAttemptResult>;

const transport: WebhookTransport = async (request) => {
  sent.push(request);
  return await reply(request, sent.length - 1);
};

beforeEach(() => {
  sent = [];
  reply = () => ({ ok: true, status: 200 });
});
afterEach(() => {
  setSystemTime();
});

const ONE: readonly WebhookOptions[] = [
  { url: "https://one.test/hook", events: ["create"], secret: "whsec_one_secret_at_least_long" },
];
const TWO: readonly WebhookOptions[] = [
  { url: "https://one.test/hook", events: ["create"], secret: "whsec_one_secret_at_least_long" },
  { url: "https://two.test/hook", events: ["create"], secret: "whsec_two_secret_at_least_long" },
];

async function makeWorkspace(webhooks: readonly WebhookOptions[] = ONE) {
  const app = defineTapeDB({ schema: appSchema, webhooks });
  const db = new Database(":memory:");
  const context = new FakeRoomContext(db, ID);
  const env = {
    DATA: new FakeR2Bucket(),
    FILES: new FakeR2Bucket(),
    TAPEDB_KEY_SECRET: KEY_SECRET,
  } as unknown as Env;
  const room = new app.WorkspaceRoom(context as never, env, { webhookTransport: transport });
  await context.ready;
  return { app, db, context, env, room };
}
type Workspace = Awaited<ReturnType<typeof makeWorkspace>>;

async function transact(workspace: Workspace, ops: unknown[]) {
  const response = await workspace.room.fetch(
    new Request("http://test/transact", {
      method: "POST",
      headers: { "content-type": "application/json", [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim(claim()) },
      body: JSON.stringify({ txId: crypto.randomUUID(), ops }),
    })
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { result: { seq: number } };
}

const note = (id: string, title = "note") => [
  { op: "insert", namespace: "note", id, values: { title, owner: PRIVATE } },
];

/** The three admin endpoints, as a caller of any role. */
async function ask(
  workspace: Workspace,
  path: string,
  role: number = WORKSPACE_ROLE_LEVELS.ADMIN,
  body?: unknown
) {
  const response = await workspace.room.fetch(
    new Request(`http://test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim(claim(role)),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
  return { status: response.status, body: (await response.json()) as { ok?: boolean; data?: unknown; error?: { code: string } } };
}

const report = async (workspace: Workspace): Promise<WebhookReport> =>
  ((await ask(workspace, "/webhooks")).body.data as WebhookReport);
const deliveries = async (workspace: Workspace, query = ""): Promise<WebhookDeliveryView[]> =>
  ((await ask(workspace, `/webhooks/deliveries${query}`)).body.data as WebhookDeliveryView[]);
const retry = async (workspace: Workspace, request: unknown): Promise<RetryOutcome> =>
  ((await ask(workspace, "/webhooks/retry", WORKSPACE_ROLE_LEVELS.ADMIN, request)).body.data as RetryOutcome);

/** Writes one note and lets delivery fail until the event is dead-lettered. */
async function killOne(workspace: Workspace, title = "note"): Promise<WebhookDeliveryView> {
  reply = () => ({ ok: false, status: 500 });
  await transact(workspace, note(crypto.randomUUID(), title));
  // Walk past the age limit rather than through 60 backoffs.
  await workspace.room.alarm();
  setSystemTime(new Date(Date.now() + WEBHOOK_MAX_AGE_MS + 1));
  await workspace.room.alarm();
  const dead = (await deliveries(workspace, "?status=dead"))[0];
  expect(dead).toBeDefined();
  return dead!;
}

describe("webhook inspection authorization", () => {
  test("a member and an editor are refused", async () => {
    const workspace = await makeWorkspace();
    for (const role of [WORKSPACE_ROLE_LEVELS.MEMBER, WORKSPACE_ROLE_LEVELS.EDITOR]) {
      expect((await ask(workspace, "/webhooks", role)).status).toBe(403);
      expect((await ask(workspace, "/webhooks/deliveries", role)).status).toBe(403);
      expect((await ask(workspace, "/webhooks/retry", role, { status: "dead" })).status).toBe(403);
    }
  });

  test("an admin may read and retry", async () => {
    const workspace = await makeWorkspace();
    expect((await ask(workspace, "/webhooks")).status).toBe(200);
    expect((await ask(workspace, "/webhooks/retry", WORKSPACE_ROLE_LEVELS.ADMIN, { status: "dead" })).status).toBe(200);
  });

  test("a deployment without webhooks answers plainly rather than emptily", async () => {
    const workspace = await makeWorkspace([]);
    const answer = await ask(workspace, "/webhooks");
    expect(answer.status).toBe(400);
    expect(answer.body.error?.code).toBe("webhooks_not_configured");
  });

  test("the methods are fixed: reads are GET, a retry is POST", async () => {
    const workspace = await makeWorkspace();
    const post = await workspace.room.fetch(
      new Request("http://test/webhooks", {
        method: "POST",
        headers: { [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim(claim()) },
      })
    );
    expect(post.status).toBe(405);
    const get = await workspace.room.fetch(
      new Request("http://test/webhooks/retry", {
        method: "GET",
        headers: { [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim(claim()) },
      })
    );
    expect(get.status).toBe(405);
  });
});

describe("what inspection shows", () => {
  test("a healthy endpoint reports its deliveries and nothing waiting", async () => {
    const workspace = await makeWorkspace();
    await transact(workspace, note("n1"));
    await workspace.room.alarm();

    const health = await report(workspace);
    expect(health.endpoints).toHaveLength(1);
    expect(health.endpoints[0]!.url).toBe("https://one.test/hook");
    expect(health.endpoints[0]!.delivered).toBe(1);
    expect(health.endpoints[0]!.pending).toBe(0);
    expect(health.endpoints[0]!.head).toBeNull();
    expect(health.endpoints[0]!.backingOff).toBe(false);
    expect(health.endpoints[0]!.retired).toBe(false);
    expect(health.totals).toEqual({ pending: 0, delivered: 1, dead: 0 });
  });

  test("a failing endpoint names the event it is stuck on, with the error", async () => {
    const workspace = await makeWorkspace();
    reply = () => ({ ok: false, status: 503, error: "upstream down" });
    await transact(workspace, note("n1"));
    await transact(workspace, note("n2"));
    await workspace.room.alarm();

    const health = await report(workspace);
    const endpoint = health.endpoints[0]!;
    // Two waiting, and the head is the earlier one: that single row is the
    // whole explanation of why the second has not gone.
    expect(endpoint.pending).toBe(2);
    expect(endpoint.head?.seq).toBe(1);
    expect(endpoint.head?.attempts).toBe(1);
    expect(endpoint.head?.lastStatus).toBe(503);
    expect(endpoint.head?.lastError).toBe("upstream down");
    expect(endpoint.backingOff).toBe(true);
    expect(endpoint.oldestPendingAgeMs).toBeGreaterThanOrEqual(0);
  });

  test("the report states the retry schedule, so a backoff is not mistaken for a stall", async () => {
    const health = await report(await makeWorkspace());
    expect(health.policy.firstRetryMs).toBeGreaterThan(0);
    expect(health.policy.maxAgeMs).toBeGreaterThan(health.policy.firstRetryMs);
    expect(health.policy.maxAttempts).toBeGreaterThan(1);
    expect(health.policy.retryLimit).toBeGreaterThan(0);
  });

  test("deliveries can be filtered and paged, newest transaction first", async () => {
    const workspace = await makeWorkspace();
    reply = () => ({ ok: false, status: 500 });
    await transact(workspace, note("n1"));
    await transact(workspace, note("n2"));
    await transact(workspace, note("n3"));

    const all = await deliveries(workspace);
    expect(all.map((row) => row.seq)).toEqual([3, 2, 1]);
    expect(await deliveries(workspace, "?status=delivered")).toEqual([]);
    expect((await deliveries(workspace, "?limit=1")).map((row) => row.seq)).toEqual([3]);
    expect((await deliveries(workspace, "?before=3")).map((row) => row.seq)).toEqual([2, 1]);
  });

  test("a bad query is refused rather than answered with a guess", async () => {
    const workspace = await makeWorkspace();
    for (const query of ["?status=nonsense", "?endpoint=abc", "?before=x", "?limit=0", "?limit=99999"]) {
      const answer = await ask(workspace, `/webhooks/deliveries${query}`);
      expect(answer.status).toBe(400);
      expect(answer.body.error?.code).toBe("invalid_webhook_query");
    }
  });

  test("inspection carries delivery bookkeeping only: no body, no row values", async () => {
    const workspace = await makeWorkspace();
    reply = () => ({ ok: false, status: 500 });
    await transact(workspace, note("n1", SECRET_TITLE));

    const serialized = JSON.stringify({ report: await report(workspace), deliveries: await deliveries(workspace) });
    // The title went to the endpoint in the signed body; it must not come
    // back through an admin read, which no read rule filtered.
    expect(serialized).not.toContain(SECRET_TITLE);
    expect(serialized).not.toContain(PRIVATE);
    expect(serialized).not.toContain("body");
    // What it does carry: what the event was about.
    expect((await deliveries(workspace))[0]!.model).toBe("note");
    expect((await deliveries(workspace))[0]!.op).toBe("create");
  });

  test("an endpoint the deployment dropped is still reported, with its queue", async () => {
    // Two endpoints queue an event each; the deployment then configures one.
    const both = await makeWorkspace(TWO);
    reply = () => ({ ok: false, status: 500 });
    await transact(both, note("n1"));

    const app = defineTapeDB({ schema: appSchema, webhooks: ONE });
    const narrowed = new app.WorkspaceRoom(both.context as never, both.env, { webhookTransport: transport });
    const health = ((await (async () => {
      const response = await narrowed.fetch(
        new Request("http://test/webhooks", { headers: { [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim(claim()) } })
      );
      return (await response.json()) as { data: WebhookReport };
    })()).data);

    const retired = health.endpoints.find((endpoint) => endpoint.retired);
    expect(retired).toBeDefined();
    // Its address survives in the events still queued for it, which is the
    // only reason a reader can tell which consumer is affected.
    expect(retired!.url).toBe("https://two.test/hook");
    expect(retired!.pending).toBe(1);
  });
});

describe("retrying a delivery", () => {
  test("a dead event returns to the queue and is delivered", async () => {
    const workspace = await makeWorkspace();
    const dead = await killOne(workspace);
    expect(dead.status).toBe("dead");

    reply = () => ({ ok: true, status: 200 });
    const outcome = await retry(workspace, { ids: [dead.id] });
    expect(outcome.requeued).toBe(1);
    expect(outcome.skipped).toEqual([]);

    const requeued = (await deliveries(workspace))[0]!;
    expect(requeued.status).toBe("pending");
    // A dead event has spent its budget; without resetting it the retry would
    // be a no-op dressed up as a retry.
    expect(requeued.attempts).toBe(0);
    expect(requeued.revivedAt).not.toBeNull();

    await workspace.room.alarm();
    expect((await deliveries(workspace))[0]!.status).toBe("delivered");
  });

  test("the retry re-sends the original event, it does not capture a new one", async () => {
    const workspace = await makeWorkspace();
    const dead = await killOne(workspace);
    const firstBody = sent[0]!.body;
    const firstEventId = sent[0]!.headers["X-Tapedb-Event-Id"];

    reply = () => ({ ok: true, status: 200 });
    await retry(workspace, { ids: [dead.id] });
    await workspace.room.alarm();

    const last = sent.at(-1)!;
    // Same event id, same seq, byte-identical body: a consumer deduplicating
    // on the id sees the event it already knows, which at-least-once delivery
    // already allows. A re-read of the row could have carried later state and
    // passed it off as the original change.
    expect(last.headers["X-Tapedb-Event-Id"]).toBe(firstEventId);
    expect(last.body).toBe(firstBody);
    expect(last.headers["X-Tapedb-Seq"]).toBe(sent[0]!.headers["X-Tapedb-Seq"]);
    // One event throughout, however many attempts it took.
    expect(new Set(sent.map((request) => request.headers["X-Tapedb-Event-Id"])).size).toBe(1);
    expect(await deliveries(workspace)).toHaveLength(1);
  });

  test("a revived event is its endpoint's head again, so newer events wait for it", async () => {
    const workspace = await makeWorkspace();
    const dead = await killOne(workspace);

    // A newer event, delivered while the old one is dead.
    reply = () => ({ ok: true, status: 200 });
    await transact(workspace, note("n2"));
    await workspace.room.alarm();
    expect((await deliveries(workspace, "?status=delivered")).map((row) => row.seq)).toEqual([2]);

    // Revive the old one and let it fail once, so it is waiting out a backoff
    // and is therefore due LATER than anything written after it.
    reply = () => ({ ok: false, status: 500 });
    await retry(workspace, { ids: [dead.id] });
    await workspace.room.alarm();
    const revived = (await deliveries(workspace, "?status=pending"))[0]!;
    expect(revived.seq).toBe(1);
    expect(revived.nextAttemptAt).toBeGreaterThan(Date.now());

    // A newer event, due now. Delivery order follows seq, not due time, so
    // the endpoint stays shut behind the revived event even though the newer
    // one could be sent this instant.
    await transact(workspace, note("n3"));
    sent = [];
    await workspace.room.alarm();

    const seqsSent = sent.map((request) => request.headers["X-Tapedb-Seq"]);
    expect(seqsSent).toEqual([]);

    const health = await report(workspace);
    // This is the consequence an operator has to know about: reviving an old
    // event holds up that endpoint's newer ones until it lands or dies again.
    expect(health.endpoints[0]!.head?.seq).toBe(1);
    expect(health.endpoints[0]!.pending).toBe(2);
    expect(health.endpoints[0]!.backingOff).toBe(true);
  });

  test("one endpoint's retry leaves another endpoint alone", async () => {
    const workspace = await makeWorkspace(TWO);
    // Endpoint 0 fails, endpoint 1 succeeds.
    reply = (request) => (request.url.includes("one.test") ? { ok: false, status: 500 } : { ok: true, status: 200 });
    await transact(workspace, note("n1"));
    await workspace.room.alarm();

    const before = await report(workspace);
    expect(before.endpoints[0]!.pending).toBe(1);
    expect(before.endpoints[1]!.delivered).toBe(1);

    await retry(workspace, { status: "pending", endpoint: 0 });
    const after = await report(workspace);
    // The healthy endpoint's row is untouched: a retry re-queues only its own.
    expect(after.endpoints[1]!.delivered).toBe(1);
    expect(after.endpoints[1]!.pending).toBe(0);
    expect(after.endpoints[0]!.head?.attempts).toBe(0);
  });

  test("a delivered event is never re-sent, even when named by id", async () => {
    const workspace = await makeWorkspace();
    await transact(workspace, note("n1"));
    await workspace.room.alarm();
    const delivered = (await deliveries(workspace, "?status=delivered"))[0]!;
    const posts = sent.length;

    const outcome = await retry(workspace, { ids: [delivered.id] });
    expect(outcome.requeued).toBe(0);
    expect(outcome.skipped).toEqual([{ id: delivered.id, reason: "already_delivered" }]);

    await workspace.room.alarm();
    expect(sent).toHaveLength(posts);
    expect((await deliveries(workspace))[0]!.status).toBe("delivered");
  });

  test("a filter retry refuses to name delivered events at all", async () => {
    const workspace = await makeWorkspace();
    const answer = await ask(workspace, "/webhooks/retry", WORKSPACE_ROLE_LEVELS.ADMIN, { status: "delivered" });
    expect(answer.status).toBe(400);
    expect(answer.body.error?.code).toBe("invalid_webhook_retry");
  });

  test("an unknown id is reported, not silently dropped", async () => {
    const workspace = await makeWorkspace();
    const outcome = await retry(workspace, { ids: ["no-such-delivery"] });
    expect(outcome.requeued).toBe(0);
    expect(outcome.skipped).toEqual([{ id: "no-such-delivery", reason: "not_found" }]);
  });

  test("a batch retry is bounded and says there is more", async () => {
    const workspace = await makeWorkspace();
    reply = () => ({ ok: false, status: 500 });
    for (let i = 0; i < 4; i += 1) await transact(workspace, note(`n${i}`));

    const outcome = await retry(workspace, { status: "pending", limit: 2 });
    expect(outcome.requeued).toBe(2);
    expect(outcome.more).toBe(true);
    // Oldest first, so a bounded replay drains a queue from its head rather
    // than leaving the blocking event behind.
    expect(outcome.ids).toHaveLength(2);

    const rest = await retry(workspace, { status: "pending", limit: 50 });
    expect(rest.more).toBe(false);
  });

  test("a malformed retry is refused rather than guessed at", async () => {
    const workspace = await makeWorkspace();
    for (const body of [
      {},
      { ids: [] },
      { ids: [""] },
      { ids: ["a"], status: "dead" },
      { status: "nonsense" },
      { endpoint: -1 },
      { status: "dead", limit: 0 },
      { status: "dead", limit: 100000 },
      [],
    ]) {
      const answer = await ask(workspace, "/webhooks/retry", WORKSPACE_ROLE_LEVELS.ADMIN, body);
      expect(answer.status).toBe(400);
      expect(answer.body.error?.code).toBe("invalid_webhook_retry");
    }
  });

  test("a retry changes delivery bookkeeping and no application row", async () => {
    const workspace = await makeWorkspace();
    const dead = await killOne(workspace);
    const rowsBefore = workspace.db.query(`SELECT id, title FROM note ORDER BY id`).all();
    const seqBefore = workspace.db.query(`SELECT MAX(seq) AS seq FROM "_tx_log"`).get() as { seq: number };

    await retry(workspace, { ids: [dead.id] });

    // The outbox is downstream of the commit: a retry cannot reach back into
    // it, and must not burn a sequence either.
    expect(workspace.db.query(`SELECT id, title FROM note ORDER BY id`).all()).toEqual(rowsBefore);
    expect(workspace.db.query(`SELECT MAX(seq) AS seq FROM "_tx_log"`).get()).toEqual(seqBefore);
  });

  test("a revived event gets a fresh age window instead of dying on the first pass", async () => {
    const workspace = await makeWorkspace();
    const dead = await killOne(workspace);

    // Still failing: the point is that it is retried rather than dead-lettered
    // at once for being older than the age limit.
    reply = () => ({ ok: false, status: 500 });
    await retry(workspace, { ids: [dead.id] });
    await workspace.room.alarm();

    const row = (await deliveries(workspace))[0]!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
  });

  test("an endpoint the deployment dropped cannot be revived into a delivery", async () => {
    const both = await makeWorkspace(TWO);
    reply = () => ({ ok: false, status: 500 });
    await transact(both, note("n1"));

    const app = defineTapeDB({ schema: appSchema, webhooks: ONE });
    const narrowed = new app.WorkspaceRoom(both.context as never, both.env, { webhookTransport: transport });
    const admin = { [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim(claim()) };
    await narrowed.fetch(
      new Request("http://test/webhooks/retry", {
        method: "POST",
        headers: { ...admin, "content-type": "application/json" },
        body: JSON.stringify({ status: "pending", endpoint: 1 }),
      })
    );
    sent = [];
    await narrowed.alarm();

    // Nothing can sign for an endpoint that is no longer configured, so it
    // dead-letters with that reason rather than posting unsigned.
    expect(sent.every((request) => !request.url.includes("two.test"))).toBe(true);
    const response = await narrowed.fetch(new Request("http://test/webhooks/deliveries?status=dead", { headers: admin }));
    const dead = ((await response.json()) as { data: WebhookDeliveryView[] }).data;
    expect(dead.some((row) => row.endpoint === 1 && (row.lastError ?? "").includes("no longer configured"))).toBe(true);
  });
});
