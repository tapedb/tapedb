/**
 * Row-level permissions.
 *
 * Role levels answer "what kind of user". Row rules answer "this exact row",
 * which is the only way to express "only the author may edit this".
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim, type WorkspaceRole } from "../src/claims";
import { configureMigrations } from "../src/engine/migrations-bundle";
import { configurePermissions } from "../src/engine/tx-permissions";
import { compileQuery } from "../src/engine/query-compile";
import {
  executeCompiledQuery,
  executeCompiledQueryWithPageInfo,
} from "../src/engine/query-execute";
import { configureRegistry } from "../src/engine/registry";
import type { SqlExecutor, SqlRow, SqlValue } from "../src/engine/tx-sql";
import { runTransaction } from "../src/engine/tx-pipeline";
import { defineSchema } from "../src/schema";

const WORKSPACE_ID = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";

const schema = defineSchema({
  entities: {
    documents: {
      title: { type: "string" },
      ownerId: { type: "string", optional: true },
    },
    notes: {
      body: { type: "string" },
    },
  },
  permissions: {
    documents: {
      // Only the author may edit or remove their document.
      create: ({ auth, next }) => next?.ownerId === auth.sub,
      update: ({ auth, data }) => data !== undefined && data.ownerId === auth.sub,
      delete: ({ auth, data }) =>
        data !== undefined && data.ownerId === auth.sub && auth.role >= WORKSPACE_ROLE_LEVELS.EDITOR,
    },
  },
});

function executor(db: Database): SqlExecutor {
  return {
    exec(sql: string, ...params: SqlValue[]): number {
      return db.query(sql).run(...(params as never[])).changes;
    },
    all<T extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): T[] {
      return db.query(sql).all(...(params as never[])) as T[];
    },
    one<T extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): T | undefined {
      return (db.query(sql).get(...(params as never[])) ?? undefined) as T | undefined;
    },
    transactionSync<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}

function freshDatabase(): SqlExecutor {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of schema.migrations) db.exec(migration.sql);
  return executor(db);
}

function claimFor(sub: string, role: WorkspaceRole = WORKSPACE_ROLE_LEVELS.EDITOR): RoleClaim {
  return {
    sub,
    workspaceId: WORKSPACE_ID,
    role,
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000),
  };
}

beforeEach(() => {
  configureRegistry(schema.registry);
  configureMigrations(schema.migrations);
  configurePermissions(schema.permissions);
});

describe("row rules", () => {
  test("let the author create and edit their own document", () => {
    const sql = freshDatabase();
    const author = claimFor("alice");

    runTransaction(sql, WORKSPACE_ID, author, {
      txId: "t1",
      ops: [
        { op: "update", namespace: "documents", id: "doc-1", values: { title: "Draft", ownerId: "alice" } },
      ],
    });

    runTransaction(sql, WORKSPACE_ID, author, {
      txId: "t2",
      ops: [{ op: "update", namespace: "documents", id: "doc-1", values: { title: "Final" } }],
    });

    const row = sql.one<{ title: string }>(`SELECT "title" FROM "documents" WHERE "id" = ?`, "doc-1");
    expect(row?.title).toBe("Final");
  });

  test("refuse an edit by someone who does not own the row", () => {
    const sql = freshDatabase();
    runTransaction(sql, WORKSPACE_ID, claimFor("alice"), {
      txId: "t1",
      ops: [
        { op: "update", namespace: "documents", id: "doc-1", values: { title: "Draft", ownerId: "alice" } },
      ],
    });

    expect(() =>
      runTransaction(sql, WORKSPACE_ID, claimFor("mallory"), {
        txId: "t2",
        ops: [{ op: "update", namespace: "documents", id: "doc-1", values: { title: "Hijacked" } }],
      })
    ).toThrow(/Row rule denied update/);

    const row = sql.one<{ title: string }>(`SELECT "title" FROM "documents" WHERE "id" = ?`, "doc-1");
    expect(row?.title).toBe("Draft");
  });

  test("refuse a create that claims someone else as the author", () => {
    const sql = freshDatabase();
    expect(() =>
      runTransaction(sql, WORKSPACE_ID, claimFor("mallory"), {
        txId: "t1",
        ops: [
          { op: "update", namespace: "documents", id: "doc-1", values: { title: "Planted", ownerId: "alice" } },
        ],
      })
    ).toThrow(/Row rule denied create/);
  });

  test("see the stored row, not the incoming values, on delete", () => {
    const sql = freshDatabase();
    runTransaction(sql, WORKSPACE_ID, claimFor("alice"), {
      txId: "t1",
      ops: [
        { op: "update", namespace: "documents", id: "doc-1", values: { title: "Draft", ownerId: "alice" } },
      ],
    });

    // Mallory cannot delete by pretending; the rule reads the stored owner.
    expect(() =>
      runTransaction(sql, WORKSPACE_ID, claimFor("mallory"), {
        txId: "t2",
        ops: [{ op: "delete", namespace: "documents", id: "doc-1" }],
      })
    ).toThrow(/Row rule denied delete/);

    runTransaction(sql, WORKSPACE_ID, claimFor("alice"), {
      txId: "t3",
      ops: [{ op: "delete", namespace: "documents", id: "doc-1" }],
    });
    expect(sql.one(`SELECT "id" FROM "documents" WHERE "id" = ?`, "doc-1")).toBeUndefined();
  });

  test("deny when the rule throws, rather than widening access", () => {
    const sql = freshDatabase();
    runTransaction(sql, WORKSPACE_ID, claimFor("alice"), {
      txId: "seed",
      ops: [
        { op: "update", namespace: "documents", id: "doc-1", values: { title: "Draft", ownerId: "alice" } },
      ],
    });
    configurePermissions({
      overrides: {
        documents: {
          update: () => {
            throw new Error("rule bug");
          },
        },
      },
    });

    expect(() =>
      runTransaction(sql, WORKSPACE_ID, claimFor("alice"), {
        txId: "t1",
        ops: [{ op: "update", namespace: "documents", id: "doc-1", values: { title: "x" } }],
      })
    ).toThrow(/Row rule denied/);
  });

  test("leaves namespaces without rules on the role levels", () => {
    const sql = freshDatabase();
    // `notes` has no rule: an editor may create, an ordinary member may not.
    runTransaction(sql, WORKSPACE_ID, claimFor("alice"), {
      txId: "t1",
      ops: [{ op: "update", namespace: "notes", id: "note-1", values: { body: "hello" } }],
    });

    expect(() =>
      runTransaction(sql, WORKSPACE_ID, claimFor("bob", WORKSPACE_ROLE_LEVELS.MEMBER), {
        txId: "t2",
        ops: [{ op: "update", namespace: "notes", id: "note-2", values: { body: "nope" } }],
      })
    ).toThrow(/not allowed to update/);
  });

  test("do not re-judge a replayed transaction", () => {
    const sql = freshDatabase();
    const op = {
      op: "update" as const,
      namespace: "documents",
      id: "doc-1",
      values: { title: "Draft", ownerId: "alice" },
    };

    runTransaction(sql, WORKSPACE_ID, claimFor("alice"), {
      txId: "t1",
      clientTxId: "client-1",
      ops: [op],
    });

    // Ownership changes; the same clientTxId is retried. It must be treated as
    // already applied, not re-authorized and not applied twice.
    sql.exec(`UPDATE "documents" SET "owner_id" = ? WHERE "id" = ?`, "someone-else", "doc-1");

    const replay = runTransaction(sql, WORKSPACE_ID, claimFor("alice"), {
      txId: "t1",
      clientTxId: "client-1",
      ops: [op],
    });

    expect(replay.applied).toBe(0);
    expect(replay.seq).toBe(1);
  });
});

describe("schema validation", () => {
  test("accepts a view rule, now that reads are filtered per row", () => {
    const rule = () => true;
    const built = defineSchema({
      entities: { documents: { title: { type: "string" } } },
      permissions: { documents: { view: rule } },
    });

    expect(built.permissions.overrides?.documents?.view).toBe(rule);
  });

  test("refuses permissions for a namespace that does not exist", () => {
    expect(() =>
      defineSchema({
        entities: { documents: { title: { type: "string" } } },
        permissions: { ghost: { update: WORKSPACE_ROLE_LEVELS.EDITOR } },
      })
    ).toThrow(/unknown namespace "ghost"/);
  });
});

/**
 * Read rules and per-field rules. A separate schema, because these need a
 * different shape and the registry is global per worker.
 */
const readSchema = defineSchema({
  entities: {
    boards: { name: { type: "string" } },
    columns: {
      name: { type: "string" },
      isPublic: { type: "boolean", optional: true },
      boardId: { type: "string", optional: true },
    },
    priced: {
      title: { type: "string" },
      price: { type: "number", optional: true },
      ownerId: { type: "string", optional: true },
    },
  },
  links: [
    {
      apiName: "boardColumns",
      kind: "one-to-many",
      forward: { namespace: "boards", label: "columns", has: "many" },
      reverse: { namespace: "columns", label: "board", has: "one" },
      foreignKey: { namespace: "columns", attribute: "boardId" },
    },
  ],
  permissions: {
    columns: {
      // Only rows the viewer is allowed to see come back.
      view: ({ data }) => data?.isPublic === true,
      create: WORKSPACE_ROLE_LEVELS.EDITOR,
      update: WORKSPACE_ROLE_LEVELS.EDITOR,
      delete: WORKSPACE_ROLE_LEVELS.EDITOR,
    },
    priced: {
      // Attribute-level: anyone may retitle, only the owner may reprice.
      update: ({ auth, data, changed }) =>
        changed?.includes("price") === true ? data?.ownerId === auth.sub : true,
      create: WORKSPACE_ROLE_LEVELS.EDITOR,
      delete: WORKSPACE_ROLE_LEVELS.EDITOR,
      view: WORKSPACE_ROLE_LEVELS.MEMBER,
    },
  },
});

function readDatabase(): SqlExecutor {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of readSchema.migrations) db.exec(migration.sql);
  return executor(db);
}

function useReadSchema(): void {
  configureRegistry(readSchema.registry);
  configureMigrations(readSchema.migrations);
  configurePermissions(readSchema.permissions);
}

describe("view rules", () => {
  test("hide rows and leave the rest intact", () => {
    useReadSchema();
    const sql = readDatabase();

    runTransaction(sql, WORKSPACE_ID, claimFor("alice"), {
      txId: "seed",
      ops: [
        { op: "update", namespace: "boards", id: "b1", values: { name: "Board" } },
        { op: "update", namespace: "columns", id: "c1", values: { name: "Public", isPublic: true, boardId: "b1" } },
        { op: "update", namespace: "columns", id: "c2", values: { name: "Private", isPublic: false, boardId: "b1" } },
      ],
    });

    const compiled = compileQuery({ columns: { $: { order: { name: "asc" } } } });
    const result = executeCompiledQuery(sql, compiled, claimFor("bob"));

    expect(result.columns.map((row) => row.name)).toEqual(["Public"]);
  });

  test("hide a denied row at link depth too", () => {
    useReadSchema();
    const sql = readDatabase();

    runTransaction(sql, WORKSPACE_ID, claimFor("alice"), {
      txId: "seed",
      ops: [
        { op: "update", namespace: "boards", id: "b1", values: { name: "Board" } },
        { op: "update", namespace: "columns", id: "c1", values: { name: "Public", isPublic: true, boardId: "b1" } },
        { op: "update", namespace: "columns", id: "c2", values: { name: "Private", isPublic: false, boardId: "b1" } },
      ],
    });

    const compiled = compileQuery({ boards: { columns: {} } });
    const result = executeCompiledQuery(sql, compiled, claimFor("bob"));

    const board = result.boards[0] as { columns: Array<{ name: string }> };
    expect(board.columns.map((column) => column.name)).toEqual(["Public"]);
  });

  test("hide a row when the rule throws", () => {
    useReadSchema();
    const sql = readDatabase();
    runTransaction(sql, WORKSPACE_ID, claimFor("alice"), {
      txId: "seed",
      ops: [
        { op: "update", namespace: "boards", id: "b1", values: { name: "Board" } },
        { op: "update", namespace: "columns", id: "c1", values: { name: "Public", isPublic: true, boardId: "b1" } },
      ],
    });

    configurePermissions({
      overrides: {
        columns: {
          view: () => {
            throw new Error("broken rule");
          },
        },
      },
    });

    const compiled = compileQuery({ columns: {} });
    expect(executeCompiledQuery(sql, compiled, claimFor("bob")).columns).toEqual([]);
  });

  test("fills the page past hidden rows and stops when nothing is left", () => {
    useReadSchema();
    const sql = readDatabase();

    runTransaction(sql, WORKSPACE_ID, claimFor("alice"), {
      txId: "seed",
      ops: [
        { op: "update", namespace: "columns", id: "c1", values: { name: "A", isPublic: false } },
        { op: "update", namespace: "columns", id: "c2", values: { name: "B", isPublic: true } },
        { op: "update", namespace: "columns", id: "c3", values: { name: "C", isPublic: false } },
      ],
    });

    const compiled = compileQuery({
      columns: { $: { order: { name: "asc" }, limit: 2 } },
    });
    const { data, pageInfo } = executeCompiledQueryWithPageInfo(
      sql,
      compiled,
      claimFor("bob")
    );

    // Only one row is visible in the whole namespace, so the scan fills what it
    // can and then reports the end instead of pretending a third row exists.
    expect(data.columns.map((row) => row.name)).toEqual(["B"]);
    expect(pageInfo.columns.returned).toBe(1);
    expect(pageInfo.columns.hasMore).toBe(false);
    expect(pageInfo.columns.nextCursor).toBeUndefined();
  });
});

describe("attribute rules", () => {
  test("allow a retitle but refuse a reprice by a non-owner", () => {
    useReadSchema();
    const sql = readDatabase();
    const owner = claimFor("alice");
    const other = claimFor("mallory");

    runTransaction(sql, WORKSPACE_ID, owner, {
      txId: "seed",
      ops: [
        { op: "update", namespace: "priced", id: "p1", values: { title: "Thing", price: 10, ownerId: "alice" } },
      ],
    });

    runTransaction(sql, WORKSPACE_ID, other, {
      txId: "t2",
      ops: [{ op: "update", namespace: "priced", id: "p1", values: { title: "Renamed" } }],
    });

    expect(() =>
      runTransaction(sql, WORKSPACE_ID, other, {
        txId: "t3",
        ops: [{ op: "update", namespace: "priced", id: "p1", values: { price: 1 } }],
      })
    ).toThrow(/Row rule denied update/);

    const row = sql.one<{ title: string; price: number }>(
      `SELECT "title", "price" FROM "priced" WHERE "id" = ?`,
      "p1"
    );
    expect(row?.title).toBe("Renamed");
    expect(row?.price).toBe(10);
  });
});
