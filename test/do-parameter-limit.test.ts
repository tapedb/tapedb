/**
 * A Durable Object binds at most 100 parameters per statement; plain SQLite
 * binds 32,766, so the rest of the suite cannot see the difference. These
 * tests run the engine through the real Durable Object adapter
 * (`durableObjectSqlExecutor`) over a storage that enforces the limit the way
 * the runtime does, and check the queries that used to exceed it: includes
 * over a page of parents, long `in` lists, and filters with many branches.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { MemoryOutbox } from "../src/client/outbox";
import { configureMigrations } from "../src/engine/migrations-bundle";
import { executeQueryWithPageInfo } from "../src/engine/query-execute";
import { configureRegistry } from "../src/engine/registry";
import { DO_MAX_BOUND_PARAMETERS, fitBindings } from "../src/engine/sql-binding";
import { configurePermissions } from "../src/engine/tx-permissions";
import { runTransaction } from "../src/engine/tx-pipeline";
import { durableObjectSqlExecutor, type SqlExecutor } from "../src/engine/tx-sql";
import { TxError } from "../src/engine/tx-types";
import { createClient } from "../src/model/client";
import { model, schema, t } from "../src/schema";
import { defaultDeploymentConfig } from "../src/engine/config";

/** These tests run the unconfigured engine: audit off, role file rules, no webhooks. */
const engineConfig = defaultDeploymentConfig();

const WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";

const appSchema = schema({
  board: model({ name: t.string(), columns: t.hasMany("column") }),
  column: model({
    name: t.string(),
    position: t.number().default(0),
    board: t.belongsTo("board", { onDelete: "cascade" }),
    tasks: t.hasMany("task"),
  }),
  task: model({ title: t.string(), column: t.belongsTo("column").optional() }),
});

/** `DurableObjectStorage` over bun:sqlite, refusing what the runtime refuses. */
function limitedStorage(db: Database): DurableObjectStorage {
  return {
    sql: {
      exec(query: string, ...params: unknown[]) {
        if (params.length > DO_MAX_BOUND_PARAMETERS) {
          throw new Error(`too many SQL variables (${params.length})`);
        }
        const statement = db.query(query);
        const rows = /^\s*(select|with|pragma)/i.test(query) ? statement.all(...(params as never[])) : [];
        const written = rows.length === 0 && !/^\s*(select|with|pragma)/i.test(query) ? statement.run(...(params as never[])).changes : 0;
        return { toArray: () => rows, rowsWritten: written };
      },
    },
    transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
  } as unknown as DurableObjectStorage;
}

let sql: SqlExecutor;

function claim(): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "alice", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.OWNER, exp: now + 600, iat: now };
}

function client() {
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
          if (url.endsWith("/transact")) return Response.json({ ok: true, result: runTransaction(sql, WORKSPACE, claim(), body, engineConfig) });
          const { data, pageInfo } = executeQueryWithPageInfo(sql, claim(), body);
          return Response.json({ ok: true, data, pageInfo });
        } catch (error) {
          if (error instanceof TxError) return Response.json({ ok: false, error: error.toJSON() }, { status: 400 });
          return Response.json({ ok: false, error: { code: "storage_error", message: String(error) } }, { status: 500 });
        }
      },
    }
  );
}

beforeEach(() => {
  configureRegistry(appSchema.registry);
  configureMigrations(appSchema.migrations);
  configurePermissions(appSchema.permissions);
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of appSchema.migrations) db.exec(migration.sql);
  sql = durableObjectSqlExecutor(limitedStorage(db));
});

async function seedColumns(count: number) {
  const db = client();
  await db.board.create({ data: { id: "b1", name: "B" } });
  const columns = Array.from({ length: count }, (_, n) =>
    db.column.create({ data: { id: `c${String(n).padStart(3, "0")}`, name: `c${n}`, position: n, board: { connect: "b1" } } })
  );
  await db.$transaction(columns);
  await db.$transaction(columns.map((column, n) => db.task.create({ data: { id: `t${String(n).padStart(3, "0")}`, title: `t${n}`, column: { connect: column.id } } })));
  return columns.map((column) => column.id);
}

describe("under a Durable Object's 100-parameter limit", () => {
  test("includes hydrate a page of 150 parents, both directions", async () => {
    await seedColumns(150);
    const db = client();

    const columns = await db.column.findMany({ take: 150, orderBy: { position: "asc" }, include: { tasks: true } });
    expect(columns).toHaveLength(150);
    expect(columns.every((column, n) => column.tasks.length === 1 && column.tasks[0].title === `t${n}`)).toBe(true);

    const tasks = await db.task.findMany({ take: 150, include: { column: true } });
    expect(tasks.every((task) => task.column?.id === task.columnId)).toBe(true);
  });

  test("in and notIn take lists longer than the limit", async () => {
    const ids = await seedColumns(150);
    const db = client();
    expect(await db.column.count({ where: { id: { in: ids.slice(0, 140) } } })).toBe(140);
    expect(await db.column.count({ where: { id: { notIn: ids.slice(0, 140) } } })).toBe(10);
    expect(await db.column.count({ where: { position: { in: [...Array(130).keys(), null] } } })).toBe(130);
  });

  test("a filter with more branches than the limit is bound through one parameter", async () => {
    const ids = await seedColumns(150);
    const db = client();
    const where = { OR: ids.slice(0, 120).map((id) => ({ id })) };
    expect(await db.column.count({ where })).toBe(120);
    expect((await db.column.findMany({ where, orderBy: { position: "desc" }, take: 3 })).map((row) => row.position)).toEqual([119, 118, 117]);
    // A bulk write resolves the same filter.
    expect(await db.column.updateMany({ where, data: { name: "picked" } })).toEqual({ count: 120 });
    expect(await db.column.count({ where: { name: "picked" } })).toBe(120);
  });
});

describe("wide reads", () => {
  test("findMany without take returns every row, includes hydrated chunk by chunk", async () => {
    await seedColumns(150);
    const db = client();
    await db.$transaction(
      Array.from({ length: 2400 }, (_, n) => db.task.create({ data: { id: `x${String(n).padStart(4, "0")}`, title: `x${n}`, column: { connect: `c${String(n % 150).padStart(3, "0")}` } } }))
    );

    const tasks = await db.task.findMany({ include: { column: true } });
    expect(tasks).toHaveLength(2550);
    expect(tasks.every((task) => task.column?.id === task.columnId)).toBe(true);

    // A take past a thousand, ordered, in keyset chunks.
    const ordered = await db.task.findMany({ take: 2500, orderBy: { title: "desc" }, select: { title: true } });
    expect(ordered).toHaveLength(2500);
    const titles = ordered.map((task) => task.title);
    expect(titles).toEqual([...titles].sort().reverse());

    const page = await db.task.findPage({ take: 2000, select: { id: true } });
    expect(page.rows).toHaveLength(2000);
    expect(page.hasMore).toBe(true);
    const rest = await db.task.findPage({ take: 2000, after: page.cursor, select: { id: true } });
    expect(rest.rows).toHaveLength(550);
    expect(new Set([...page.rows, ...rest.rows].map((row) => row.id)).size).toBe(2550);

    const columns = await db.column.findMany({ include: { tasks: { orderBy: { title: "asc" }, take: 2 } } });
    expect(columns.every((column) => column.tasks.length === 2)).toBe(true);
  });
});

describe("fitBindings", () => {
  test("leaves a statement within the limit alone", () => {
    expect(fitBindings("SELECT ? AS a", [1])).toEqual({ sql: "SELECT ? AS a", params: [1] });
  });

  test("rewrites only real placeholders, keeping blobs as their own parameters", () => {
    const blob = new Uint8Array([1, 2]).buffer;
    const fitted = fitBindings(`SELECT '?' AS "q?", ? AS a -- ?\n, ? AS b /* ? */, ? AS c`, [1, "x'y", blob], 2);
    expect(fitted.sql).toBe(`SELECT '?' AS "q?", json_extract(?1, '$[0]') AS a -- ?\n, json_extract(?1, '$[1]') AS b /* ? */, ?2 AS c`);
    expect(fitted.params).toEqual(['[1,"x\'y"]', blob]);

    const db = new Database(":memory:");
    const row = db.query(fitted.sql).get(...(fitted.params as never[])) as Record<string, unknown>;
    expect(row.a).toBe(1);
    expect(row.b).toBe("x'y");
    expect([...new Uint8Array(row.c as Uint8Array)]).toEqual([1, 2]);
  });

  test("returns a statement it cannot match unchanged, for SQLite to report", () => {
    expect(fitBindings("SELECT ?1", [1, 2], 1)).toEqual({ sql: "SELECT ?1", params: [1, 2] });
  });
});

describe("expression depth", () => {
  /** Deepest parenthesis nesting, and the most joiners sharing one level. */
  function shape(sql: string) {
    let depth = 0;
    let deepest = 0;
    const joinersAt = new Map<number, number>();
    const counts: number[] = [];
    for (let index = 0; index < sql.length; index += 1) {
      if (sql[index] === "(") {
        depth += 1;
        deepest = Math.max(deepest, depth);
        counts[depth] = 0;
      } else if (sql[index] === ")") {
        joinersAt.set(depth, Math.max(joinersAt.get(depth) ?? 0, counts[depth] ?? 0));
        depth -= 1;
      } else if (sql.startsWith(" OR ", index) || sql.startsWith(" AND ", index)) {
        counts[depth] = (counts[depth] ?? 0) + 1;
      }
    }
    return { deepest, chain: Math.max(...joinersAt.values()) };
  }

  test("a 400-branch OR compiles to a balanced tree, not a chain", async () => {
    const { compileQuery, buildSelectSql } = await import("../src/engine/query-compile");
    const where = { $or: Array.from({ length: 400 }, (_, n) => ({ name: `c${n}` })) };
    const statement = buildSelectSql(compileQuery({ column: { $: { where } } }).nodes[0]);
    const { deepest, chain } = shape(statement.sql);
    // A chain would put 399 joiners on one level; balanced, every level has one.
    expect(chain).toBe(1);
    expect(deepest).toBeLessThan(16);
  });
});
