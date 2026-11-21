/**
 * Keyword recall for a deployment that searches with words.
 *
 * A vector index misses what the embedding blurs: a part number, an acronym, a
 * name spelled exactly. A workspace already has the text in its own SQLite, so
 * the keyword side is an FTS5 table in that same database, maintained by
 * triggers inside the write's transaction, queried with `bm25` and merged with
 * the vector candidates by reciprocal rank.
 *
 * This is not the index: keyword candidates come from the workspace's own rows,
 * so they need no provider call, no digest gate and no visibility wait. A row
 * written a second ago is findable by its exact words while its vector is still
 * pending, which is the one part of search latency this feature removes.
 */

import type { SqlExecutor, SqlValue } from "../tx-sql";
import type { ConfiguredVectorize } from "./definition";

/** The FTS5 table, one per workspace: a deployment indexes one model. */
export const VECTOR_KEYWORD_TABLE = "_vector_keyword";

/** The key in `_engine_meta` recording which fields the table was built for. */
const BACKFILL_KEY = "vector_keyword_fields";

const TRIGGER_PREFIX = "_tapedb_keyword_";

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function columns(config: ConfiguredVectorize): string[] {
  return config.keywordFields.map((field) => field.column);
}

/**
 * Creates the FTS5 table and its triggers, and backfills rows that predate the
 * option. A changed field list rebuilds the table, because an FTS5 column set
 * cannot be altered in place; the backfill is guarded by a record of the fields
 * so a boot does not rescan a large table.
 */
export function installKeywordIndex(sql: SqlExecutor, config: ConfiguredVectorize): void {
  if (config.keywordFields.length === 0) return;
  const fields = columns(config);
  const recorded = sql.one<{ value: string }>(
    `SELECT value FROM "_engine_meta" WHERE "key" = ?`,
    BACKFILL_KEY
  )?.value;
  const wanted = fields.join(",");

  if (recorded !== undefined && recorded !== wanted) {
    // The field list changed: the old table's columns mean nothing now.
    dropKeywordIndex(sql, config);
  }

  try {
    sql.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${quote(VECTOR_KEYWORD_TABLE)} USING fts5(${fields
        .map(quote)
        .join(", ")}, tokenize = 'unicode61')`
    );
  } catch (error) {
    // A table left with another column set cannot be reused; rebuild it.
    if (!/already exists/i.test(error instanceof Error ? error.message : String(error))) throw error;
    dropKeywordIndex(sql, config);
    sql.exec(
      `CREATE VIRTUAL TABLE ${quote(VECTOR_KEYWORD_TABLE)} USING fts5(${fields
        .map(quote)
        .join(", ")}, tokenize = 'unicode61')`
    );
  }

  for (const [suffix, timing, body] of [
    [
      "ai",
      "INSERT",
      `INSERT INTO ${quote(VECTOR_KEYWORD_TABLE)}(rowid, ${fields.map(quote).join(", ")})
       VALUES (new.rowid, ${fields.map((field) => `new.${quote(field)}`).join(", ")})`,
    ],
    [
      "au",
      "UPDATE",
      `DELETE FROM ${quote(VECTOR_KEYWORD_TABLE)} WHERE rowid = old.rowid;
       INSERT INTO ${quote(VECTOR_KEYWORD_TABLE)}(rowid, ${fields.map(quote).join(", ")})
       VALUES (new.rowid, ${fields.map((field) => `new.${quote(field)}`).join(", ")})`,
    ],
    [
      "ad",
      "DELETE",
      `DELETE FROM ${quote(VECTOR_KEYWORD_TABLE)} WHERE rowid = old.rowid`,
    ],
  ] as const) {
    sql.exec(
      `CREATE TRIGGER IF NOT EXISTS ${quote(`${TRIGGER_PREFIX}${config.table}_${suffix}`)}
         AFTER ${timing} ON ${quote(config.table)}
       BEGIN ${body}; END`
    );
  }

  if (recorded === wanted) return;
  // Rows written before this option existed are not in the table yet.
  sql.exec(
    `INSERT INTO ${quote(VECTOR_KEYWORD_TABLE)}(rowid, ${fields.map(quote).join(", ")})
     SELECT rowid, ${fields.map(quote).join(", ")} FROM ${quote(config.table)}
      WHERE rowid NOT IN (SELECT rowid FROM ${quote(VECTOR_KEYWORD_TABLE)})`
  );
  sql.exec(
    `INSERT OR REPLACE INTO "_engine_meta" ("key", value) VALUES (?, ?)`,
    BACKFILL_KEY,
    wanted
  );
}

/** Removes the triggers and the table, when search stops or the fields change. */
export function dropKeywordIndex(sql: SqlExecutor, config: ConfiguredVectorize): void {
  for (const suffix of ["ai", "au", "ad"]) {
    sql.exec(`DROP TRIGGER IF EXISTS ${quote(`${TRIGGER_PREFIX}${config.table}_${suffix}`)}`);
  }
  sql.exec(`DROP TABLE IF EXISTS ${quote(VECTOR_KEYWORD_TABLE)}`);
  sql.exec(`DELETE FROM "_engine_meta" WHERE "key" = ?`, BACKFILL_KEY);
}

/** One lexical candidate: the row it points at and its bm25 rank (lower is better). */
export interface KeywordMatch {
  id: string;
  rank: number;
}

/**
 * Rows matching the query terms, best first.
 *
 * The caller's text is tokenized here and every token is quoted, so FTS5
 * operators in a query (`AND`, `NEAR`, `-`, `"`) are words rather than syntax:
 * a search string is user input, not a query language. Terms are OR-ed, so a
 * multi-word query still matches a row that carries only one of them; the
 * fusion with the vector side is what decides the order.
 */
export function keywordMatches(
  sql: SqlExecutor,
  config: ConfiguredVectorize,
  text: string,
  limit: number,
  filter: Record<string, string | number | boolean>
): KeywordMatch[] {
  if (config.keywordFields.length === 0) return [];
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (tokens.length === 0) return [];
  const query = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");

  // Search stays "over the rows this index publishes": a keyword hit without an
  // embedding is a row nobody asked to be searchable.
  const conditions: string[] = [
    `n.${quote(config.column)} IS NOT NULL`,
    `n.${quote(config.column)} <> ''`,
  ];
  const params: SqlValue[] = [query];
  for (const [attribute, value] of Object.entries(filter)) {
    const field = config.filters.find((entry) => entry.attribute === attribute);
    if (field === undefined) continue;
    // A boolean is stored 0/1, the same conversion a write makes.
    conditions.push(`n.${quote(field.column)} = ?`);
    params.push(field.type === "boolean" ? (value === true ? 1 : 0) : (value as string | number));
  }
  params.push(limit);

  const rows = sql.all<{ id: string; rank: number }>(
    `SELECT n.id AS id, bm25(${quote(VECTOR_KEYWORD_TABLE)}) AS rank
       FROM ${quote(VECTOR_KEYWORD_TABLE)}
       JOIN ${quote(config.table)} AS n ON n.rowid = ${quote(VECTOR_KEYWORD_TABLE)}.rowid
      WHERE ${quote(VECTOR_KEYWORD_TABLE)} MATCH ?
        ${conditions.length === 0 ? "" : `AND ${conditions.join(" AND ")}`}
      ORDER BY rank, n.id
      LIMIT ?`,
    ...params
  );
  return rows.map((row) => ({ id: String(row.id), rank: Number(row.rank) }));
}

/**
 * Reciprocal-rank fusion of two ranked id lists. Cosine scores and bm25 scores
 * are not comparable, so their positions are: a row in both lists outranks a
 * row at the top of only one, and the constant softens the top of each list.
 */
export function fuseRanks(
  lists: ReadonlyArray<readonly string[]>,
  limit: number,
  constant = 60
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (const [position, id] of list.entries()) {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (constant + position + 1));
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
}
