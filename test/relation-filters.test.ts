/**
 * Filtering on a linked model.
 *
 * These compile to correlated subqueries over rows the caller never receives,
 * which is exactly why the linked model's read rule has to go into the
 * subquery: without it, `where: { board: { secret: true } }` answers a
 * question about rows the caller is not allowed to see.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim, type WorkspaceRole } from "../src/claims";
import { MemoryOutbox } from "../src/client/outbox";
import { configureMigrations } from "../src/engine/migrations-bundle";
import { buildSelectSql, compileQuery } from "../src/engine/query-compile";
import { executeQueryWithPageInfo } from "../src/engine/query-execute";
import { STAGE_DEPTH } from "../src/engine/query-stages";
import { configureRegistry } from "../src/engine/registry";
import { configurePermissions, type PermissionOverrides } from "../src/engine/tx-permissions";
import type { SqlExecutor, SqlRow, SqlValue } from "../src/engine/tx-sql";
import { runTransaction } from "../src/engine/tx-pipeline";
import { TxError } from "../src/engine/tx-types";
import { createClient } from "../src/model/client";
import { filter, model, schema, t } from "../src/schema";

const WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";

const models = {
  board: model({
    name: t.string(),
    ownerId: t.string().index(),
    archived: t.boolean().default(false),
    columns: t.hasMany("column"),
  }),
  column: model({
    name: t.string(),
    position: t.number().default(0),
    board: t.belongsTo("board", { onDelete: "cascade" }),
    tasks: t.hasMany("task"),
  }),
  task: model({
    title: t.string(),
    done: t.boolean().default(false),
    column: t.belongsTo("column").optional(),
  }),
};

let sql: SqlExecutor;
let appSchema: ReturnType<typeof schema>;

function build(permissions: PermissionOverrides = {}) {
  appSchema = schema(models);
  configureRegistry(appSchema.registry);
  configureMigrations(appSchema.migrations);
  configurePermissions({ overrides: { ...appSchema.permissions.overrides, ...permissions } });

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
}

function claimFor(sub: string, role: WorkspaceRole = WORKSPACE_ROLE_LEVELS.EDITOR): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return { sub, workspaceId: WORKSPACE, role, exp: now + 600, iat: now };
}

function client(sub = "alice", role: WorkspaceRole = WORKSPACE_ROLE_LEVELS.EDITOR) {
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

async function seed() {
  const db = client("alice", WORKSPACE_ROLE_LEVELS.OWNER);
  await db.$transaction([
    db.board.create({ data: { id: "b-open", name: "Open", ownerId: "alice" } }),
    db.board.create({ data: { id: "b-secret", name: "Secret", ownerId: "mallory", archived: true } }),
  ]);
  await db.$transaction([
    db.column.create({ data: { id: "c-todo", name: "Todo", position: 1, board: { connect: "b-open" } } }),
    db.column.create({ data: { id: "c-done", name: "Done", position: 2, board: { connect: "b-open" } } }),
    db.column.create({ data: { id: "c-hidden", name: "Hidden", position: 3, board: { connect: "b-secret" } } }),
  ]);
  await db.$transaction([
    db.task.create({ data: { id: "t1", title: "one", done: false, column: { connect: "c-todo" } } }),
    db.task.create({ data: { id: "t2", title: "two", done: true, column: { connect: "c-todo" } } }),
    db.task.create({ data: { id: "t3", title: "three", done: true, column: { connect: "c-done" } } }),
    db.task.create({ data: { id: "t4", title: "four", done: false, column: { connect: "c-hidden" } } }),
  ]);
}

beforeEach(() => build());

describe("to-one links", () => {
  test("filter by the row they point at", async () => {
    await seed();
    const db = client();
    const names = async (where: object) =>
      (await db.column.findMany({ where: where as never, orderBy: { name: "asc" } })).map((row) => row.name);

    expect(await names({ board: { name: "Open" } })).toEqual(["Done", "Todo"]);
    expect(await names({ board: { archived: true } })).toEqual(["Hidden"]);
    // ANDs with the row's own fields.
    expect(await names({ board: { name: "Open" }, position: { gt: 1 } })).toEqual(["Done"]);
  });

  test("null matches rows with no parent, and a missing parent never matches", async () => {
    await seed();
    const db = client();
    await db.task.create({ data: { id: "loose", title: "loose" } });

    expect((await db.task.findMany({ where: { column: null } })).map((row) => row.id)).toEqual(["loose"]);
    expect((await db.task.findMany({ where: { column: { name: "Todo" } }, orderBy: { id: "asc" } })).map((row) => row.id)).toEqual([
      "t1",
      "t2",
    ]);
  });

  test("two hops reach the grandparent", async () => {
    await seed();
    const db = client();
    const ids = (await db.task.findMany({
      where: { column: { board: { name: "Open" } } } as never,
      orderBy: { id: "asc" },
    })).map((row) => row.id);
    expect(ids).toEqual(["t1", "t2", "t3"]);
  });
});

describe("to-many links", () => {
  test("some, every and none", async () => {
    await seed();
    const db = client();
    const names = async (where: object) =>
      (await db.column.findMany({ where: where as never, orderBy: { name: "asc" } })).map((row) => row.name);

    expect(await names({ tasks: { some: { done: false } } })).toEqual(["Hidden", "Todo"]);
    expect(await names({ tasks: { every: { done: true } } })).toEqual(["Done"]);
    expect(await names({ tasks: { none: { done: false } } })).toEqual(["Done"]);
  });

  test("every and none are true for a row with no children", async () => {
    await seed();
    const db = client();
    await db.column.create({ data: { id: "c-empty", name: "Empty", board: { connect: "b-open" } } });

    const every = await db.column.findMany({ where: { tasks: { every: { done: true } } } as never, orderBy: { name: "asc" } });
    expect(every.map((row) => row.name)).toEqual(["Done", "Empty"]);
    const none = await db.column.findMany({ where: { tasks: { none: {} } } as never });
    expect(none.map((row) => row.name)).toEqual(["Empty"]);
  });

  test("combine with the row's own filters and with OR", async () => {
    await seed();
    const db = client();
    const names = (
      await db.column.findMany({
        where: { OR: [{ tasks: { some: { title: "three" } } }, { name: "Hidden" }] } as never,
        orderBy: { name: "asc" },
      })
    ).map((row) => row.name);
    expect(names).toEqual(["Done", "Hidden"]);
  });
});

describe("access", () => {
  test("a read rule on the linked model filters the subquery too", async () => {
    build({ board: { view: { where: ({ sub }) => ({ ownerId: sub }) } } });
    await seed();

    // alice owns only b-open, so the secret board's column must not match
    // "its board is archived" — the rule applies inside the subquery.
    const alice = client("alice");
    expect((await alice.column.findMany({ where: { board: { archived: true } } as never })).map((row) => row.id)).toEqual([]);
    expect(
      (await alice.column.findMany({ where: { board: { name: "Open" } } as never, orderBy: { name: "asc" } })).map((row) => row.id)
    ).toEqual(["c-done", "c-todo"]);

    // The owner of the secret board sees the opposite.
    const mallory = client("mallory");
    expect((await mallory.column.findMany({ where: { board: { archived: true } } as never })).map((row) => row.id)).toEqual([
      "c-hidden",
    ]);
  });

  test("a function read rule on the linked model is refused, not ignored", async () => {
    build({ board: { view: ({ auth, data }) => data?.ownerId === auth.sub } });
    await seed();

    // A function rule runs after fetch, so it cannot filter a subquery; a
    // filter compiled without it would answer questions about hidden rows.
    await expect(
      client().column.findMany({ where: { board: { archived: true } } as never }).then()
    ).rejects.toThrow(/read rule is a function/);
    // The same model is still filterable on its own fields.
    expect((await client().column.findMany({ where: { position: 1 } })).map((row) => row.id)).toEqual(["c-todo"]);
  });

  test("a role that cannot read the linked model cannot filter through it", async () => {
    build({ board: { view: WORKSPACE_ROLE_LEVELS.ADMIN } });
    await seed();
    await expect(
      client("alice", WORKSPACE_ROLE_LEVELS.EDITOR)
        .column.findMany({ where: { board: { name: "Open" } } as never })
        .then()
    ).rejects.toThrow(/not allowed to view/);
  });
});

describe("refusals", () => {
  test("wrong mode for the link's multiplicity, unknown relation", async () => {
    await seed();
    const db = client();
    expect(() => db.column.findMany({ where: { board: { some: { name: "x" } } } as never })).toThrow(
      /to-one link/
    );
    expect(() => db.board.findMany({ where: { columns: { name: "x" } } as never })).toThrow(
      /some, every or none/
    );
    expect(() => db.board.findMany({ where: { nope: { some: {} } } as never })).toThrow(/no filterable field/);
  });
});

describe("depth", () => {
  test("relation filters and includes nest past two links", async () => {
    await seed();
    const db = client();

    // Three hops: tasks whose column's board has a column named "Done".
    const tasks = await db.task.findMany({
      where: { column: { board: { columns: { some: { name: "Done" } } } } } as never,
      orderBy: { id: "asc" },
    });
    expect(tasks.map((task) => task.id)).toEqual(["t1", "t2", "t3"]);

    // Four hops of include, back round to the board.
    const boards = await db.board.findMany({
      where: { id: "b-open" },
      select: {
        name: true,
        columns: {
          orderBy: { position: "asc" },
          select: { tasks: { orderBy: { id: "asc" }, select: { column: { select: { board: { select: { name: true } } } } } } },
        },
      },
    });
    expect(boards[0].columns[0].tasks.map((task) => (task as { column: { board: { name: string } } }).column.board.name)).toEqual(["Open", "Open"]);
  });

  test("a filter of any depth runs, staged past a few hops", async () => {
    await seed();
    // Alternates column -> tasks -> column ..., 41 hops, ending on column.
    // Each round trip lands back on the same column, so the answer is the
    // one-hop "columns with a task titled one".
    let where: Record<string, unknown> = { title: "one" };
    for (let hop = 0; hop < 41; hop += 1) {
      where = hop % 2 === 0 ? { tasks: { some: where } } : { column: where };
    }
    const deep = await client().column.findMany({ where: where as never, orderBy: { id: "asc" } });
    expect(deep.map((row) => row.id)).toEqual(["c-todo"]);
  });

  test("staged filters agree with a direct evaluation, every mode at every depth", async () => {
    await seed();
    const db = client("alice", WORKSPACE_ROLE_LEVELS.OWNER);
    await db.task.create({ data: { id: "loose", title: "one", done: true } });
    await db.column.create({ data: { id: "c-empty", name: "Empty", position: 4, board: { connect: "b-secret" } } });

    type Row = Record<string, unknown>;
    const rows = {
      board: sql.all("SELECT * FROM board") as Row[],
      column: sql.all("SELECT * FROM column") as Row[],
      task: sql.all("SELECT * FROM task") as Row[],
    };
    type Model = keyof typeof rows;
    const scalar: Record<Model, Array<[string, unknown[]]>> = {
      board: [["name", ["Open", "Secret"]], ["archived", [true, false]]],
      column: [["name", ["Todo", "Done", "Hidden", "Empty"]]],
      task: [["title", ["one", "two", "three", "four"]], ["done", [true, false]]],
    };
    const parent: Record<Model, Array<[string, Model, string]>> = {
      board: [], column: [["board", "board", "board_id"]], task: [["column", "column", "column_id"]],
    };
    const children: Record<Model, Array<[string, Model, string]>> = {
      board: [["columns", "column", "board_id"]], column: [["tasks", "task", "column_id"]], task: [],
    };

    let seedValue = 7;
    const random = (n: number) => {
      seedValue = (seedValue * 1103515245 + 12345) % 2147483648;
      return seedValue % n;
    };

    type Filter = Record<string, unknown>;
    const make = (model: Model, depth: number): Filter => {
      const choices = random(depth <= 0 ? 2 : 7);
      if (choices <= 1 || (parent[model].length === 0 && children[model].length === 0)) {
        const [field, values] = scalar[model][random(scalar[model].length)];
        return { [field]: values[random(values.length)] };
      }
      if (choices === 2) return { OR: [make(model, depth - 1), make(model, depth - 1)] };
      if (choices === 3) return { NOT: make(model, depth - 1) };
      const links = [...parent[model].map((link) => ["parent", ...link]), ...children[model].map((link) => ["child", ...link])] as Array<[string, string, Model, string]>;
      const [kind, label, target] = links[random(links.length)];
      if (kind === "parent") return { [label]: make(target, depth - 1) };
      const mode = ["some", "every", "none"][random(3)];
      return { [label]: { [mode]: make(target, depth - 1) } };
    };

    const matches = (model: Model, row: Row, filter: Filter): boolean =>
      Object.entries(filter).every(([key, value]) => {
        if (key === "OR") return (value as Filter[]).some((branch) => matches(model, row, branch));
        if (key === "NOT") return !matches(model, row, value as Filter);
        const up = parent[model].find(([label]) => label === key);
        if (up) {
          const target = rows[up[1]].find((candidate) => candidate.id === row[up[2]]);
          return target !== undefined && matches(up[1], target, value as Filter);
        }
        const down = children[model].find(([label]) => label === key);
        if (down) {
          const kids = rows[down[1]].filter((candidate) => candidate[down[2]] === row.id);
          const [mode, inner] = Object.entries(value as Filter)[0];
          const hits = kids.map((kid) => matches(down[1], kid, inner as Filter));
          return mode === "some" ? hits.some(Boolean) : mode === "every" ? hits.every(Boolean) : !hits.some(Boolean);
        }
        const stored = row[key];
        return typeof value === "boolean" ? Boolean(stored) === value : stored === value;
      });

    let deepest = 0;
    for (let round = 0; round < 150; round += 1) {
      const model = (["board", "column", "task"] as Model[])[round % 3];
      const filter = make(model, 9);
      deepest = Math.max(deepest, JSON.stringify(filter).split("{").length);
      const expected = rows[model].filter((row) => matches(model, row, filter)).map((row) => row.id as string).sort();
      const got = (await (db[model] as { findMany(args: object): Promise<Array<{ id: string }>> }).findMany({ where: filter }))
        .map((row) => row.id)
        .sort();
      expect({ filter, ids: got }).toEqual({ filter, ids: expected });
    }
    expect(deepest).toBeGreaterThan(8);
  });

  test("a filter too long for one statement is staged, not refused", async () => {
    await seed();
    const titles = Array.from({ length: 4000 }, (_, index) => `missing-${index}`).concat(["two"]);
    const tasks = await client().task.findMany({ where: { OR: titles.map((title) => ({ title })) } as never });
    expect(tasks.map((task) => task.id)).toEqual(["t2"]);
    const none = await client().task.findMany({ where: { AND: titles.map((title) => ({ NOT: { title } })) } as never, orderBy: { id: "asc" } });
    expect(none.map((task) => task.id)).toEqual(["t1", "t3", "t4"]);
  });

  test("every statement it runs stays shallow and short, however deep or wide the filter", () => {
    let deep: Record<string, unknown> = { title: "one" };
    for (let hop = 0; hop < 41; hop += 1) {
      deep = hop % 2 === 0 ? { $link: [{ label: "tasks", mode: "some", where: deep }] } : { $link: [{ label: "column", mode: "parent", where: deep }] };
    }
    const wide = { $or: Array.from({ length: 4000 }, (_, index) => ({ title: `missing-${index}` })) };
    for (const [namespace, where] of [["column", deep], ["task", wide]] as const) {
      const node = compileQuery({ [namespace]: { $: { where } } }).nodes[0];
      const statement = buildSelectSql(node);
      const all = [statement.sql, ...(statement.stages ?? []).map((stage) => stage.sql)];
      for (const text of all) {
        // Nesting: a subquery inside a subquery is what SQLite's depth counts.
        let open = 0;
        let deepest = 0;
        const stack: boolean[] = [];
        for (let index = 0; index < text.length; index += 1) {
          if (text[index] === "(") {
            const isSelect = text.startsWith("(SELECT", index);
            stack.push(isSelect);
            if (isSelect) deepest = Math.max(deepest, ++open);
          } else if (text[index] === ")" && stack.pop()) {
            open -= 1;
          }
        }
        expect(deepest).toBeLessThanOrEqual(STAGE_DEPTH + 1);
        expect(text.length).toBeLessThan(40_000);
      }
      expect((statement.stages ?? []).length).toBeGreaterThan(0);
    }
  });
});
