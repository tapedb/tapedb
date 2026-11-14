/**
 * Staged evaluation: running part of a filter first, into a scratch table, so
 * the statement that uses it stays within SQLite's limits.
 *
 * A Durable Object's SQLite refuses expressions deeper than 100 and very long
 * statements. A relation filter compiles to a correlated subquery, and SQLite
 * counts the enclosing expression again for every subquery nested inside
 * another, so one statement holds only a few hops. A filter with thousands of
 * branches makes a statement too long. Neither is a property of the query
 * being unreasonable, so neither is refused: the compiler cuts the filter into
 * stages. Each stage is a shallow `INSERT ... SELECT` of matching ids into
 * `_tapedb_scratch`, run in dependency order, and the statement that needed it
 * tests membership with a one-level subquery.
 *
 * Temporary tables are not authorised in a Durable Object (`SQLITE_AUTH`), so
 * the scratch table is an ordinary one. Its rows live only for one statement:
 * stages, statement and cleanup run synchronously in one turn of the object,
 * so nothing else can observe them, and a transaction that rolls back takes
 * them with it. Recovery, snapshots and export only touch the tables on their
 * allow-lists, so the scratch table never reaches a copy of the workspace.
 */

import type { SqlExecutor, SqlRow, SqlValue } from "./tx-sql";

export const SCRATCH_TABLE = "_tapedb_scratch";

/** Relation filters nested this many hops inside a statement start a new stage. */
export const STAGE_DEPTH = 3;

/** Conditions longer than this many characters are split into stages. */
export const MAX_CONDITION_SQL = 30_000;

export interface Stage {
  /** Placeholder for this stage's scratch key; replaced with a fresh key per run. */
  key: string;
  /** `INSERT OR IGNORE INTO _tapedb_scratch (k, id) SELECT ?, ...`; the first parameter is `key`. */
  sql: string;
  params: SqlValue[];
  /**
   * A stage a SQL predicate cannot express: `sql` selects candidate rows
   * (`alias.*` plus the staged value as `"__tapedb_staged"`), they are read in
   * id order a chunk at a time, and only those `keep` accepts are staged.
   * Used for a read rule that is a function, which runs on fetched rows.
   */
  scan?: { alias: string; keep: (row: SqlRow) => boolean };
}

/** Rows a scan stage reads per statement, and ids it stages per insert. */
const SCAN_CHUNK = 1000;

// Placeholders carry a random per-isolate prefix: a filter value a client
// sends can equal one only by guessing it. Made on first use, because a
// Worker may not generate random values at module load.
let keyPrefix: string | null = null;
let nextKey = 0;

/** A fresh stage placeholder. */
export function stageKey(): string {
  keyPrefix ??= `\u0000tapedb-stage:${globalThis.crypto.randomUUID()}:`;
  nextKey += 1;
  return `${keyPrefix}${nextKey}`;
}

/** `column IN (ids staged under key)`, or `NOT IN`. */
export function membership(column: string, key: string, negate = false): { sql: string; params: SqlValue[] } {
  return {
    sql: `${column} ${negate ? "NOT IN" : "IN"} (SELECT "id" FROM "${SCRATCH_TABLE}" WHERE "k" = ?)`,
    params: [key],
  };
}

/** The `INSERT ... SELECT` that stages `select` (an id-valued expression) from `from` where `where` holds. */
export function stageInsert(key: string, select: string, from: string, where: string, params: SqlValue[]): Stage {
  return {
    key,
    sql: `INSERT OR IGNORE INTO "${SCRATCH_TABLE}" ("k", "id") SELECT ?, ${select} FROM ${from} WHERE ${where}`,
    params: [key, ...params],
  };
}

const ensured = new WeakSet<SqlExecutor>();

function ensureScratch(sql: SqlExecutor): void {
  if (ensured.has(sql)) return;
  sql.exec(
    `CREATE TABLE IF NOT EXISTS "${SCRATCH_TABLE}" ("k" TEXT NOT NULL, "id" TEXT NOT NULL, PRIMARY KEY ("k", "id")) WITHOUT ROWID`
  );
  ensured.add(sql);
}

function freshKey(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Runs `stages` in order, then `run` with `params`, then removes the staged
 * rows. Every stage placeholder in the stages' and the statement's parameters
 * is replaced with a key unique to this run, so a compiled query can be run
 * again, or by another subscriber, without its stages colliding.
 */
export function runStaged<T>(
  sql: SqlExecutor,
  stages: readonly Stage[] | undefined,
  params: readonly SqlValue[],
  run: (params: SqlValue[]) => T
): T {
  if (stages === undefined || stages.length === 0) return run([...params]);

  const keys = new Map<string, string>();
  for (const stage of stages) {
    if (!keys.has(stage.key)) keys.set(stage.key, freshKey());
  }
  const bind = (values: readonly SqlValue[]): SqlValue[] =>
    values.map((value) => (typeof value === "string" && keys.has(value) ? keys.get(value)! : value));

  ensureScratch(sql);
  const used = [...keys.values()];
  try {
    for (const stage of stages) {
      if (stage.scan === undefined) sql.exec(stage.sql, ...bind(stage.params));
      else runScan(sql, stage, bind(stage.params));
    }
    return run(bind(params));
  } finally {
    sql.exec(`DELETE FROM "${SCRATCH_TABLE}" WHERE "k" IN (SELECT value FROM json_each(?))`, JSON.stringify(used));
  }
}

/** The `SELECT` a scan stage reads candidates with; the first parameter is the key. */
export function stageScan(
  key: string,
  alias: string,
  select: string,
  from: string,
  where: string,
  params: SqlValue[],
  keep: (row: SqlRow) => boolean
): Stage {
  return {
    key,
    sql: `SELECT ${alias}.*, ${select} AS "__tapedb_staged" FROM ${from} WHERE ${where}`,
    params: [key, ...params],
    scan: { alias, keep },
  };
}

function runScan(sql: SqlExecutor, stage: Stage, params: SqlValue[]): void {
  const [key, ...where] = params;
  const { alias, keep } = stage.scan!;
  let after: SqlValue | null = null;
  for (;;) {
    const rows: SqlRow[] =
      after === null
        ? sql.all(`${stage.sql} ORDER BY ${alias}."id" LIMIT ${SCAN_CHUNK}`, ...where)
        : sql.all(`${stage.sql} AND ${alias}."id" > ? ORDER BY ${alias}."id" LIMIT ${SCAN_CHUNK}`, ...where, after);
    const kept = rows
      .filter((row) => row.__tapedb_staged !== null && keep(row))
      .map((row) => row.__tapedb_staged);
    if (kept.length > 0) {
      sql.exec(
        `INSERT OR IGNORE INTO "${SCRATCH_TABLE}" ("k", "id") SELECT ?, value FROM json_each(?)`,
        key,
        JSON.stringify(kept)
      );
    }
    if (rows.length < SCAN_CHUNK) return;
    after = rows[rows.length - 1].id;
  }
}

/** Every stage a set of conditions depends on, in order, once each. */
export function stagesOf(conditions: readonly { stages?: readonly Stage[] }[]): Stage[] | undefined {
  // Deduplicated by identity, not key: an OR stages each of its chunks under
  // one key, and every one of them has to run.
  const out: Stage[] = [];
  const seen = new Set<Stage>();
  for (const condition of conditions) {
    for (const stage of condition.stages ?? []) {
      if (seen.has(stage)) continue;
      seen.add(stage);
      out.push(stage);
    }
  }
  return out.length === 0 ? undefined : out;
}
