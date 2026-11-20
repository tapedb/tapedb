/**
 * Outbound webhooks: signatures, retries, the durable outbox, ordering, and
 * what a payload may contain.
 *
 * Everything here runs the real `WorkspaceRoom` over in-memory SQLite, so the
 * capture triggers, the write path, the outbox and the durability alarm are the
 * same code a deployed Worker runs. Only the network is replaced: the transport
 * stub records each POST and answers with whatever the test wants.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { createHmac } from "node:crypto";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { encodeTrustedRoleClaim } from "../src/verify";
import { model, schema, t } from "../src/schema";
import type { Env } from "../src/types";
import {
  WEBHOOK_FIRST_RETRY_MS,
  WEBHOOK_MAX_RETRY_MS,
  type WebhookTransport,
  type WebhookAttemptResult,
  type WebhookOptions,
  type WebhookRequest,
} from "../src/engine/webhooks";
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
const KEY_SECRET = "webhook-test-personal-key-secret-32chars";
const SIGNING_SECRET = "whsec_webhook_test_secret";
const PRIVATE = "ada@private.test";

/** A schema with a personal field, so a payload can be checked for leaks. */
const appSchema = schema({
  note: model({
    title: t.string(),
    owner: t.string().personal({ subject: "self" }),
  }),
  task: model({ title: t.string(), done: t.boolean().optional() }),
});

function claim(): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "user-1",
    workspaceId: ID,
    role: WORKSPACE_ROLE_LEVELS.DEVELOPER,
    exp: now + 3600,
    iat: now,
  };
}

let sent: WebhookRequest[] = [];
let reply: (request: WebhookRequest, index: number) => WebhookAttemptResult | Promise<WebhookAttemptResult>;

/**
 * The network this file's deployments post to. It is handed to the rooms it
 * builds (`webhookTransport`), never installed globally: a test that stubs
 * delivery cannot stub another deployment's.
 */
const transport: WebhookTransport = async (request) => {
  sent.push(request);
  return await reply(request, sent.length - 1);
};

beforeEach(() => {
  sent = [];
  reply = () => ({ ok: true, status: 200 });
});

afterEach(() => {
  // Undo any time travel a retry test did.
  setSystemTime();
});

/** A workspace with its own SQLite, a fake R2 and the given webhook config. */
async function makeWorkspace(webhooks?: readonly WebhookOptions[]) {
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

async function transact(
  workspace: Workspace,
  ops: unknown[]
): Promise<{ status: number; body: { ok?: boolean; result?: { seq: number }; error?: { code: string } } }> {
  const response = await workspace.room.fetch(
    new Request("http://test/transact", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tapedb-claims": encodeTrustedRoleClaim(claim()),
      },
      body: JSON.stringify({ txId: crypto.randomUUID(), ops }),
    })
  );
  return { status: response.status, body: (await response.json()) as never };
}

function outbox(workspace: Workspace) {
  return workspace.db
    .query(`SELECT id, event_id, hook, url, seq, model, op, body, created_at, attempts, next_attempt_at, status, last_status, last_error, delivered_at FROM "_webhook_outbox" ORDER BY rowid`)
    .all() as Array<Record<string, unknown>>;
}

function payload(request: WebhookRequest): Record<string, unknown> {
  return JSON.parse(request.body) as Record<string, unknown>;
}

function signatureOf(request: WebhookRequest): string {
  return String(request.headers["X-Tapedb-Signature"]);
}

/** What a consumer computes: HMAC-SHA256 over `<timestamp>.<raw body>`. */
function expectedSignature(secret: string, header: string, body: string): string {
  const timestamp = /(?:^|,)t=(\d+)/.exec(header)?.[1];
  expect(timestamp).toBeDefined();
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function uuid(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

describe("webhook signatures", () => {
  test("signs `t=<unix>,v1=<hex>` over the timestamp and the exact body", async () => {
    const workspace = await makeWorkspace([{ url: "https://consumer.test/hook", events: ["create"], secret: SIGNING_SECRET }]);

    const write = await transact(workspace, [
      { op: "insert", namespace: "note", id: "n1", values: { title: "Public tape", owner: PRIVATE } },
    ]);
    expect(write.status).toBe(200);
    // The write answers before anything is delivered, and the alarm it leaves
    // behind is the one that delivers.
    expect(workspace.context.alarm).not.toBeNull();
    expect(sent).toHaveLength(0);

    await workspace.room.alarm();

    expect(sent).toHaveLength(1);
    const [request] = sent;
    const header = signatureOf(request);
    const parsed = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
    expect(parsed).not.toBeNull();
    expect(Number(parsed![1])).toBeGreaterThan(0);
    // A standard HMAC implementation reproduces the header: the body is signed
    // byte for byte, not re-serialised.
    expect(parsed![2]).toBe(expectedSignature(SIGNING_SECRET, header, request.body));
    // A different secret does not.
    expect(parsed![2]).not.toBe(expectedSignature("whsec_something_else", header, request.body));

    const body = payload(request);
    expect(uuid(body.eventId)).toBe(true);
    expect(body.seq).toBe(write.body.result!.seq);
    expect(body.workspaceId).toBe(ID);
    expect(body.model).toBe("note");
    expect(body.op).toBe("create");
    expect(typeof body.at).toBe("number");
    expect(body.row).toMatchObject({ id: "n1", title: "Public tape" });

    expect(request.headers["X-Tapedb-Event"]).toBe("create");
    expect(request.headers["X-Tapedb-Event-Id"]).toBe(body.eventId);
    expect(request.headers["X-Tapedb-Seq"]).toBe(String(write.body.result!.seq));
    expect(request.headers["content-type"]).toBe("application/json");
  });

  test("a retry is re-signed for its own attempt time and keeps the event id", async () => {
    const workspace = await makeWorkspace([{ url: "https://consumer.test/hook", events: ["create"], secret: SIGNING_SECRET }]);
    reply = () => ({ ok: false, status: 500 });

    await transact(workspace, [{ op: "insert", namespace: "note", id: "n1", values: { title: "One", owner: PRIVATE } }]);
    await workspace.room.alarm();
    const first = sent[0];
    const firstId = payload(first).eventId;

    const due = outbox(workspace)[0].next_attempt_at as number;
    setSystemTime(new Date(due));
    reply = () => ({ ok: true, status: 204 });
    await workspace.room.alarm();

    expect(sent).toHaveLength(2);
    const second = sent[1];
    expect(payload(second).eventId).toBe(firstId);
    expect(second.body).toBe(first.body);
    expect(signatureOf(second)).not.toBe(signatureOf(first));
    expect(/^t=(\d+),v1=([0-9a-f]{64})$/.test(signatureOf(second))).toBe(true);
  });
});

describe("webhook retries and the outbox", () => {
  test("a 500 is retried with exponential backoff and later dead-lettered", async () => {
    const workspace = await makeWorkspace([{ url: "https://consumer.test/hook", events: ["create"], secret: SIGNING_SECRET }]);
    reply = () => ({ ok: false, status: 500 });

    const startedAt = Date.now();
    await transact(workspace, [{ op: "insert", namespace: "note", id: "n1", values: { title: "One", owner: PRIVATE } }]);
    await workspace.room.alarm();

    const afterFirst = outbox(workspace)[0];
    expect(afterFirst.status).toBe("pending");
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.last_status).toBe(500);
    // First retry: 30 s later, not immediately and not hours later.
    expect(Number(afterFirst.next_attempt_at) - Date.now()).toBeWithin(WEBHOOK_FIRST_RETRY_MS - 1_000, WEBHOOK_FIRST_RETRY_MS + 1_000);

    // Doubling, capped at 30 minutes: walk the backoff until the event is given up.
    const delays: number[] = [];
    let rounds = 0;
    for (;;) {
      const row = outbox(workspace)[0];
      if (row.status === "dead") break;
      const due = Number(row.next_attempt_at);
      delays.push(due - Date.now());
      setSystemTime(new Date(due));
      await workspace.room.alarm();
      if (++rounds > 80) throw new Error("the outbox never stopped retrying");
    }
    expect(delays[0]).toBeWithin(29_000, 31_000);
    expect(delays[1]).toBeWithin(59_000, 61_000);
    expect(delays[2]).toBeWithin(119_000, 121_000);
    expect(Math.max(...delays)).toBe(WEBHOOK_MAX_RETRY_MS);
    // 24 hours: the cap, not the attempt count, is what ends it.
    const dead = outbox(workspace)[0];
    expect(dead.status).toBe("dead");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
    expect(Number(dead.attempts)).toBeGreaterThan(40);

    // The row is kept, no longer tried, and counted where it is cheap to see.
    const before = sent.length;
    setSystemTime(new Date(Date.now() + 60 * 60 * 1000));
    await workspace.room.alarm();
    expect(sent).toHaveLength(before);
    const status = await workspace.room.fetch(
      new Request("http://test/status", { headers: { "x-tapedb-claims": encodeTrustedRoleClaim(claim()) } })
    );
    const body = (await status.json()) as { webhooks: { dead: number; pending: number; delivered: number } };
    expect(body.webhooks.dead).toBe(1);
    expect(body.webhooks.pending).toBe(0);
  });

  test("a 2xx stops retries", async () => {
    const workspace = await makeWorkspace([{ url: "https://consumer.test/hook", events: ["create"], secret: SIGNING_SECRET }]);
    reply = () => ({ ok: true, status: 201 });

    await transact(workspace, [{ op: "insert", namespace: "note", id: "n1", values: { title: "One", owner: PRIVATE } }]);
    await workspace.room.alarm();

    const row = outbox(workspace)[0];
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(1);
    expect(Number(row.delivered_at)).toBeGreaterThan(0);

    await workspace.room.alarm();
    setSystemTime(new Date(Date.now() + 60 * 60 * 1000));
    await workspace.room.alarm();
    expect(sent).toHaveLength(1);
  });

  test("a delivery that never answers is a retry, not a lost event", async () => {
    const workspace = await makeWorkspace([{ url: "https://consumer.test/hook", events: ["create"], secret: SIGNING_SECRET }]);
    reply = () => {
      throw new Error("connection reset");
    };

    await transact(workspace, [{ op: "insert", namespace: "note", id: "n1", values: { title: "One", owner: PRIVATE } }]);
    await workspace.room.alarm();

    const row = outbox(workspace)[0];
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);

    reply = () => ({ ok: true, status: 200 });
    setSystemTime(new Date(Number(row.next_attempt_at)));
    await workspace.room.alarm();
    expect(outbox(workspace)[0].status).toBe("delivered");
  });

  test("delivery survives an eviction round-trip", async () => {
    const workspace = await makeWorkspace([{ url: "https://consumer.test/hook", events: ["create"], secret: SIGNING_SECRET }]);
    reply = () => ({ ok: false, status: 503 });

    await transact(workspace, [{ op: "insert", namespace: "note", id: "n1", values: { title: "One", owner: PRIVATE } }]);
    await workspace.room.alarm();
    expect(outbox(workspace)[0].status).toBe("pending");
    const eventId = payload(sent[0]).eventId;

    // The object is evicted: a new one, same storage, same outbox.
    const revived = new FakeRoomContext(workspace.db, ID);
    const room = new workspace.app.WorkspaceRoom(revived as never, workspace.env, { webhookTransport: transport });
    await revived.ready;
    expect(outbox(workspace)).toHaveLength(1);

    reply = () => ({ ok: true, status: 200 });
    setSystemTime(new Date(Number(outbox(workspace)[0].next_attempt_at)));
    await room.alarm();

    expect(outbox(workspace)[0].status).toBe("delivered");
    expect(sent).toHaveLength(2);
    expect(payload(sent[1]).eventId).toBe(eventId);
    expect(sent[1].body).toBe(sent[0].body);
  });
});

describe("webhooks never touch the write path", () => {
  test("a webhook failure cannot fail the commit", async () => {
    const workspace = await makeWorkspace([{ url: "https://consumer.test/hook", events: ["create"], secret: SIGNING_SECRET }]);
    reply = () => ({ ok: false, status: 500 });

    const write = await transact(workspace, [
      { op: "insert", namespace: "note", id: "n1", values: { title: "One", owner: PRIVATE } },
    ]);
    expect(write.status).toBe(200);
    expect(write.body.result!.seq).toBe(1);
    expect(workspace.db.query(`SELECT title FROM note WHERE id = 'n1'`).get()).toBeDefined();
  });

  test("emit work that throws does not fail the write either", async () => {
    const workspace = await makeWorkspace([{ url: "https://consumer.test/hook", events: ["create"], secret: SIGNING_SECRET }]);
    // The outbox cannot be written: the row store a deployment might have lost.
    workspace.db.exec(`DROP TABLE "_webhook_outbox"`);

    const write = await transact(workspace, [
      { op: "insert", namespace: "note", id: "n1", values: { title: "One", owner: PRIVATE } },
    ]);
    expect(write.status).toBe(200);
    expect(write.body.result!.seq).toBe(1);
    expect(workspace.db.query(`SELECT title FROM note WHERE id = 'n1'`).get()).toEqual({ title: "One" });
    // The capture it could not consume is still there for the next pass.
    expect(workspace.db.query(`SELECT COUNT(*) AS n FROM "_webhook_changes"`).get()).toEqual({ n: 1 });
  });

  test("nothing is captured or delivered unless webhooks are configured", async () => {
    const workspace = await makeWorkspace();

    await transact(workspace, [{ op: "insert", namespace: "note", id: "n1", values: { title: "One", owner: PRIVATE } }]);
    await workspace.room.alarm();

    expect(
      workspace.db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '_webhook%'`).all()
    ).toEqual([]);
    expect(sent).toHaveLength(0);
  });
});

describe("webhook payloads", () => {
  test("personal values never leave the workspace", async () => {
    const workspace = await makeWorkspace([{ url: "https://consumer.test/hook", events: ["create"], secret: SIGNING_SECRET }]);

    await transact(workspace, [
      { op: "insert", namespace: "note", id: "n1", values: { title: "Public tape", owner: PRIVATE } },
    ]);
    await workspace.room.alarm();

    expect(sent).toHaveLength(1);
    const row = payload(sent[0]).row as Record<string, unknown>;
    expect(row).toEqual({ id: "n1", title: "Public tape" });
    expect(sent[0].body).not.toContain(PRIVATE);
    expect(sent[0].body).not.toContain("tapedb:personal:");
    // The value is stored, encrypted, for the workspace itself.
    expect(JSON.stringify(workspace.db.query(`SELECT * FROM note`).all())).not.toContain(PRIVATE);
  });

  test("a delete carries the row's last non-personal values", async () => {
    const workspace = await makeWorkspace([{ url: "https://consumer.test/hook", events: ["delete"], secret: SIGNING_SECRET }]);
    await transact(workspace, [
      { op: "insert", namespace: "note", id: "n1", values: { title: "So long", owner: PRIVATE } },
    ]);
    await transact(workspace, [{ op: "delete", namespace: "note", id: "n1" }]);
    await workspace.room.alarm();

    expect(sent).toHaveLength(1);
    const body = payload(sent[0]);
    expect(body.op).toBe("delete");
    expect(body.row).toEqual({ id: "n1", title: "So long" });
    expect(sent[0].body).not.toContain(PRIVATE);
  });

  test("a model filter excludes every other model", async () => {
    const workspace = await makeWorkspace([
      { url: "https://consumer.test/tasks", events: ["create"], models: ["task"], secret: SIGNING_SECRET },
    ]);

    await transact(workspace, [
      { op: "insert", namespace: "note", id: "n1", values: { title: "Note", owner: PRIVATE } },
      { op: "insert", namespace: "task", id: "t1", values: { title: "Task", done: false } },
    ]);
    await workspace.room.alarm();

    expect(sent).toHaveLength(1);
    expect(payload(sent[0])).toMatchObject({ model: "task", op: "create", row: { id: "t1", title: "Task", done: false } });
  });

  test("an event filter excludes the operations it does not name", async () => {
    const workspace = await makeWorkspace([
      { url: "https://consumer.test/deletes", events: ["delete"], secret: SIGNING_SECRET },
    ]);

    await transact(workspace, [
      { op: "insert", namespace: "task", id: "t1", values: { title: "Task", done: false } },
    ]);
    await workspace.room.alarm();
    expect(sent).toHaveLength(0);

    await transact(workspace, [{ op: "update", namespace: "task", id: "t1", values: { title: "Renamed" } }]);
    await workspace.room.alarm();
    expect(sent).toHaveLength(0);

    await transact(workspace, [{ op: "delete", namespace: "task", id: "t1" }]);
    await workspace.room.alarm();
    expect(sent).toHaveLength(1);
    expect(payload(sent[0]).op).toBe("delete");
  });
});

describe("webhook ordering", () => {
  test("delivers one endpoint's events in seq order and holds the rest back behind a failure", async () => {
    const workspace = await makeWorkspace([{ url: "https://consumer.test/hook", events: ["create"], secret: SIGNING_SECRET }]);
    // The first POST fails; every later one succeeds.
    reply = (_request, index) => (index === 0 ? { ok: false, status: 500 } : { ok: true, status: 200 });

    for (const id of ["n1", "n2", "n3"]) {
      await transact(workspace, [{ op: "insert", namespace: "note", id, values: { title: id, owner: PRIVATE } }]);
    }
    await workspace.room.alarm();

    // Only the head was attempted: the later events wait behind it.
    expect(sent.map((request) => payload(request).seq)).toEqual([1]);
    expect(outbox(workspace).map((row) => row.status)).toEqual(["pending", "pending", "pending"]);

    setSystemTime(new Date(Number(outbox(workspace)[0].next_attempt_at)));
    await workspace.room.alarm();

    const delivered = sent.map((request) => Number(payload(request).seq));
    expect(delivered).toEqual([1, 1, 2, 3]);
    expect(outbox(workspace).map((row) => row.status)).toEqual(["delivered", "delivered", "delivered"]);
  });

  test("a head held back by its backoff keeps the endpoint's later events waiting", async () => {
    const workspace = await makeWorkspace([{ url: "https://consumer.test/hook", events: ["create"], secret: SIGNING_SECRET }]);
    reply = (_request, index) => (index === 0 ? { ok: false, status: 500 } : { ok: true, status: 200 });

    await transact(workspace, [{ op: "insert", namespace: "note", id: "n1", values: { title: "One", owner: PRIVATE } }]);
    await transact(workspace, [{ op: "insert", namespace: "note", id: "n2", values: { title: "Two", owner: PRIVATE } }]);
    await workspace.room.alarm();
    expect(sent.map((request) => payload(request).seq)).toEqual([1]);

    // The alarm fires again before the head is due: the second event must not
    // overtake it.
    await workspace.room.alarm();
    expect(sent.map((request) => payload(request).seq)).toEqual([1]);
    // ... and the wake-up that follows is the head's retry, not a busy loop.
    const due = Number(outbox(workspace)[0].next_attempt_at);
    expect(workspace.context.alarm).toBeLessThanOrEqual(due);
  });

  test("a failing endpoint does not hold up a healthy one", async () => {
    const workspace = await makeWorkspace([
      { url: "https://down.test/hook", events: ["create"], secret: SIGNING_SECRET },
      { url: "https://up.test/hook", events: ["create"], secret: SIGNING_SECRET },
    ]);
    reply = (request) => (request.url.includes("down.test") ? { ok: false, status: 500 } : { ok: true, status: 200 });

    await transact(workspace, [{ op: "insert", namespace: "note", id: "n1", values: { title: "One", owner: PRIVATE } }]);
    await transact(workspace, [{ op: "insert", namespace: "note", id: "n2", values: { title: "Two", owner: PRIVATE } }]);
    await workspace.room.alarm();

    const rows = outbox(workspace);
    expect(rows.filter((row) => String(row.url).includes("up.test")).map((row) => row.status)).toEqual([
      "delivered",
      "delivered",
    ]);
    expect(rows.filter((row) => String(row.url).includes("down.test")).map((row) => row.status)).toEqual([
      "pending",
      "pending",
    ]);
  });
});
