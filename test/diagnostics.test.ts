/**
 * Workspace diagnostics (`GET /diagnostics`, `db.$diagnostics()`): the
 * histograms and the health verdict on their own, then the real room.
 */

import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS } from "../src/claims";
import { MemoryOutbox } from "../src/client/outbox";
import { flushPending } from "../src/engine/durability/flusher";
import {
  assessHealth,
  LatencyHistogram,
  RateWindow,
  WorkspaceMetrics,
  type StoredDiagnostics,
  type WorkspaceDiagnostics,
} from "../src/engine/diagnostics";
import { createClient } from "../src/model/client";
import { model, schema, t } from "../src/schema";
import { encodeTrustedRoleClaim, TRUSTED_CLAIM_HEADER } from "../src/verify";
import { FakeRoomContext } from "./fixtures/room-harness";
import { FakeR2Bucket } from "./fixtures/test-support";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");

const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6c";
const SECRET = "test-secret-test-secret-test-secret";

function healthyStored(overrides: Partial<StoredDiagnostics["durability"]> = {}): StoredDiagnostics {
  return {
    storage: { databaseBytes: null, txLogRows: 0, files: 0 },
    durability: {
      seq: 10,
      flushedSeq: 10,
      unflushedTransactions: 0,
      oldestUnflushedAt: null,
      lastFlushAt: 0,
      lastFlushError: null,
      flushAttempts: 0,
      nextFlushAttemptAt: null,
      snapshotSeq: 10,
      snapshotStatus: "idle",
      snapshotCompletedAt: 0,
      snapshotDueAt: null,
      ...overrides,
    },
    recovery: { status: null, recovering: false },
    connections: { sockets: 0, subscriptions: 0, topics: 0, presenceTargets: 0 },
    webhooks: null,
    migrations: { applied: 1, latest: "x" },
  };
}

describe("LatencyHistogram", () => {
  test("percentiles are bucket upper bounds, capped by the largest sample", () => {
    const histogram = new LatencyHistogram();
    for (let n = 0; n < 90; n += 1) histogram.record(3);
    for (let n = 0; n < 10; n += 1) histogram.record(400);
    const summary = histogram.summary();
    expect(summary.count).toBe(100);
    expect(summary.p50Ms).toBe(5);
    expect(summary.p95Ms).toBe(400);
    expect(summary.p99Ms).toBe(400);
    expect(summary.maxMs).toBe(400);
    expect(summary.meanMs).toBe(42.7);
    expect(summary.buckets["5"]).toBe(90);
    expect(summary.buckets["500"]).toBe(10);
  });

  test("an empty histogram reports nulls, and bad samples are ignored", () => {
    const histogram = new LatencyHistogram();
    histogram.record(Number.NaN);
    histogram.record(-1);
    expect(histogram.summary()).toMatchObject({ count: 0, p50Ms: null, meanMs: null, maxMs: null });
  });

  test("samples past the last bound land in the open bucket", () => {
    const histogram = new LatencyHistogram();
    histogram.record(45_000);
    expect(histogram.summary()).toMatchObject({ p99Ms: 45_000, buckets: { "+Inf": 1 } });
  });

  test("memory is constant: a million samples keep the same buckets", () => {
    const histogram = new LatencyHistogram();
    const started = performance.now();
    for (let n = 0; n < 1_000_000; n += 1) histogram.record(n % 2_000);
    const elapsed = performance.now() - started;
    expect(Object.keys(histogram.summary().buckets)).toHaveLength(15);
    // Generous: this is a regression guard on per-sample cost, not a benchmark.
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("RateWindow", () => {
  test("counts only the last five minutes", () => {
    let now = 1_000_000;
    const window = new RateWindow(() => now);
    for (let n = 0; n < 60; n += 1) window.add();
    now += 60_000;
    expect(window.perSecond(0)).toBe(0.2);
    now += 10 * 60_000;
    expect(window.perSecond(0)).toBe(0);
  });
});

describe("assessHealth", () => {
  const measured = () => new WorkspaceMetrics(() => 0).snapshot();

  test("a quiet, flushed workspace is ok", () => {
    expect(assessHealth(measured(), healthyStored(), 1_000)).toEqual({ status: "ok", reasons: [] });
  });

  test("a failing flush is failing; an old unflushed write is degraded", () => {
    const failing = assessHealth(measured(), healthyStored({ lastFlushError: "R2 500", flushAttempts: 3, flushedSeq: 4 }), 1_000);
    expect(failing.status).toBe("failing");
    expect(failing.reasons.map((reason) => reason.code)).toEqual(["flush_failing"]);

    const lagging = assessHealth(measured(), healthyStored({ oldestUnflushedAt: 0, unflushedTransactions: 3 }), 10 * 60_000);
    expect(lagging).toMatchObject({ status: "degraded", reasons: [{ code: "flush_lagging" }] });
  });

  test("an overdue snapshot and dead-lettered webhooks are degraded", () => {
    const stored = healthyStored({ snapshotDueAt: 0 });
    stored.webhooks = { pending: 0, delivered: 4, dead: 2 };
    const health = assessHealth(measured(), stored, 2 * 86_400_000);
    expect(health.status).toBe("degraded");
    expect(health.reasons.map((reason) => reason.code).sort()).toEqual(["snapshot_overdue", "webhooks_dead_lettered"]);
  });

  test("a recovery that keeps failing is failing; one in progress is degraded", () => {
    const metrics = new WorkspaceMetrics(() => 0);
    const stored = healthyStored();
    stored.recovery = { status: "running", recovering: true };
    expect(assessHealth(metrics.snapshot(), stored, 0).reasons[0].code).toBe("recovering");
    metrics.recoveryFailed("R2 unavailable");
    metrics.recoveryFailed("R2 unavailable");
    expect(assessHealth(metrics.snapshot(), stored, 0)).toMatchObject({ status: "failing", reasons: [{ code: "recovery_failing" }] });
  });

  test("slow writes are degraded only with enough samples", () => {
    const metrics = new WorkspaceMetrics(() => 0);
    for (let n = 0; n < 19; n += 1) metrics.transactionDone(3_000, 1);
    expect(assessHealth(metrics.snapshot(), healthyStored(), 0).status).toBe("ok");
    metrics.transactionDone(3_000, 1);
    expect(assessHealth(metrics.snapshot(), healthyStored(), 0).reasons[0].code).toBe("write_latency_high");
  });
});

describe("GET /diagnostics on the room", () => {
  const tapedb = defineTapeDB({ schema: schema({ task: model({ title: t.string() }) }) });
  const now = Math.floor(Date.now() / 1000);

  function setup() {
    const bucket = new FakeR2Bucket();
    const env = { FILES: new FakeR2Bucket(), DATA: bucket, TAPEDB_CLAIM_SECRET: SECRET, ENVIRONMENT: "development" };
    const context = new FakeRoomContext(new Database(":memory:"), WORKSPACE);
    const room = new tapedb.WorkspaceRoom(context as never, env as never);
    const call = (role: number, path: string, body?: unknown) => {
      const claim = { sub: "secret-subject-7", workspaceId: WORKSPACE, role, exp: now + 600, iat: now };
      return room.fetch(
        new Request(`https://room${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim(claim as never), "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      );
    };
    return { bucket, context, room, call };
  }

  const read = async (response: Response) => ((await response.json()) as { data: WorkspaceDiagnostics }).data;

  test("needs an admin or owner", async () => {
    const { context, call } = setup();
    await context.ready;
    for (const role of [WORKSPACE_ROLE_LEVELS.GUEST, WORKSPACE_ROLE_LEVELS.MEMBER, WORKSPACE_ROLE_LEVELS.EDITOR]) {
      const response = await call(role, "/diagnostics");
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("insufficient_role");
    }
    expect((await call(WORKSPACE_ROLE_LEVELS.ADMIN, "/diagnostics")).status).toBe(200);
    expect((await call(WORKSPACE_ROLE_LEVELS.OWNER, "/diagnostics")).status).toBe(200);
    expect((await call(WORKSPACE_ROLE_LEVELS.OWNER, "/diagnostics", {})).status).toBe(405);
  });

  test("counts writes, refusals and reads, and reports unflushed durability", async () => {
    const { bucket, context, call } = setup();
    await context.ready;
    const owner = WORKSPACE_ROLE_LEVELS.OWNER;
    for (let n = 0; n < 3; n += 1) {
      const response = await call(owner, "/transact", { txId: `t${n}`, clientTxId: `c${n}`, ops: [{ op: "insert", namespace: "task", id: `task-${n}`, values: { title: `private title ${n}` } }] });
      expect(response.status).toBe(200);
    }
    // A replay of t0 commits nothing; a duplicate id is refused.
    await call(owner, "/transact", { txId: "t0", clientTxId: "c0", ops: [{ op: "insert", namespace: "task", id: "task-0", values: { title: "private title 0" } }] });
    expect((await call(owner, "/transact", { txId: "t9", ops: [{ op: "insert", namespace: "task", id: "task-1", values: { title: "dup" } }] })).status).toBe(409);
    expect((await call(owner, "/query", { query: { task: {} } })).status).toBe(200);
    expect((await call(owner, "/query", { query: { nope: {} } })).status).toBe(400);

    let diagnostics = await read(await call(owner, "/diagnostics"));
    expect(diagnostics.workspaceId).toBe(WORKSPACE);
    expect(diagnostics.measured.transactions).toMatchObject({ committed: 3, unchanged: 1, rejected: 1, failed: 0 });
    expect(Object.values(diagnostics.measured.transactions.rejectedByCode)).toEqual([1]);
    expect(diagnostics.measured.reads).toMatchObject({ query: 1, rejected: 1 });
    expect(diagnostics.measured.latency.transaction.count).toBe(4);
    expect(diagnostics.measured.rates.transactionsPerSecond).toBeGreaterThan(0);
    expect(diagnostics.stored.durability).toMatchObject({ seq: 3, flushedSeq: 0, unflushedTransactions: 3 });
    expect(diagnostics.stored.durability.oldestUnflushedAt).not.toBeNull();
    expect(diagnostics.stored.storage.txLogRows).toBe(3);
    expect(diagnostics.health.status).toBe("ok");

    // Nothing in the answer comes from a row or a claim.
    const text = JSON.stringify(diagnostics);
    expect(text).not.toContain("private title");
    expect(text).not.toContain("secret-subject-7");

    await flushPending(bucket as never, context.storage.sql as never, WORKSPACE, Date.now());
    diagnostics = await read(await call(owner, "/diagnostics"));
    expect(diagnostics.stored.durability).toMatchObject({ flushedSeq: 3, unflushedTransactions: 0, oldestUnflushedAt: null, lastFlushError: null });
  });

  test("a failing flush shows as failing", async () => {
    const { bucket, context, call, room } = setup();
    await context.ready;
    const owner = WORKSPACE_ROLE_LEVELS.OWNER;
    await call(owner, "/transact", { txId: "t1", ops: [{ op: "insert", namespace: "task", id: "task-1", values: { title: "x" } }] });
    (bucket as unknown as { put: () => Promise<never> }).put = async () => {
      throw new Error("R2 is down");
    };
    await room.alarm();
    const diagnostics = await read(await call(owner, "/diagnostics"));
    expect(diagnostics.health.status).toBe("failing");
    expect(diagnostics.health.reasons.map((reason) => reason.code)).toContain("flush_failing");
    expect(diagnostics.measured.durability.ticks + diagnostics.measured.durability.tickFailures).toBeGreaterThan(0);
  });
});

describe("db.$diagnostics", () => {
  test("reads the workspace's diagnostics with the caller's token", async () => {
    const workspace = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";
    const payload = { workspaceId: workspace, health: { status: "ok", reasons: [] } };
    const db = createClient(
      { schema: schema({ note: model({ body: t.string() }) }), url: "http://engine.test", workspace, getToken: async () => "token" },
      {
        outbox: new MemoryOutbox(),
        createWebSocket: () => {
          throw new Error("no socket here");
        },
        fetch: async (url: string, init: { method: string; headers: Record<string, string> }) => {
          expect(url).toBe(`http://engine.test/engine/workspaces/${workspace}/diagnostics`);
          expect(init.method).toBe("GET");
          expect(init.headers.authorization).toBe("Bearer token");
          return Response.json({ ok: true, data: payload });
        },
      }
    );
    expect(await db.$diagnostics()).toEqual(payload as never);
  });

  test("a refusal surfaces the engine's code", async () => {
    const db = createClient(
      { schema: schema({ note: model({ body: t.string() }) }), url: "http://engine.test", workspace: "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a", getToken: async () => "token" },
      {
        outbox: new MemoryOutbox(),
        createWebSocket: () => {
          throw new Error("no socket here");
        },
        fetch: async () => Response.json({ ok: false, error: { code: "insufficient_role", message: "no" } }, { status: 403 }),
      }
    );
    await expect(db.$diagnostics()).rejects.toMatchObject({ code: "insufficient_role", status: 403 });
  });
});
