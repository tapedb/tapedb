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
    points: t.number().optional(),
    column: t.belongsTo("column").optional(),
  }).access({ delete: role("moderator") }),
  note: model({
    body: t.string(),
    author: t.string(),
  }).access({ read: check(({ auth, row }) => row?.author === auth.sub) }),
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
    expect(appSchema.migrations.at(-1)!.sql).toContain('REFERENCES "board"("id") ON DELETE CASCADE');
  });

  test("maps a model onto an existing table", () => {
    const mapped = schema({
      boards: model({ name: t.string(), columns: t.hasMany("columns") }, { table: "kanban_boards" }),
      columns: model({ board: t.belongsTo("boards") }, { table: "kanban_columns" }),
    });
    expect(mapped.migrations.at(-1)!.sql).toContain('CREATE TABLE IF NOT EXISTS "kanban_boards"');
    expect(mapped.migrations.at(-1)!.sql).toContain('REFERENCES "kanban_boards"("id")');
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

  test("unknown fields fail before the request; relation filters compile", () => {
    const db = client();
    expect(() => db.task.findMany({ where: { nope: 1 } as never })).toThrow(/no filterable field "nope"/);
    expect(
      db.task.findMany({ where: { column: { name: "x" } } as never }).document
    ).toEqual({ task: { $: { where: { $link: [{ label: "column", mode: "parent", where: { name: "x" } }] } } } });
    expect(() => db.task.findMany({ where: { title: { like: "x" } } as never })).toThrow(/Unknown filter "like"/);
    expect(() => db.task.findMany({ include: { nope: true } as never })).toThrow(/no relation "nope"/);
  });
});

describe("select", () => {
  const claimFor = (sub: string): RoleClaim => {
    const now = Math.floor(Date.now() / 1000);
    return { sub, workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.EDITOR, exp: now + 600, iat: now };
  };

  test("the engine sends only the selected fields, plus the id", async () => {
    await seed();
    const { data } = executeQueryWithPageInfo(sql, claimFor("alice"), {
      query: { task: { $: { select: ["title"], where: { id: "t1" } } } },
    });
    expect(data.task).toEqual([{ id: "t1", title: "Write spec" }]);

    expect(() =>
      executeQueryWithPageInfo(sql, claimFor("alice"), { query: { task: { $: { select: ["nope"] } } } })
    ).toThrow(/Unknown attribute "nope"/);
  });

  test("the client returns exactly the selected fields, at every level", async () => {
    const db = client();
    const ids = await seed(db);

    expect(await db.task.findUnique({ where: { id: "t2" }, select: { title: true, due: true } })).toEqual({
      title: "Build it",
      due: Date.parse("2026-12-01T00:00:00Z"),
    });

    // Forward link: the child's key is read to group it, never returned.
    const columns = await db.column.findMany({
      where: { boardId: ids.board },
      orderBy: { position: "asc" },
      select: { name: true, tasks: { select: { title: true } } },
    });
    expect(columns).toEqual([
      { name: "Todo", tasks: [{ title: "Write spec" }] },
      { name: "Doing", tasks: [{ title: "Build it" }] },
    ]);

    // Reverse link: this row's key is read to find the parent, never returned.
    const tasks = await db.task.findMany({
      where: { id: "t1" },
      select: { title: true, column: { select: { name: true, board: { select: { name: true } } } } },
    });
    expect(tasks).toEqual([{ title: "Write spec", column: { name: "Todo", board: { name: "Roadmap" } } }]);

    // A relation can carry a select inside a plain include, too.
    const withColumn = await db.task.findMany({ where: { id: "t2" }, include: { column: { select: { name: true } } } });
    expect(withColumn[0].column).toEqual({ name: "Doing" });
    expect(withColumn[0].title).toBe("Build it");
  });

  test("findPage pages by a field it does not select", async () => {
    const db = client();
    for (let n = 0; n < 5; n += 1) await db.task.create({ data: { title: `task ${n}`, done: n % 2 === 0 } });

    const seen: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page = await db.task.findPage({
        take: 2,
        after: cursor,
        orderBy: [{ title: "desc" }],
        select: { done: true },
      });
      seen.push(...page.rows);
      cursor = page.cursor;
    } while (cursor !== null);
    expect(seen).toEqual([{ done: true }, { done: false }, { done: true }, { done: false }, { done: true }]);
  });

  test("a function read rule still sees the whole row", async () => {
    await client("alice").note.create({ data: { body: "mine", author: "alice" } });
    await client("bob").note.create({ data: { body: "theirs", author: "bob" } });

    // The rule reads `author`, which the select leaves out.
    expect(await client("alice").note.findMany({ select: { body: true } })).toEqual([{ body: "mine" }]);
    expect(await client("alice").note.count()).toBe(1);
  });

  test("select and include together, or an unknown field, fail before the request", () => {
    const db = client();
    expect(() => db.task.findMany({ select: { title: true }, include: { column: true } } as never)).toThrow(
      /select or include, not both/
    );
    expect(() => db.task.findMany({ select: { nope: true } } as never)).toThrow(/no field "nope" to select/);
    expect(db.task.findMany({ select: { title: true, column: true } }).document).toEqual({
      task: { $: { select: ["title"] }, column: { $: {} } },
    });
  });
});

describe("aggregates", () => {
  async function seedPoints(db = client()) {
    const ids = await seed(db);
    await db.$transaction([
      db.task.update({ where: { id: "t1" }, data: { points: 3 } }),
      db.task.update({ where: { id: "t2" }, data: { points: 5, done: true } }),
      db.task.create({ data: { id: "t4", title: "Also todo", points: 1, column: { connect: ids.todo } } }),
    ]);
    return ids;
  }

  test("aggregate returns the measures asked for", async () => {
    const db = client();
    await seedPoints(db);

    expect(
      await db.task.aggregate({
        _count: true,
        _sum: { points: true },
        _avg: { points: true },
        _min: { points: true, title: true, due: true },
        _max: { points: true },
      })
    ).toEqual({
      _count: 4,
      _sum: { points: 9 },
      _avg: { points: 3 },
      _min: { points: 1, title: "Also todo", due: Date.parse("2026-12-01T00:00:00Z") },
      _max: { points: 5 },
    });

    // Counting a field counts its non-null values; no match sums to null.
    expect(await db.task.aggregate({ _count: { _all: true, points: true, due: true } })).toEqual({
      _count: { _all: 4, points: 3, due: 1 },
    });
    expect(await db.task.aggregate({ where: { title: "none" }, _count: true, _sum: { points: true } })).toEqual({
      _count: 0,
      _sum: { points: null },
    });
  });

  test("groupBy returns one row per key, ordered and limited", async () => {
    const db = client();
    const ids = await seedPoints(db);

    const byColumn = await db.task.groupBy({ by: ["columnId"], _count: true, _sum: { points: true } });
    expect(byColumn).toEqual([
      { columnId: null, _count: 1, _sum: { points: null } },
      ...[
        { columnId: ids.todo, _count: 2, _sum: { points: 4 } },
        { columnId: ids.doing, _count: 1, _sum: { points: 5 } },
      ].sort((a, b) => (a.columnId < b.columnId ? -1 : 1)),
    ]);

    const byDone = await db.task.groupBy({ by: ["done"], _count: true, orderBy: { done: "desc" }, take: 1 });
    expect(byDone).toEqual([{ done: true, _count: 1 }]);

    // Filters, relation filters included, narrow the rows first.
    expect(
      await db.task.groupBy({ by: ["done"], where: { column: { name: "Todo" } }, _avg: { points: true } })
    ).toEqual([{ done: false, _avg: { points: 2 } }]);
  });

  test("a where read rule scopes aggregates in SQL", async () => {
    await client("alice").board.create({ data: { name: "A1", ownerId: "alice" } });
    await client("alice").board.create({ data: { name: "A2", ownerId: "alice" } });
    await client("bob").board.create({ data: { name: "B1", ownerId: "bob" } });

    expect(await client("alice").board.aggregate({ _count: true, _min: { name: true } })).toEqual({
      _count: 2,
      _min: { name: "A1" },
    });
    expect(await client("bob").board.groupBy({ by: ["ownerId"], _count: true })).toEqual([
      { ownerId: "bob", _count: 1 },
    ]);
  });

  test("a function read rule is applied row by row, past one chunk", async () => {
    const writes = [];
    for (let n = 0; n < 450; n += 1) {
      writes.push(client(n % 3 === 0 ? "alice" : "bob").note.create({ data: { body: `n${n}`, author: n % 3 === 0 ? "alice" : "bob" } }));
    }
    for (const write of writes) await write;

    expect(await client("alice").note.aggregate({ _count: true, _max: { body: true } })).toEqual({
      _count: 150,
      _max: { body: "n99" },
    });
    expect(await client("alice").note.groupBy({ by: ["author"], _count: true })).toEqual([
      { author: "alice", _count: 150 },
    ]);
  });

  test("bad measures fail before the request; the engine refuses them too", async () => {
    const db = client();
    expect(() => db.task.aggregate({ _sum: { title: true } } as never)).toThrow(/cannot measure "title"/);
    expect(() => db.task.groupBy({ by: ["meta"], _count: true } as never)).toThrow(/cannot be grouped by "meta"/);
    expect(() => db.task.groupBy({ by: ["done"], orderBy: { title: "asc" } } as never)).toThrow(/only order by a "by" field/);

    const now = Math.floor(Date.now() / 1000);
    const claim: RoleClaim = { sub: "alice", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.EDITOR, exp: now + 600, iat: now };
    const run = (options: object) => () => executeQueryWithPageInfo(sql, claim, { query: { task: { $: options } } });
    expect(run({ aggregate: { sum: ["title"] } })).toThrow(/Cannot sum "title"/);
    expect(run({ aggregate: { count: true, limit: 5 } })).toThrow(/needs a groupBy/);
    expect(run({ aggregate: { count: true }, order: { title: "asc" } })).toThrow(/cannot be combined with "order"/);
    expect(run({ aggregate: {} })).toThrow(/needs count/);
    expect(() =>
      executeQueryWithPageInfo(sql, claim, { query: { column: { tasks: { $: { aggregate: { count: true } } } } } })
    ).toThrow(/only available on a top-level namespace/);
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

  test("a live select stays narrow through optimistic writes", async () => {
    const { db, socket } = await live();
    await db.task.create({ data: { id: "a", title: "A" } });
    const states: Array<{ data: unknown }> = [];
    db.task.findMany({ select: { title: true } }).subscribe((state) => states.push(state));
    await tick();
    socket.onopen?.({});
    socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1 });
    await tick();
    const subscribe = socket.sent.find((message) => message.type === "query:subscribe")!;
    expect(subscribe.query).toEqual({ task: { $: { select: ["title"] } } });

    socket.push({ type: "query:data", id: subscribe.id, seq: 1, data: { task: [{ id: "a", title: "A", updatedSeq: 1 }] }, pageInfo: {} });
    expect(states.at(-1)?.data).toEqual([{ title: "A" }]);

    // The optimistic patch writes `done` into the cached row; the result
    // keeps the shape the select promised.
    void db.task.update({ where: { id: "a" }, data: { title: "B", done: true } }).catch(() => {});
    for (let n = 0; n < 20 && JSON.stringify(states.at(-1)?.data) !== '[{"title":"B"}]'; n += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(states.at(-1)?.data).toEqual([{ title: "B" }]);
  });

  test("a live aggregate reads its groups from pageInfo", async () => {
    const { db, socket } = await live();
    const seen: unknown[] = [];
    db.task.groupBy({ by: ["done"], _count: true }).subscribe((state) => seen.push(state.data));
    await tick();
    socket.onopen?.({});
    socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1 });
    await tick();
    const subscribe = socket.sent.find((message) => message.type === "query:subscribe")!;
    expect(subscribe.query).toEqual({ task: { $: { limit: 0, aggregate: { count: true, groupBy: ["done"] } } } });

    const info = (groups: unknown[]) => ({ task: { limit: 0, returned: 0, hasMore: false, aggregate: groups } });
    socket.push({ type: "query:data", id: subscribe.id, seq: 1, data: { task: [] }, pageInfo: info([{ key: { done: false }, count: 2 }]) });
    socket.push({ type: "query:diff", id: subscribe.id, seq: 2, namespace: "task", added: [], updated: [], removed: [], pageInfo: info([{ key: { done: false }, count: 2 }, { key: { done: true }, count: 1 }]) });
    expect(seen.slice(-2)).toEqual([
      [{ done: false, _count: 2 }],
      [{ done: false, _count: 2 }, { done: true, _count: 1 }],
    ]);
  });

  test("a live diff keeps rows in the query's order", async () => {
    const { db, socket } = await live();
    const seen: unknown[] = [];
    db.task.findMany({ orderBy: { title: "asc" }, select: { title: true } }).subscribe((state) => seen.push(state.data));
    await tick();
    socket.onopen?.({});
    socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1 });
    await tick();
    const subscribe = socket.sent.find((message) => message.type === "query:subscribe")!;
    socket.push({ type: "query:data", id: subscribe.id, seq: 1, data: { task: [{ id: "b", title: "B" }, { id: "c", title: "C" }] }, pageInfo: {} });

    // "A" sorts first; the engine sends the order along with the new row.
    socket.push({ type: "query:diff", id: subscribe.id, seq: 2, namespace: "task", added: [{ id: "a", title: "A" }], updated: [], removed: [], order: ["a", "b", "c"] });
    expect(seen.at(-1)).toEqual([{ title: "A" }, { title: "B" }, { title: "C" }]);

    // A renamed row moves.
    socket.push({ type: "query:diff", id: subscribe.id, seq: 3, namespace: "task", added: [], updated: [{ id: "a", title: "D" }], removed: [], order: ["b", "c", "a"] });
    expect(seen.at(-1)).toEqual([{ title: "B" }, { title: "C" }, { title: "D" }]);
  });

  test("broadcast topics join, rejoin, deliver and leave on the workspace socket", async () => {
    const { db, socket } = await live();
    const topic = db.$broadcast<{ x: number }>("board:1");
    // Not open yet: the message is dropped, not delivered late.
    expect(topic.send({ x: 0 })).toBe(false);

    const heard: unknown[] = [];
    const errors: unknown[] = [];
    const stop = topic.subscribe((message, from) => heard.push([message, from]), { onError: (error) => errors.push(error) });
    const second = topic.subscribe(() => {});
    await tick();
    socket.onopen?.({});
    socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1 });
    await tick();
    expect(socket.sent.filter((message) => message.type === "topic:join")).toEqual([{ type: "topic:join", topic: "board:1" }]);

    expect(topic.send({ x: 1 })).toBe(true);
    expect(socket.sent.at(-1)).toEqual({ type: "topic:send", topic: "board:1", message: { x: 1 } });

    socket.push({ type: "topic:message", topic: "board:1", message: { x: 2 }, from: { clientId: "c2", sub: "bob" } });
    expect(heard).toEqual([[{ x: 2 }, { clientId: "c2", userId: "bob" }]]);
    socket.push({ type: "topic:error", topic: "board:1", code: "permission_denied", message: "no" });
    expect(errors).toEqual([{ code: "permission_denied", message: "no" }]);

    // A reconnect rejoins.
    socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1 });
    expect(socket.sent.filter((message) => message.type === "topic:join")).toHaveLength(2);

    // The socket leaves with the last listener, not before.
    stop();
    expect(socket.sent.some((message) => message.type === "topic:leave")).toBe(false);
    second();
    expect(socket.sent.at(-1)).toEqual({ type: "topic:leave", topic: "board:1" });
    socket.push({ type: "topic:message", topic: "board:1", message: { x: 3 }, from: { clientId: "c2", sub: "bob" } });
    expect(heard).toHaveLength(1);

    expect(() => db.$broadcast("no spaces")).toThrow(/not a topic name/);
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

describe("storage without getToken", () => {
  test("uploads through the dev claim route, as `tapedb dev` serves it", async () => {
    // Reads and writes already worked with no getToken; uploads asked for one
    // and threw, so files were the one feature `tapedb dev` could not run.
    const realFetch = globalThis.fetch;
    const claims: string[] = [];
    const authorizations: Array<string | null> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/_tapedb/claim")) {
        claims.push(url);
        return Response.json({ token: "dev-token" });
      }
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ id: "f1", key: "k", size: 3, etag: "e", contentType: "text/plain" }, { status: 201 });
    }) as typeof fetch;

    try {
      const db = createClient(
        { schema: appSchema, url: "http://engine.test", workspace: WORKSPACE },
        { outbox: new MemoryOutbox(), createWebSocket: () => { throw new Error("no socket"); } }
      );
      const uploaded = await db.$files.upload(new Blob(["abc"], { type: "text/plain" }), { path: "a/b.txt" });
      expect(uploaded).toMatchObject({ id: "f1" });
      expect(claims).toHaveLength(1);
      expect(authorizations).toEqual(["Bearer dev-token"]);
      db.$close();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("nested create", () => {
  test("nests as deep as the data does", () => {
    const tree = schema({
      node: model({
        label: t.string(),
        parent: t.belongsTo("node").optional(),
        children: t.hasMany("node", { inverse: "parent" }),
      }),
    });
    const db = createClient(
      { schema: tree, url: "http://engine.test", workspace: WORKSPACE, getToken: async () => "token" },
      { fetch: async () => { throw new Error("not sent"); }, outbox: new MemoryOutbox(), createWebSocket: () => { throw new Error("no socket"); } }
    );
    let data: Record<string, unknown> = { id: "n6", label: "6" };
    for (let level = 5; level >= 1; level -= 1) {
      data = { id: `n${level}`, label: String(level), children: { create: [data] } };
    }
    // Six levels: each child is inserted after the row it points at.
    const write = db.node.create({ data: data as never });
    expect(write.ops.map((op) => [op.op, (op as { id: string }).id, (op as { values?: { parentId?: string } }).values?.parentId])).toEqual([
      ["insert", "n1", undefined],
      ["insert", "n2", "n1"],
      ["insert", "n3", "n2"],
      ["insert", "n4", "n3"],
      ["insert", "n5", "n4"],
      ["insert", "n6", "n5"],
    ]);
  });

  test("creates children with the parent, in one transaction", async () => {
    const db = client();
    const created = await db.board.create({
      data: {
        name: "Nested",
        ownerId: "alice",
        columns: {
          create: [
            { name: "Todo", position: 1, tasks: { create: [{ title: "first" }, { title: "second" }] } },
            { name: "Doing", position: 2 },
          ],
        },
      },
    });

    const board = await db.board.findUnique({
      where: { id: created.id },
      include: { columns: { orderBy: { position: "asc" }, include: { tasks: { orderBy: { title: "asc" } } } } },
    });
    expect(board?.columns.map((column) => column.name)).toEqual(["Todo", "Doing"]);
    expect(board?.columns[0].tasks.map((task) => task.title)).toEqual(["first", "second"]);
    expect(board?.columns[1].tasks).toEqual([]);
    // Defaults still apply to rows created this way.
    expect(board?.columns[0].tasks[0].done).toBe(false);
  });

  test("creates the row a new row points at, before it", async () => {
    const db = client();
    const column = await db.column.create({
      data: { name: "Solo", position: 1, board: { create: { name: "Made for it", ownerId: "alice" } } },
    });

    const row = await db.column.findUnique({ where: { id: column.id }, include: { board: true } });
    expect(row?.board.name).toBe("Made for it");
  });

  test("adds children to a row that already exists", async () => {
    const db = client();
    const board = await db.board.create({ data: { name: "Later", ownerId: "alice" } });
    await db.board.update({ where: { id: board.id }, data: { columns: { create: { name: "Added", position: 9 } } } });

    const row = await db.board.findUnique({ where: { id: board.id }, include: { columns: true } });
    expect(row?.columns.map((column) => column.name)).toEqual(["Added"]);
  });

  test("one failure rolls the whole tree back", async () => {
    const db = client();
    await expect(
      db.board
        .create({
          data: {
            id: "rollback",
            name: "Doomed",
            ownerId: "alice",
            columns: { create: [{ id: "dup", name: "One", position: 1 }, { id: "dup", name: "Two", position: 2 }] },
          },
        })
        .then()
    ).rejects.toThrow(/already exists/);
    expect(await db.board.findUnique({ where: { id: "rollback" } })).toBeNull();
    expect(await db.column.findUnique({ where: { id: "dup" } })).toBeNull();
  });

  test("upsert cannot create related rows", () => {
    const db = client();
    expect(() =>
      db.task.upsert({
        where: { id: "x" },
        create: { title: "a", column: { create: { name: "no", position: 1 } } as never },
        update: { title: "b" },
      })
    ).toThrow(/cannot create related rows/);
  });
});
