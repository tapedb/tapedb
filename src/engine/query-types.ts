/**
 * Query document wire contract for the workspace engine.
 *
 * `where`, `order`, `limit`, `after`, `count`, `select`, `aggregate` and
 * nested link traversal at any depth. This module owns the typed
 * shapes and the registry-independent validation. Registry-specific checks
 * (namespace, attribute and link existence) live in `query-compile.ts`.
 *
 * Values describe the API shape: attribute names are camelCase registry names,
 * booleans are real booleans, dates are epoch milliseconds and `json`/`any`
 * attributes are JSON values. Storage conversion happens in `query-execute.ts`.
 */

import { parseAggregate, type AggregateGroup, type QueryAggregate } from "./query-aggregate";
import { TxError } from "./tx-types";

/**
 * Rows one statement reads. A read with a larger `limit`, or none, is served
 * in keyset chunks of this size, and includes hydrate this many parents per
 * statement, so no single statement grows with the result.
 */
export const QUERY_CHUNK_ROWS = 1000;

export type SortDirection = "asc" | "desc";

/** Scalars accepted by `where` and by comparison operators. */
export type QueryScalar = string | number | boolean | null;

/** Supported comparison operators. Anything else is rejected. */
export interface QueryComparison {
  $ne?: QueryScalar;
  $in?: QueryScalar[];
  /** Not in the list. Like `$ne`, also matches rows where the value is null. */
  $nin?: QueryScalar[];
  $gt?: QueryScalar;
  $gte?: QueryScalar;
  $lt?: QueryScalar;
  $lte?: QueryScalar;
  /**
   * True matches rows where the attribute is null, false where it is not.
   * The attribute exists on every row of a namespace — an optional field is
   * stored as null — so this is the only way to ask for "set" or "not set".
   * Relations are filtered with `$link`, not here.
   */
  $isNull?: boolean;
  /**
   * SQL `LIKE`, case-sensitive: `%` matches any run of characters, `_`
   * exactly one, and a backslash makes the next `%`, `_` or backslash
   * literal. Every other backslash is refused rather than guessed at.
   */
  $like?: string;
  /** `$like`, case-insensitive (ASCII, as SQLite's `lower()` is). */
  $ilike?: string;
}

export type QueryWhereValue = QueryScalar | QueryComparison;

/**
 * Attribute conditions, ANDed. Three reserved keys combine whole filters:
 * `$or` and `$and` take non-empty arrays of filters, `$not` takes one.
 */
/** How a relation filter matches: the parent row, or some/every/no children. */
export type RelationMode = "parent" | "some" | "every" | "none";

/**
 * A filter on a linked namespace, by the same label `include` uses. Compiled
 * into a correlated subquery, so the rows are never fetched.
 */
export interface QueryRelationFilter {
  label: string;
  mode: RelationMode;
  where: QueryWhere;
}

export interface QueryWhere {
  [attribute: string]:
    | QueryWhereValue
    | QueryWhere
    | QueryWhere[]
    | QueryRelationFilter[]
    | undefined;
  $or?: QueryWhere[];
  $and?: QueryWhere[];
  $not?: QueryWhere;
  $link?: QueryRelationFilter[];
}


export interface QueryOptions {
  where?: QueryWhere;
  order?: Record<string, SortDirection>;
  limit?: number;
  /**
   * Opaque cursor from a previous page's `pageInfo.nextCursor`. Requires an
   * explicit `order`, because a cursor is only meaningful against a total
   * order.
   */
  after?: string;
  /**
   * Top level only: also report how many rows match, ignoring `after` and
   * `limit`, as `pageInfo[namespace].count`. With `limit: 0` no rows are read.
   */
  count?: boolean;
  /**
   * Attributes to return, by API name. Omitted means every attribute. `id`
   * is always returned: live diffs key rows by it.
   */
  select?: string[];
  /**
   * Top level only: count, sum, avg, min and max over the matching rows,
   * optionally grouped. Reads no rows; the result is
   * `pageInfo[namespace].aggregate`.
   */
  aggregate?: QueryAggregate;
}

/**
 * One namespace/link level.
 *
 * `$` carries options; every other key is a registered link label for the
 * namespace at this level.
 */
export interface QueryNodeInput {
  $?: QueryOptions;
  [link: string]: QueryOptions | QueryNodeInput | undefined;
}

/** A query document keyed by top-level namespace API name. */
export interface QueryDocument {
  [namespace: string]: QueryNodeInput;
}

/** Result payload keyed by the requested top-level namespace names. */
export interface QueryResult {
  [namespace: string]: unknown[];
}

/**
 * Truncation metadata for one namespace. The default result cap is silent, so
 * a caller cannot otherwise tell 100 rows from the first 100 of 500.
 */
export interface PageInfo {
  /** The effective limit, or null when the namespace is uncapped. */
  limit: number | null;
  /** Rows actually returned for this namespace. */
  returned: number;
  /** True when more rows matched than were returned. */
  hasMore: boolean;
  /**
   * Opaque cursor for the next page, present only when `hasMore` is true and
   * the query has an explicit `order`. Pass it back as `$: { after }`.
   */
  nextCursor?: string;
  /** Total matching rows, when the query asked for `count`. */
  count?: number;
  /** The groups, when the query asked for `aggregate`. */
  aggregate?: AggregateGroup[];
}

export type QueryPageInfo = Record<string, PageInfo>;

export interface QueryResponse {
  ok: true;
  data: QueryResult;
}

export interface QueryErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

const OPTION_KEYS = new Set(["where", "order", "limit", "after", "count", "select", "aggregate"]);
const LOGICAL_KEYS = new Set(["$or", "$and", "$not", "$link"]);
const RELATION_MODES = new Set(["parent", "some", "every", "none"]);
const COMPARISON_OPERATORS = new Set([
  "$ne",
  "$in",
  "$nin",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$isNull",
  "$like",
  "$ilike",
]);

const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Validates the request envelope `{ query: {...} }` and returns the query
 * document. Unknown envelope keys are rejected rather than ignored.
 */
export function parseQueryEnvelope(value: unknown): QueryDocument {
  if (!isPlainObject(value)) {
    throw invalidOp("Query request body must be a JSON object.");
  }

  for (const key of Object.keys(value)) {
    if (key !== "query") {
      throw invalidOp(`Unknown query envelope key "${key}".`);
    }
  }

  if (!("query" in value)) {
    throw invalidOp('Query request body requires a "query" object.');
  }

  const query = value.query;
  if (!isPlainObject(query)) {
    throw invalidOp('"query" must be a plain object.');
  }

  return query as QueryDocument;
}

/**
 * Validates an options object (`$`). Attribute and link names are checked
 * later, against the registry.
 */
export function parseQueryOptions(value: unknown): QueryOptions {
  if (!isPlainObject(value)) {
    throw invalidOp('"$" must be an object.');
  }

  for (const key of Object.keys(value)) {
    if (!OPTION_KEYS.has(key)) {
      throw invalidOp(`Unknown query option "$${key}".`);
    }
  }

  const options: QueryOptions = {};

  if ("where" in value) {
    options.where = parseWhere(value.where);
  }
  if ("order" in value) {
    options.order = parseOrder(value.order);
  }
  if ("count" in value) {
    if (typeof value.count !== "boolean") {
      throw invalidValue('"count" must be true or false.');
    }
    options.count = value.count;
  }
  if ("aggregate" in value) {
    options.aggregate = parseAggregate(value.aggregate);
  }
  if ("limit" in value) {
    // limit 0 only makes sense as "count or aggregate, read no rows".
    options.limit =
      value.limit === 0 && (options.count === true || options.aggregate !== undefined)
        ? 0
        : parseLimit(value.limit);
  }
  if ("after" in value) {
    options.after = parseCursor(value.after);
  }
  if ("select" in value) {
    options.select = parseSelect(value.select);
  }

  return options;
}

/**
 * Pagination cursor: the ordered column values of the last row on the page.
 *
 * Keyset, not offset: an offset cursor silently skips or repeats rows when
 * something is inserted above the window, which is the normal case for a live
 * database.
 */
export interface QueryCursor {
  v: 1;
  /** Physical columns the cursor is ordered by. */
  cols: string[];
  /** Values of those columns on the last returned row. */
  vals: (string | number | null)[];
}

function base64UrlEncode(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

export function encodeQueryCursor(cursor: QueryCursor): string {
  return base64UrlEncode(JSON.stringify(cursor));
}

/** Decodes and validates a cursor. A malformed cursor is a client error. */
export function decodeQueryCursor(value: string): QueryCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(value));
  } catch {
    throw invalidOp('"after" is not a valid cursor.');
  }

  if (!isPlainObject(parsed) || parsed.v !== 1) {
    throw invalidOp('"after" is not a valid cursor.');
  }

  const cols = parsed.cols;
  const vals = parsed.vals;
  if (!Array.isArray(cols) || cols.length === 0 || !cols.every((c) => typeof c === "string")) {
    throw invalidOp('"after" cursor has no columns.');
  }
  if (!Array.isArray(vals) || vals.length !== cols.length) {
    throw invalidOp('"after" cursor does not match its columns.');
  }
  for (const val of vals) {
    if (val !== null && typeof val !== "string" && typeof val !== "number") {
      throw invalidOp('"after" cursor contains an unsupported value.');
    }
  }

  return { v: 1, cols: cols as string[], vals: vals as (string | number | null)[] };
}

function parseSelect(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidOp('"select" must be a non-empty array of attribute names.');
  }
  const names = new Set<string>();
  for (const name of value) {
    if (typeof name !== "string" || name.length === 0) {
      throw invalidOp('"select" must be a non-empty array of attribute names.');
    }
    names.add(name);
  }
  return [...names];
}

function parseCursor(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidOp('"after" must be a non-empty cursor string.');
  }
  return value;
}

/** Validates a `where` object. Exported for view rules, which share the shape. */
export function parseWhere(value: unknown): QueryWhere {
  if (!isPlainObject(value)) {
    throw invalidOp('"where" must be an object.');
  }

  const where: QueryWhere = {};
  for (const [attribute, raw] of Object.entries(value)) {
    if (attribute.startsWith("$")) {
      if (!LOGICAL_KEYS.has(attribute)) {
        throw invalidOp(`Unknown where key "${attribute}".`);
      }
      if (attribute === "$not") {
        where.$not = parseWhere(raw);
        continue;
      }
      if (attribute === "$link") {
        if (!Array.isArray(raw) || raw.length === 0) {
          throw invalidOp('"$link" needs a non-empty array of relation filters.');
        }
        where.$link = raw.map((entry) => parseRelationFilter(entry));
        continue;
      }
      if (!Array.isArray(raw) || raw.length === 0) {
        // An empty $or would match nothing and an empty $and everything; both
        // are more likely a bug in the caller than a request.
        throw invalidOp(`"${attribute}" needs a non-empty array of filters.`);
      }
      where[attribute as "$or" | "$and"] = raw.map((branch) =>
        parseWhere(branch)
      );
      continue;
    }
    if (isPlainObject(raw)) {
      where[attribute] = parseComparison(attribute, raw);
    } else {
      where[attribute] = parseScalar(attribute, raw);
    }
  }
  return where;
}

function parseRelationFilter(value: unknown): QueryRelationFilter {
  if (!isPlainObject(value)) {
    throw invalidOp('Each "$link" entry must be an object.');
  }
  const { label, mode, where } = value;
  if (typeof label !== "string" || label.length === 0) {
    throw invalidOp('A "$link" entry needs a link label.');
  }
  if (typeof mode !== "string" || !RELATION_MODES.has(mode)) {
    throw invalidOp(
      `"$link" mode for "${label}" must be one of parent, some, every, none.`
    );
  }
  return { label, mode: mode as RelationMode, where: parseWhere(where) };
}

function parseComparison(
  attribute: string,
  value: Record<string, unknown>
): QueryComparison {
  const keys = Object.keys(value);
  if (keys.length === 0) {
    throw invalidValue(`Comparison for "${attribute}" has no operators.`);
  }

  const comparison: QueryComparison = {};
  for (const operator of keys) {
    if (!COMPARISON_OPERATORS.has(operator)) {
      throw invalidValue(
        `Unsupported where operator "${operator}" on "${attribute}".`
      );
    }

    const operand = value[operator];
    switch (operator) {
      case "$in":
        if (!Array.isArray(operand)) {
          throw invalidValue(`"$in" on "${attribute}" requires an array.`);
        }
        comparison.$in = operand.map((item, index) =>
          parseScalar(`${attribute}.$in[${index}]`, item)
        );
        break;
      case "$nin":
        if (!Array.isArray(operand)) {
          throw invalidValue(`"$nin" on "${attribute}" requires an array.`);
        }
        comparison.$nin = operand.map((item, index) =>
          parseScalar(`${attribute}.$nin[${index}]`, item)
        );
        break;
      case "$ne":
        comparison.$ne = parseScalar(attribute, operand);
        break;
      case "$gt":
        comparison.$gt = parseScalar(attribute, operand);
        break;
      case "$gte":
        comparison.$gte = parseScalar(attribute, operand);
        break;
      case "$lt":
        comparison.$lt = parseScalar(attribute, operand);
        break;
      case "$lte":
        comparison.$lte = parseScalar(attribute, operand);
        break;
      case "$isNull":
        if (typeof operand !== "boolean") {
          throw invalidValue(`"$isNull" on "${attribute}" takes true or false.`);
        }
        comparison.$isNull = operand;
        break;
      case "$like":
      case "$ilike":
        if (typeof operand !== "string") {
          throw invalidValue(`"${operator}" on "${attribute}" takes a string pattern.`);
        }
        parseLikePattern(operand, `${operator} on "${attribute}"`);
        comparison[operator] = operand;
        break;
    }
  }

  return comparison;
}

/**
 * Checks the backslash escapes in a `LIKE` pattern.
 *
 * `%` and `_` mean what SQL says; a backslash in front of either, or in front
 * of another backslash, makes it a literal. A backslash anywhere else is
 * refused: silently reading `\d` as `d` would drop a character the caller
 * wrote on purpose, and silently keeping it would put a stray backslash in the
 * comparison. The pattern itself is returned unchanged, escapes included, so
 * the caller can bind it with `ESCAPE '\'`.
 */
export function parseLikePattern(pattern: string, label: string): string {
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] !== "\\") continue;
    const next = pattern[index + 1];
    if (next === "%" || next === "_" || next === "\\") {
      index += 1;
      continue;
    }
    throw invalidValue(
      next === undefined
        ? `"${label}" ends with a backslash; write "\\\\" for a literal one.`
        : `"${label}" escapes "${next}"; only %, _ and \\ are escape sequences.`
    );
  }
  return pattern;
}

function parseOrder(value: unknown): Record<string, SortDirection> {
  if (!isPlainObject(value)) {
    throw invalidOp('"order" must be an object.');
  }

  const order: Record<string, SortDirection> = {};
  for (const [attribute, direction] of Object.entries(value)) {
    if (direction !== "asc" && direction !== "desc") {
      throw invalidValue(`Order for "${attribute}" must be "asc" or "desc".`);
    }
    order[attribute] = direction;
  }
  return order;
}

function parseLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidValue("Limit must be a positive integer.");
  }
  return value;
}

function parseScalar(attribute: string, value: unknown): QueryScalar {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw invalidValue(
    `Value for "${attribute}" must be a scalar (string, number, boolean or null).`
  );
}

export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isIsoDate(value: string): boolean {
  return ISO_DATE_PATTERN.test(value);
}

export function invalidOp(message: string): TxError {
  return new TxError("invalid_op", message);
}

export function invalidValue(message: string): TxError {
  return new TxError("invalid_value", message);
}
