/**
 * Named SQL queries (POST /sql): run by name with bound params, read-only,
 * checked against the caller's role and every read model's read rule, with
 * the tables and columns a statement reads taken from SQLite's own plan.
 */
import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS } from "../src/claims";
import { encodeTrustedRoleClaim, TRUSTED_CLAIM_HEADER } from "../src/verify";
import { FakeRoomContext } from "./fixtures/room-harness";
import { FakeR2Bucket } from "./fixtures/test-support";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");
const { filter, model, role, schema, sqlQuery, t } = await import("../src/schema");

const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";

const queries = {
  boardStats: sqlQuery({
    params: { prefix: t.string() },
    returns: { id: t.string(), name: t.string(), open: t.number() },
    sql: `
      -- open tasks per board: a CTE, a join, a named parameter
      WITH open AS (SELECT board_id, count(*) AS n FROM task WHERE done = 0 GROUP BY board_id)
      SELECT b.id, b.name, coalesce(o.n, 0) AS open
      FROM board b LEFT JOIN open o ON o.board_id = b.id
      WHERE b.name LIKE :prefix || '%'
      ORDER BY b.name`,
  }),
  countdown: sqlQuery({
    params: { upto: t.number() },
    returns: { i: t.number() },
    sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < :upto) SELECT i FROM n`,
  }),
  typed: sqlQuery({
    params: { done: t.boolean().optional() },
    returns: { id: t.string(), done: t.boolean(), due: t.date().optional(), meta: t.json().optional() },
    sql: `SELECT id, done, due, meta FROM task WHERE :done IS NULL OR done = :done ORDER BY id`,
  }),
  log: sqlQuery({ returns: { seq: t.number() }, sql: `SELECT seq FROM _tx_log` }),
  catalog: sqlQuery({ returns: { name: t.string() }, sql: `SELECT name FROM sqlite_schema` }),
  names: sqlQuery({ returns: { name: t.string() }, sql: `SELECT name FROM person` }),
  people: sqlQuery({ returns: { n: t.number() }, sql: `SELECT count(id) AS n FROM person` }),
  notes: sqlQuery({ returns: { body: t.string() }, sql: `SELECT body FROM note` }),
  myNotes: sqlQuery({
    bypassReadRules: true,
    returns: { body: t.string() },
    sql: `SELECT body FROM note WHERE owner_id = :authSub ORDER BY body`,
  }),
  admins: sqlQuery({ role: "admin", returns: { n: t.number() }, sql: `SELECT count(*) AS n FROM board` }),
  wrongShape: sqlQuery({ returns: { id: t.string(), missing: t.string() }, sql: `SELECT id FROM board` }),
  nullable: sqlQuery({ returns: { due: t.date() }, sql: `SELECT due FROM task` }),
};

async function setUp() {
  const app = schema(
    {
      board: model({ name: t.string(), tasks: t.hasMany("task") }),
      task: model({
        title: t.string(),
        done: t.boolean().default(false),
        due: t.date().optional(),
        meta: t.json().optional(),
        board: t.belongsTo("board"),
      }),
      note: model({ ownerId: t.string().index(), body: t.string() }).access({ read: filter(({ auth }) => ({ ownerId: auth.sub })) }),
      person: model({ email: t.string(), name: t.string().personal({ subject: "self" }) }).access({ read: role("member") }),
    },
    { queries }
  );
  const tapedb = defineTapeDB({ schema: app });
  const env = { FILES: new FakeR2Bucket(), DATA: new FakeR2Bucket(), TAPEDB_KEY_SECRET: "k".repeat(32), ENVIRONMENT: "development" };
  const context = new FakeRoomContext(new Database(":memory:"), WORKSPACE);
  const room = new tapedb.WorkspaceRoom(context as never, env as never);
  await context.ready;
  const as = (sub: string, level: number) => {
    const now = Math.floor(Date.now() / 1000);
    return { [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim({ sub, workspaceId: WORKSPACE, role: level, iat: now, exp: now + 600 } as never), "content-type": "application/json" };
  };
  const owner = as("olivia", WORKSPACE_ROLE_LEVELS.OWNER);
  const write = async (ops: unknown[]) => {
    const response = await room.fetch(new Request("https://room/transact", { method: "POST", headers: owner, body: JSON.stringify({ txId: crypto.randomUUID(), ops }) }));
    expect(response.status).toBe(200);
  };
  const run = async (headers: Record<string, string>, name: string, params?: unknown) => {
    const response = await room.fetch(new Request("https://room/sql", { method: "POST", headers, body: JSON.stringify({ name, params }) }));
    const body = (await response.json()) as { ok: boolean; data?: { rows: unknown[] }; error?: { code: string; message: string } };
    return { status: response.status, rows: body.data?.rows, error: body.error };
  };
  await write([
    { op: "insert", namespace: "board", id: "b1", values: { name: "Alpha" } },
    { op: "insert", namespace: "board", id: "b2", values: { name: "Beta" } },
    { op: "insert", namespace: "task", id: "t1", values: { title: "a", done: false, boardId: "b1", due: Date.UTC(2026, 10, 22), meta: { tags: ["x"] } } },
    { op: "insert", namespace: "task", id: "t2", values: { title: "b", done: false, boardId: "b1" } },
    { op: "insert", namespace: "task", id: "t3", values: { title: "c", done: true, boardId: "b2" } },
    { op: "insert", namespace: "note", id: "n1", values: { ownerId: "olivia", body: "mine" } },
    { op: "insert", namespace: "note", id: "n2", values: { ownerId: "sam", body: "sam's" } },
    { op: "insert", namespace: "person", id: "p1", values: { email: "a@x.io", name: "Ada" } },
  ]);
  return { as, run, owner, member: as("mia", WORKSPACE_ROLE_LEVELS.MEMBER) };
}

test("runs a query by name: CTEs, joins, recursion, bound params, API-typed rows", async () => {
  const { run, member } = await setUp();
  expect(await run(member, "boardStats", { prefix: "" })).toEqual({
    status: 200,
    rows: [{ id: "b1", name: "Alpha", open: 2 }, { id: "b2", name: "Beta", open: 0 }],
    error: undefined,
  });
  // A value is bound, never pasted into the SQL.
  expect((await run(member, "boardStats", { prefix: "B' OR 1=1 --" })).rows).toEqual([]);
  expect((await run(member, "countdown", { upto: 3 })).rows).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
  expect((await run(member, "typed", { done: false })).rows).toEqual([
    { id: "t1", done: false, due: Date.UTC(2026, 10, 22), meta: { tags: ["x"] } },
    { id: "t2", done: false, due: null, meta: null },
  ]);
  expect((await run(member, "typed")).rows).toHaveLength(3);
});

test("reads only models: engine tables, the catalog and personal fields are refused", async () => {
  const { run, owner } = await setUp();
  for (const name of ["log", "catalog"]) {
    const { status, error } = await run(owner, name);
    expect([status, error?.code]).toEqual([400, "query_refused"]);
    expect(error?.message).toContain("not a model's");
  }
  const personal = await run(owner, "names");
  expect([personal.status, personal.error?.code]).toEqual([400, "query_refused"]);
  expect(personal.error?.message).toContain("person.name, a personal field");
  // Other columns of the same model are fine.
  expect((await run(owner, "people")).rows).toEqual([{ n: 1 }]);
});

test("the caller's role and every read model's read rule decide who may run it", async () => {
  const { run, as, member } = await setUp();
  const forbidden = await run(member, "notes");
  expect([forbidden.status, forbidden.error?.code]).toEqual([403, "query_forbidden"]);
  expect(forbidden.error?.message).toContain("bypassReadRules");
  // A query that filters per-row rules itself, with the caller bound as :authSub.
  expect((await run(as("sam", WORKSPACE_ROLE_LEVELS.MEMBER), "myNotes")).rows).toEqual([{ body: "sam's" }]);
  expect((await run(as("olivia", WORKSPACE_ROLE_LEVELS.MEMBER), "myNotes")).rows).toEqual([{ body: "mine" }]);
  expect((await run(member, "admins")).status).toBe(403);
  expect((await run(as("ann", WORKSPACE_ROLE_LEVELS.ADMIN), "admins")).rows).toEqual([{ n: 2 }]);
  // A model's role rule binds a query too: a guest may not read boards.
  const guest = await run(as("g", WORKSPACE_ROLE_LEVELS.GUEST), "boardStats", { prefix: "" });
  expect([guest.status, guest.error?.code]).toEqual([403, "query_forbidden"]);
});

test("params are checked, and the result must match returns", async () => {
  const { run, member } = await setUp();
  const cases: Array<[string, unknown, string]> = [
    ["boardStats", {}, "needs prefix"],
    ["boardStats", { prefix: 4 }, "prefix is text"],
    ["boardStats", { prefix: "", extra: 1 }, "no parameter extra"],
    ["countdown", { upto: "3" }, "upto is a number"],
    ["typed", { done: "yes" }, "done is true or false"],
  ];
  for (const [name, params, message] of cases) {
    const { status, error } = await run(member, name, params);
    expect([status, error?.code]).toEqual([400, "invalid_query_params"]);
    expect(error?.message).toContain(message);
  }
  const shape = await run(member, "wrongShape");
  expect([shape.status, shape.error?.code]).toEqual([500, "query_result_mismatch"]);
  expect((await run(member, "nullable")).error?.message).toContain("returned null in due");
  expect((await run(member, "nothing")).status).toBe(404);
});

test("schema() refuses queries that are not one read with matching params", () => {
  const cases: Array<[unknown, RegExp]> = [
    [sqlQuery({ returns: { n: t.number() }, sql: "DELETE FROM board" }), /one SELECT/],
    [sqlQuery({ returns: { n: t.number() }, sql: "SELECT 1 AS n; SELECT 2 AS n" }), /exactly one statement/],
    [sqlQuery({ returns: { n: t.number() }, sql: "SELECT ? AS n" }), /name every parameter/],
    [sqlQuery({ returns: { n: t.number() }, sql: "SELECT :n AS n" }), /:n is not in params/],
    [sqlQuery({ params: { a: t.string() }, returns: { n: t.number() }, sql: "SELECT 1 AS n" }), /params.a is never used/],
    [sqlQuery({ params: { authSub: t.string() }, returns: { n: t.number() }, sql: "SELECT :authSub AS n" }), /binds :authSub itself/],
    [sqlQuery({ returns: {}, sql: "SELECT 1" }), /returns names no columns/],
    [sqlQuery({ returns: { n: t.number() }, role: "chief" as never, sql: "SELECT 1 AS n" }), /Unknown role/],
  ];
  for (const [query, message] of cases) {
    expect(() => schema({ board: model({ name: t.string() }) }, { queries: { q: query as never } })).toThrow(message);
  }
  // A colon inside a string or comment is not a parameter; a trailing ; is fine.
  expect(() => schema({ board: model({ name: t.string() }) }, { queries: { q: sqlQuery({ returns: { n: t.string() }, sql: "SELECT ':x' AS n -- :y\n;" }) } })).not.toThrow();
});

test("migrate check prepares every query against the migrated tables, with the engine's checks", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { migrateDev, readMigrations } = await import("../src/cli/migrate");
  const { checkQueries } = await import("../src/cli/query-check");
  const bunSqlite = async () => {
    const db = new Database(":memory:");
    return {
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => {
        const statement = db.query(sql);
        return { all: (...params: unknown[]) => statement.values(...(params as never[])), columns: () => statement.columnNames.map((name) => ({ name })) };
      },
      close: () => db.close(),
    };
  };
  const models = {
    board: model({ name: t.string() }),
    person: model({ email: t.string(), name: t.string().personal({ subject: "self" }) }),
  };
  const good = schema(models, { queries: { boards: sqlQuery({ returns: { name: t.string() }, sql: "SELECT name FROM board" }) } });
  const root = mkdtempSync(join(tmpdir(), "tapedb-queries-"));
  migrateDev(root, good, "init");
  expect(await checkQueries(good, readMigrations(root), bunSqlite)).toEqual([]);

  const bad = schema(models, {
    queries: {
      renamed: sqlQuery({ returns: { title: t.string() }, sql: "SELECT title FROM board" }),
      secret: sqlQuery({ returns: { name: t.string() }, sql: "SELECT name FROM person" }),
    },
  });
  const problems = await checkQueries(bad, readMigrations(root), bunSqlite);
  expect(problems).toHaveLength(2);
  expect(problems[0]).toMatch(/^queries\.renamed: "renamed" does not prepare: .*title/);
  expect(problems[1]).toMatch(/^queries\.secret: .*person\.name, a personal field/);
});
