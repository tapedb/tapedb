/**
 * Executes compiled query documents against workspace SQLite.
 *
 * Entity rows are read as physical columns, hydrated one link level at a time,
 * then folded back into the API shape: camelCase registry attributes, real
 * booleans, epoch-millisecond dates and parsed JSON. Permission checks run on
 * every requested and traversed namespace before any SQL executes.
 */

import type { RoleClaim } from "../claims";
import {
  buildSelectSql,
  compileQuery,
  compileViewCondition,
  type CompiledChild,
  type CompiledCondition,
  type CompiledNode,
  type CompiledOrder,
  type CompiledQuery,
} from "./query-compile";
import {
  encodeQueryCursor,
  parseQueryEnvelope,
  type QueryPageInfo,
  type QueryResult,
} from "./query-types";
import { findNamespace, toSnakeCase, type AttributeType } from "./registry";
import {
  allowRowView,
  assertPermission,
  hasFunctionViewRule,
  viewWhereBranches,
} from "./tx-permissions";
import { quoteIdentifier } from "./tx-apply";
import type { SqlExecutor, SqlValue } from "./tx-sql";
import { TxError } from "./tx-types";

type PhysicalRow = Record<string, SqlValue>;

interface HydratedEntity {
  namespace: string;
  row: PhysicalRow;
  links: Record<string, HydratedEntity | HydratedEntity[] | null>;
}

/**
 * Parses the envelope, compiles the query, authorizes every namespace and
 * executes it. Invalid queries and permission failures surface as `TxError`;
 * driver failures become `storage_error` so the route maps them to 500.
 */
export function executeQuery(
  sql: SqlExecutor,
  claim: RoleClaim,
  envelope: unknown
): QueryResult {
  const document = parseQueryEnvelope(envelope);
  const compiled = compileQuery(document);

  authorizeQuery(claim, compiled);

  try {
    return executeCompiledQuery(sql, compiled);
  } catch (error) {
    if (error instanceof TxError) throw error;
    throw new TxError("storage_error", errorMessage(error));
  }
}

/** `executeQuery` plus per-namespace truncation metadata. */
export function executeQueryWithPageInfo(
  sql: SqlExecutor,
  claim: RoleClaim,
  envelope: unknown
): { data: QueryResult; pageInfo: QueryPageInfo } {
  const document = parseQueryEnvelope(envelope);
  const compiled = compileQuery(document);

  authorizeQuery(claim, compiled);

  try {
    return executeCompiledQueryWithPageInfo(sql, compiled, claim);
  } catch (error) {
    if (error instanceof TxError) throw error;
    throw new TxError("storage_error", errorMessage(error));
  }
}

/**
 * Requires `view` on the top-level namespace and every traversed namespace.
 */
export function authorizeQuery(
  claim: RoleClaim,
  compiled: CompiledQuery
): void {
  const checked = new Set<string>();

  const visit = (node: CompiledNode): void => {
    if (!checked.has(node.namespace)) {
      assertPermission(claim, node.namespace, "view");
      checked.add(node.namespace);
    }
    for (const child of node.children) visit(child.node);
  };

  for (const node of compiled.nodes) visit(node);
}

/** Executes an already compiled and authorized query. */
export function executeCompiledQuery(
  sql: SqlExecutor,
  compiled: CompiledQuery,
  claim?: RoleClaim
): QueryResult {
  return executeCompiledQueryWithPageInfo(sql, compiled, claim).data;
}

/**
 * Multiplier and floor for the scan cap. One page may read at most
 * `max(limit * 10, 200)` matching rows before it gives up filling: a rule that
 * hides every row must terminate instead of walking the whole namespace.
 */
const SCAN_CAP_FACTOR = 10;
const SCAN_CAP_FLOOR = 200;

/**
 * Hard ceiling on how many rows one page may read while filling. Returns rows
 * are bounded by `limit`; this bounds the work behind them.
 */
export function pageScanCap(limit: number): number {
  return Math.max(limit * SCAN_CAP_FACTOR, SCAN_CAP_FLOOR);
}

/**
 * Executes a compiled query and reports truncation per namespace.
 *
 * Each chunk asks for one row beyond the limit so `hasMore` is exact instead of
 * a guess, and the extra row is discarded before hydration.
 *
 * Row-level `view` rules run in TypeScript, so they cannot be pushed into SQL:
 * they see API-shaped values and may be arbitrary predicates. A page is
 * therefore filled by scanning further when a rule hides rows, up to
 * `pageScanCap(limit)`. `hasMore` and `nextCursor` stay honest: `returned`
 * counts visible rows only, `hasMore` means matching rows remain outside this
 * page, and `nextCursor` resumes after the last VISIBLE row.
 */
export function executeCompiledQueryWithPageInfo(
  sql: SqlExecutor,
  compiled: CompiledQuery,
  claim?: RoleClaim
): { data: QueryResult; pageInfo: QueryPageInfo } {
  const data: QueryResult = {};
  const pageInfo: QueryPageInfo = {};
  const nodes =
    claim === undefined
      ? compiled.nodes
      : compiled.nodes.map((node) => withViewConditions(node, claim));

  for (const node of nodes) {
    const limit = node.limit;

    if (limit === null) {
      // A nested level is bounded per parent, not by a page: there is no page
      // to fill and no cursor to resume from.
      const entities = hydrateNode(sql, node);
      const visible =
        claim === undefined ? entities : visibleOnly(entities, claim);

      data[node.namespace] = visible.map(toApiEntity);
      pageInfo[node.namespace] = {
        limit,
        returned: visible.length,
        hasMore: false,
      };
      continue;
    }

    const count = node.count ? countRows(sql, node, claim) : undefined;

    // limit 0 is a count with no rows: nothing to fill, nothing to resume.
    const { page, hasMore } =
      limit === 0
        ? { page: [] as HydratedEntity[], hasMore: (count ?? 0) > 0 }
        : fillPage(sql, node, claim, limit);

    data[node.namespace] = page.map(toApiEntity);

    const nextCursor = cursorFor(node, page, hasMore);
    pageInfo[node.namespace] = {
      limit,
      returned: page.length,
      hasMore,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      ...(count === undefined ? {} : { count }),
    };
  }

  return { data, pageInfo };
}

/**
 * Pushes `where` view rules into the SQL of every level that reads a
 * namespace with one. Those rows never reach the post-fetch filter, so a page
 * fills from an index instead of a bounded scan.
 */
function withViewConditions(node: CompiledNode, claim: RoleClaim): CompiledNode {
  const branches = viewWhereBranches(claim, node.namespace);
  const children = node.children.map((child) => ({
    ...child,
    node: withViewConditions(child.node, claim),
  }));
  if (branches === null) return { ...node, children };

  return {
    ...node,
    conditions: [
      ...node.conditions,
      compileViewCondition(node.namespace, branches),
    ],
    children,
  };
}

/**
 * Rows matching the node's filters, ignoring `after` and `limit`. Uses the
 * same conditions the page used, `where` view rules included, so the count
 * never sees a row the caller could not read.
 */
function countRows(
  sql: SqlExecutor,
  node: CompiledNode,
  claim: RoleClaim | undefined
): number {
  if (claim !== undefined && hasFunctionViewRule(node.namespace)) {
    throw new TxError(
      "invalid_op",
      `"count" is not available on "${node.namespace}": its view rule is a function, which runs after fetch, so a count would include hidden rows. Use a { where } view rule.`
    );
  }

  const conditions = node.conditions.filter((condition) => !condition.cursor);
  const whereSql =
    conditions.length > 0
      ? ` WHERE ${conditions.map((condition) => `(${condition.sql})`).join(" AND ")}`
      : "";
  const row = sql.one<{ total: number }>(
    `SELECT COUNT(*) AS "total" FROM ${quoteIdentifier(node.table)}${whereSql}`,
    ...conditions.flatMap((condition) => condition.params)
  );
  return Number(row?.total ?? 0);
}

/** Rows the namespace's `view` rule hides are dropped at every link depth. */
function visibleOnly(
  entities: HydratedEntity[],
  claim: RoleClaim
): HydratedEntity[] {
  return entities
    .map((entity) => filterVisible(entity, claim))
    .filter((entity): entity is HydratedEntity => entity !== null);
}

/**
 * Fills one page by scanning forward while `view` rules hide rows.
 *
 * Stops on the first of: a full page, an exhausted match set, or the scan cap.
 * `hasMore` is only ever set when a row outside the page is known to exist, so
 * a cap-limited page resumes from its last visible row without skipping or
 * repeating anything.
 */
function fillPage(
  sql: SqlExecutor,
  node: CompiledNode,
  claim: RoleClaim | undefined,
  limit: number
): { page: HydratedEntity[]; hasMore: boolean } {
  const maxScan = pageScanCap(limit);
  const page: HydratedEntity[] = [];

  const more =
    node.order.length === 0
      ? fillUnordered(sql, node, claim, limit, maxScan, page)
      : fillOrdered(sql, node, claim, limit, maxScan, page);

  // A cap-limited page with nothing visible has no valid cursor to hand back,
  // so it must be terminal rather than an unactionable `hasMore: true`.
  return { page, hasMore: more && page.length > 0 };
}

/**
 * Ordered scan: keyset, one chunk at a time, appending visible rows.
 *
 * The page's own limit plus one probe row is the chunk size. Once the page is
 * full the scan keeps looking for one more VISIBLE row, so `hasMore` is never
 * set on the strength of a hidden row: a client is not sent on an extra round
 * trip to fetch an empty page. Each chunk resumes after the last row actually
 * read, which is what keeps the scan linear in rows read.
 *
 * Returns whether a visible row remains outside the page.
 */
function fillOrdered(
  sql: SqlExecutor,
  node: CompiledNode,
  claim: RoleClaim | undefined,
  limit: number,
  maxScan: number,
  page: HydratedEntity[]
): boolean {
  let scanned = 0;
  let cursor: CompiledCondition | null = null;

  while (scanned < maxScan) {
    const chunkLimit = Math.min(limit + 1, maxScan - scanned);
    const chunkNode: CompiledNode =
      cursor === null
        ? { ...node, limit: chunkLimit }
        : { ...node, limit: chunkLimit, conditions: [...node.conditions, cursor] };

    const chunk = hydrateNode(sql, chunkNode);
    if (chunk.length === 0) return false;

    scanned += chunk.length;

    for (const entity of chunk) {
      const visible = claim === undefined ? entity : filterVisible(entity, claim);
      if (visible === null) continue;
      if (page.length < limit) {
        page.push(visible);
        continue;
      }
      return true; // a visible row sits outside the page
    }

    // A short chunk is the end of the match set, so nothing is left to return.
    if (chunk.length < chunkLimit) return false;

    const next = conditionAfter(node.order, chunk[chunk.length - 1].row);
    // A null ordering value has no total order to advance along, so the scan
    // cannot continue; report the rows it may not have reached.
    if (next === null) return true;
    cursor = next;
  }

  return true; // scan cap: rows were left unread
}

/**
 * Unordered scan: no total order exists, so there is no keyset to advance.
 * Re-read one widening window from the start instead of inventing offsets.
 * Bounded by the same cap, so it terminates; the window doubles, so it costs
 * a logarithmic number of queries.
 */
function fillUnordered(
  sql: SqlExecutor,
  node: CompiledNode,
  claim: RoleClaim | undefined,
  limit: number,
  maxScan: number,
  page: HydratedEntity[]
): boolean {
  let window = Math.min(limit + 1, maxScan);

  for (;;) {
    const rows = hydrateNode(sql, { ...node, limit: window });
    const visible = claim === undefined ? rows : visibleOnly(rows, claim);

    page.length = 0;
    page.push(...visible.slice(0, limit));

    if (rows.length < window) return false; // exhausted
    if (visible.length >= limit) return true; // window held more than a page
    if (window >= maxScan) return true; // cap: rows were left unread

    window = Math.min(window * 2, maxScan);
  }
}

/**
 * Keyset predicate for "strictly after `row`" in the node's order.
 *
 * Mirrors the compiler's private `cursorCondition`: for `(a ASC, b DESC)` it
 * builds `a > ? OR (a = ? AND b < ?)`. The executor needs it mid-scan, from a
 * row it just read rather than an opaque client cursor, so it cannot reuse the
 * compile-time helper. Returns null when a value cannot be compared, matching
 * the compiler's refusal to resume from a null.
 */
function conditionAfter(
  order: CompiledOrder[],
  row: PhysicalRow
): CompiledCondition | null {
  const clauses: string[] = [];
  const params: SqlValue[] = [];

  for (let index = 0; index < order.length; index += 1) {
    const parts: string[] = [];

    for (let prior = 0; prior < index; prior += 1) {
      const value = row[order[prior].column];
      if (!isComparable(value)) return null;
      parts.push(`${quoteIdentifier(order[prior].column)} = ?`);
      params.push(value);
    }

    const value = row[order[index].column];
    if (!isComparable(value)) return null;
    const operator = order[index].direction === "desc" ? "<" : ">";
    parts.push(`${quoteIdentifier(order[index].column)} ${operator} ?`);
    params.push(value);

    clauses.push(`(${parts.join(" AND ")})`);
  }

  if (clauses.length === 0) return null;
  return { sql: clauses.join(" OR "), params };
}

function isComparable(
  value: SqlValue | undefined
): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

/** Drops rows the namespace's `view` rule hides, at every link depth. */
function filterVisible(
  entity: HydratedEntity,
  claim: RoleClaim
): HydratedEntity | null {
  if (!allowRowView(claim, entity.namespace, rowToApi(entity))) return null;

  const links: HydratedEntity["links"] = {};
  for (const [label, value] of Object.entries(entity.links)) {
    if (Array.isArray(value)) {
      links[label] = value
        .map((child) => filterVisible(child, claim))
        .filter((child): child is HydratedEntity => child !== null);
    } else if (value === null) {
      links[label] = null;
    } else {
      links[label] = filterVisible(value, claim);
    }
  }

  return { ...entity, links };
}

/** Stored row with API attribute names, for rule evaluation. */
function rowToApi(entity: HydratedEntity): Record<string, unknown> {
  const namespace = findNamespace(entity.namespace);
  if (!namespace) return { id: entity.row.id };

  const output: Record<string, unknown> = { id: entity.row.id };
  for (const [attribute, definition] of Object.entries(namespace.attributes)) {
    // Rules see the same values a client would: booleans as booleans, JSON
    // parsed, dates as epoch millis. Handing them raw SQLite integers would
    // make `data.isPublic === true` fail for every row.
    output[attribute] = fromStoredValue(
      definition.type,
      entity.row[toSnakeCase(attribute)]
    );
  }
  return output;
}

/**
 * Cursor for the next page, or undefined when there is nothing to resume from.
 *
 * Requires an explicit order: without one there is no total order for a keyset
 * cursor to sit in. A null ordering value also yields no cursor, because
 * comparisons against null never select a row.
 */
function cursorFor(
  node: CompiledNode,
  page: HydratedEntity[],
  hasMore: boolean
): string | undefined {
  if (!hasMore || node.order.length === 0 || page.length === 0) return undefined;

  const last = page[page.length - 1];
  const values: (string | number | null)[] = [];

  for (const entry of node.order) {
    const value = last.row[entry.column];
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    values.push(value);
  }

  return encodeQueryCursor({
    v: 1,
    cols: node.order.map((entry) => entry.column),
    vals: values,
  });
}

function hydrateNode(
  sql: SqlExecutor,
  node: CompiledNode,
  extra?: { column: string; ids: string[] }
): HydratedEntity[] {
  const { sql: statement, params } = buildSelectSql(node, extra);
  const rows = sql.all<PhysicalRow>(statement, ...params);
  const entities: HydratedEntity[] = rows.map((row) => ({
    namespace: node.namespace,
    row,
    links: {},
  }));

  for (const child of node.children) {
    hydrateChild(sql, entities, child);
  }

  return entities;
}

function hydrateChild(
  sql: SqlExecutor,
  entities: HydratedEntity[],
  child: CompiledChild
): void {
  if (entities.length === 0) return;

  const foreignKey = child.foreignKeyColumn;

  if (child.direction === "forward") {
    // Forward links store the FK on the child: fetch children whose FK is one
    // of the current parent ids, then group by that FK.
    const parentIds = uniqueIds(entities.map((entity) => entity.row.id));

    // One SQL LIMIT over `fk IN (...)` is shared by every parent, so the last
    // parents silently get nothing. Apply an explicit limit per parent instead:
    // fetch unbounded when several parents are in play, then trim each group.
    const perParentLimit =
      child.node.explicitLimit && parentIds.length > 1
        ? child.node.limit
        : null;
    const children =
      parentIds.length > 0
        ? hydrateNode(
            sql,
            perParentLimit === null
              ? child.node
              : { ...child.node, limit: null },
            {
              column: foreignKey,
              ids: parentIds,
            }
          )
        : [];

    if (child.multiplicity === "many") {
      const groups = new Map<string, HydratedEntity[]>();
      for (const entry of children) {
        const key = stringValue(entry.row[foreignKey]);
        if (key === null) continue;
        const group = groups.get(key);
        if (group) {
          if (perParentLimit !== null && group.length >= perParentLimit) {
            continue;
          }
          group.push(entry);
        } else {
          groups.set(key, [entry]);
        }
      }
      for (const entity of entities) {
        const key = stringValue(entity.row.id);
        entity.links[child.label] = key === null ? [] : (groups.get(key) ?? []);
      }
      return;
    }

    const firstByKey = new Map<string, HydratedEntity>();
    for (const entry of children) {
      const key = stringValue(entry.row[foreignKey]);
      if (key !== null && !firstByKey.has(key)) {
        firstByKey.set(key, entry);
      }
    }
    for (const entity of entities) {
      const key = stringValue(entity.row.id);
      entity.links[child.label] =
        key === null ? null : (firstByKey.get(key) ?? null);
    }
    return;
  }

  // Reverse traversal: the current rows own the foreign key, so look the
  // target rows up by id.
  const keys = uniqueIds(entities.map((entity) => entity.row[foreignKey]));
  const targets =
    keys.length > 0
      ? hydrateNode(sql, child.node, { column: "id", ids: keys })
      : [];
  const byId = new Map<string, HydratedEntity>();
  for (const target of targets) {
    const id = stringValue(target.row.id);
    if (id !== null) byId.set(id, target);
  }

  if (child.multiplicity === "many") {
    for (const entity of entities) {
      const id = stringValue(entity.row[foreignKey]);
      const target = id === null ? undefined : byId.get(id);
      entity.links[child.label] = target ? [target] : [];
    }
    return;
  }

  for (const entity of entities) {
    const id = stringValue(entity.row[foreignKey]);
    entity.links[child.label] = id === null ? null : (byId.get(id) ?? null);
  }
}

function toApiEntity(entity: HydratedEntity): Record<string, unknown> {
  const namespace = findNamespace(entity.namespace);
  if (!namespace) {
    throw new TxError(
      "storage_error",
      `Namespace "${entity.namespace}" is not registered.`
    );
  }

  const output: Record<string, unknown> = { id: entity.row.id };
  const attributes = new Set<string>(["id"]);

  for (const [attribute, definition] of Object.entries(namespace.attributes)) {
    output[attribute] = fromStoredValue(
      definition.type,
      entity.row[toSnakeCase(attribute)]
    );
    attributes.add(attribute);
  }

  // Engine columns are part of every row even when the namespace does not
  // declare them as attributes. Expose them consistently under API names.
  if (!attributes.has("createdAt")) {
    output.createdAt = fromStoredValue("date", entity.row.created_at);
  }
  if (!attributes.has("updatedAt")) {
    output.updatedAt = fromStoredValue("date", entity.row.updated_at);
  }
  output.updatedSeq = fromStoredValue("number", entity.row.updated_seq) ?? 0;

  for (const [label, value] of Object.entries(entity.links)) {
    output[label] = Array.isArray(value)
      ? value.map(toApiEntity)
      : value === null
        ? null
        : toApiEntity(value);
  }

  return output;
}

/** Converts a stored value to the API shape for its registry type. */
export function fromStoredValue(
  type: AttributeType,
  value: SqlValue | undefined
): unknown {
  if (value === null || value === undefined) return null;

  switch (type) {
    case "string":
      return typeof value === "string" ? value : String(value);
    case "number":
      return typeof value === "number" ? value : Number(value);
    case "boolean":
      return value !== 0;
    case "date":
      return toEpochMilliseconds(value);
    case "json":
    case "any":
      return typeof value === "string" ? parseJson(value) : value;
  }
}

function toEpochMilliseconds(value: SqlValue): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // Stored JSON should be valid; keep the request alive if it is not.
    return value;
  }
}

function uniqueIds(values: SqlValue[]): string[] {
  const ids = new Set<string>();
  for (const value of values) {
    const id = stringValue(value);
    if (id !== null) ids.add(id);
  }
  return [...ids];
}

function stringValue(value: SqlValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
