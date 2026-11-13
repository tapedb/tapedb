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
import { executeQueryWithPageInfo } from "../src/engine/query-execute";
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
  test("wrong mode for the link's multiplicity, unknown relation, too deep", async () => {
    await seed();
    const db = client();
    expect(() => db.column.findMany({ where: { board: { some: { name: "x" } } } as never })).toThrow(
      /to-one link/
    );
    expect(() => db.board.findMany({ where: { columns: { name: "x" } } as never })).toThrow(
      /some, every or none/
    );
    expect(() => db.board.findMany({ where: { nope: { some: {} } } as never })).toThrow(/no filterable field/);
    await expect(
      db.task.findMany({ where: { column: { board: { columns: { some: { name: "x" } } } } } as never }).then()
    ).rejects.toThrow(/nest at most/);
  });
});
