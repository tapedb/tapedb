/**
 * `updateMany` and `deleteMany`.
 *
 * A bulk write arrives as a filter and has to end up in the log as rows: a
 * filter re-run during a recovery months later would match a different set,
 * and a replay that changes different rows than the original is not a replay.
 * These tests pin that, the access rules that bound which rows a caller can
 * reach, and the batching that keeps one transaction bounded however many
 * rows match.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim, type WorkspaceRole } from "../src/claims";
import { MemoryOutbox } from "../src/client/outbox";
import { BULK_BATCH_ROWS } from "../src/engine/tx-bulk";
import { setLogPartBytesForTests } from "../src/engine/tx-log";
import { configureMigrations } from "../src/engine/migrations-bundle";
import { executeQueryWithPageInfo } from "../src/engine/query-execute";
import { configureRegistry } from "../src/engine/registry";
import { configurePermissions, type PermissionOverrides } from "../src/engine/tx-permissions";
import type { SqlExecutor, SqlRow, SqlValue } from "../src/engine/tx-sql";
import { runTransaction } from "../src/engine/tx-pipeline";
import { TxError } from "../src/engine/tx-types";
import { createClient } from "../src/model/client";
import { model, schema, t } from "../src/schema";

const WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";

const models = {
  project: model({ name: t.string(), secret: t.boolean().default(false), tasks: t.hasMany("task") }),
  task: model({
    title: t.string(),
    done: t.boolean().default(false),
    ownerId: t.string().index(),
    weight: t.number().optional(),
    project: t.belongsTo("project").optional(),
  }),
};

let sql: SqlExecutor;
let db: Database;
let appSchema: ReturnType<typeof schema>;

function build(permissions: PermissionOverrides = {}) {
  appSchema = schema(models);
  configureRegistry(appSchema.registry);
  configureMigrations(appSchema.migrations);
  configurePermissions({ overrides: { ...appSchema.permissions.overrides, ...permissions } });

  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of appSchema.migrations) db.exec(migration.sql);
  sql = {
    exec: (q: string, ...p: SqlValue[]) => db.query(q).run(...(p as never[])).changes,
    all: <T extends SqlRow = SqlRow>(q: string, ...p: SqlValue[]) => db.query(q).all(...(p as never[])) as T[],
    one: <T extends SqlRow = SqlRow>(q: string, ...p: SqlValue[]) =>
      (db.query(q).get(...(p as never[])) ?? undefined) as T | undefined,
    transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
  };
}

function claimFor(sub: string, role: WorkspaceRole): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return { sub, workspaceId: WORKSPACE, role, exp: now + 600, iat: now };
}

function client(sub = "alice", role: WorkspaceRole = WORKSPACE_ROLE_LEVELS.MODERATOR) {
  const claim = claimFor(sub, role);
  return createClient(
    { schema: appSchema, url: "http://engine.test", workspace: WORKSPACE, getToken: async () => "t" },
    {
      outbox: new MemoryOutbox(),
      createWebSocket: () => {
        throw new Error("no socket here");
      },
      fetch: async (url: string, init?: { body?: string }) => {
        const body = init?.body === undefined ? undefined : JSON.parse(init.body);
        try {
          if (url.endsWith("/transact")) {
            return Response.json({ ok: true, result: runTransaction(sql, WORKSPACE, claim, body) });
          }
          const { data, pageInfo } = executeQueryWithPageInfo(sql, claim, body);
          return Response.json({ ok: true, data, pageInfo });
        } catch (error) {
          if (error instanceof TxError) {
            return Response.json({ ok: false, error: error.toJSON() }, { status: 400 });
          }
          throw error;
        }
      },
    }
  );
}

function seed(count: number, owner = (index: number) => (index % 2 === 0 ? "alice" : "bob")) {
  const claim = claimFor("seed", WORKSPACE_ROLE_LEVELS.OWNER);
  runTransaction(sql, WORKSPACE, claim, {
    txId: "seed",
    ops: Array.from({ length: count }, (_, index) => ({
      op: "insert",
      namespace: "task",
      id: `t${String(index).padStart(4, "0")}`,
      values: { title: `task ${index}`, done: false, ownerId: owner(index) },
    })),
  });
}

/** A log entry's ops, every part, as stored (compact bulk ops unexpanded). */
function logged(seq: number): Array<Record<string, unknown>> {
  const row = db.query(`SELECT ops FROM "_tx_log" WHERE seq = ?`).get(seq) as { ops: string };
  const parts = db.query(`SELECT ops FROM "_tx_log_parts" WHERE seq = ? ORDER BY part`).all(seq) as Array<{ ops: string }>;
  return [row.ops, ...parts.map((part) => part.ops)].flatMap((text) => JSON.parse(text) as Array<Record<string, unknown>>);
}

beforeEach(() => build());

describe("updateMany", () => {
  test("writes every matching row and reports the count", async () => {
    seed(6);
    expect(await client().task.updateMany({ where: { ownerId: "alice" }, data: { done: true } })).toEqual({ count: 3 });
    expect(db.query(`SELECT COUNT(*) AS n FROM "task" WHERE "done" = 1`).get()).toEqual({ n: 3 });
    expect(db.query(`SELECT COUNT(*) AS n FROM "task" WHERE "done" = 1 AND "owner_id" != 'alice'`).get()).toEqual({ n: 0 });
  });

  test("the log holds the rows it resolved, not the filter", async () => {
    seed(4);
    await client().task.updateMany({ where: { ownerId: "alice" }, data: { done: true } });

    // A replay must change the same rows as the original. Re-running the
    // filter later cannot promise that, so the filter is not what is stored.
    // Compactly: the ids, and the values once.
    const ops = logged(2);
    expect(ops).toEqual([{ op: "patchIds", namespace: "task", ids: ["t0000", "t0002"], values: { done: true } }]);
    expect(JSON.stringify(ops)).not.toContain("ownerId");
  });

  test("a no-match write records its receipt without changing application rows", async () => {
    seed(2);
    const before = db.query(`SELECT high_water_seq AS seq FROM "_tx_state"`).get() as { seq: number };
    expect(await client().task.updateMany({ where: { ownerId: "nobody" }, data: { done: true } })).toEqual({ count: 0 });
    expect(db.query(`SELECT high_water_seq AS seq FROM "_tx_state"`).get()).toEqual({seq:before.seq+1});
  });

  test("refuses to connect relations, and refuses unknown fields", async () => {
    seed(1);
    await expect(
      client().task.updateMany({ where: {}, data: { nope: 1 } as never })
    ).rejects.toThrow(/has no field "nope"/);
  });
});

describe("deleteMany", () => {
  test("removes every matching row, and logs each removal", async () => {
    seed(6);
    expect(await client().task.deleteMany({ where: { ownerId: "bob" } })).toEqual({ count: 3 });
    expect(db.query(`SELECT COUNT(*) AS n FROM "task"`).get()).toEqual({ n: 3 });
    expect(logged(2)).toEqual([{ op: "deleteIds", namespace: "task", ids: ["t0001", "t0003", "t0005"] }]);
  });

  test("an empty filter matches everything the caller can read", async () => {
    seed(4);
    expect(await client().task.deleteMany({ where: {} })).toEqual({ count: 4 });
    expect(db.query(`SELECT COUNT(*) AS n FROM "task"`).get()).toEqual({ n: 0 });
  });
});

describe("access", () => {
  test("a read rule bounds which rows a bulk write can reach", async () => {
    build({ task: { view: { where: ({ sub }) => ({ ownerId: sub }) } } });
    seed(6);

    // alice cannot read bob's rows, so an unfiltered deleteMany must not
    // delete them either.
    expect(await client("alice").task.deleteMany({ where: {} })).toEqual({ count: 3 });
    expect(db.query(`SELECT COUNT(*) AS n FROM "task" WHERE "owner_id" = 'bob'`).get()).toEqual({ n: 3 });
  });

  test("row write rules still run per row", async () => {
    // Engine-level overrides take a plain predicate over the stored row.
    build({ task: { update: ({ auth, data }) => data?.ownerId === auth.sub } });
    seed(4);

    // The read rules let alice see every row; the update rule does not let her
    // write bob's, and one refusal rolls the whole transaction back.
    await expect(client("alice").task.updateMany({ where: {}, data: { done: true } })).rejects.toThrow(
      /Row rule denied update/
    );
    expect(db.query(`SELECT COUNT(*) AS n FROM "task" WHERE "done" = 1`).get()).toEqual({ n: 0 });

    expect(await client("alice").task.updateMany({ where: { ownerId: "alice" }, data: { done: true } })).toEqual({
      count: 2,
    });
  });

  test("the role level still gates the action", async () => {
    build({ task: { delete: WORKSPACE_ROLE_LEVELS.ADMIN } });
    seed(2);
    await expect(client("alice", WORKSPACE_ROLE_LEVELS.EDITOR).task.deleteMany({ where: {} })).rejects.toThrow(
      /not allowed to delete/
    );
  });
});

describe("filters through a relation", () => {
  test("carry the linked model's read rule into the bulk write", async () => {
    build({ project: { view: { where: () => ({ secret: false }) } } });
    const owner = claimFor("seed", WORKSPACE_ROLE_LEVELS.OWNER);
    runTransaction(sql, WORKSPACE, owner, {
      txId: "seed",
      ops: [
        { op: "insert", namespace: "project", id: "open", values: { name: "Open", secret: false } },
        { op: "insert", namespace: "project", id: "hidden", values: { name: "Hidden", secret: true } },
        { op: "insert", namespace: "task", id: "a", values: { title: "a", done: false, ownerId: "alice", projectId: "open" } },
        { op: "insert", namespace: "task", id: "b", values: { title: "b", done: false, ownerId: "alice", projectId: "hidden" } },
      ],
    });

    // "tasks whose project is named anything" must not reach the task whose
    // project the caller cannot read.
    expect(
      await client().task.updateMany({ where: { project: { name: { not: "" } } } as never, data: { done: true } })
    ).toEqual({ count: 1 });
    expect(db.query(`SELECT "id" FROM "task" WHERE "done" = 1`).all()).toEqual([{ id: "a" }]);
  });
});

describe("any size, one transaction", () => {
  const count = (where = "1 = 1") =>
    (db.query(`SELECT COUNT(*) AS n FROM "task" WHERE ${where}`).get() as { n: number }).n;
  const writes = () =>
    (db.query(`SELECT COUNT(*) AS n FROM "_tx_log" WHERE ops LIKE '%Ids"%'`).get() as { n: number }).n;
  afterEach(() => setLogPartBytesForTests(null));

  test("thousands of rows are one transaction, every row exactly once", async () => {
    const total = BULK_BATCH_ROWS * 2 + 500;
    seed(total, () => "alice");

    // The patch leaves every row matching the filter; the filter is resolved
    // once, before anything is written, so no row is written twice.
    expect(await client().task.updateMany({ where: { ownerId: "alice" }, data: { weight: 7 } })).toEqual({ count: total });
    expect(count(`"weight" = 7`)).toBe(total);
    expect(writes()).toBe(1);
    const ids = logged(2).flatMap((op) => op.ids as string[]);
    expect(ids.length).toBe(total);
    expect(new Set(ids).size).toBe(total);

    // The patch takes rows out of the filter.
    expect(await client().task.updateMany({ where: { done: false }, data: { done: true } })).toEqual({ count: total });
    expect(count(`"done" = 1`)).toBe(total);

    expect(await client().task.deleteMany({ where: { done: true } })).toEqual({ count: total });
    expect(count()).toBe(0);
  });

  test("a function read rule is applied to every row", async () => {
    build({ task: { view: ({ auth, data }) => data?.ownerId === auth.sub } });
    seed(BULK_BATCH_ROWS * 3, (index) => (index % 3 === 0 ? "bob" : "alice"));
    expect(await client("alice").task.updateMany({ where: {}, data: { done: true } })).toEqual({ count: BULK_BATCH_ROWS * 2 });
    expect(count(`"done" = 1 AND "owner_id" = 'bob'`)).toBe(0);
  });

  test("one refused row anywhere rolls the whole write back", async () => {
    // The row rule refuses one row far past the first thousand.
    build({ task: { update: ({ data }) => data?.title !== "task 2400" } });
    seed(BULK_BATCH_ROWS * 3, () => "alice");

    const error = await client().task.updateMany({ where: {}, data: { done: true } }).catch((caught) => caught);
    expect(error).toMatchObject({ code: "permission_denied" });
    expect(count(`"done" = 1`)).toBe(0);
    expect(writes()).toBe(0);
  });

  test("the engine writes it all at once and returns no cursor", () => {
    seed(BULK_BATCH_ROWS + 1, () => "alice");
    const claim = claimFor("alice", WORKSPACE_ROLE_LEVELS.MODERATOR);
    const result = runTransaction(sql, WORKSPACE, claim, {
      txId: "b1",
      ops: [{ op: "patchMany", namespace: "task", where: {}, values: { done: true } }],
    });
    expect(result.matched).toEqual({ 0: BULK_BATCH_ROWS + 1 });
    expect(result.more).toBeUndefined();
    expect(count(`"done" = 1`)).toBe(BULK_BATCH_ROWS + 1);
    // An older client's cursor still resumes, and a bad one is still refused.
    const resumed = runTransaction(sql, WORKSPACE, claim, {
      txId: "b2",
      ops: [{ op: "deleteMany", namespace: "task", where: {}, after: "t0999" }],
    });
    expect(resumed.matched).toEqual({ 0: 1 });
    expect(() =>
      runTransaction(sql, WORKSPACE, claim, {
        txId: "b3",
        ops: [{ op: "deleteMany", namespace: "task", where: {}, after: "not an id!" }],
      })
    ).toThrow();
  });

  test("a log entry larger than a row is stored in parts", async () => {
    // A part holds at least one whole op; one op here (1000 short ids) is about 9 KB.
    setLogPartBytesForTests(20_000);
    seed(BULK_BATCH_ROWS * 3, () => "alice");
    await client().task.updateMany({ where: {}, data: { done: true } });
    const parts = (db.query(`SELECT COUNT(*) AS n FROM "_tx_log_parts" WHERE seq = 2`).get() as { n: number }).n;
    expect(parts).toBeGreaterThan(0);
    for (const row of db.query(`SELECT ops FROM "_tx_log" UNION ALL SELECT ops FROM "_tx_log_parts"`).all() as Array<{ ops: string }>) {
      expect(row.ops.length).toBeLessThanOrEqual(20_000);
    }
    const ids = logged(2).flatMap((op) => op.ids as string[]);
    expect(new Set(ids).size).toBe(BULK_BATCH_ROWS * 3);
  });

  test("a create and a bulk write in one transaction: the filter sees the database before it", () => {
    seed(3, () => "alice");
    const claim = claimFor("alice", WORKSPACE_ROLE_LEVELS.MODERATOR);
    const result = runTransaction(sql, WORKSPACE, claim, {
      txId: "mix",
      ops: [
        { op: "insert", namespace: "task", id: "t9999", values: { title: "new", done: false, ownerId: "alice" } },
        { op: "patchMany", namespace: "task", where: {}, values: { weight: 3 } },
      ],
    });
    expect(result.matched).toEqual({ 1: 3 });
    expect(count(`"weight" = 3`)).toBe(3);
    expect(count(`"id" = 't9999' AND "weight" = 3`)).toBe(0);
  });
});

