/**
 * `where` view rules: row visibility compiled into SQL.
 *
 * The function form filters after fetch, so a rule that hides most rows can
 * only fill a page by scanning, and the scan is capped. The `where` form is a
 * filter, so it reaches SQL, uses an index, and fills every page.
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

const entities = {
  boards: { name: { type: "string" as const } },
  notes: {
    title: { type: "string" as const },
    ownerId: { type: "string" as const, optional: true, indexed: true },
    isPublic: { type: "boolean" as const, optional: true },
    boardId: { type: "string" as const, optional: true },
  },
};

const links = [
  {
    apiName: "boardNotes",
    kind: "one-to-many" as const,
    forward: { namespace: "boards", label: "notes", has: "many" as const },
    reverse: { namespace: "notes", label: "board", has: "one" as const },
    foreignKey: { namespace: "notes", attribute: "boardId" },
  },
];

function setup(permissions: PermissionOverrides): {
  sql: SqlExecutor;
  statements: string[];
} {
  const schema = defineSchema({ entities, links, permissions });
  configureRegistry(schema.registry);
  configureMigrations(schema.migrations);
  configurePermissions(schema.permissions);

  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of schema.migrations) db.exec(migration.sql);

  const statements: string[] = [];
  const sql: SqlExecutor = {
    exec(query: string, ...params: SqlValue[]): number {
      return db.query(query).run(...(params as never[])).changes;
    },
    all<T extends SqlRow = SqlRow>(query: string, ...params: SqlValue[]): T[] {
      statements.push(query);
      const plan = db
        .query(`EXPLAIN QUERY PLAN ${query}`)
        .all(...(params as never[])) as Array<{ detail: string }>;
      statements.push(...plan.map((row) => `PLAN ${row.detail}`));
      return db.query(query).all(...(params as never[])) as T[];
    },
    one<T extends SqlRow = SqlRow>(query: string, ...params: SqlValue[]): T | undefined {
      return (db.query(query).get(...(params as never[])) ?? undefined) as T | undefined;
    },
    transactionSync<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
  return { sql, statements };
}

function claimFor(sub: string): RoleClaim {
  return {
    sub,
    workspaceId: WORKSPACE_ID,
    role: WORKSPACE_ROLE_LEVELS.MEMBER,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  };
}

const owner = claimFor("owner");

function seedNotes(sql: SqlExecutor, rows: Array<{ id: string; title: string; ownerId: string; isPublic?: boolean; boardId?: string }>): void {
  runTransaction(sql, WORKSPACE_ID, { ...owner, role: WORKSPACE_ROLE_LEVELS.OWNER }, {
    txId: `seed-${rows[0]?.id ?? "x"}`,
    ops: rows.map(({ id, ...values }) => ({ op: "update", namespace: "notes", id, values })),
  });
}

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

const mine = { where: ({ sub }: { sub: string }) => ({ ownerId: sub }) };

describe("where view rules", () => {
  test("filter rows in SQL, and the plan uses the index", () => {
    const { sql, statements } = setup({ notes: { view: mine } });
    seedNotes(sql, [
      { id: "n1", title: "A", ownerId: "alice" },
      { id: "n2", title: "B", ownerId: "bob" },
      { id: "n3", title: "C", ownerId: "alice" },
    ]);

    statements.length = 0;
    const { data } = executeCompiledQueryWithPageInfo(
      sql,
      compileQuery({ notes: { $: { order: { title: "asc" } } } }),
      claimFor("alice")
    );

    expect(data.notes.map((row) => row.title)).toEqual(["A", "C"]);
    expect(statements.some((line) => line.includes('"owner_id" = ?'))).toBe(true);
    expect(statements.some((line) => line.startsWith("PLAN") && line.includes("notes_owner_id_idx"))).toBe(true);
  });

  test("SQL and function rules both fill a page beyond hidden rows", () => {
    // 300 rows owned by someone else sort ahead of the caller's five rows.
    const rows = [
      ...Array.from({ length: 300 }, (_, n) => ({ id: `x${pad(n)}`, title: `a-${pad(n)}`, ownerId: "other" })),
      ...Array.from({ length: 5 }, (_, n) => ({ id: `m${n}`, title: `z-${n}`, ownerId: "alice" })),
    ];
    const query = compileQuery({ notes: { $: { order: { title: "asc" }, limit: 5 } } });

    // Both access-rule forms must return the same complete visible page.
    const asFunction = setup({ notes: { view: ({ auth, data }) => data?.ownerId === auth.sub } });
    seedNotes(asFunction.sql, rows);
    const capped = executeCompiledQueryWithPageInfo(asFunction.sql, query, claimFor("alice"));
    expect(capped.data.notes).toHaveLength(5);

    const asWhere = setup({ notes: { view: mine } });
    seedNotes(asWhere.sql, rows);
    const { data, pageInfo } = executeCompiledQueryWithPageInfo(asWhere.sql, query, claimFor("alice"));
    expect(data.notes.map((row) => row.title)).toEqual(["z-0", "z-1", "z-2", "z-3", "z-4"]);
    expect(pageInfo.notes.hasMore).toBe(false);
  });

  test("an array is OR of its branches", () => {
    const { sql } = setup({
      notes: { view: { where: ({ sub }) => [{ ownerId: sub }, { isPublic: true }] } },
    });
    seedNotes(sql, [
      { id: "n1", title: "mine", ownerId: "alice" },
      { id: "n2", title: "public", ownerId: "bob", isPublic: true },
      { id: "n3", title: "private", ownerId: "bob", isPublic: false },
    ]);

    const { data } = executeCompiledQueryWithPageInfo(
      sql,
      compileQuery({ notes: { $: { order: { title: "asc" } } } }),
      claimFor("alice")
    );
    expect(data.notes.map((row) => row.title)).toEqual(["mine", "public"]);
  });

  test("apply at link depth and combine with the caller's own where", () => {
    const { sql } = setup({ notes: { view: mine } });
    runTransaction(sql, WORKSPACE_ID, { ...owner, role: WORKSPACE_ROLE_LEVELS.OWNER }, {
      txId: "board",
      ops: [{ op: "update", namespace: "boards", id: "b1", values: { name: "Board" } }],
    });
    seedNotes(sql, [
      { id: "n1", title: "A", ownerId: "alice", boardId: "b1" },
      { id: "n2", title: "B", ownerId: "bob", boardId: "b1" },
      { id: "n3", title: "C", ownerId: "alice", boardId: "b1" },
    ]);

    const nested = executeCompiledQueryWithPageInfo(
      sql,
      compileQuery({ boards: { notes: { $: { order: { title: "asc" } } } } }),
      claimFor("alice")
    );
    const board = nested.data.boards[0] as { notes: Array<{ title: string }> };
    expect(board.notes.map((note) => note.title)).toEqual(["A", "C"]);

    // A caller cannot widen the rule with their own filter: the two AND.
    const widened = executeCompiledQueryWithPageInfo(
      sql,
      compileQuery({ notes: { $: { where: { ownerId: "bob" } } } }),
      claimFor("alice")
    );
    expect(widened.data.notes).toEqual([]);
  });

  test("an empty array and a throwing rule both hide everything", () => {
    for (const view of [
      { where: () => [] },
      {
        where: () => {
          throw new Error("broken rule");
        },
      },
    ]) {
      const { sql } = setup({ notes: { view } });
      seedNotes(sql, [{ id: "n1", title: "A", ownerId: "alice" }]);
      const { data } = executeCompiledQueryWithPageInfo(sql, compileQuery({ notes: {} }), claimFor("alice"));
      expect(data.notes).toEqual([]);
    }
  });

  test("an unsupported operator is refused, not ignored", () => {
    const { sql } = setup({
      notes: { view: { where: ({ sub }) => ({ ownerId: { $like: sub } } as never) } },
    });
    seedNotes(sql, [{ id: "n1", title: "A", ownerId: "alice" }]);

    // Ignoring "$like" would compile to 1 = 1 and show every row.
    expect(() =>
      executeCompiledQueryWithPageInfo(sql, compileQuery({ notes: {} }), claimFor("alice"))
    ).toThrow(/View rule for "notes" returned an invalid filter/);
  });

  test("is refused on write actions, where it would be skipped", () => {
    expect(() =>
      defineSchema({ entities, links, permissions: { notes: { update: mine as never } } })
    ).toThrow(/where rules are only valid for view/);
    expect(() =>
      configurePermissions({ overrides: { notes: { delete: mine as never } } })
    ).toThrow(/where rules are only valid for view/);
  });
});
