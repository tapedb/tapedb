/**
 * `GET /metrics` on a workspace.
 *
 * The room, the transaction pipeline and the query path are the real ones over
 * in-memory SQLite, because the thing worth testing is that the numbers match
 * what the workspace actually did. A test that incremented the counters itself
 * would prove only that a Map works.
 *
 * Three properties:
 *
 *   1. It is admin-only, and refuses a member rather than answering a thinner
 *      document.
 *   2. The counters follow real work — a committed write, a refusal, a replay
 *      and a query each land where they should.
 *   3. It carries no row values, no claims and no personal data, and says
 *      which of its numbers are measured and which are estimates.
 */

import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { model, role, schema, t } from "../src/schema";
import { encodeTrustedRoleClaim, TRUSTED_CLAIM_HEADER } from "../src/verify";
import { FakeR2Bucket } from "./fixtures/test-support";
import { FakeRoomContext } from "./fixtures/room-harness";

/**
 * A socket that behaves as the runtime's does where it matters here: the
 * attachment round-trips through JSON, so a subscription the room stores is
 * the one a hibernated room would find again.
 */
class FakeSocket {
  readonly sent: unknown[] = [];
  attachment: unknown;
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  deserializeAttachment(): unknown {
    return this.attachment === undefined ? undefined : JSON.parse(JSON.stringify(this.attachment));
  }

  serializeAttachment(value: unknown): void {
    this.attachment = JSON.parse(JSON.stringify(value)) as unknown;
  }

  close(): void {
    this.closed = true;
  }
}

class FakeWebSocketPair {
  0 = new FakeSocket();
  1 = new FakeSocket();
}
(globalThis as { WebSocketPair?: unknown }).WebSocketPair = FakeWebSocketPair;

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");

const SECRET = "workspace-metrics-test-secret-123456";
const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5b01";
const { MEMBER, EDITOR, ADMIN, OWNER } = WORKSPACE_ROLE_LEVELS;

const models = schema({
  note: model({ title: t.string(), body: t.string().optional() }).access({
    read: role("member"),
    create: role("editor"),
    update: role("editor"),
    delete: role("moderator"),
  }),
});

const app = defineTapeDB({ schema: models });

interface MetricsBody {
  ok: boolean;
  metrics: {
    since: number;
    uptimeMs: number;
    restartsCounters: boolean;
    counters: Record<string, number>;
    latency: {
      estimated: boolean;
      bucketsMs: number[];
      timers: Record<string, { count: number; sumMs: number; maxMs: number; p99Ms: number | null }>;
    };
  };
  gauges: {
    sockets: number;
    subscriptions: number;
    presenceTargets: number;
    topics: number;
    storageBytes: number;
    txLogRows: number;
    recovering: boolean;
    durability: {
      seq: number;
      flushedSeq: number;
      pendingSeq: number;
      snapshotStatus: string;
      lastFlushAgeMs: number | null;
    };
  };
  measurement: Record<string, string>;
}

function harness() {
  const data = new FakeR2Bucket();
  const context = new FakeRoomContext(new Database(":memory:"), WORKSPACE);
  const env = { DATA: data, FILES: new FakeR2Bucket(), TAPEDB_CLAIM_SECRET: SECRET } as never;
  const room = new app.WorkspaceRoom(context as never, env);

  const claim = (level: number, sub = "user-1"): RoleClaim => ({
    sub,
    workspaceId: WORKSPACE,
    role: level as RoleClaim["role"],
    iat: 0,
    exp: Math.floor(Date.now() / 1000) + 60,
  });

  const call = async (path: string, level: number, init: RequestInit = {}) => {
    await context.ready;
    return room.fetch(
      new Request(`https://room.internal${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim(claim(level)),
          ...(init.headers ?? {}),
        },
      })
    );
  };

  const metrics = async (level: number = ADMIN): Promise<MetricsBody> => {
    const response = await call("/metrics", level);
    expect(response.status).toBe(200);
    return (await response.json()) as MetricsBody;
  };

  const transact = (body: unknown, level: number = EDITOR) =>
    call("/transact", level, { method: "POST", body: JSON.stringify(body) });

  const query = (document: unknown, level: number = MEMBER) =>
    call("/query", level, { method: "POST", body: JSON.stringify({ query: document }) });

  /** Opens a socket the way a client does, and returns the room's side of it. */
  const openSocket = async (level: number = EDITOR, sub = "user-1") => {
    await context.ready;
    const response = await room.fetch(
      new Request("https://room.internal/websocket", {
        headers: {
          upgrade: "websocket",
          [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim(claim(level, sub)),
        },
      })
    );
    expect(response.status).toBe(101);
    return (context.sockets as FakeSocket[]).at(-1)!;
  };

  const message = (socket: FakeSocket, payload: unknown) =>
    room.webSocketMessage(socket as never, JSON.stringify(payload));

  return { data, context, room, call, metrics, transact, query, openSocket, message };
}

const insert = (id: string, txId: string, title = `note ${id}`, clientTxId?: string) => ({
  txId,
  ...(clientTxId === undefined ? {} : { clientTxId }),
  ops: [{ op: "insert", namespace: "note", id, values: { title } }],
});

describe("GET /metrics authorization", () => {
  test("a member is refused", async () => {
    const { call } = harness();
    const response = await call("/metrics", MEMBER);

    expect(response.status).toBe(403);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("insufficient_role");
  });

  test("an editor is refused: writing is not operating", async () => {
    const { call } = harness();
    expect((await call("/metrics", EDITOR)).status).toBe(403);
  });

  test("an admin and an owner may read it", async () => {
    const { call } = harness();
    expect((await call("/metrics", ADMIN)).status).toBe(200);
    expect((await call("/metrics", OWNER)).status).toBe(200);
  });

  test("a request with no claim is refused, not answered emptily", async () => {
    const { context, room } = harness();
    await context.ready;
    const response = await room.fetch(new Request("https://room.internal/metrics"));

    // The engine refuses an unclaimed request the same way everywhere: the
    // point here is that it is refused, not answered with a thinner document.
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("counters");
  });

  test("only GET is accepted", async () => {
    const { call } = harness();
    const response = await call("/metrics", ADMIN, { method: "POST" });

    expect(response.status).toBe(405);
  });
});

describe("GET /metrics counters follow real work", () => {
  test("a committed write is counted, with the rows it changed", async () => {
    const { transact, metrics } = harness();
    expect((await transact(insert("n1", "tx-1"))).status).toBe(200);

    const body = await metrics();
    expect(body.metrics.counters["transactions.committed"]).toBe(1);
    expect(body.metrics.counters["transactions.rows"]).toBe(1);
    expect(body.metrics.counters["transactions.refused"]).toBe(0);
    // The write was timed, so the histogram has a sample.
    expect(body.metrics.latency.timers.transaction.count).toBe(1);
  });

  test("a refused write is counted as refused and not as committed", async () => {
    const { transact, metrics } = harness();
    // A member may not create: the rule refuses before anything is written.
    const response = await transact(insert("n1", "tx-1"), MEMBER);
    expect(response.status).toBe(403);

    const body = await metrics();
    expect(body.metrics.counters["transactions.refused"]).toBe(1);
    expect(body.metrics.counters["transactions.committed"]).toBe(0);
    expect(body.metrics.counters["transactions.rows"]).toBe(0);
  });

  test("a replay is counted as deduped, not as a second commit", async () => {
    const { transact, metrics } = harness();
    const envelope = insert("n1", "tx-1", "note n1", "client-1");
    expect((await transact(envelope)).status).toBe(200);
    // The same clientTxId and the same ops: the receipt answers, nothing runs.
    expect((await transact(envelope)).status).toBe(200);

    const body = await metrics();
    expect(body.metrics.counters["transactions.committed"]).toBe(1);
    expect(body.metrics.counters["transactions.deduped"]).toBe(1);
    // The row was written once; a replay must not inflate the row count.
    expect(body.metrics.counters["transactions.rows"]).toBe(1);
  });

  test("a conflict is counted as a conflict as well as a refusal", async () => {
    const { transact, metrics } = harness();
    expect((await transact(insert("n1", "tx-1", "first", "client-1"))).status).toBe(200);
    // Same clientTxId, different ops: that is the conflict the engine refuses.
    const conflict = await transact(insert("n1", "tx-2", "second", "client-1"));
    expect(conflict.status).toBe(409);

    const body = await metrics();
    expect(body.metrics.counters["transactions.conflicts"]).toBe(1);
    expect(body.metrics.counters["transactions.refused"]).toBe(1);
  });

  test("a served query is counted and timed; a refused one is counted apart", async () => {
    const { transact, query, metrics } = harness();
    await transact(insert("n1", "tx-1"));

    expect((await query({ note: {} })).status).toBe(200);
    // An unknown model is refused by the compiler, before SQL.
    expect((await query({ nope: {} })).status).toBe(400);

    const body = await metrics();
    expect(body.metrics.counters["queries.served"]).toBe(1);
    expect(body.metrics.counters["queries.refused"]).toBe(1);
    // Both were timed: a refusal that scans before it refuses costs real time,
    // and hiding it would understate the work the workspace did.
    expect(body.metrics.latency.timers.query.count).toBe(2);
  });

  test("counters start at zero and name every metric", async () => {
    const { metrics } = harness();
    const body = await metrics();

    expect(body.metrics.counters["transactions.committed"]).toBe(0);
    expect(body.metrics.counters["subscriptions.updates"]).toBe(0);
    expect(body.metrics.counters["broadcast.messages"]).toBe(0);
    expect(body.metrics.counters["recovery.failures"]).toBe(0);
  });
});

describe("GET /metrics gauges", () => {
  test("the log and the sequence are read from storage, not from memory", async () => {
    const { transact, metrics } = harness();
    await transact(insert("n1", "tx-1"));
    await transact(insert("n2", "tx-2"));

    const body = await metrics();
    expect(body.gauges.txLogRows).toBe(2);
    expect(body.gauges.durability.seq).toBe(2);
    // Nothing has flushed in this harness, so the whole log is pending — the
    // figure an operator watches when durability falls behind.
    expect(body.gauges.durability.flushedSeq).toBe(0);
    expect(body.gauges.durability.pendingSeq).toBe(2);
    expect(body.gauges.durability.lastFlushAgeMs).toBeNull();
  });

  test("storage size is a real figure that grows with the data", async () => {
    const { transact, metrics } = harness();
    const before = (await metrics()).gauges.storageBytes;
    expect(before).toBeGreaterThan(0);

    for (let i = 0; i < 200; i += 1) {
      await transact(insert(`n${i}`, `tx-${i}`, `note ${i}`.padEnd(400, "x")));
    }

    expect((await metrics()).gauges.storageBytes).toBeGreaterThan(before);
  });

  test("no socket means no connections and no subscriptions", async () => {
    const { metrics } = harness();
    const body = await metrics();

    expect(body.gauges.sockets).toBe(0);
    expect(body.gauges.subscriptions).toBe(0);
    expect(body.gauges.recovering).toBe(false);
  });
});

describe("GET /metrics is honest about what it is", () => {
  test("it says the counters reset, and when they started", async () => {
    const { metrics } = harness();
    const body = await metrics();

    // Without this an operator would read one object's lifetime as the
    // workspace's history.
    expect(body.metrics.restartsCounters).toBe(true);
    expect(body.metrics.since).toBeGreaterThan(0);
    expect(body.metrics.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  test("it marks quantiles as estimates and publishes the bucket bounds", async () => {
    const { metrics } = harness();
    const body = await metrics();

    expect(body.metrics.latency.estimated).toBe(true);
    expect(body.metrics.latency.bucketsMs.length).toBeGreaterThan(0);
    expect(body.measurement["latency.p99Ms"]).toContain("estimated");
    expect(body.measurement["latency.maxMs"]).toBe("measured");
    expect(body.measurement.gauges).toContain("measured");
  });

  test("it carries counts and sizes only: no row values, no subjects, no claims", async () => {
    const { transact, query, metrics } = harness();
    // A distinctive value in a row, and a distinctive subject in a claim.
    await transact(insert("n1", "tx-1", "SENSITIVE-ROW-TITLE"));
    await query({ note: {} });

    const body = await metrics();
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain("SENSITIVE-ROW-TITLE");
    expect(serialized).not.toContain("user-1");
    expect(serialized).not.toContain(SECRET);
    // The workspace's own id is operational, not a secret, and the caller
    // already named it to get here; everything else is a number or a label.
    for (const value of Object.values(body.gauges)) {
      if (typeof value === "object" && value !== null) continue;
      expect(["number", "boolean"]).toContain(typeof value);
    }
  });
});

describe("GET /metrics counts realtime work", () => {
  test("an accepted socket is counted, and shows as connected", async () => {
    const { openSocket, metrics } = harness();
    await openSocket();

    const body = await metrics();
    expect(body.metrics.counters["sockets.accepted"]).toBe(1);
    expect(body.gauges.sockets).toBe(1);
    expect(body.metrics.counters["sockets.closed"]).toBe(0);
  });

  test("a live query is counted when it opens and when it is dropped", async () => {
    const { openSocket, message, metrics } = harness();
    const socket = await openSocket();

    await message(socket, { type: "query:subscribe", id: "s1", query: { note: {} } });
    expect((await metrics()).metrics.counters["subscriptions.opened"]).toBe(1);
    expect((await metrics()).gauges.subscriptions).toBe(1);

    await message(socket, { type: "query:unsubscribe", id: "s1" });
    const body = await metrics();
    expect(body.metrics.counters["subscriptions.closed"]).toBe(1);
    expect(body.gauges.subscriptions).toBe(0);
  });

  test("re-pointing a subscription at another query opens nothing new", async () => {
    const { openSocket, message, metrics } = harness();
    const socket = await openSocket();

    await message(socket, { type: "query:subscribe", id: "s1", query: { note: {} } });
    await message(socket, { type: "query:subscribe", id: "s1", query: { note: { $: { limit: 1 } } } });

    // One id, one live query: counting the second as an open would make a
    // client that refines its filter look like a leak.
    expect((await metrics()).metrics.counters["subscriptions.opened"]).toBe(1);
    expect((await metrics()).gauges.subscriptions).toBe(1);
  });

  test("a socket that drops without unsubscribing closes its live queries", async () => {
    const { openSocket, message, room, metrics } = harness();
    const socket = await openSocket();
    await message(socket, { type: "query:subscribe", id: "s1", query: { note: {} } });
    await message(socket, { type: "query:subscribe", id: "s2", query: { note: {} } });

    room.webSocketClose(socket as never, 1006, "dropped");

    const body = await metrics();
    expect(body.metrics.counters["sockets.closed"]).toBe(1);
    // Both of them: otherwise opened stays permanently ahead of closed, and
    // the difference is exactly the figure an operator reads as a leak.
    expect(body.metrics.counters["subscriptions.closed"]).toBe(2);
  });

  test("a write that touches a live query pushes an update, and it is timed", async () => {
    const { openSocket, message, transact, metrics } = harness();
    const socket = await openSocket();
    await message(socket, { type: "query:subscribe", id: "s1", query: { note: {} } });

    expect((await transact(insert("n1", "tx-1"))).status).toBe(200);
    // Invalidation is scheduled, not synchronous: let it run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const body = await metrics();
    expect(body.metrics.counters["subscriptions.updates"]).toBeGreaterThanOrEqual(1);
    expect(body.metrics.latency.timers.subscriptionUpdate.count).toBeGreaterThanOrEqual(1);
  });

  test("presence and broadcast activity are counted", async () => {
    const { openSocket, message, metrics } = harness();
    const first = await openSocket(EDITOR, "user-1");
    const second = await openSocket(EDITOR, "user-2");

    await message(first, { type: "presence:set", target: "board:1", presence: { at: "card-1" } });
    await message(first, { type: "topic:join", topic: "board:1" });
    await message(second, { type: "topic:join", topic: "board:1" });
    await message(first, { type: "topic:send", topic: "board:1", message: { hello: true } });

    const body = await metrics();
    expect(body.metrics.counters["presence.updates"]).toBeGreaterThanOrEqual(1);
    expect(body.metrics.counters["broadcast.messages"]).toBe(1);
    expect(body.gauges.topics).toBe(2);
    expect(body.gauges.presenceTargets).toBe(1);
  });
});

describe("GET /metrics leads with a health verdict", () => {
  type Health = { status: string; reasons: Array<{ code: string; status: string }> };
  const health = async (h: ReturnType<typeof harness>) => {
    const response = await h.call("/metrics", ADMIN);
    return ((await response.json()) as { health: Health; gauges: { durability: { oldestPendingAt: number | null } } });
  };

  test("a workspace with writes waiting for the alarm is ok, and says what is waiting", async () => {
    const h = harness();
    expect((await h.transact(insert("n1", "t1"))).status).toBe(200);
    const body = await health(h);
    expect(body.health).toEqual({ status: "ok", reasons: [] });
    expect(body.gauges.durability.oldestPendingAt).not.toBeNull();
  });

  test("a flush R2 refuses makes it failing, with the reason named", async () => {
    const h = harness();
    expect((await h.transact(insert("n1", "t1"))).status).toBe(200);
    (h.data as unknown as { put: () => Promise<never> }).put = async () => {
      throw new Error("R2 is down");
    };
    await h.room.alarm();
    const body = await health(h);
    expect(body.health.status).toBe("failing");
    expect(body.health.reasons.map((reason) => reason.code)).toContain("flush_failing");
  });

  test("the verdict carries no row values either", async () => {
    const h = harness();
    await h.transact(insert("n1", "t1", "a secret title"));
    expect(JSON.stringify(await health(h))).not.toContain("a secret title");
  });
});
