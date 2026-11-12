/**
 * Executes compiled InstaQL queries against workspace SQLite (KAN-392).
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
  type CompiledChild,
  type CompiledNode,
  type CompiledQuery,
} from "./query-compile";
import {
  encodeQueryCursor,
  parseQueryEnvelope,
  type QueryPageInfo,
  type QueryResult,
} from "./query-types";
import { findNamespace, toSnakeCase, type AttributeType } from "./registry";
import { allowRowView, assertPermission } from "./tx-permissions";
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
 * Executes a compiled query and reports truncation per namespace.
 *
 * The SELECT asks for one row beyond the limit so `hasMore` is exact instead of
 * a guess, and the extra row is discarded before hydration.
 */
export function executeCompiledQueryWithPageInfo(
  sql: SqlExecutor,
  compiled: CompiledQuery,
  claim?: RoleClaim
): { data: QueryResult; pageInfo: QueryPageInfo } {
  const data: QueryResult = {};
  const pageInfo: QueryPageInfo = {};

  for (const node of compiled.nodes) {
    const limit = node.limit;
    const entities = hydrateNode(
      sql,
      limit === null ? node : { ...node, limit: limit + 1 }
    );
    const hasMore = limit !== null && entities.length > limit;
    const page = hasMore ? entities.slice(0, limit) : entities;

    // Row-level read rules run here, after the SQL limit: a rule is arbitrary
    // TypeScript, so it cannot be pushed into the query. A page can therefore
    // come back smaller than the limit, and `hasMore` reflects the unfiltered
    // match count.
    const visible =
      claim === undefined
        ? page
        : page
            .map((entity) => filterVisible(entity, claim))
            .filter((entity): entity is HydratedEntity => entity !== null);

    data[node.namespace] = visible.map(toApiEntity);

    const nextCursor = cursorFor(node, page, hasMore);
    pageInfo[node.namespace] =
      nextCursor === undefined
        ? { limit, returned: visible.length, hasMore }
        : { limit, returned: visible.length, hasMore, nextCursor };
  }

  return { data, pageInfo };
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
