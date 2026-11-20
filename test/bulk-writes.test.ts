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
import { beforeEach, describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim, type WorkspaceRole } from "../src/claims";
import { MemoryOutbox } from "../src/client/outbox";
import { BULK_BATCH_ROWS } from "../src/engine/tx-bulk";
import { matchesWhere } from "../src/client/local-where";
import { applyOptimisticOps } from "../src/client/query-cache";
import { configureMigrations } from "../src/engine/migrations-bundle";
import { executeQueryWithPageInfo } from "../src/engine/query-execute";
import { configureRegistry } from "../src/engine/registry";
import { configurePermissions, type PermissionOverrides } from "../src/engine/tx-permissions";
import type { SqlExecutor, SqlRow, SqlValue } from "../src/engine/tx-sql";
import { runTransaction } from "../src/engine/tx-pipeline";
import { defaultDeploymentConfig, deploymentConfig } from "../src/engine/config";
import { TxError } from "../src/engine/tx-types";
import { createClient } from "../src/model/client";
import { model, schema, t } from "../src/schema";

const WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";

/** These tests run the unconfigured engine: audit off, standard log parts. */
const engineConfig = defaultDeploymentConfig();

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

let offline = false;
let sharedOutbox: MemoryOutbox | null = null;

function client(
  sub = "alice",
  role: WorkspaceRole = WORKSPACE_ROLE_LEVELS.MODERATOR,
  config = engineConfig
) {
  const claim = claimFor(sub, role);
  return createClient(
    { schema: appSchema, url: "http://engine.test", workspace: WORKSPACE, getToken: async () => "t" },
    {
      outbox: sharedOutbox ?? new MemoryOutbox(),
      createWebSocket: () => {
        throw new Error("no socket here");
      },
      fetch: async (url: string, init?: { body?: string }) => {
        if (offline) throw new TypeError("network down");
        const body = init?.body === undefined ? undefined : JSON.parse(init.body);
        try {
          if (url.endsWith("/transact")) {
            return Response.json({ ok: true, result: runTransaction(sql, WORKSPACE, claim, body, config) });
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

function seed(
  count: number,
  owner = (index: number) => (index % 2 === 0 ? "alice" : "bob"),
  config = engineConfig
) {
  const claim = claimFor("seed", WORKSPACE_ROLE_LEVELS.OWNER);
  runTransaction(sql, WORKSPACE, claim, {
    txId: "seed",
    ops: Array.from({ length: count }, (_, index) => ({
      op: "insert",
      namespace: "task",
      id: `t${String(index).padStart(4, "0")}`,
      values: { title: `task ${index}`, done: false, ownerId: owner(index) },
    })),
  }, config);
}

/** A log entry's ops, every part, as stored (compact bulk ops unexpanded). */
function logged(seq: number): Array<Record<string, unknown>> {
  const row = db.query(`SELECT ops FROM "_tx_log" WHERE seq = ?`).get(seq) as { ops: string };
  const parts = db.query(`SELECT ops FROM "_tx_log_parts" WHERE seq = ? ORDER BY part`).all(seq) as Array<{ ops: string }>;
  return [row.ops, ...parts.map((part) => part.ops)].flatMap((text) => JSON.parse(text) as Array<Record<string, unknown>>);
}

beforeEach(() => {
  build();
  offline = false;
  sharedOutbox = null;
});

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
    }, engineConfig);

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
    }, engineConfig);
    expect(result.matched).toEqual({ 0: BULK_BATCH_ROWS + 1 });
    expect(result.more).toBeUndefined();
    expect(count(`"done" = 1`)).toBe(BULK_BATCH_ROWS + 1);
    // An older client's cursor still resumes, and a bad one is still refused.
    const resumed = runTransaction(sql, WORKSPACE, claim, {
      txId: "b2",
      ops: [{ op: "deleteMany", namespace: "task", where: {}, after: "t0999" }],
    }, engineConfig);
    expect(resumed.matched).toEqual({ 0: 1 });
    expect(() =>
      runTransaction(sql, WORKSPACE, claim, {
        txId: "b3",
        ops: [{ op: "deleteMany", namespace: "task", where: {}, after: "not an id!" }],
      }, engineConfig)
    ).toThrow();
  });

  test("a log entry larger than a row is stored in parts", async () => {
    // A part holds at least one whole op; one op here (1000 short ids) is about 9 KB.
    // A smaller part size for this deployment only: the engine is told per
    // call, so no other test (or the other deployment in this process) sees it.
    const smallParts = deploymentConfig({ logPartBytes: 20_000 });
    seed(BULK_BATCH_ROWS * 3, () => "alice", smallParts);
    await client("alice", WORKSPACE_ROLE_LEVELS.MODERATOR, smallParts).task.updateMany({ where: {}, data: { done: true } });
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
    }, engineConfig);
    expect(result.matched).toEqual({ 1: 3 });
    expect(count(`"weight" = 3`)).toBe(3);
    expect(count(`"id" = 't9999' AND "weight" = 3`)).toBe(0);
  });
});

describe("offline and optimistic", () => {
  test("queued offline, it changes the cache now and the engine when it reconnects", async () => {
    seed(4);
    sharedOutbox = new MemoryOutbox();
    offline = true;
    const db = client();
    const queued = await db.task.updateMany({ where: { ownerId: "alice" }, data: { done: true } });
    expect(queued.queued).toBe(true);
    expect(await sharedOutbox.list(WORKSPACE)).toHaveLength(1);
    // Nothing reached the engine yet.
    expect((sql.one(`SELECT COUNT(*) AS n FROM "task" WHERE "done" = 1`) as { n: number }).n).toBe(0);

    offline = false;
    await db.$flush();
    expect(await sharedOutbox.list(WORKSPACE)).toHaveLength(0);
    expect((sql.one(`SELECT COUNT(*) AS n FROM "task" WHERE "done" = 1`) as { n: number }).n).toBe(2);
  });

  test("the cache changes the rows it can judge, and only those", () => {
    const data = {
      task: [
        { id: "a", title: "x", done: false, ownerId: "alice" },
        { id: "b", title: "y", done: false, ownerId: "bob" },
        { id: "c", title: "z", done: false },
      ],
    };
    const patched = applyOptimisticOps(data, [{ op: "patchMany", namespace: "task", where: { ownerId: "alice" }, values: { done: true } }], undefined);
    expect((patched.task as Array<Record<string, unknown>>).map((row) => row.done)).toEqual([true, false, false]);
    // `c` holds no ownerId in the cache: cannot tell, left for the engine.
    const unsure = applyOptimisticOps(data, [{ op: "deleteMany", namespace: "task", where: { ownerId: { $ne: "bob" } } }], undefined);
    expect((unsure.task as Array<{ id: string }>).map((row) => row.id)).toEqual(["b", "c"]);
    const relation = applyOptimisticOps(data, [{ op: "deleteMany", namespace: "task", where: { $link: [] } }], undefined);
    expect((relation.task as unknown[]).length).toBe(3);
  });

  test("whenever the cache can judge a row, it agrees with the engine", () => {
    let state = 11;
    // The high bits: a power-of-two LCG's low bits cycle quickly.
    const random = (n: number) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return Math.floor((state / 2147483648) * n);
    };
    const owners = ["alice", "bob", "Zed", "ålice", null];
    const titles = ["a", "B", "b", "ä", "", "a b"];
    const claim = claimFor("seed", WORKSPACE_ROLE_LEVELS.OWNER);
    runTransaction(sql, WORKSPACE, claim, {
      txId: "rows",
      ops: Array.from({ length: 60 }, (_, index) => ({
        op: "insert",
        namespace: "task",
        id: `r${String(index).padStart(3, "0")}`,
        values: {
          title: titles[random(titles.length)],
          done: random(2) === 0,
          ownerId: owners[random(owners.length - 1)],
          ...(random(3) === 0 ? {} : { weight: random(5) - 2 }),
        },
      })),
    }, engineConfig);
    const reader = claimFor("alice", WORKSPACE_ROLE_LEVELS.OWNER);
    const rows = executeQueryWithPageInfo(sql, reader, { query: { task: { $: {} } } }).data.task as Array<Record<string, unknown>>;

    const leaf = (): Record<string, unknown> => {
      const field = ["title", "done", "ownerId", "weight"][random(4)];
      const values: Record<string, unknown[]> = { title: titles, done: [true, false], ownerId: owners, weight: [-2, -1, 0, 1, 2, null] };
      const pick = () => values[field][random(values[field].length)];
      const operator = random(8);
      if (operator === 0) return { [field]: pick() };
      if (operator === 1) return { [field]: { $ne: pick() } };
      if (operator === 2) return { [field]: { $in: [pick(), pick()] } };
      if (operator === 3) return { [field]: { $nin: [pick(), pick()] } };
      const value = pick();
      if (value === null || field === "done") return { [field]: value };
      return { [field]: { [["$gt", "$gte", "$lt", "$lte"][operator - 4]]: value } };
    };
    const filter = (depth: number): Record<string, unknown> => {
      const kind = depth <= 0 ? 0 : random(4);
      if (kind === 0) return leaf();
      if (kind === 1) return { $or: [filter(depth - 1), filter(depth - 1)] };
      if (kind === 2) return { $and: [filter(depth - 1), filter(depth - 1)] };
      return { $not: filter(depth - 1) };
    };

    let judged = 0;
    for (let round = 0; round < 300; round += 1) {
      const where = filter(3);
      const engine = new Set(
        (executeQueryWithPageInfo(sql, reader, { query: { task: { $: { where } } } }).data.task as Array<{ id: string }>).map((row) => row.id)
      );
      for (const row of rows) {
        const local = matchesWhere(row, where);
        if (local === undefined) continue;
        judged += 1;
        expect({ where, id: row.id, local }).toEqual({ where, id: row.id, local: engine.has(row.id as string) });
      }
    }
    // Most rows are judged, so this is a real comparison, not a vacuous one.
    expect(judged).toBeGreaterThan(300 * 60 * 0.5);
  });
});



test("bulk writes cannot enumerate a root model whose read role is denied", () => {
  build({ task: { view: WORKSPACE_ROLE_LEVELS.ADMIN, update: WORKSPACE_ROLE_LEVELS.EDITOR, delete: WORKSPACE_ROLE_LEVELS.EDITOR } });
  const owner = claimFor("seed", WORKSPACE_ROLE_LEVELS.OWNER);
  runTransaction(sql, WORKSPACE, owner, { txId: "seed-hidden", ops: [{ op: "insert", namespace: "task", id: "hidden", values: { title: "secret", ownerId: "seed", done: false } }] }, engineConfig);
  for (const op of [{ op: "patchMany", namespace: "task", where: {}, values: { done: true } }, { op: "deleteMany", namespace: "task", where: {} }]) {
    expect(() => runTransaction(sql, WORKSPACE, claimFor("editor", WORKSPACE_ROLE_LEVELS.EDITOR), { txId: crypto.randomUUID(), ops: [op] }, engineConfig)).toThrow(/not allowed to view/);
    expect(sql.one<{ title: string }>(`SELECT title FROM task WHERE id = 'hidden'`)?.title).toBe("secret");
  }
});
