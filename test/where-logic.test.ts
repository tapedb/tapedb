/**
 * `$nin`, `$or` / `$and` / `$not`, and `count`.
 *
 * Null handling is the part worth pinning: SQL's three-valued logic silently
 * drops rows whose field is null from NOT IN and from NOT (...). The engine
 * already treats `$ne` as matching nulls; these follow the same rule.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { configureMigrations } from "../src/engine/migrations-bundle";
import { configurePermissions, type PermissionOverrides } from "../src/engine/tx-permissions";
import { compileQuery } from "../src/engine/query-compile";
import { executeCompiledQueryWithPageInfo } from "../src/engine/query-execute";
import { configureRegistry } from "../src/engine/registry";
import type { SqlExecutor, SqlRow, SqlValue } from "../src/engine/tx-sql";
import { runTransaction } from "../src/engine/tx-pipeline";
import { defineSchema } from "../src/schema";

const WORKSPACE_ID = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";

function setup(permissions: PermissionOverrides = {}): SqlExecutor {
  const schema = defineSchema({
    entities: {
      tasks: {
        title: { type: "string" },
        status: { type: "string", optional: true },
        ownerId: { type: "string", optional: true },
        points: { type: "number", optional: true },
      },
    },
    permissions,
  });
  configureRegistry(schema.registry);
  configureMigrations(schema.migrations);
  configurePermissions(schema.permissions);
  const db = new Database(":memory:");
  for (const migration of schema.migrations) db.exec(migration.sql);
  const sql: SqlExecutor = {
    exec: (q: string, ...p: SqlValue[]) => db.query(q).run(...(p as never[])).changes,
    all: <T extends SqlRow = SqlRow>(q: string, ...p: SqlValue[]) => db.query(q).all(...(p as never[])) as T[],
    one: <T extends SqlRow = SqlRow>(q: string, ...p: SqlValue[]) =>
      (db.query(q).get(...(p as never[])) ?? undefined) as T | undefined,
    transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
  };
  const now = Math.floor(Date.now() / 1000);
  runTransaction(sql, WORKSPACE_ID, { sub: "o", workspaceId: WORKSPACE_ID, role: WORKSPACE_ROLE_LEVELS.OWNER, exp: now + 600, iat: now }, {
    txId: "seed",
    ops: [
      { op: "insert", namespace: "tasks", id: "a", values: { title: "a", status: "todo", ownerId: "alice", points: 1 } },
      { op: "insert", namespace: "tasks", id: "b", values: { title: "b", status: "done", ownerId: "bob", points: 3 } },
      { op: "insert", namespace: "tasks", id: "c", values: { title: "c", status: null, ownerId: "alice", points: 5 } },
      { op: "insert", namespace: "tasks", id: "d", values: { title: "d", status: "doing", ownerId: "bob", points: null } },
    ],
  });
  return sql;
}

function claim(sub = "alice"): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return { sub, workspaceId: WORKSPACE_ID, role: WORKSPACE_ROLE_LEVELS.MEMBER, exp: now + 600, iat: now };
}

function titles(sql: SqlExecutor, where: unknown): string[] {
  const { data } = executeCompiledQueryWithPageInfo(
    sql,
    compileQuery({ tasks: { $: { where, order: { title: "asc" } } } }),
    claim()
  );
  return data.tasks.map((row) => (row as { title: string }).title);
}

describe("$nin", () => {
  test("keeps rows whose field is null, like $ne", () => {
    const sql = setup();
    expect(titles(sql, { status: { $nin: ["todo", "done"] } })).toEqual(["c", "d"]);
  });

  test("a null in the list excludes null rows too", () => {
    const sql = setup();
    expect(titles(sql, { status: { $nin: ["todo", null] } })).toEqual(["b", "d"]);
  });
});

describe("$or, $and, $not", () => {
  test("$or matches any branch; $and requires every one", () => {
    const sql = setup();
    expect(titles(sql, { $or: [{ status: "done" }, { points: { $gte: 5 } }] })).toEqual(["b", "c"]);
    expect(titles(sql, { $and: [{ ownerId: "alice" }, { points: { $gt: 1 } }] })).toEqual(["c"]);
  });

  test("combine with plain attributes, which AND with them", () => {
    const sql = setup();
    expect(titles(sql, { ownerId: "bob", $or: [{ status: "done" }, { status: "todo" }] })).toEqual(["b"]);
  });

  test("$not matches rows whose field is null", () => {
    const sql = setup();
    // Bare SQL NOT (status = 'todo') drops c, whose status is null.
    expect(titles(sql, { $not: { status: "todo" } })).toEqual(["b", "c", "d"]);
    expect(titles(sql, { $not: { $or: [{ ownerId: "alice" }, { points: null }] } })).toEqual(["b"]);
  });

  test("refuses empty arrays, unknown $ keys and runaway nesting", () => {
    const sql = setup();
    expect(() => titles(sql, { $or: [] })).toThrow(/non-empty array/);
    expect(() => titles(sql, { $xor: [{ status: "a" }] })).toThrow(/Unknown where key/);
    let deep: Record<string, unknown> = { status: "todo" };
    for (let i = 0; i < 5; i += 1) deep = { $not: deep };
    expect(() => titles(sql, deep)).toThrow(/nest at most/);
  });
});

describe("count", () => {
  test("counts every match, ignoring limit and after", () => {
    const sql = setup();
    const first = executeCompiledQueryWithPageInfo(
      sql,
      compileQuery({ tasks: { $: { where: { status: { $ne: "done" } }, order: { title: "asc" }, limit: 1, count: true } } }),
      claim()
    );
    expect(first.data.tasks).toHaveLength(1);
    expect(first.pageInfo.tasks.count).toBe(3);

    const second = executeCompiledQueryWithPageInfo(
      sql,
      compileQuery({ tasks: { $: { where: { status: { $ne: "done" } }, order: { title: "asc" }, limit: 1, count: true, after: first.pageInfo.tasks.nextCursor } } }),
      claim()
    );
    expect(second.pageInfo.tasks.count).toBe(3);
  });

  test("limit 0 counts without reading rows", () => {
    const sql = setup();
    const { data, pageInfo } = executeCompiledQueryWithPageInfo(
      sql,
      compileQuery({ tasks: { $: { count: true, limit: 0 } } }),
      claim()
    );
    expect(data.tasks).toEqual([]);
    expect(pageInfo.tasks).toMatchObject({ count: 4, returned: 0, hasMore: true });
    expect(() => compileQuery({ tasks: { $: { limit: 0 } } })).toThrow(/Limit must be/);
  });

  test("counts only visible rows under both SQL and function view rules", () => {
    const filtered = setup({ tasks: { view: { where: ({ sub }) => ({ ownerId: sub }) } } });
    const { pageInfo } = executeCompiledQueryWithPageInfo(
      filtered,
      compileQuery({ tasks: { $: { count: true, limit: 0 } } }),
      claim("alice")
    );
    expect(pageInfo.tasks.count).toBe(2);

    const fn = setup({ tasks: { view: ({ auth, data }) => data?.ownerId === auth.sub } });
    const counted = executeCompiledQueryWithPageInfo(fn, compileQuery({ tasks: { $: { count: true, limit: 0 } } }), claim("alice"));
    expect(counted.pageInfo.tasks.count).toBe(2);
    expect(counted.data.tasks).toEqual([]);
  });

  test("is top level only", () => {
    const linked = defineSchema({
      entities: { boards: { name: { type: "string" } }, cards: { boardId: { type: "string", optional: true } } },
      links: [
        {
          apiName: "boardCards",
          kind: "one-to-many",
          forward: { namespace: "boards", label: "cards", has: "many" },
          reverse: { namespace: "cards", label: "board", has: "one" },
          foreignKey: { namespace: "cards", attribute: "boardId" },
        },
      ],
    });
    configureRegistry(linked.registry);
    expect(() => compileQuery({ boards: { cards: {} } })).not.toThrow();
    expect(() => compileQuery({ boards: { cards: { $: { count: true } } } })).toThrow(/only available on a top-level/);
  });
});


describe("nullable ordering", () => {
  for (const direction of ["asc", "desc"] as const) {
    test(`paginates nullable fields in ${direction} order without skipping or repeating`, () => {
      const sql = setup();
      const seen: string[] = [];
      let after: string | undefined;
      for (let step = 0; step < 5; step++) {
        const result = executeCompiledQueryWithPageInfo(sql, compileQuery({
          tasks: { $: { limit: 1, order: { points: direction }, ...(after ? { after } : {}) } },
        }), claim());
        seen.push(...result.data.tasks.map(row => row.id as string));
        if (!result.pageInfo.tasks.hasMore) break;
        expect(result.pageInfo.tasks.nextCursor).toBeDefined();
        after = result.pageInfo.tasks.nextCursor;
      }
      expect(seen).toEqual(direction === "asc" ? ["d", "a", "b", "c"] : ["c", "b", "a", "d"]);
    });
  }
});
