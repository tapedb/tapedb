/**
 * Complete page filling for row-level `view` rules.
 *
 * A `view` rule is arbitrary TypeScript, so it runs after the SQL page. Without
 * filling, a namespace with a selective rule returns far fewer rows than the
 * limit even when more visible rows exist. These tests prove the page is filled
 * by scanning further, that a rule hiding everything
 * terminates, and that `pageInfo` stays honest while paging.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim, type WorkspaceRole } from "../src/claims";
import { configureMigrations } from "../src/engine/migrations-bundle";
import { configurePermissions } from "../src/engine/tx-permissions";
import { compileQuery } from "../src/engine/query-compile";
import {
  executeCompiledQueryWithPageInfo,
} from "../src/engine/query-execute";
import { configureRegistry } from "../src/engine/registry";
import type { SqlExecutor, SqlRow, SqlValue } from "../src/engine/tx-sql";
import { runTransaction } from "../src/engine/tx-pipeline";
import { defineSchema } from "../src/schema";
import { defaultDeploymentConfig } from "../src/engine/config";

/** These tests run the unconfigured engine: audit off, role file rules, no webhooks. */
const engineConfig = defaultDeploymentConfig();

const WORKSPACE_ID = "2b7d4c1e-9a3f-4e6b-8c2d-7f1a0b3c5d9e";

/** 50 rows, `rank` 0..49, and only the rows a rule lets through are visible. */
const ROW_COUNT = 50;

const schema = defineSchema({
  entities: {
    records: {
      label: { type: "string" },
      rank: { type: "number" },
      visible: { type: "boolean", optional: true },
    },
  },
  permissions: {
    records: {
      // Row-level read rule: the only filter that cannot become a SQL predicate.
      view: ({ data }) => data?.visible === true,
      create: WORKSPACE_ROLE_LEVELS.EDITOR,
      update: WORKSPACE_ROLE_LEVELS.EDITOR,
      delete: WORKSPACE_ROLE_LEVELS.EDITOR,
    },
  },
});

interface ReadStats {
  selects: number;
  rowsRead: number;
}

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

/**
 * Counts what the executor actually reads. `rowsRead` is rows returned by
 * SELECTs, which is exactly the work a page pays for: a keyset scan adds rows,
 * it never re-reads them.
 */
function counting(inner: SqlExecutor): { sql: SqlExecutor; stats: ReadStats } {
  const stats: ReadStats = { selects: 0, rowsRead: 0 };
  return {
    stats,
    sql: {
      exec: inner.exec,
      transactionSync: inner.transactionSync,
      one: inner.one,
      all<T extends SqlRow = SqlRow>(statement: string, ...params: SqlValue[]): T[] {
        const rows = inner.all<T>(statement, ...params);
        stats.selects += 1;
        stats.rowsRead += rows.length;
        return rows;
      },
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
  const now = Math.floor(Date.now() / 1000);
  return { sub, workspaceId: WORKSPACE_ID, role, exp: now + 600, iat: now };
}

/**
 * Seeds `ROW_COUNT` rows in ascending `rank`. `visibleRanks` decides which rows
 * the view rule keeps, so a test can make the visible set as sparse as it likes.
 */
function seed(sql: SqlExecutor, visibleRanks: (rank: number) => boolean): void {
  runTransaction(sql, WORKSPACE_ID, claimFor("alice"), {
    txId: "seed",
    ops: Array.from({ length: ROW_COUNT }, (_unused, rank) => ({
      op: "update" as const,
      namespace: "records",
      id: `rec-${String(rank).padStart(2, "0")}`,
      values: {
        label: `Row ${rank}`,
        rank,
        visible: visibleRanks(rank),
      },
    })),
  }, engineConfig);
}

function page(
  sql: SqlExecutor,
  limit: number,
  after?: string,
  order: "asc" | "desc" | null = "asc"
) {
  const compiled = compileQuery({
    records: {
      $: {
        limit,
        ...(order === null ? {} : { order: { rank: order } }),
        ...(after === undefined ? {} : { after }),
      },
    },
  });
  return executeCompiledQueryWithPageInfo(sql, compiled, claimFor("bob"));
}

beforeEach(() => {
  configureRegistry(schema.registry);
  configureMigrations(schema.migrations);
  configurePermissions(schema.permissions);
});

describe("complete page filling", () => {
  test("fills a page of 10 when only 1 row in 5 is visible", () => {
    const sql = freshDatabase();
    seed(sql, (rank) => rank % 5 === 0); // ranks 0,5,...,45 are visible

    const { data, pageInfo } = page(sql, 10);

    // Fifty rows are in the table and only ten are visible: the page holds ten
    // of them, which the old single-page behavior could never do.
    expect(data.records).toHaveLength(10);
    expect(data.records.map((row) => row.rank)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45]);
    expect(pageInfo.records.returned).toBe(10);
    expect(pageInfo.records.limit).toBe(10);
    // Ten visible rows exist in total, so the scan reached the end of the table.
    expect(pageInfo.records.hasMore).toBe(false);
    expect(pageInfo.records.nextCursor).toBeUndefined();
  });

  test("fills a page of 10 and still reports the visible row after it", () => {
    const sql = freshDatabase();
    // Eleven visible rows: 0,5,...,50 across a 60-row table.
    runTransaction(sql, WORKSPACE_ID, claimFor("alice"), {
      txId: "seed",
      ops: Array.from({ length: 60 }, (_unused, rank) => ({
        op: "update" as const,
        namespace: "records",
        id: `rec-${String(rank).padStart(2, "0")}`,
        values: { label: `Row ${rank}`, rank, visible: rank % 5 === 0 },
      })),
    }, engineConfig);

    const first = page(sql, 10);
    expect(first.data.records.map((row) => row.rank)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45]);
    // A full page that stopped before the end must not claim to be the end.
    expect(first.pageInfo.records.hasMore).toBe(true);

    const second = page(sql, 10, first.pageInfo.records.nextCursor);
    expect(second.data.records.map((row) => row.rank)).toEqual([50, 55]);
    expect(second.pageInfo.records.returned).toBe(2);
    // The trailing hidden rows after rank 55 do not fake a third page.
    expect(second.pageInfo.records.hasMore).toBe(false);
  });

  test("fills a page that stops mid-namespace and offers a cursor for the rest", () => {
    const sql = freshDatabase();
    seed(sql, (rank) => rank % 2 === 1); // 25 visible rows

    const { data, pageInfo } = page(sql, 10);

    expect(data.records.map((row) => row.rank)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19]);
    expect(pageInfo.records.returned).toBe(10);
    expect(pageInfo.records.hasMore).toBe(true);
    expect(typeof pageInfo.records.nextCursor).toBe("string");
  });

  test("terminates on a rule that hides everything", () => {
    const sql = freshDatabase();
    seed(sql, () => false);
    const { sql: counted, stats } = counting(sql);

    const { data, pageInfo } = page(counted, 10);

    expect(data.records).toEqual([]);
    expect(pageInfo.records).toEqual({
      limit: 10,
      returned: 0,
      hasMore: false,
    });

    // Exhaust the matching set without revisiting rows.
    expect(stats.rowsRead).toBeLessThanOrEqual(ROW_COUNT);
    expect(stats.rowsRead).toBe(ROW_COUNT);
  });

  test("exhausts a large hidden result without inventing another page", () => {
    const sql = freshDatabase();
    seed(sql, () => false);
    // Grow the table past the cap so the cap, not exhaustion, is what ends it.
    runTransaction(sql, WORKSPACE_ID, claimFor("alice"), {
      txId: "bulk",
      ops: Array.from({ length: 400 }, (_unused, index) => ({
        op: "update" as const,
        namespace: "records",
        id: `bulk-${String(index).padStart(3, "0")}`,
        values: { label: `Bulk ${index}`, rank: 1000 + index, visible: false },
      })),
    }, engineConfig);
    const { sql: counted, stats } = counting(sql);

    const { data, pageInfo } = page(counted, 10);

    expect(data.records).toEqual([]);
    expect(pageInfo.records.returned).toBe(0);
    // Terminal, because an empty page has no visible row to resume from.
    expect(pageInfo.records.hasMore).toBe(false);
    expect(pageInfo.records.nextCursor).toBeUndefined();

    // Every matching row was checked, even beyond the former scan cap.
    expect(stats.rowsRead).toBe(450);
  });

  test("finds visible rows beyond the former scan boundary and counts them", () => {
    const sql = freshDatabase();
    runTransaction(sql, WORKSPACE_ID, claimFor("alice"), {
      txId: "sparse",
      ops: Array.from({ length: 450 }, (_, rank) => ({
        op: "update" as const, namespace: "records", id: `sparse-${String(rank).padStart(3, "0")}`,
        values: { label: `Row ${rank}`, rank, visible: rank >= 430 },
      })),
    }, engineConfig);
    const first = executeCompiledQueryWithPageInfo(sql, compileQuery({
      records: { $: { limit: 5, count: true, order: { rank: "asc" } } },
    }), claimFor("bob"));
    expect(first.data.records.map(row => row.rank)).toEqual([430, 431, 432, 433, 434]);
    expect(first.pageInfo.records.count).toBe(20);
    expect(first.pageInfo.records.hasMore).toBe(true);
    const second = page(sql, 5, first.pageInfo.records.nextCursor);
    expect(second.data.records.map(row => row.rank)).toEqual([435, 436, 437, 438, 439]);
  });

  test("pages through every visible row exactly once", () => {
    const sql = freshDatabase();
    seed(sql, (rank) => rank % 2 === 1);

    const seen: number[] = [];
    let after: string | undefined;
    let pages = 0;

    for (;;) {
      const result: ReturnType<typeof page> = page(sql, 4, after);
      pages += 1;
      expect(result.pageInfo.records.returned).toBe(result.data.records.length);
      expect(result.data.records.length).toBeLessThanOrEqual(4);

      seen.push(...result.data.records.map((row) => row.rank as number));

      if (!result.pageInfo.records.hasMore) {
        expect(result.pageInfo.records.nextCursor).toBeUndefined();
        break;
      }

      expect(typeof result.pageInfo.records.nextCursor).toBe("string");
      after = result.pageInfo.records.nextCursor;
      expect(pages).toBeLessThan(ROW_COUNT); // a cursor loop would hang here
    }

    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 39, 41, 43, 45, 47, 49]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("pages through a sparse namespace without skipping rows the scan passed", () => {
    const sql = freshDatabase();
    // One visible row in ten: every page needs a scan of roughly ten rows.
    seed(sql, (rank) => rank % 10 === 3);

    const seen: number[] = [];
    let after: string | undefined;
    for (;;) {
      const result: ReturnType<typeof page> = page(sql, 2, after);
      seen.push(...result.data.records.map((row) => row.rank as number));
      if (!result.pageInfo.records.hasMore) break;
      after = result.pageInfo.records.nextCursor;
    }

    expect(seen).toEqual([3, 13, 23, 33, 43]);
    expect(new Set(seen).size).toBe(5);
  });

  test("keeps the descending order keyset correct while filling", () => {
    const sql = freshDatabase();
    seed(sql, (rank) => rank % 5 === 0);

    const first = page(sql, 4, undefined, "desc");
    expect(first.data.records.map((row) => row.rank)).toEqual([45, 40, 35, 30]);
    expect(first.pageInfo.records.hasMore).toBe(true);

    const second = page(sql, 4, first.pageInfo.records.nextCursor, "desc");
    expect(second.data.records.map((row) => row.rank)).toEqual([25, 20, 15, 10]);

    const third = page(sql, 4, second.pageInfo.records.nextCursor, "desc");
    expect(third.data.records.map((row) => row.rank)).toEqual([5, 0]);
    expect(third.pageInfo.records.hasMore).toBe(false);
  });

  test("fills the page when the query has no order to page on", () => {
    const sql = freshDatabase();
    seed(sql, (rank) => rank % 5 === 0);

    const { data, pageInfo } = page(sql, 10, undefined, null);

    // No total order, so no cursor: the page is still filled by widening the
    // read window, and it reports the end of the match set.
    expect(data.records).toHaveLength(10);
    expect(data.records.map((row) => row.rank).sort((a, b) => Number(a) - Number(b))).toEqual([
      0, 5, 10, 15, 20, 25, 30, 35, 40, 45,
    ]);
    expect(pageInfo.records.returned).toBe(10);
    expect(pageInfo.records.hasMore).toBe(false);
  });

  test("counts only visible rows in returned, not rows read", () => {
    const sql = freshDatabase();
    seed(sql, (rank) => rank % 5 === 0);
    const { sql: counted, stats } = counting(sql);

    const { data, pageInfo } = page(counted, 3);

    expect(data.records.map((row) => row.rank)).toEqual([0, 5, 10]);
    // Twelve-plus rows were read to find three visible ones, and the count
    // reports the page, not the work.
    expect(pageInfo.records.returned).toBe(3);
    expect(stats.rowsRead).toBeGreaterThan(3);
  });

  test("leaves a namespace with no view rule on a single page", () => {
    // `view` is a rule here, so remove it: the registry still has the namespace.
    configurePermissions({});
    const sql = freshDatabase();
    seed(sql, () => true);
    const { sql: counted, stats } = counting(sql);

    const { data, pageInfo } = page(counted, 10);

    expect(data.records).toHaveLength(10);
    expect(pageInfo.records.limit).toBe(10);
    expect(pageInfo.records.returned).toBe(10);
    expect(pageInfo.records.hasMore).toBe(true);
    expect(typeof pageInfo.records.nextCursor).toBe("string");
    // One SELECT for the page: nothing was hidden, so nothing was re-scanned.
    expect(stats.selects).toBe(1);
    expect(stats.rowsRead).toBe(11);
  });
});
