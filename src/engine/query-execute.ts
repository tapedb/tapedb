/**
 * Executes compiled query documents against workspace SQLite.
 *
 * Entity rows are read as physical columns, hydrated one link level at a time,
 * then folded back into the API shape: camelCase registry attributes, real
 * booleans, epoch-millisecond dates and parsed JSON. Permission checks run on
 * every requested and traversed namespace before any SQL executes.
 */

import { runStaged, stagesOf } from "./query-stages";
import type { RoleClaim } from "../claims";
import {
  buildSelectSql,
  compileQuery,
  sqliteLimitError,
  selectColumns,
  conditionAfterValues,
  compileViewCondition,
  type ViewAccess,
  type CompiledChild,
  type CompiledCondition,
  type CompiledNode,
  type CompiledOrder,
  type CompiledQuery,
} from "./query-compile";
import {
  AggregateFold,
  aggregateColumns,
  buildAggregateSql,
  groupsFromSql,
} from "./query-aggregate";
import type { AggregateGroup } from "./query-aggregate";
import { balancedJoin } from "./sql-binding";
import {
  encodeQueryCursor,
  parseQueryEnvelope,
  QUERY_CHUNK_ROWS,
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
import { TxError as PermissionError } from "./tx-types";
import { quoteIdentifier } from "./tx-apply";
import type { SqlExecutor, SqlValue } from "./tx-sql";
import { TxError } from "./tx-types";

type PhysicalRow = Record<string, SqlValue>;

interface HydratedEntity {
  namespace: string;
  row: PhysicalRow;
  /** API attributes the query selected, or null for all of them. */
  select: string[] | null;
  links: Record<string, HydratedEntity | HydratedEntity[] | null>;
}

/**
 * Parses the envelope, compiles the query, authorizes every namespace and
 * executes it. Invalid queries and permission failures surface as `TxError`;
 * driver failures become `storage_error` so the route maps them to 500.
 */
/**
 * What a relation filter's subquery may see, for this caller. A namespace the
 * caller cannot read at all, or whose read rule is a function that only runs
 * after fetch, cannot be filtered on in SQL without leaking the rows it hides.
 */
export function viewAccess(claim: RoleClaim): ViewAccess {
  return {
    branches: (namespace) => viewWhereBranches(claim, namespace),
    refusal: (namespace) => {
      try {
        assertPermission(claim, namespace, "view");
      } catch (error) {
        return error instanceof PermissionError
          ? error.message
          : `Cannot filter on "${namespace}".`;
      }
      return hasFunctionViewRule(namespace)
        ? `Cannot filter on "${namespace}" through a link: its read rule is a function, which runs after fetch, so the filter would match rows the rule hides. Use a { where } read rule.`
        : null;
    },
  };
}

export function executeQuery(
  sql: SqlExecutor,
  claim: RoleClaim,
  envelope: unknown
): QueryResult {
  const document = parseQueryEnvelope(envelope);
  const compiled = compileQuery(document, viewAccess(claim));

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
  const compiled = compileQuery(document, viewAccess(claim));

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
 * Executes a compiled query and reports truncation per namespace.
 *
 * Each chunk asks for one row beyond the limit so `hasMore` is exact instead of
 * a guess, and the extra row is discarded before hydration.
 *
 * Row-level `view` rules run in TypeScript, so they cannot be pushed into SQL:
 * they see API-shaped values and may be arbitrary predicates. A page is
 * therefore filled by scanning further until it has enough visible rows or
 * exhausts the matching rows. `hasMore` and `nextCursor` stay honest: `returned`
 * counts visible rows only, `hasMore` means matching rows remain outside this
 * page, and `nextCursor` resumes after the last VISIBLE row.
 */
export function executeCompiledQueryWithPageInfo(
  sql: SqlExecutor,
  compiled: CompiledQuery,
  claim?: RoleClaim
): { data: QueryResult; pageInfo: QueryPageInfo } {
  try {
    return executePages(sql, compiled, claim);
  } catch (error) {
    throw sqliteLimitError(error) ?? error;
  }
}

function executePages(
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
      // No limit: every matching row, so there is no page to fill and no
      // cursor to resume from.
      const entities = hydrateNode(sql, node);
      const visible =
        claim === undefined ? entities : visibleOnly(entities, claim);
      const count = node.count ? countRows(sql, node, claim) : undefined;

      data[node.namespace] = visible.map(toApiEntity);
      pageInfo[node.namespace] = {
        limit,
        returned: visible.length,
        hasMore: false,
        ...(count === undefined ? {} : { count }),
      };
      continue;
    }

    const count = node.count ? countRows(sql, node, claim) : undefined;
    const aggregate =
      node.aggregate === null ? undefined : aggregateRows(sql, node, claim);

    // limit 0 is a count or aggregate with no rows: nothing to fill, nothing
    // to resume.
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
      ...(aggregate === undefined ? {} : { aggregate }),
    };
  }

  return { data, pageInfo };
}

/**
 * Aggregates the rows matching the node's conditions, `where` read rules
 * included. A function read rule cannot run in SQL, so for one the matching
 * rows are walked in bounded chunks in id order, the rule applied to each,
 * and the visible ones folded; no limit on how far the walk goes.
 */
function aggregateRows(
  sql: SqlExecutor,
  node: CompiledNode,
  claim: RoleClaim | undefined
): AggregateGroup[] {
  const aggregate = node.aggregate!;
  const conditions = node.conditions.filter((condition) => !condition.cursor);

  if (claim === undefined || !hasFunctionViewRule(node.namespace)) {
    const statement = buildAggregateSql(node.table, aggregate, conditions);
    const rows = runStaged(sql, statement.stages, statement.params, (params) =>
      sql.all<PhysicalRow>(statement.sql, ...params)
    );
    return groupsFromSql(aggregate, rows, fromStoredValue);
  }

  const namespace = findNamespace(node.namespace);
  const fold = new AggregateFold(aggregate);
  const chunk = 200;
  const base: CompiledNode = {
    ...node,
    columns: [
      ...new Set([
        ...(namespace === undefined ? node.columns : selectColumns(namespace)),
        ...aggregateColumns(aggregate),
      ]),
    ],
    conditions,
    order: [{ column: "id", direction: "asc" }],
    children: [],
    limit: chunk,
  };
  let cursor: CompiledCondition | null = null;
  for (;;) {
    const rows = hydrateNode(sql, cursor === null ? base : { ...base, conditions: [...conditions, cursor] });
    for (const entity of rows) {
      if (allowRowView(claim, entity.namespace, rowToApi(entity))) fold.add(entity.row);
    }
    if (rows.length < chunk) return fold.groups(fromStoredValue);
    cursor = conditionAfter(base.order, rows[rows.length - 1].row)!;
  }
}

/**
 * Pushes `where` view rules into the SQL of every level that reads a
 * namespace with one. Those rows never reach the post-fetch filter, so a page
 * fills directly from its SQL index.
 */
function withViewConditions(node: CompiledNode, claim: RoleClaim): CompiledNode {
  const branches = viewWhereBranches(claim, node.namespace);
  const children = node.children.map((child) => ({
    ...child,
    node: withViewConditions(child.node, claim),
  }));
  // A function read rule sees the whole row, so a projected read still
  // fetches every column; only the response is narrowed.
  const namespace = findNamespace(node.namespace);
  const columns =
    node.select !== null && namespace !== undefined && hasFunctionViewRule(node.namespace)
      ? [...new Set([...node.columns, ...selectColumns(namespace)])]
      : node.columns;
  if (branches === null) return { ...node, columns, children };

  return {
    ...node,
    columns,
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
    // Arbitrary predicates cannot be compiled to SQL. Walk bounded chunks in
    // primary-key order, applying the same rule as reads, without limiting how
    // far through the matching set the count may look.
    const base: CompiledNode = {
      ...node,
      conditions: node.conditions.filter((condition) => !condition.cursor),
      order: [{ column: "id", direction: "asc" }],
      children: [],
      limit: 200,
    };
    let cursor: CompiledCondition | null = null;
    let total = 0;
    for (;;) {
      const rows = hydrateNode(sql, cursor === null ? base : {
        ...base, conditions: [...base.conditions, cursor],
      });
      total += visibleOnly(rows, claim).length;
      if (rows.length < 200) return total;
      cursor = conditionAfter(base.order, rows[rows.length - 1].row)!;
    }
  }

  const conditions = node.conditions.filter((condition) => !condition.cursor);
  const whereSql =
    conditions.length > 0
      ? ` WHERE ${balancedJoin(conditions.map((condition) => condition.sql), " AND ")}`
      : "";
  const row = runStaged(sql, stagesOf(conditions), conditions.flatMap((condition) => condition.params), (params) =>
    sql.one<{ total: number }>(`SELECT COUNT(*) AS "total" FROM ${quoteIdentifier(node.table)}${whereSql}`, ...params)
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
 * Stops on the first of a full page with another visible row, or exhaustion.
 * `hasMore` requires another visible row; hidden rows cannot truncate a
 * page or create an empty follow-up page.
 */
function fillPage(
  sql: SqlExecutor,
  node: CompiledNode,
  claim: RoleClaim | undefined,
  limit: number
): { page: HydratedEntity[]; hasMore: boolean } {
  const page: HydratedEntity[] = [];

  const more =
    node.order.length === 0
      ? fillUnordered(sql, node, claim, limit, page)
      : fillOrdered(sql, node, claim, limit, page);

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
  page: HydratedEntity[]
): boolean {
  let cursor: CompiledCondition | null = null;

  for (;;) {
    // A wide page is read in bounded chunks, each resuming after the last.
    const chunkLimit = Math.min(limit, QUERY_CHUNK_ROWS) + 1;
    const chunkNode: CompiledNode =
      cursor === null
        ? { ...node, limit: chunkLimit }
        : { ...node, limit: chunkLimit, conditions: [...node.conditions, cursor] };

    const chunk = hydrateNode(sql, chunkNode);
    if (chunk.length === 0) return false;

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
    if (next === null) throw new TxError("storage_error", "Cannot read an ordering column from the stored row.");
    cursor = next;
  }
}

/**
 * Unordered scan: no total order exists, so there is no keyset to advance.
 * Re-read one widening window from the start instead of inventing offsets.
 * The window doubles until enough visible rows or the end of the result set
 * is reached.
 */
function fillUnordered(
  sql: SqlExecutor,
  node: CompiledNode,
  claim: RoleClaim | undefined,
  limit: number,
  page: HydratedEntity[]
): boolean {
  let window = limit + 1;

  for (;;) {
    const rows = hydrateNode(sql, { ...node, limit: window });
    const visible = claim === undefined ? rows : visibleOnly(rows, claim);

    page.length = 0;
    page.push(...visible.slice(0, limit));

    if (rows.length < window) return false; // exhausted
    if (visible.length > limit) return true; // window held more than a page

    window *= 2;
  }
}

/**
 * Keyset predicate for "strictly after `row`" in the node's order.
 *
 * Mirrors the compiler's private `cursorCondition`: for `(a ASC, b DESC)` it
 * builds `a > ? OR (a = ? AND b < ?)`. The executor needs it mid-scan, from a
 * row it just read rather than an opaque client cursor. Both paths share the
 * same null-aware tuple comparison. Missing or invalid ordering columns fail closed.
 */
function conditionAfter(
  order: CompiledOrder[],
  row: PhysicalRow
): CompiledCondition | null {
  const values = order.map(entry => row[entry.column]);
  if (values.some(value => value !== null && typeof value !== "string" && typeof value !== "number")) return null;
  return conditionAfterValues(order, values as (string | number | null)[]);
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
 * cursor to sit in. Null ordering values use SQLite's null-aware ordering.
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
    if (value !== null && typeof value !== "string" && typeof value !== "number") return undefined;
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
  const { sql: statement, params, stages } = buildSelectSql(node, extra);
  const rows = runStaged(sql, stages, params, (bound) => sql.all<PhysicalRow>(statement, ...bound));
  const entities: HydratedEntity[] = rows.map((row) => ({
    namespace: node.namespace,
    row,
    select: node.select,
    links: {},
  }));

  for (const child of node.children) {
    hydrateChild(sql, entities, child);
  }

  return entities;
}

/**
 * Hydrates one link level for every parent, a chunk of parents at a time: the
 * parents' keys travel as one JSON list per statement, and a list of every
 * key on an unbounded page would outgrow what one bound value may hold.
 * Each parent's children come from the one statement that holds its key, so
 * per-parent order and limits are unchanged.
 */
function hydrateChild(
  sql: SqlExecutor,
  entities: HydratedEntity[],
  child: CompiledChild
): void {
  for (let start = 0; start < entities.length; start += QUERY_CHUNK_ROWS) {
    hydrateChildChunk(sql, entities.slice(start, start + QUERY_CHUNK_ROWS), child);
  }
}

function hydrateChildChunk(
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
  if (entity.select !== null) {
    for (const name of entity.select) {
      if (name === "id") continue;
      const definition = namespace.attributes[name];
      if (definition !== undefined) {
        output[name] = fromStoredValue(definition.type, entity.row[toSnakeCase(name)]);
      } else if (name === "createdAt") {
        output.createdAt = fromStoredValue("date", entity.row.created_at);
      } else if (name === "updatedAt") {
        output.updatedAt = fromStoredValue("date", entity.row.updated_at);
      } else if (name === "updatedSeq") {
        output.updatedSeq = fromStoredValue("number", entity.row.updated_seq) ?? 0;
      }
    }
    appendLinks(output, entity);
    return output;
  }
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
  appendLinks(output, entity);
  return output;
}

function appendLinks(output: Record<string, unknown>, entity: HydratedEntity): void {
  for (const [label, value] of Object.entries(entity.links)) {
    output[label] = Array.isArray(value)
      ? value.map(toApiEntity)
      : value === null
        ? null
        : toApiEntity(value);
  }
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
