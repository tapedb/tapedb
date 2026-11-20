/**
 * Per-model and per-workspace write budgets.
 *
 * Runs the real `WorkspaceRoom` over in-memory SQLite: the same charge, the
 * same `_write_limits` table and the same `rate_limited` refusal a deployed
 * Worker gives. The limiter's own arithmetic is checked with an explicit
 * `now`, so nothing here depends on how fast the suite runs.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { encodeTrustedRoleClaim } from "../src/verify";
import { model, schema, t } from "../src/schema";
import type { Env } from "../src/types";
import {
  countWrites,
  reserveWriteBudget,
  resolveWriteLimits,
  WRITE_LIMITS_TABLE,
  type LimitsOptions,
} from "../src/engine/rate-limits";
import { durableObjectSqlExecutor } from "../src/engine/tx-sql";
import { TxError } from "../src/engine/tx-types";
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
const OTHER_ID = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6c";

const appSchema = schema({
  task: model({ title: t.string(), done: t.boolean().optional() }),
  note: model({ title: t.string() }),
});

function claim(workspaceId = ID): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "user-1", workspaceId, role: WORKSPACE_ROLE_LEVELS.DEVELOPER, exp: now + 86_400, iat: now };
}

function env(): Env {
  return { DATA: new FakeR2Bucket(), FILES: new FakeR2Bucket() } as unknown as Env;
}

interface Workspace {
  app: ReturnType<typeof defineTapeDB>;
  db: Database;
  context: FakeRoomContext;
  room: InstanceType<ReturnType<typeof defineTapeDB>["WorkspaceRoom"]>;
}

/** A workspace whose room carries `limits`; no limits configured when absent. */
async function makeWorkspace(limits?: LimitsOptions, workspaceId = ID, app?: ReturnType<typeof defineTapeDB>): Promise<Workspace> {
  const deployment = app ?? defineTapeDB({ schema: appSchema, limits });
  const db = new Database(":memory:");
  const context = new FakeRoomContext(db, workspaceId);
  const room = new deployment.WorkspaceRoom(context as never, env() as never);
  await context.ready;
  return { app: deployment, db, context, room };
}

interface Reply {
  status: number;
  retryAfter: string | null;
  body: {
    ok?: boolean;
    result?: { seq: number; applied: number };
    error?: { code: string; message: string; model?: string; limit?: number; windowSeconds?: number; retryAfterMs?: number };
  };
}

async function transact(workspace: Workspace, ops: unknown[], clientTxId?: string): Promise<Reply> {
  const response = await workspace.room.fetch(
    new Request("http://test/transact", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tapedb-claims": encodeTrustedRoleClaim(claim(workspace.context.id.name)),
      },
      body: JSON.stringify({ txId: crypto.randomUUID(), ...(clientTxId === undefined ? {} : { clientTxId }), ops }),
    })
  );
  return { status: response.status, retryAfter: response.headers.get("retry-after"), body: (await response.json()) as never };
}

const insert = (namespace: string, id: string, extra: Record<string, unknown> = {}) => ({
  op: "insert",
  namespace,
  id,
  values: { title: id, ...extra },
});

const rows = (db: Database, table: string): number => (db.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
const limitRows = (db: Database) => db.query(`SELECT scope, used FROM "${WRITE_LIMITS_TABLE}" ORDER BY scope`).all();

afterEach(() => setSystemTime());

describe("write budgets", () => {
  test("a write under the budget lands; the one past it is refused with rate_limited", async () => {
    const workspace = await makeWorkspace({ writes: { models: { task: { count: 3, windowSeconds: 60 } } } });

    for (const id of ["t1", "t2", "t3"]) expect((await transact(workspace, [insert("task", id)])).status).toBe(200);

    const refused = await transact(workspace, [insert("task", "t4")]);
    expect(refused.status).toBe(429);
    expect(refused.retryAfter).toBe("60");
    expect(refused.body.error?.code).toBe("rate_limited");
    expect(refused.body.error?.model).toBe("task");
    expect(refused.body.error?.limit).toBe(3);
    expect(refused.body.error?.windowSeconds).toBe(60);
    // The window opened on the first write of it, so the wait is at most one.
    expect(refused.body.error?.retryAfterMs).toBeGreaterThan(0);
    expect(refused.body.error?.retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(refused.body.error?.message).toContain("task");

    // The refusal moved no rows and charged nothing.
    expect(rows(workspace.db, "task")).toBe(3);
    expect(limitRows(workspace.db)).toEqual([{ scope: "task", used: 3 }]);
  });

  test("a different model keeps its own budget", async () => {
    const workspace = await makeWorkspace({
      writes: { models: { task: { count: 1, windowSeconds: 60 }, note: { count: 1, windowSeconds: 60 } } },
    });

    expect((await transact(workspace, [insert("task", "t1")])).status).toBe(200);
    expect((await transact(workspace, [insert("task", "t2")])).status).toBe(429);
    // The task budget is spent; a note is untouched by it.
    expect((await transact(workspace, [insert("note", "n1")])).status).toBe(200);
    expect(limitRows(workspace.db)).toEqual([
      { scope: "note", used: 1 },
      { scope: "task", used: 1 },
    ]);
  });

  test("the workspace budget applies across models", async () => {
    const workspace = await makeWorkspace({
      writes: { models: { task: { count: 10, windowSeconds: 60 }, note: { count: 10, windowSeconds: 60 } }, workspace: { count: 3, windowSeconds: 60 } },
    });

    expect((await transact(workspace, [insert("task", "t1")])).status).toBe(200);
    expect((await transact(workspace, [insert("task", "t2")])).status).toBe(200);
    expect((await transact(workspace, [insert("note", "n1")])).status).toBe(200);

    const refused = await transact(workspace, [insert("note", "n2")]);
    expect(refused.status).toBe(429);
    expect(refused.body.error?.model).toBe("workspace");
    expect(refused.body.error?.limit).toBe(3);
    expect(rows(workspace.db, "note")).toBe(1);
  });

  test("an invalid write spends nothing", async () => {
    const workspace = await makeWorkspace({ writes: { models: { task: { count: 1, windowSeconds: 60 } } } });

    // Missing `values`: refused by validation, before any budget is charged.
    const invalid = await transact(workspace, [{ op: "insert", namespace: "task", id: "bad" }]);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error?.code).toBe("invalid_op");

    expect((await transact(workspace, [insert("task", "t1")])).status).toBe(200);
    expect((await transact(workspace, [insert("task", "t2")])).status).toBe(429);
  });

  test("a write that fails inside the transaction is refunded", async () => {
    const workspace = await makeWorkspace({ writes: { models: { task: { count: 2, windowSeconds: 60 } } } });

    expect((await transact(workspace, [insert("task", "t1")])).status).toBe(200);
    // Same id again: the transaction rolls back, so its charge is given back.
    const duplicate = await transact(workspace, [insert("task", "t1")]);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error?.code).toBe("unique_violation");
    expect(limitRows(workspace.db)).toEqual([{ scope: "task", used: 1 }]);

    expect((await transact(workspace, [insert("task", "t2")])).status).toBe(200);
    expect((await transact(workspace, [insert("task", "t3")])).status).toBe(429);
  });

  test("the window resets when it closes, and retryAfterMs is exact", async () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    setSystemTime(new Date(t0));
    const workspace = await makeWorkspace({ writes: { models: { task: { count: 1, windowSeconds: 60 } } } });

    expect((await transact(workspace, [insert("task", "t1")])).status).toBe(200);

    setSystemTime(new Date(t0 + 15_000));
    const refused = await transact(workspace, [insert("task", "t2")]);
    expect(refused.status).toBe(429);
    expect(refused.body.error?.retryAfterMs).toBe(45_000);
    expect(refused.retryAfter).toBe("45");

    setSystemTime(new Date(t0 + 59_999));
    expect((await transact(workspace, [insert("task", "t2")])).status).toBe(429);

    setSystemTime(new Date(t0 + 60_000));
    expect((await transact(workspace, [insert("task", "t2")])).status).toBe(200);
  });

  test("counters survive eviction: a new room object on the same storage still refuses", async () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    setSystemTime(new Date(t0));
    const first = await makeWorkspace({ writes: { models: { task: { count: 1, windowSeconds: 600 } } } });
    expect((await transact(first, [insert("task", "t1")])).status).toBe(200);

    // The object is evicted and rebuilt over the same SQLite: same storage,
    // no memory carried over.
    const revived = new FakeRoomContext(first.db, ID);
    const room = new first.app.WorkspaceRoom(revived as never, env() as never);
    await revived.ready;

    const refused = await transact({ ...first, context: revived, room: room as never }, [insert("task", "t2")]);
    expect(refused.status).toBe(429);
    expect(refused.body.error?.code).toBe("rate_limited");
    expect(refused.body.error?.model).toBe("task");
    expect(rows(first.db, "task")).toBe(1);
  });

  test("an unconfigured deployment creates no table and charges nothing", async () => {
    const workspace = await makeWorkspace();
    for (let n = 0; n < 20; n += 1) expect((await transact(workspace, [insert("task", `t${n}`)])).status).toBe(200);

    const tables = workspace.db
      .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .all(WRITE_LIMITS_TABLE);
    expect(tables).toEqual([]);
  });

  test("two deployments and two rooms in one process do not share a budget", async () => {
    const limited = defineTapeDB({ schema: appSchema, limits: { writes: { models: { task: { count: 1, windowSeconds: 60 } } } } });
    // Defined afterwards and without limits: it must not inherit or overwrite
    // the other deployment's configuration.
    const open = defineTapeDB({ schema: appSchema });

    const one = await makeWorkspace(undefined, ID, limited);
    expect((await transact(one, [insert("task", "t1")])).status).toBe(200);
    expect((await transact(one, [insert("task", "t2")])).status).toBe(429);

    const unlimited = await makeWorkspace(undefined, ID, open);
    for (let n = 0; n < 3; n += 1) expect((await transact(unlimited, [insert("task", `u${n}`)])).status).toBe(200);

    // A second workspace of the same deployment has its own counters.
    const other = await makeWorkspace(undefined, OTHER_ID, limited);
    expect((await transact(other, [insert("task", "o1")])).status).toBe(200);

    expect(limitRows(one.db)).toEqual([{ scope: "task", used: 1 }]);
  });

  test("a deduped retry of an applied write is not charged again", async () => {
    const workspace = await makeWorkspace({ writes: { models: { task: { count: 2, windowSeconds: 60 } } } });

    expect((await transact(workspace, [insert("task", "t1")], "client-1")).status).toBe(200);
    // The same clientTxId again: a replay, answered with the original seq, and
    // not another write against the budget.
    expect((await transact(workspace, [insert("task", "t1")], "client-1")).status).toBe(200);
    expect(limitRows(workspace.db)).toEqual([{ scope: "task", used: 1 }]);

    expect((await transact(workspace, [insert("task", "t2")])).status).toBe(200);
    expect((await transact(workspace, [insert("task", "t3")])).status).toBe(429);
  });

  test("a limit that cannot be honoured is refused when the deployment is defined", () => {
    expect(() => defineTapeDB({ schema: appSchema, limits: { writes: { models: { task: { count: 0, windowSeconds: 60 } } } } })).toThrow(
      /positive integer/
    );
    expect(() => defineTapeDB({ schema: appSchema, limits: { writes: { workspace: { count: 5, windowSeconds: 0 } } } })).toThrow(
      /positive `windowSeconds`/
    );
    expect(() => defineTapeDB({ schema: appSchema, limits: { writes: { models: { tasks: { count: 5, windowSeconds: 60 } } } } })).toThrow(
      /names no model/
    );
  });
});

describe("the limiter's arithmetic", () => {
  function fixture(limits: LimitsOptions) {
    const context = new FakeRoomContext(new Database(":memory:"), "tapedb-rate-limits");
    const sql = durableObjectSqlExecutor(context.storage as never);
    const resolved = resolveWriteLimits(limits.writes)!;
    return { sql, limits: resolved, db: context.db };
  }

  const spend = (limits: Awaited<ReturnType<typeof fixture>>, model: string, now: number, units = 1) =>
    reserveWriteBudget(limits.sql, limits.limits, countWrites(limits.limits, Array.from({ length: units }, () => model)), now);

  test("a window is exact to the millisecond it closes", () => {
    const limits = fixture({ writes: { models: { task: { count: 2, windowSeconds: 10 } } } });
    spend(limits, "task", 0);
    spend(limits, "task", 0);
    expect(() => spend(limits, "task", 0)).toThrow(TxError);
    try {
      spend(limits, "task", 9_999);
    } catch (error) {
      expect((error as TxError).detail).toEqual({ model: "task", limit: 2, windowSeconds: 10, retryAfterMs: 1 });
    }
    // The window closes and the counter starts again at zero.
    expect(() => spend(limits, "task", 10_000)).not.toThrow();
    expect(limits.db.query(`SELECT used, window_start FROM "${WRITE_LIMITS_TABLE}"`).get()).toEqual({ used: 1, window_start: 10_000 });
  });

  test("a multi-op write is charged per operation, and the workspace sees every model", () => {
    const limits = fixture({ writes: { models: { task: { count: 5, windowSeconds: 10 } }, workspace: { count: 4, windowSeconds: 10 } } });
    spend(limits, "task", 0, 3);
    expect(() => spend(limits, "task", 0, 1)).not.toThrow();
    // One more task is fine for the model budget but past the workspace's 4.
    expect(() => spend(limits, "task", 0, 1)).toThrow(/workspace allows 4 writes/);
    expect(limits.db.query(`SELECT scope, used FROM "${WRITE_LIMITS_TABLE}" ORDER BY scope`).all()).toEqual([
      { scope: "task", used: 4 },
      { scope: "workspace", used: 4 },
    ]);
  });

  test("an unconfigured deployment resolves to nothing at all", () => {
    expect(resolveWriteLimits(undefined)).toBeUndefined();
    expect(resolveWriteLimits({})).toBeUndefined();
    expect(resolveWriteLimits({ models: {} })).toBeUndefined();
  });
});
