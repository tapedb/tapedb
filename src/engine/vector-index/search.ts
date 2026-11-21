/**
 * Nearest-neighbour search: the read side of an indexed vector field.
 *
 * The index is a cache of rows that were written earlier, and it answers a
 * question about the past: a vector it holds can belong to a row that has since
 * been deleted, edited or erased. So a search never answers with what the index
 * returned. It asks the index for candidates, then re-reads every one of them
 * from this workspace's SQLite, which is the only authority on which rows exist
 * and which of them the caller may see.
 *
 * The order of the answer is the index's ranking; everything else comes from
 * the read:
 *
 * 1. **Candidates.** `index.query` with the workspace's namespace, the
 *    declared filter fields as provider metadata (applied before the ranking,
 *    which is what makes a filtered search return `limit` matches rather than
 *    whatever survives a filter over an unfiltered ranking), and metadata
 *    requested so each candidate carries the digest it was published under.
 * 2. **Rows.** The digest is the only handle back to a row: a vector's ID is a
 *    hash of the row ID, not the row ID, and provider metadata carries no row
 *    ID by design. `_vector_state` maps the digest the provider holds to the
 *    row it was published for.
 * 3. **The re-read.** One compiled query with the caller's `where`, the filter
 *    values and `id IN (…)`, executed through the same path a `findMany` takes,
 *    so `view` rules, `where` rules and row-level rules apply exactly as they
 *    do to a read. A row the caller cannot read is simply absent: not present
 *    with a null score, and not counted anywhere.
 * 4. **The version gate.** Each surviving row's digest is recomputed from the
 *    vector and filter values SQLite holds now. A candidate whose digest moved
 *    describes a state of that row that no longer exists — the embedding was
 *    replaced and the new one is not in the index yet — so it is dropped rather
 *    than ranked on the old vector. A candidate whose row is gone is dropped by
 *    the re-read itself.
 *
 * None of those drops is an error, and none of them is reported: the count, the
 * IDs and the scores of rows the caller may not see would each be a way to tell
 * that they exist. A search that finds nothing answers with no rows.
 *
 * The search is not live. It is one provider query and one SQLite read per
 * call, and nothing here subscribes: the result ages the moment it is sent.
 */

import type { RoleClaim } from "../../claims";
import { canonicalVectorValue, decodeVector } from "../../model/vector";
import { compileQuery } from "../query-compile";
import {
  authorizeQuery,
  executeCompiledQueryWithPageInfo,
  viewAccess,
} from "../query-execute";
import { invalidValue, isPlainObject, type QueryWhere } from "../query-types";
import { findNamespace, type NamespaceDefinition } from "../registry";
import type { SqlExecutor, SqlRow } from "../tx-sql";
import { TxError } from "../tx-types";
import type { ConfiguredVectorize } from "./definition";
import { fuseRanks, keywordMatches } from "./keyword";
import { vectorRowDigest, type VectorFilterValue } from "./digest";
import { vectorNamespaceFor } from "./identity";
import { VECTOR_STATE_TABLE } from "./queue";
import type { VectorIndex, VectorMatch } from "./types";

/**
 * The most matches one search returns: the provider's ceiling for a query that
 * returns metadata, which the version gate needs. A larger `limit` is refused
 * rather than clamped, because a caller who asked for 200 and got 50 would read
 * the answer as "this is all there is".
 */
export const VECTOR_SEARCH_MAX_LIMIT = 50;

/** Matches per search when the caller does not say. */
export const VECTOR_SEARCH_DEFAULT_LIMIT = 10;

/** What a caller sends to `POST /search`. */
export interface VectorSearchRequest {
  /** The indexed model's API name. */
  model?: unknown;
  /** The query embedding, as the numbers a write takes. Alternative to `text`. */
  vector?: unknown;
  /**
   * The query in words. The engine embeds it through the deployment's
   * `vectorize.embed` binding, so a caller does not have to run the same model
   * the corpus was embedded with. Refused when the deployment configures no
   * embedding binding.
   */
  text?: unknown;
  /** 1 to {@link VECTOR_SEARCH_MAX_LIMIT}. */
  limit?: unknown;
  /** Equality on the declared filter fields only. */
  filter?: unknown;
  /** The engine's `where`, applied to the rows the index returned. */
  where?: unknown;
  /** API attribute names, which narrows rows the way a read's `select` does. */
  select?: unknown;
}

/** What a search answers. */
export interface VectorSearchAnswer {
  /** The indexed model, so the payload can be keyed by it. */
  model: string;
  /**
   * How the rows were ranked. `vector` means the index alone and the score is
   * the provider's cosine similarity. `hybrid` means the index and the
   * workspace's FTS5 keyword index, merged by reciprocal rank, and the score is
   * that fused rank: comparable within the answer, not a cosine.
   */
  mode: "vector" | "hybrid";
  /** Rows in rank order, each shaped like a read with the same `select`. */
  rows: Record<string, unknown>[];
  /** Score per row ID, for the rows in `rows`. */
  scores: Record<string, number>;
  /** True when the index returned as many candidates as it was asked for. */
  truncated: boolean;
  /** True when a reranker decided the order and the scores. */
  reranked: boolean;
}

/**
 * Runs one search. Everything the caller can get wrong is refused before the
 * provider is called; everything the database knows wins over the index.
 */
export async function executeVectorSearch(input: {
  sql: SqlExecutor;
  claim: RoleClaim;
  config: ConfiguredVectorize | null;
  index: VectorIndex | null;
  workspaceId: string;
  request: VectorSearchRequest;
  /**
   * Runs one synchronous read, retrying whatever the personal runtime defers
   * to a later pass (`PersonalRuntime.read`). The room passes it when the
   * schema has personal fields.
   */
  reads?: <T>(fn: () => T) => Promise<T>;
  /**
   * Embeds one text into the field's declared length, through the binding
   * `vectorize.embed` names. Required only for a `text` query.
   */
  embed?: (text: string) => Promise<readonly number[]>;
  /**
   * Scores each passage against the query, through the reranker
   * `vectorize.rerank` names. Applied only to a text query: a vector has no
   * words for a cross-encoder to read.
   */
  rerank?: (query: string, passages: readonly string[]) => Promise<readonly number[]>;
}): Promise<VectorSearchAnswer> {
  const { sql, claim, config, index, workspaceId, request } = input;
  if (config === null) {
    throw new TxError(
      "invalid_op",
      "This deployment does not configure vectorize, so it has no index to search."
    );
  }
  if (index === null) {
    throw new TxError(
      "storage_error",
      `This deployment has no Vectorize binding named ${JSON.stringify(config.binding)}.`
    );
  }
  if (request.model !== config.model) {
    throw new TxError(
      "invalid_op",
      `Only ${config.model} is indexed; its ${config.field} is the field this deployment searches.`
    );
  }

  const limit = searchLimit(request.limit);
  const filter = searchFilter(config, request.filter);
  const vector = await searchQueryVector(config, request, input.embed);
  const select = searchSelect(request.select);
  const where = searchWhere(request.where);

  const namespace = await vectorNamespaceFor(config.binding, workspaceId);
  const candidates = await queryIndex(index, vector, {
    namespace,
    limit,
    filter,
    workspaceId,
    binding: config.binding,
  });

  // The index's own order, and the digest each candidate was published under.
  const digestToRow = rowsForDigests(sql, config.model, candidates);
  const vectorIds: string[] = [];
  const digestByRowId = new Map<string, string>();
  for (const candidate of candidates) {
    const digest = candidate.metadata?.digest;
    if (typeof digest !== "string") continue;
    const rowId = digestToRow.get(digest);
    if (rowId === undefined || digestByRowId.has(rowId)) continue;
    digestByRowId.set(rowId, digest);
    vectorIds.push(rowId);
  }

  // Keyword recall, when the deployment indexes text and the caller sent words.
  // Its candidates come from this workspace's SQLite, so they are available
  // before the provider has seen anything.
  const useKeywords = config.keywordFields.length > 0 && typeof request.text === "string";
  const keywordIds = useKeywords
    ? keywordMatches(sql, config, request.text as string, limit, filter).map((match) => match.id)
    : [];

  // A full page from either side means rows may rank below the cut.
  const truncated = candidates.length >= limit || keywordIds.length >= limit;

  if (useKeywords) {
    const fused = fuseRanks([vectorIds, keywordIds], limit);
    if (fused.length === 0) {
      return { model: config.model, mode: "hybrid", rows: [], scores: {}, truncated, reranked: false };
    }
    const candidateIds = fused.map((entry) => entry.id);
    const rows = await readRows(input, {
      model: config.model,
      select: columnsForRead(config, select),
      where: andWhere([where, filter, { id: { $in: candidateIds } }]),
      limit: candidateIds.length,
    });
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const hybridRanked: Array<{ row: Record<string, unknown>; score: number }> = [];
    for (const entry of fused) {
      const row = byId.get(entry.id);
      if (row === undefined) continue;
      // A vector candidate must still describe the row it ranked; a keyword
      // candidate is a lexical hit on the current row and needs no digest.
      const published = digestByRowId.get(entry.id);
      if (published !== undefined && !(await isCurrent(row, entry.id, published, config))) continue;
      hybridRanked.push({ row: project(row, select, config), score: entry.score });
    }
    const rerankedRows = await rerankRows(input.rerank, request, config, hybridRanked);
    const hybridScores: Record<string, number> = {};
    for (const entry of rerankedRows.ranked) hybridScores[String(entry.row.id)] = entry.score;
    return {
      model: config.model,
      mode: "hybrid",
      rows: rerankedRows.ranked.map((entry) => entry.row),
      scores: hybridScores,
      truncated,
      reranked: rerankedRows.applied,
    };
  }

  if (vectorIds.length === 0) {
    return { model: config.model, mode: "vector", rows: [], scores: {}, truncated, reranked: false };
  }

  const ids = vectorIds;

  const found = await readRows(input, {
    model: config.model,
    // The read is asked for the vector and the filter columns whatever the
    // caller selected: the version gate compares them with the digest, and a
    // candidate cannot be trusted on the strength of a column nobody read.
    select: columnsForRead(config, select),
    where: andWhere([where, filter, { id: { $in: ids } }]),
    limit: ids.length,
  });

  const scoreByDigest = new Map<string, number>();
  for (const candidate of candidates) {
    const digest = candidate.metadata?.digest;
    if (typeof digest === "string") scoreByDigest.set(digest, candidate.score);
  }

  const ranked: Array<{ row: Record<string, unknown>; score: number }> = [];
  for (const row of found) {
    const rowId = String(row.id);
    const published = digestByRowId.get(rowId);
    if (published === undefined) continue;
    if (!(await isCurrent(row, rowId, published, config))) continue;
    const score = scoreByDigest.get(published);
    if (score === undefined) continue;
    ranked.push({ row: project(row, select, config), score });
  }

  // The index ranked these; a stable sort keeps its order among equal scores,
  // which is the provider's tie-break and not this engine's invention.
  ranked.sort((left, right) => right.score - left.score);

  const rerankedRows = await rerankRows(input.rerank, request, config, ranked);
  const scores: Record<string, number> = {};
  for (const entry of rerankedRows.ranked) scores[String(entry.row.id)] = entry.score;
  return {
    model: config.model,
    mode: "vector",
    rows: rerankedRows.ranked.map((entry) => entry.row),
    scores,
    truncated,
    reranked: rerankedRows.applied,
  };
}

/**
 * Reorders the candidate window with the reranker and replaces the scores with
 * its relevance. Only a text query can be reranked: a cross-encoder reads the
 * query as words. A reranker that fails or answers a different number of
 * passages leaves the retrieval order in place and says so in `reranked`,
 * because an answer that is merely less well ordered is better than no answer.
 */
async function rerankRows(
  rerank: ((query: string, passages: readonly string[]) => Promise<readonly number[]>) | undefined,
  request: VectorSearchRequest,
  config: ConfiguredVectorize,
  ranked: Array<{ row: Record<string, unknown>; score: number }>
): Promise<{ ranked: Array<{ row: Record<string, unknown>; score: number }>; applied: boolean }> {
  if (rerank === undefined || typeof request.text !== "string" || ranked.length === 0) {
    return { ranked, applied: false };
  }
  const passages = ranked.map((entry) =>
    config.keywordFields.map((field) => String(entry.row[field.attribute] ?? "")).join("\n")
  );
  let scores: readonly number[];
  try {
    scores = await rerank(request.text, passages);
  } catch {
    return { ranked, applied: false };
  }
  if (scores.length !== ranked.length) return { ranked, applied: false };
  const reordered = ranked
    .map((entry, index) => ({ row: entry.row, score: Number(scores[index] ?? entry.score) }))
    .sort((left, right) => right.score - left.score);
  return { ranked: reordered, applied: true };
}

/** The limit a caller asked for, refused rather than clamped past the ceiling. */
function searchLimit(value: unknown): number {
  if (value === undefined || value === null) return VECTOR_SEARCH_DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw invalidValue(`"limit" must be a whole number from 1 to ${VECTOR_SEARCH_MAX_LIMIT}.`);
  }
  if (value > VECTOR_SEARCH_MAX_LIMIT) {
    throw invalidValue(
      `"limit" is ${value}; a search returns at most ${VECTOR_SEARCH_MAX_LIMIT} matches, the provider's ceiling for a query that returns metadata.`
    );
  }
  return value;
}

/**
 * The query embedding, through the codec a write uses: the same length check,
 * the same float32 conversion, and the same message when it is wrong.
 */
/**
 * The query vector, from either the numbers the caller sent or the words it
 * asked to embed. Both are alternatives: sending both is ambiguous, and
 * sending words to a deployment with no embedding binding is a deployment
 * error the caller can see rather than an empty answer.
 */
async function searchQueryVector(
  config: ConfiguredVectorize,
  request: VectorSearchRequest,
  embed: ((text: string) => Promise<readonly number[]>) | undefined
): Promise<number[]> {
  const hasVector = request.vector !== undefined && request.vector !== null;
  const hasText = request.text !== undefined && request.text !== null;
  if (hasVector && hasText) {
    throw invalidValue('"vector" and "text" are alternatives; send one of them.');
  }
  if (!hasText) return searchVector(config, request.vector);

  if (typeof request.text !== "string" || request.text.trim() === "") {
    throw invalidValue('"text" must be a non-empty string.');
  }
  if (config.embed === null || embed === undefined) {
    throw invalidValue(
      `This deployment does not configure an embedding binding, so it cannot embed a text query. Send "vector", or set defineTapeDB({ vectorize: { embed: { binding: "AI" } } }).`
    );
  }
  let values: readonly number[];
  try {
    values = await embed(request.text);
  } catch (error) {
    // The binding's failure is not the caller's fault; its text may name
    // provider internals, so the answer says only that embedding is unavailable.
    throw new TxError(
      "storage_error",
      `The embedding binding did not answer (${error instanceof Error ? error.message : String(error)}); retry shortly.`
    );
  }
  // The same validator a write and a vector query pass: length, finiteness,
  // and the all-zero refusal.
  return searchVector(config, values);
}

function searchVector(config: ConfiguredVectorize, value: unknown): number[] {
  try {
    return decodeVector(canonicalVectorValue(value, config.dimensions), config.dimensions);
  } catch (error) {
    throw invalidValue(
      `Attribute "${config.field}" ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * The filter, as the provider takes it: equality on the attributes the
 * deployment declared, typed as the attribute is. Anything else is refused
 * here, before a provider call: an undeclared attribute has no metadata index,
 * so a filter on it would either match nothing or match on a value the index
 * does not carry.
 */
function searchFilter(
  config: ConfiguredVectorize,
  value: unknown
): Record<string, string | number | boolean> {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    throw invalidValue('"filter" must be an object of the declared filter fields.');
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [attribute, raw] of Object.entries(value)) {
    if (raw === undefined) continue;
    const declared = config.filters.find((entry) => entry.attribute === attribute);
    if (declared === undefined) {
      const allowed = config.filters.map((entry) => entry.attribute);
      throw invalidValue(
        `${JSON.stringify(attribute)} is not a filter field of this index; defineTapeDB({ vectorize }) declares ${allowed.length === 0 ? "none" : allowed.map((name) => JSON.stringify(name)).join(", ")}.`
      );
    }
    if (declared.type === "boolean") {
      if (typeof raw !== "boolean") {
        throw invalidValue(`The filter on "${attribute}" must be a boolean; it is ${kindOf(raw)}.`);
      }
    } else if (declared.type === "number") {
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        throw invalidValue(`The filter on "${attribute}" must be a finite number; it is ${kindOf(raw)}.`);
      }
    } else if (typeof raw !== "string") {
      throw invalidValue(`The filter on "${attribute}" must be a string; it is ${kindOf(raw)}.`);
    }
    out[attribute] = raw;
  }
  return out;
}

function searchSelect(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    throw invalidValue('"select" must be an array of attribute names.');
  }
  return [...new Set(value as string[])];
}

function searchWhere(value: unknown): QueryWhere | null {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw invalidValue('"where" must be an object of filters.');
  }
  return value as QueryWhere;
}

async function queryIndex(
  index: VectorIndex,
  vector: readonly number[],
  options: {
    namespace: string;
    limit: number;
    filter: Record<string, string | number | boolean>;
    workspaceId: string;
    binding: string;
  }
): Promise<VectorMatch[]> {
  try {
    const result = await index.query(vector, {
      namespace: options.namespace,
      topK: options.limit,
      // Metadata is what carries the digest, so it must come back with the
      // matches: without it there is no way back to a row.
      returnMetadata: "all",
      ...(Object.keys(options.filter).length === 0 ? {} : { filter: options.filter }),
    });
    return result.matches;
  } catch (error) {
    // A provider failure is not the caller's fault and its text may name
    // provider internals; the answer says only that the index is unavailable.
    console.error("workspace_vector_search_failed", {
      workspaceId: options.workspaceId,
      binding: options.binding,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new TxError("storage_error", "The vector index did not answer; retry shortly.");
  }
}

/**
 * Digest to row ID, from the state the queue recorded when the provider
 * accepted each vector. A digest that is not here belongs to a state this
 * workspace has since replaced or deleted, so its candidate is dropped.
 */
function rowsForDigests(
  sql: SqlExecutor,
  model: string,
  candidates: readonly VectorMatch[]
): Map<string, string> {
  const digests = new Set<string>();
  for (const candidate of candidates) {
    const digest = candidate.metadata?.digest;
    if (typeof digest === "string" && digest !== "") digests.add(digest);
  }
  if (digests.size === 0) return new Map();

  const values = [...digests];
  const stored = sql.all<SqlRow>(
    `SELECT row_id, digest FROM "${VECTOR_STATE_TABLE}"
      WHERE model = ? AND digest IN (${values.map(() => "?").join(", ")})`,
    model,
    ...values
  );
  const out = new Map<string, string>();
  for (const row of stored) {
    if (typeof row.digest === "string" && typeof row.row_id === "string") {
      out.set(row.digest, row.row_id);
    }
  }
  return out;
}

/** Reads the candidates through the same path a `findMany` takes. */
async function readRows(
  input: { sql: SqlExecutor; claim: RoleClaim; reads?: <T>(fn: () => T) => Promise<T> },
  args: { model: string; select: string[]; where: QueryWhere; limit: number }
): Promise<Record<string, unknown>[]> {
  const document = { [args.model]: { $: { where: args.where, select: args.select, limit: args.limit } } };
  try {
    const compiled = compileQuery(document, viewAccess(input.claim));
    // The same gate a read passes: `view` on the namespace, or a refusal.
    authorizeQuery(input.claim, compiled);
    const run = () => executeCompiledQueryWithPageInfo(input.sql, compiled, input.claim);
    const data = input.reads === undefined ? run().data : await input.reads(run).then((read) => read.data);
    return (data[args.model] ?? []) as Record<string, unknown>[];
  } catch (error) {
    if (error instanceof TxError) throw error;
    throw new TxError("storage_error", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Which of `ids` this caller may read, through the same query path a search's
 * candidates take. A row that is hidden, deleted or outside the caller's view
 * is simply absent from the answer, so an operator cannot use this to learn
 * that a row exists.
 */
export async function visibleRowIds(
  input: { sql: SqlExecutor; claim: RoleClaim; reads?: <T>(fn: () => T) => Promise<T> },
  model: string,
  ids: readonly string[]
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await readRows(input, {
    model,
    select: ["id"],
    where: { id: { $in: [...ids] } } as QueryWhere,
    limit: ids.length,
  });
  return rows.map((row) => String(row.id));
}

/**
 * Whether the vector the index holds for this row is still the row's vector.
 *
 * The digest covers the vector bytes and the filter values, so a row whose
 * embedding or filter attribute moved since it was published fails this and is
 * dropped: it would otherwise be ranked on an embedding it no longer has. A
 * value this build cannot decode fails it too — such a row could only come
 * from a restore or a hand-edited column, and it is not a candidate.
 */
async function isCurrent(
  row: Record<string, unknown>,
  rowId: string,
  published: string,
  config: ConfiguredVectorize
): Promise<boolean> {
  const vector = row[config.field];
  if (typeof vector !== "string" || vector === "") return false;
  try {
    const digest = await vectorRowDigest({
      model: config.model,
      rowId,
      vector,
      dimensions: config.dimensions,
      filters: digestFilters(config, row),
    });
    return digest === published;
  } catch {
    return false;
  }
}

/**
 * The filter values of a row as the queue hashed them when it published: in API
 * attribute names, a boolean as a boolean, a number as a number, a string as a
 * string, and an absent value left out. This is the same mapping
 * `filterValuesOf` in `queue.ts` applies to a stored row, and the two must
 * agree or every candidate would read as stale.
 */
function digestFilters(
  config: ConfiguredVectorize,
  row: Record<string, unknown>
): Record<string, VectorFilterValue> {
  const values: Record<string, VectorFilterValue> = {};
  for (const filter of config.filters) {
    const value = row[filter.attribute];
    if (value === null || value === undefined) continue;
    values[filter.attribute] =
      filter.type === "boolean" ? value === true : filter.type === "number" ? Number(value) : String(value);
  }
  return values;
}

/**
 * The columns to read: the caller's `select`, or every attribute a default
 * projection returns, plus the vector and the filter fields the version gate
 * needs. Those extra values never reach the caller — `project` strips them —
 * but they must be read in the same statement that decides visibility.
 */
function columnsForRead(config: ConfiguredVectorize, select: string[] | null): string[] {
  const namespace = findNamespace(config.model);
  const wanted =
    select ??
    (namespace === undefined
      ? ["id"]
      : [...defaultProjection(namespace), "createdAt", "updatedAt", "updatedSeq"]);
  return [
    ...new Set([
      ...wanted,
      config.field,
      ...config.filters.map((entry) => entry.attribute),
      // A reranker reads the passage, so the read has to carry its text even
      // when the caller's `select` does not.
      ...config.keywordFields.map((entry) => entry.attribute),
    ]),
  ];
}

/** The attributes a read without `select` returns, in declaration order. */
function defaultProjection(namespace: NamespaceDefinition): string[] {
  return ["id", ...Object.keys(namespace.attributes)];
}

/**
 * The row as the caller asked for it. The embedding is never returned, even
 * when the `select` names it: a search answers with rows to show, not with the
 * vectors they were found by.
 */
function project(
  row: Record<string, unknown>,
  select: string[] | null,
  config: ConfiguredVectorize
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  delete out[config.field];
  if (select === null) return out;
  for (const key of Object.keys(out)) {
    if (key === "id" || key === "$erased") continue;
    if (!select.includes(key)) delete out[key];
  }
  return out;
}

/** Combines the conditions a search's read needs, or null when there are none. */
function andWhere(parts: Array<QueryWhere | null>): QueryWhere {
  const conditions = parts.filter((part): part is QueryWhere => part !== null && Object.keys(part).length > 0);
  if (conditions.length === 0) return {};
  return conditions.length === 1 ? conditions[0]! : { $and: conditions };
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
