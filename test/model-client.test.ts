/**
 * The model API end to end: `schema()` compiled into the real engine, and
 * `createClient()` talking to it through a fetch that calls the engine
 * directly. No Worker, no socket: every assertion here is about what the
 * public API sends and what the engine does with it.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim, type WorkspaceRole } from "../src/claims";
import { MemoryOutbox } from "../src/client/outbox";
import { configureMigrations } from "../src/engine/migrations-bundle";
import { executeQueryWithPageInfo } from "../src/engine/query-execute";
import { configureRegistry } from "../src/engine/registry";
import { configurePermissions } from "../src/engine/tx-permissions";
import type { SqlExecutor, SqlRow, SqlValue } from "../src/engine/tx-sql";
import { runTransaction } from "../src/engine/tx-pipeline";
import { TxError } from "../src/engine/tx-types";
import { createClient } from "../src/model/client";
import { check, filter, model, role, schema, t } from "../src/schema";

const WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";

const appSchema = schema({
  board: model({
    name: t.string(),
    ownerId: t.string().index(),
    archived: t.boolean().default(false),
    columns: t.hasMany("column"),
  }).access({
    read: filter(({ auth }) => ({ ownerId: auth.sub })),
    update: check(({ auth, row }) => row?.ownerId === auth.sub),
  }),
  column: model({
    name: t.string(),
    position: t.number().index(),
    board: t.belongsTo("board", { onDelete: "cascade" }),
    tasks: t.hasMany("task"),
  }),
  task: model({
    title: t.string(),
    done: t.boolean().default(false),
    due: t.date().optional(),
    meta: t.json().optional(),
    column: t.belongsTo("column").optional(),
  }).access({ delete: role("moderator") }),
});

let sql: SqlExecutor;

function engine(sub: string, role: WorkspaceRole) {
  const now = Math.floor(Date.now() / 1000);
  const claim: RoleClaim = { sub, workspaceId: WORKSPACE, role, exp: now + 600, iat: now };
  return async (url: string, init: { method: string; body?: string }) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    try {
      if (url.endsWith("/transact")) {
        const result = runTransaction(sql, WORKSPACE, claim, body);
        return Response.json({ ok: true, result });
      }
      if (url.endsWith("/query")) {
        const { data, pageInfo } = executeQueryWithPageInfo(sql, claim, body);
        return Response.json({ ok: true, data, pageInfo });
      }
    } catch (error) {
      if (error instanceof TxError) {
        const status = error.code === "permission_denied" ? 403 : error.code === "storage_error" ? 500 : error.code === "invalid_op" || error.code === "invalid_value" ? 400 : 409;
        return Response.json({ ok: false, error: error.toJSON() }, { status });
      }
      throw error;
    }
    return Response.json({ ok: false, error: { code: "no_route", message: url } }, { status: 404 });
  };
}

function client(sub = "alice", role: WorkspaceRole = WORKSPACE_ROLE_LEVELS.EDITOR) {
  return createClient(
    { schema: appSchema, url: "http://engine.test", workspace: WORKSPACE, getToken: async () => "token" },
    { fetch: engine(sub, role), outbox: new MemoryOutbox(), createWebSocket: () => { throw new Error("no socket in this test"); } }
  );
}

beforeEach(() => {
  configureRegistry(appSchema.registry);
  configureMigrations(appSchema.migrations);
  configurePermissions(appSchema.permissions);
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of appSchema.migrations) db.exec(migration.sql);
  sql = {
    exec: (q: string, ...p: SqlValue[]) => db.query(q).run(...(p as never[])).changes,
    all: <T extends SqlRow = SqlRow>(q: string, ...p: SqlValue[]) => db.query(q).all(...(p as never[])) as T[],
    one: <T extends SqlRow = SqlRow>(q: string, ...p: SqlValue[]) =>
      (db.query(q).get(...(p as never[])) ?? undefined) as T | undefined,
    transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
  };
});

async function seed(db = client()) {
  const board = await db.board.create({ data: { name: "Roadmap", ownerId: "alice" } });
  const todo = await db.column.create({ data: { name: "Todo", position: 1, board: { connect: board.id } } });
  const doing = await db.column.create({ data: { name: "Doing", position: 2, board: { connect: board.id } } });
  await db.$transaction([
    db.task.create({ data: { id: "t1", title: "Write spec", column: { connect: todo.id } } }),
    db.task.create({ data: { id: "t2", title: "Build it", due: new Date("2026-12-01T00:00:00Z"), column: { connect: doing.id } } }),
    db.task.create({ data: { id: "t3", title: "Loose end", meta: { tags: ["x"] } } }),
  ]);
  return { board: board.id, todo: todo.id, doing: doing.id };
}

describe("schema()", () => {
  test("compiles models, foreign keys and links for the engine", () => {
    const tasks = appSchema.registry.namespaces.find((namespace) => namespace.apiName === "task")!;
    expect(tasks.table).toBe("task");
    expect(tasks.attributes.columnId).toMatchObject({ type: "string", optional: true, indexed: true });
    expect(appSchema.registry.links.map((link) => link.apiName).sort()).toEqual(["column.board", "task.column"]);
    expect(appSchema.migrations[1].sql).toContain('REFERENCES "board"("id") ON DELETE CASCADE');
  });

  test("maps a model onto an existing table", () => {
    const mapped = schema({
      boards: model({ name: t.string(), columns: t.hasMany("columns") }, { table: "kanban_boards" }),
      columns: model({ board: t.belongsTo("boards") }, { table: "kanban_columns" }),
    });
    expect(mapped.migrations[1].sql).toContain('CREATE TABLE IF NOT EXISTS "kanban_boards"');
    expect(mapped.migrations[1].sql).toContain('REFERENCES "kanban_boards"("id")');
  });

  test("refuses relations it cannot resolve", () => {
    expect(() => schema({ a: model({ b: t.belongsTo("missing") }) })).toThrow(/not a model/);
    expect(() => schema({ a: model({ bs: t.hasMany("b") }), b: model({ name: t.string() }) })).toThrow(/no matching belongsTo/);
    expect(() =>
      schema({
        user: model({ posts: t.hasMany("post") }),
        post: model({ author: t.belongsTo("user"), editor: t.belongsTo("user") }),
      })
    ).toThrow(/name one with \{ inverse \}/);
    expect(() =>
      schema({
        user: model({ posts: t.hasMany("post", { inverse: "author" }) }),
        post: model({ author: t.belongsTo("user"), editor: t.belongsTo("user") }),
      })
    ).not.toThrow();
    expect(() => schema({ a: model({ id: t.string() }) })).toThrow(/system field/);
    expect(() => schema({ a: model({ name: t.string() }).access({ update: filter(() => ({})) as never }) })).toThrow(/only valid for read/);
  });
});

describe("reads", () => {
  test("findMany with where, orderBy and nested include", async () => {
    const db = client();
    const ids = await seed(db);

    const columns = await db.column.findMany({
      where: { boardId: ids.board },
      orderBy: { position: "desc" },
      include: { board: true, tasks: { orderBy: { title: "asc" } } },
    });
    expect(columns.map((column) => column.name)).toEqual(["Doing", "Todo"]);
    expect(columns[0].board.name).toBe("Roadmap");
    expect(columns[1].tasks.map((task) => task.title)).toEqual(["Write spec"]);
  });

  test("findUnique, findFirst and count", async () => {
    const db = client();
    await seed(db);
    expect((await db.task.findUnique({ where: { id: "t2" } }))?.title).toBe("Build it");
    expect(await db.task.findUnique({ where: { id: "nope" } })).toBeNull();
    expect((await db.task.findFirst({ orderBy: { title: "desc" } }))?.title).toBe("Write spec");
    expect(await db.task.count()).toBe(3);
    expect(await db.task.count({ where: { columnId: { not: null } } })).toBe(2);
  });

  test("filters translate operators, OR and NOT, and dates", async () => {
    const db = client();
    await seed(db);
    const titles = async (where: object) =>
      (await db.task.findMany({ where: where as never, orderBy: { title: "asc" } })).map((task) => task.title);

    expect(await titles({ OR: [{ id: "t1" }, { title: { in: ["Loose end"] } }] })).toEqual(["Loose end", "Write spec"]);
    expect(await titles({ NOT: { title: "Build it" } })).toEqual(["Loose end", "Write spec"]);
    expect(await titles({ id: { notIn: ["t1", "t2"] } })).toEqual(["Loose end"]);
    expect(await titles({ due: { lt: new Date("2027-01-01") } })).toEqual(["Build it"]);
    expect(await titles({ title: { equals: "Build it", not: "x" } })).toEqual(["Build it"]);
  });

  test("findPage walks every row exactly once, in id order by default", async () => {
    const db = client();
    for (let n = 0; n < 7; n += 1) await db.task.create({ data: { title: `task ${n}` } });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await db.task.findPage({ take: 3, after: cursor });
      seen.push(...page.rows.map((row) => row.title));
      cursor = page.cursor;
    } while (cursor !== null);
    expect(seen).toEqual(Array.from({ length: 7 }, (_, n) => `task ${n}`));
  });

  test("a filter access rule scopes every read", async () => {
    await seed(client("alice"));
    await client("bob").board.create({ data: { name: "Bob's", ownerId: "bob" } });

    expect((await client("alice").board.findMany()).map((board) => board.name)).toEqual(["Roadmap"]);
    expect(await client("bob").board.count()).toBe(1);
  });

  test("unknown fields and relation filters fail before the request", () => {
    const db = client();
    expect(() => db.task.findMany({ where: { nope: 1 } as never })).toThrow(/no filterable field "nope"/);
    expect(() => db.task.findMany({ where: { column: { name: "x" } } as never })).toThrow(/not supported yet/);
    expect(() => db.task.findMany({ where: { title: { like: "x" } } as never })).toThrow(/Unknown filter "like"/);
    expect(() => db.task.findMany({ include: { nope: true } as never })).toThrow(/no relation "nope"/);
  });
});

describe("ids", () => {
  test("sort in the order they were made, within one millisecond too", async () => {
    const { id } = await import("../src/client/id");
    const made = Array.from({ length: 5000 }, () => id());
    expect([...made].sort()).toEqual(made);
    expect(new Set(made).size).toBe(made.length);
  });
});

describe("writes", () => {
  test("create fills defaults and returns the id", async () => {
    const db = client();
    const created = await db.task.create({ data: { title: "Defaults" } });
    expect(created.status).toBe("applied");
    const task = await db.task.findUnique({ where: { id: created.id } });
    expect(task).toMatchObject({ title: "Defaults", done: false, due: null, columnId: null });
  });

  test("create refuses an existing id; update refuses a missing row", async () => {
    const db = client();
    await db.task.create({ data: { id: "dup", title: "First" } });
    await expect(db.task.create({ data: { id: "dup", title: "Second" } }).then()).rejects.toThrow(/already exists/);
    await expect(db.task.update({ where: { id: "ghost" }, data: { done: true } }).then()).rejects.toThrow(/No "task" row/);
    expect((await db.task.findUnique({ where: { id: "dup" } }))?.title).toBe("First");
  });

  test("upsert creates, then updates", async () => {
    const db = client();
    await db.task.upsert({ where: { id: "u1" }, create: { title: "Made" }, update: { title: "Changed" } });
    expect((await db.task.findUnique({ where: { id: "u1" } }))?.title).toBe("Made");
    await db.task.upsert({ where: { id: "u1" }, create: { title: "Made" }, update: { done: true } });
    expect(await db.task.findUnique({ where: { id: "u1" } })).toMatchObject({ title: "Made", done: true });
  });

  test("connect and disconnect on both sides of a relation", async () => {
    const db = client();
    const ids = await seed(db);

    await db.column.update({ where: { id: ids.todo }, data: { tasks: { connect: ["t3"], disconnect: ["t1"] } } });
    const todo = await db.column.findUnique({ where: { id: ids.todo }, include: { tasks: true } });
    expect(todo?.tasks.map((task) => task.id)).toEqual(["t3"]);

    await db.task.update({ where: { id: "t3" }, data: { column: null } });
    expect((await db.task.findUnique({ where: { id: "t3" } }))?.columnId).toBeNull();
  });

  test("$transaction is all or nothing", async () => {
    const db = client();
    await db.task.create({ data: { id: "keep", title: "Keep" } });
    await expect(
      db.$transaction([
        db.task.create({ data: { id: "new", title: "New" } }),
        db.task.update({ where: { id: "missing" }, data: { title: "x" } }),
      ])
    ).rejects.toThrow();
    expect(await db.task.findUnique({ where: { id: "new" } })).toBeNull();
  });

  test("check and role rules guard writes", async () => {
    const ids = await seed(client("alice"));
    await expect(
      client("mallory").board.update({ where: { id: ids.board }, data: { name: "Mine now" } }).then()
    ).rejects.toThrow(/Row rule denied update/);
    await expect(client("alice").task.delete({ where: { id: "t1" } }).then()).rejects.toThrow(/not allowed to delete/);
    await client("alice", WORKSPACE_ROLE_LEVELS.MODERATOR).task.delete({ where: { id: "t1" } });
    expect(await client().task.findUnique({ where: { id: "t1" } })).toBeNull();
  });

  test("a write is lazy: nothing is sent until it is awaited or batched", async () => {
    const db = client();
    db.task.create({ data: { id: "never", title: "Never sent" } });
    expect(await db.task.findUnique({ where: { id: "never" } })).toBeNull();
  });
});

describe("live reads", () => {
  class FakeSocket {
    sent: Array<Record<string, unknown>> = [];
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() {}
    push(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }

  async function live() {
    const socket = new FakeSocket();
    const db = createClient(
      { schema: appSchema, url: "http://engine.test", workspace: WORKSPACE, getToken: async () => "token" },
      { fetch: engine("alice", WORKSPACE_ROLE_LEVELS.EDITOR), outbox: new MemoryOutbox(), createWebSocket: () => socket }
    );
    return { db, socket };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("subscribe sends the compiled query and projects results", async () => {
    const { db, socket } = await live();
    const states: unknown[] = [];
    const query = db.task.findMany({ where: { done: false }, orderBy: { title: "asc" }, take: 10 });
    query.subscribe((state) => states.push(state));
    await tick();
    socket.onopen?.({});
    socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1 });
    await tick();

    const subscribe = socket.sent.find((message) => message.type === "query:subscribe")!;
    expect(subscribe.query).toEqual({ task: { $: { where: { done: false }, order: { title: "asc" }, limit: 10 } } });

    socket.push({ type: "query:data", id: subscribe.id, seq: 1, data: { task: [{ id: "a", title: "A" }] }, pageInfo: {} });
    expect(states.at(0)).toMatchObject({ data: undefined, isLoading: true });
    expect(states.at(-1)).toMatchObject({ data: [{ id: "a", title: "A" }], isLoading: false });

    // Stable while nothing changes, which is what useSyncExternalStore needs.
    const again = db.task.findMany({ where: { done: false }, orderBy: { title: "asc" }, take: 10 });
    expect(again.snapshot()).toBe(query.snapshot());
  });

  test("a live count reads pageInfo", async () => {
    const { db, socket } = await live();
    const counts: Array<number | undefined> = [];
    db.task.count({ where: { done: false } }).subscribe((state) => counts.push(state.data));
    await tick();
    socket.onopen?.({});
    socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1 });
    await tick();
    const subscribe = socket.sent.find((message) => message.type === "query:subscribe")!;
    expect(subscribe.query).toEqual({ task: { $: { count: true, limit: 0, where: { done: false } } } });

    socket.push({ type: "query:data", id: subscribe.id, seq: 1, data: { task: [] }, pageInfo: { task: { limit: 0, returned: 0, hasMore: true, count: 4 } } });
    socket.push({ type: "query:diff", id: subscribe.id, seq: 2, namespace: "task", added: [], updated: [], removed: [], pageInfo: { task: { limit: 0, returned: 0, hasMore: true, count: 5 } } });
    expect(counts.slice(-2)).toEqual([4, 5]);
  });
});
