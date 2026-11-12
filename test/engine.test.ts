/**
 * Acceptance test for the extracted engine.
 *
 * Runs the real transaction pipeline, query compiler and recovery bookkeeping
 * against in-memory SQLite, using the migrations that `defineSchema()` emits.
 * No Durable Object runtime is involved, so this is the cheapest proof that
 * the engine still works after extraction.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { configureMigrations } from "../src/engine/migrations-bundle";
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
    boards: { name: { type: "string" } },
    columns: {
      name: { type: "string" },
      boardId: { type: "string", optional: true, indexed: true },
    },
    tasks: {
      title: { type: "string" },
      done: { type: "boolean", optional: true },
      columnId: { type: "string", optional: true, indexed: true },
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
    {
      apiName: "columnTasks",
      kind: "one-to-many",
      forward: { namespace: "columns", label: "tasks", has: "many" },
      reverse: { namespace: "tasks", label: "column", has: "one" },
      foreignKey: { namespace: "tasks", attribute: "columnId" },
    },
  ],
});

const claim: RoleClaim = {
  sub: "user-1",
  workspaceId: WORKSPACE_ID,
  role: WORKSPACE_ROLE_LEVELS.EDITOR,
  exp: Math.floor(Date.now() / 1000) + 600,
  iat: Math.floor(Date.now() / 1000),
};

/** Adapts bun:sqlite to the engine's synchronous SQL contract. */
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

  for (const migration of schema.migrations) {
    db.exec(migration.sql);
  }

  return executor(db);
}

beforeEach(() => {
  configureRegistry(schema.registry);
  configureMigrations(schema.migrations);
});

describe("schema", () => {
  test("emits engine bookkeeping plus one table per entity", () => {
    const sql = schema.migrations.map((migration) => migration.sql).join("\n");

    for (const table of ["_tx_log", "_tx_state", "_flush_state", "_snapshot_state"]) {
      expect(sql).toContain(`"${table}"`);
    }
    for (const table of ["boards", "columns", "tasks"]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
    }
  });

  test("derives the foreign key on the child namespace", () => {
    const columns = schema.registry.namespaces.find((ns) => ns.apiName === "columns");
    expect(columns?.attributes.boardId?.references?.table).toBe("boards");

    const sql = schema.migrations[1].sql;
    expect(sql).toContain('REFERENCES "boards"("id")');
  });

  test("rejects a link whose foreign key attribute does not exist", () => {
    expect(() =>
      defineSchema({
        entities: { boards: { name: { type: "string" } } },
        links: [
          {
            apiName: "broken",
            kind: "one-to-many",
            forward: { namespace: "boards", label: "items", has: "many" },
            reverse: { namespace: "boards", label: "board", has: "one" },
            foreignKey: { namespace: "boards", attribute: "missingId" },
          },
        ],
      })
    ).toThrow(/needs "boards\.missingId"/);
  });
});

describe("transaction pipeline", () => {
  test("applies a transaction, logs it and advances the sequence", () => {
    const sql = freshDatabase();

    const result = runTransaction(sql, WORKSPACE_ID, claim, {
      txId: "t1",
      clientTxId: "tx-1",
      ops: [
        { op: "update", namespace: "boards", id: "board-1", values: { name: "Roadmap" } },
        {
          op: "update",
          namespace: "columns",
          id: "column-1",
          values: { name: "Todo", boardId: "board-1" },
        },
        {
          op: "update",
          namespace: "tasks",
          id: "task-1",
          values: { title: "Ship it", columnId: "column-1" },
        },
      ],
    });

    expect(result.seq).toBe(1);
    expect(result.applied).toBe(3);

    const task = sql.one<{ title: string; column_id: string }>(
      `SELECT "title", "column_id" FROM "tasks" WHERE "id" = ?`,
      "task-1"
    );
    expect(task?.title).toBe("Ship it");
    expect(task?.column_id).toBe("column-1");

    const log = sql.one<{ seq: number; ops_hash: string }>(
      `SELECT seq, ops_hash FROM "_tx_log" WHERE client_tx_id = ?`,
      "tx-1"
    );
    expect(log?.seq).toBe(1);
    expect(log?.ops_hash.length).toBeGreaterThan(0);
  });

  test("is idempotent for a repeated clientTxId and rejects a different payload", () => {
    const sql = freshDatabase();
    const envelope = {
      txId: "t2",
      clientTxId: "tx-same",
      ops: [{ op: "update", namespace: "boards", id: "board-1", values: { name: "A" } }],
    };

    expect(runTransaction(sql, WORKSPACE_ID, claim, envelope).applied).toBe(1);

    const replay = runTransaction(sql, WORKSPACE_ID, claim, envelope);
    expect(replay.applied).toBe(0);
    expect(replay.seq).toBe(1);

    expect(() =>
      runTransaction(sql, WORKSPACE_ID, claim, {
        txId: "t3",
        clientTxId: "tx-same",
        ops: [{ op: "update", namespace: "boards", id: "board-1", values: { name: "B" } }],
      })
    ).toThrow(/already used with different ops/);
  });

  test("denies a claim issued for another workspace", () => {
    const sql = freshDatabase();
    expect(() =>
      runTransaction(
        sql,
        WORKSPACE_ID,
        { ...claim, workspaceId: "00000000-0000-4000-8000-000000000000" },
        { txId: "t5", ops: [] }
      )
    ).toThrow(/does not belong to this workspace/);
  });
});

describe("recovery ordering", () => {
  test("orders parents before children and terminates", async () => {
    const { restoreOrder } = await import("../src/engine/durability/recovery");
    const order = restoreOrder();

    // Regression: an earlier version re-selected the same tables forever and
    // overflowed the array on a real cold start, which no unit test reached.
    expect(order.length).toBeLessThan(100);
    expect(new Set(order).size).toBe(order.length);

    const boards = order.indexOf("boards");
    const columns = order.indexOf("columns");
    const tasks = order.indexOf("tasks");

    expect(boards).toBeGreaterThanOrEqual(0);
    expect(boards).toBeLessThan(columns);
    expect(columns).toBeLessThan(tasks);
    expect(order.at(-1)).toBe("$files");
  });
});

describe("pagination", () => {
  function seed(sql: ReturnType<typeof freshDatabase>): void {
    runTransaction(sql, WORKSPACE_ID, claim, {
      txId: "seed",
      ops: ["B1", "B2", "B3", "B4", "B5"].map((name, index) => ({
        op: "update" as const,
        namespace: "boards",
        id: `board-${index + 1}`,
        values: { name },
      })),
    });
  }

  function page(sql: ReturnType<typeof freshDatabase>, after?: string) {
    const compiled = compileQuery({
      boards: {
        $: {
          order: { name: "asc" },
          limit: 2,
          ...(after === undefined ? {} : { after }),
        },
      },
    });
    return executeCompiledQueryWithPageInfo(sql, compiled);
  }

  test("walks every row exactly once across pages", () => {
    const sql = freshDatabase();
    seed(sql);

    const first = page(sql);
    expect(first.data.boards.map((row) => row.name)).toEqual(["B1", "B2"]);
    expect(first.pageInfo.boards.hasMore).toBe(true);
    expect(typeof first.pageInfo.boards.nextCursor).toBe("string");

    const second = page(sql, first.pageInfo.boards.nextCursor);
    expect(second.data.boards.map((row) => row.name)).toEqual(["B3", "B4"]);

    const third = page(sql, second.pageInfo.boards.nextCursor);
    expect(third.data.boards.map((row) => row.name)).toEqual(["B5"]);
    expect(third.pageInfo.boards.hasMore).toBe(false);
    expect(third.pageInfo.boards.nextCursor).toBeUndefined();

    const seen = [
      ...first.data.boards,
      ...second.data.boards,
      ...third.data.boards,
    ].map((row) => row.name);
    expect(seen).toEqual(["B1", "B2", "B3", "B4", "B5"]);
    expect(new Set(seen).size).toBe(5);
  });

  test("does not repeat a row when something is inserted above the window", () => {
    const sql = freshDatabase();
    seed(sql);

    const first = page(sql);
    // A new row that sorts before the whole first page.
    runTransaction(sql, WORKSPACE_ID, claim, {
      txId: "insert-a",
      ops: [{ op: "update", namespace: "boards", id: "board-a", values: { name: "A0" } }],
    });

    const second = page(sql, first.pageInfo.boards.nextCursor);
    // Keyset, not offset: the new row does not shift the window, so nothing
    // from page one reappears.
    expect(second.data.boards.map((row) => row.name)).toEqual(["B3", "B4"]);
  });

  test("pages in descending order", () => {
    const sql = freshDatabase();
    seed(sql);

    const compiled = compileQuery({
      boards: { $: { order: { name: "desc" }, limit: 2 } },
    });
    const first = executeCompiledQueryWithPageInfo(sql, compiled);
    expect(first.data.boards.map((row) => row.name)).toEqual(["B5", "B4"]);

    const second = page2(sql, first.pageInfo.boards.nextCursor);
    expect(second.data.boards.map((row) => row.name)).toEqual(["B3", "B2"]);
  });

  function page2(sql: ReturnType<typeof freshDatabase>, after?: string) {
    const compiled = compileQuery({
      boards: {
        $: {
          order: { name: "desc" },
          limit: 2,
          ...(after === undefined ? {} : { after }),
        },
      },
    });
    return executeCompiledQueryWithPageInfo(sql, compiled);
  }

  test("refuses a cursor without an explicit order", () => {
    const sql = freshDatabase();
    seed(sql);
    expect(() =>
      compileQuery({ boards: { $: { limit: 2, after: "eyJ2IjoxfQ" } } })
    ).toThrow(/requires an explicit/);
  });

  test("refuses a cursor built for a different order", () => {
    const sql = freshDatabase();
    seed(sql);
    const first = page(sql);

    expect(() =>
      compileQuery({
        boards: {
          $: {
            order: { id: "asc" },
            limit: 2,
            after: first.pageInfo.boards.nextCursor,
          },
        },
      })
    ).toThrow(/does not match/);
  });

  test("refuses a malformed cursor", () => {
    expect(() =>
      compileQuery({ boards: { $: { order: { name: "asc" }, after: "not-a-cursor" } } })
    ).toThrow(/valid cursor/);
  });
});

describe("recovery tables", () => {
  test("uses the configured registry, not a module-load snapshot", async () => {
    const { allowedTables } = await import("../src/engine/durability/recovery");
    const tables = allowedTables();

    // Regression: this was a module-level Set built before configureRegistry()
    // ran, so it rejected every entity table on a real cold start.
    expect(tables.has("boards")).toBe(true);
    expect(tables.has("columns")).toBe(true);
    expect(tables.has("tasks")).toBe(true);
    expect(tables.has("$files")).toBe(true);
    expect(tables.has("_tx_log")).toBe(false);
  });
});

describe("queries", () => {
  test("traverses a two-level link from the compiled query", () => {
    const sql = freshDatabase();

    runTransaction(sql, WORKSPACE_ID, claim, {
      txId: "t4",
      ops: [
        { op: "update", namespace: "boards", id: "board-1", values: { name: "Roadmap" } },
        {
          op: "update",
          namespace: "columns",
          id: "column-1",
          values: { name: "Todo", boardId: "board-1" },
        },
        {
          op: "update",
          namespace: "tasks",
          id: "task-1",
          values: { title: "Ship it", columnId: "column-1" },
        },
      ],
    });

    const compiled = compileQuery({
      boards: { $: { where: { id: "board-1" } }, columns: { tasks: {} } },
    });

    const result = executeCompiledQuery(sql, compiled) as Record<
      string,
      Array<Record<string, unknown>>
    >;

    const board = result.boards?.[0];
    expect(board?.name).toBe("Roadmap");

    const columns = board?.columns as Array<Record<string, unknown>>;
    expect(columns).toHaveLength(1);
    expect(columns[0]?.name).toBe("Todo");

    const tasks = columns[0]?.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe("Ship it");
  });
});
