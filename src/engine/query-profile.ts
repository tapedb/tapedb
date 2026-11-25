/**
 * Which reads cost a workspace the most, and why (`GET /queries`).
 *
 * Every read statement the room runs for a query, a live re-run or a named
 * SQL query is recorded under its SQL text: how often it ran, the rows it
 * returned, the rows SQLite read to produce them, and its duration. On demand,
 * the most expensive statements are explained with SQLite's own planner
 * (`EXPLAIN QUERY PLAN`), so a full table scan and the columns it filtered on
 * are named.
 *
 * What makes it safe to keep and to show:
 *
 * - The compiled SQL binds every value as a parameter, so the text holds
 *   table and column names, operators and placeholders. Parameters are
 *   never recorded, so no filter value, subject or personal field is kept.
 * - Memory is bounded: at most `MAX_STATEMENTS` entries, keyed by a hash of
 *   the text, with the text itself cut to `MAX_TEXT` characters. When full, the
 *   entry that has cost least gives way.
 * - Like `/metrics`, it lives in the Durable Object's memory and starts again
 *   when the object does. Nothing is written to SQLite.
 * - It never changes an index or a migration. A missing index is reported as
 *   a candidate for `.index()` in the schema, which you review and migrate.
 *
 * Two measures, because one of them is blind on Cloudflare: `rowsRead` comes
 * from SQLite (the Durable Object cursor's own count, which is also what
 * Cloudflare bills) and is exact. `ms` is wall time, and workerd only advances
 * the clock at I/O, so a statement that never waits reads as 0 ms in a
 * deployment. Rank by `rowsRead` there.
 */

import type { SqlRow, SqlValue } from "./tx-sql";

export const MAX_STATEMENTS = 200;
export const MAX_TEXT = 4_000;

/** Where a statement ran. */
export type QuerySource = "query" | "live" | "sql";

export interface StatementStats {
  /** Stable id of the statement text (FNV-1a), for comparing two reads. */
  id: string;
  sources: QuerySource[];
  /** The SQL, cut to MAX_TEXT characters; placeholders, never values. */
  sql: string;
  truncated: boolean;
  count: number;
  rowsReturned: number;
  /** Rows SQLite read; null where the runtime does not report it. */
  rowsRead: number | null;
  totalMs: number;
  maxMs: number;
  lastAt: number;
}

interface Entry extends Omit<StatementStats, "sources"> {
  sources: Set<QuerySource>;
  /** The full text, kept only while it is short enough to explain. */
  fullSql: string | null;
  params: number;
}

export type ProfileSort = "rowsRead" | "totalMs" | "count" | "rowsReturned";

export class QueryProfiler {
  private readonly entries = new Map<string, Entry>();
  readonly since: number;

  constructor(private readonly clock: () => number = Date.now) {
    this.since = clock();
  }

  /** Records one read statement. `rowsRead` is null where the runtime has no count. */
  record(source: QuerySource, sql: string, params: number, ms: number, rowsReturned: number, rowsRead: number | null): void {
    const id = hash(sql);
    let entry = this.entries.get(id);
    if (!entry) {
      if (this.entries.size >= MAX_STATEMENTS) this.evict();
      entry = {
        id,
        sources: new Set(),
        sql: sql.length > MAX_TEXT ? sql.slice(0, MAX_TEXT) : sql,
        truncated: sql.length > MAX_TEXT,
        fullSql: sql.length <= 100_000 ? sql : null,
        params,
        count: 0,
        rowsReturned: 0,
        rowsRead: rowsRead === null ? null : 0,
        totalMs: 0,
        maxMs: 0,
        lastAt: 0,
      };
      this.entries.set(id, entry);
    }
    entry.sources.add(source);
    entry.count += 1;
    entry.rowsReturned += rowsReturned;
    if (rowsRead !== null) entry.rowsRead = (entry.rowsRead ?? 0) + rowsRead;
    const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
    entry.totalMs += safeMs;
    if (safeMs > entry.maxMs) entry.maxMs = safeMs;
    entry.lastAt = this.clock();
  }

  /** The `limit` most expensive statements by `sort`. */
  top(sort: ProfileSort, limit: number): Array<StatementStats & { fullSql: string | null; params: number }> {
    const key = (entry: Entry) => (sort === "rowsRead" ? entry.rowsRead ?? entry.rowsReturned : entry[sort]);
    return [...this.entries.values()]
      .sort((a, b) => key(b) - key(a) || b.count - a.count)
      .slice(0, limit)
      .map(({ sources, ...rest }) => ({ ...rest, sources: [...sources].sort() }));
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private evict(): void {
    let cheapest: Entry | null = null;
    for (const entry of this.entries.values()) {
      const cost = entry.rowsRead ?? entry.rowsReturned;
      if (cheapest === null || cost < (cheapest.rowsRead ?? cheapest.rowsReturned) || (cost === (cheapest.rowsRead ?? cheapest.rowsReturned) && entry.lastAt < cheapest.lastAt)) {
        cheapest = entry;
      }
    }
    if (cheapest) this.entries.delete(cheapest.id);
  }
}

/** One line of SQLite's plan. */
export interface PlanStep {
  id: number;
  parent: number;
  detail: string;
}

export interface PlanReading {
  plan: PlanStep[];
  /** Tables read whole: a `SCAN` without an index. Engine tables and json_each are left out. */
  fullScans: string[];
  /** Indexes the plan uses. */
  indexes: string[];
  /** For each full scan, columns the statement compares on that table: candidates for `.index()`. */
  indexCandidates: Array<{ table: string; columns: string[] }>;
}

/**
 * Explains a recorded statement with SQLite's planner. Parameters are bound
 * as null: the plan's shape (scan or search, which index) does not depend on
 * the values. Returns null when the statement cannot be explained here.
 */
export function explain(
  run: (sql: string, params: SqlValue[]) => SqlRow[],
  sql: string,
  params: number,
  tables: ReadonlyMap<string, string>
): PlanReading | null {
  let rows: SqlRow[];
  try {
    rows = run(`EXPLAIN QUERY PLAN ${sql}`, new Array<SqlValue>(params).fill(null));
  } catch {
    return null;
  }
  const plan = rows.map((row) => ({ id: Number(row.id), parent: Number(row.parent), detail: String(row.detail) }));
  return readPlan(plan, sql, tables);
}

/**
 * Reads a plan: which tables were scanned whole, which indexes were used,
 * and which columns of a scanned table the statement compares. `tables`
 * maps each table name a model owns to that model, so engine tables are left
 * out.
 */
export function readPlan(plan: PlanStep[], sql: string, tables: ReadonlyMap<string, string>): PlanReading {
  const fullScans = new Set<string>();
  const indexes = new Set<string>();
  const aliases = aliasMap(sql);
  for (const step of plan) {
    const scan = /^SCAN (\S+)(?: (?:USING (?:COVERING )?INDEX (\S+)))?/.exec(step.detail);
    const index = /USING (?:COVERING )?INDEX (\S+)/.exec(step.detail);
    if (index) indexes.add(index[1]);
    if (scan && !scan[2]) {
      const table = aliases.get(scan[1]) ?? scan[1];
      if (tables.has(table)) fullScans.add(table);
    }
  }
  const indexCandidates = [...fullScans].map((table) => ({ table, columns: comparedColumns(sql, table, aliases) }));
  return { plan, fullScans: [...fullScans], indexes: [...indexes], indexCandidates };
}

/** `FROM "table" AS "alias"` and `JOIN "table" AS "alias"`: alias to table. */
function aliasMap(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of sql.matchAll(/(?:FROM|JOIN)\s+"([^"]+)"(?:\s+AS\s+"([^"]+)")?/gi)) {
    map.set(match[2] ?? match[1], match[1]);
    map.set(match[1], match[1]);
  }
  return map;
}

/**
 * Columns of `table` that appear on the left of a comparison: `"alias"."col"
 * <op>` for any alias of the table, or a bare `"col" <op>` when the table is
 * the statement's first FROM. A heuristic over the compiled text, reported
 * as candidates, never applied.
 */
function comparedColumns(sql: string, table: string, aliases: Map<string, string>): string[] {
  const columns = new Set<string>();
  const ops = String.raw`\s*(?:=|<>|!=|<=|>=|<|>|IN\b|IS\b|LIKE\b|GLOB\b|BETWEEN\b)`;
  for (const match of sql.matchAll(new RegExp(String.raw`"([^"]+)"\."([^"]+)"${ops}`, "gi"))) {
    if (aliases.get(match[1]) === table && match[2] !== "id") columns.add(match[2]);
  }
  const first = /FROM\s+"([^"]+)"/i.exec(sql)?.[1];
  if (first === table) {
    const where = sql.slice(sql.search(/\bWHERE\b/i) + 1 || sql.length);
    for (const match of where.matchAll(new RegExp(String.raw`(?<![."])"([^"]+)"${ops}`, "gi"))) {
      if (match[1] !== "id" && !aliases.has(match[1])) columns.add(match[1]);
    }
  }
  return [...columns].sort();
}

/** FNV-1a over the text, as hex: stable and cheap, not cryptographic. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0") + text.length.toString(16);
}
