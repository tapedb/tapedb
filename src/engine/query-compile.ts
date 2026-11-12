/**
 * InstaQL-to-SQLite compiler for the workspace engine (KAN-392).
 *
 * The compiler resolves every namespace, table, column and link from the
 * registry; client input never names a SQL identifier. Each requested level
 * becomes its own parameterised `SELECT` and the executor hydrates one link
 * level at a time. That keeps link direction handling simple: forward links
 * filter the child table by its foreign key, reverse links look the parent up
 * by id.
 *
 * Supported subset: equality and `$ne`/`$in`/`$gt`/`$gte`/`$lt`/`$lte` on
 * scalar attributes, `order` and `limit` (1..1000). JSON/`any` attributes are
 * returned but cannot be filtered or ordered on. Link nesting is capped at two
 * levels.
 */

import {
  DEFAULT_QUERY_LIMIT,
  invalidOp,
  invalidValue,
  isIsoDate,
  isPlainObject,
  MAX_LINK_DEPTH,
  parseQueryOptions,
  type QueryComparison,
  type QueryOptions,
  type QueryScalar,
  type QueryWhere,
  type SortDirection,
} from "./query-types";
import {
  findNamespace,
  LINKS,
  registryGeneration,
  toSnakeCase,
  type AttributeDefinition,
  type AttributeType,
  type LinkDefinition,
  type NamespaceDefinition,
} from "./registry";
import { quoteIdentifier } from "./tx-apply";
import type { SqlValue } from "./tx-sql";
import { TxError } from "./tx-types";

export type LinkDirection = "forward" | "reverse";
export type LinkMultiplicity = "one" | "many";

export interface CompiledCondition {
  sql: string;
  params: SqlValue[];
}

export interface CompiledOrder {
  column: string;
  direction: SortDirection;
}

export interface CompiledNode {
  /** Namespace API name, e.g. "boards". */
  namespace: string;
  /** Registered SQLite table. */
  table: string;
  /** 0 for a top-level namespace, 1 or 2 for link levels. */
  depth: number;
  /** Quoted-ready physical columns. */
  columns: string[];
  conditions: CompiledCondition[];
  order: CompiledOrder[];
  /** `null` means "no SQL LIMIT" (nested levels are unbounded by default). */
  limit: number | null;
  /** True when the caller asked for `limit`; false for the implicit default. */
  explicitLimit: boolean;
  children: CompiledChild[];
}

export interface CompiledChild {
  /** Link label as it appeared in the query. */
  label: string;
  /** Target namespace of the traversal. */
  target: string;
  direction: LinkDirection;
  multiplicity: LinkMultiplicity;
  /** Physical FK column used to join this level to its target. */
  foreignKeyColumn: string;
  node: CompiledNode;
}

export interface CompiledQuery {
  nodes: CompiledNode[];
}

/** Extra predicate applied by the executor during link hydration. */
export interface ForeignKeyFilter {
  column: string;
  ids: string[];
}

interface LinkLabelInfo {
  link: LinkDefinition;
  direction: LinkDirection;
}

interface ResolvedAttribute {
  column: string;
  type: AttributeType;
}

/** namespace -> link label -> direction. Built once from the registry. */
/**
 * Link labels are indexed lazily: the deployment schema is installed by
 * `configureRegistry()` after this module loads, so a module-level snapshot
 * would be empty forever.
 */
let linkLabelCache: {
  generation: number;
  index: Map<string, Map<string, LinkLabelInfo>>;
} | null = null;

function linkLabels(): Map<string, Map<string, LinkLabelInfo>> {
  const generation = registryGeneration();
  if (linkLabelCache === null || linkLabelCache.generation !== generation) {
    linkLabelCache = { generation, index: buildLinkLabels() };
  }
  return linkLabelCache.index;
}

export function compileQuery(value: unknown): CompiledQuery {
  if (!isPlainObject(value)) {
    throw invalidOp("Query must be a plain object keyed by namespace.");
  }

  const nodes = Object.entries(value).map(([namespace, node]) =>
    compileNode(namespace, node, 0)
  );

  return { nodes };
}

/**
 * Builds the parameterised `SELECT` for one level. `extra` adds the link
 * predicate (`foreign_key IN (...)` or `id IN (...)`) without rebuilding the
 * level's own options.
 */
export function buildSelectSql(
  node: CompiledNode,
  extra?: ForeignKeyFilter
): { sql: string; params: SqlValue[] } {
  const conditions = [...node.conditions];

  if (extra !== undefined) {
    if (extra.ids.length === 0) {
      conditions.push({ sql: "0 = 1", params: [] });
    } else {
      conditions.push({
        sql: `${quoteIdentifier(extra.column)} IN (${extra.ids
          .map(() => "?")
          .join(", ")})`,
        params: [...extra.ids],
      });
    }
  }

  const params = conditions.flatMap((condition) => condition.params);
  const whereSql =
    conditions.length > 0
      ? ` WHERE ${conditions
          .map((condition) => `(${condition.sql})`)
          .join(" AND ")}`
      : "";
  const orderSql =
    node.order.length > 0
      ? ` ORDER BY ${node.order
          .map(
            (entry) =>
              `${quoteIdentifier(entry.column)} ${entry.direction.toUpperCase()}`
          )
          .join(", ")}`
      : "";

  const limitSql = node.limit === null ? "" : " LIMIT ?";
  if (node.limit !== null) params.push(node.limit);

  return {
    sql: `SELECT ${node.columns
      .map(quoteIdentifier)
      .join(", ")} FROM ${quoteIdentifier(
      node.table
    )}${whereSql}${orderSql}${limitSql}`,
    params,
  };
}

function compileNode(
  namespaceName: string,
  value: unknown,
  depth: number
): CompiledNode {
  if (depth > MAX_LINK_DEPTH) {
    throw invalidOp(
      `Links may be nested at most ${MAX_LINK_DEPTH} levels deep.`
    );
  }

  const namespace = findNamespace(namespaceName);
  if (!namespace) {
    throw new TxError(
      "unknown_namespace",
      `Unknown namespace "${namespaceName}".`
    );
  }

  if (!isPlainObject(value)) {
    throw invalidOp(`Query for "${namespaceName}" must be an object.`);
  }

  const options: QueryOptions = "$" in value ? parseQueryOptions(value.$) : {};

  const children: CompiledChild[] = [];
  for (const [label, raw] of Object.entries(value)) {
    if (label === "$") continue;

    const info = findLinkLabel(namespaceName, label);
    if (!info) {
      throw new TxError(
        "unknown_link",
        `Unknown link "${label}" on namespace "${namespaceName}".`
      );
    }

    if (depth >= MAX_LINK_DEPTH) {
      throw invalidOp(
        `Links may be nested at most ${MAX_LINK_DEPTH} levels deep.`
      );
    }

    if (!isPlainObject(raw)) {
      throw invalidOp(`Link "${label}" must be an object.`);
    }

    const target = linkTarget(info);
    children.push({
      label,
      target: target.namespace,
      direction: info.direction,
      multiplicity: linkMultiplicity(info),
      foreignKeyColumn: toSnakeCase(info.link.foreignKey.attribute),
      node: compileNode(target.namespace, raw, depth + 1),
    });
  }

  return {
    namespace: namespaceName,
    table: namespace.table,
    depth,
    columns: selectColumns(namespace),
    conditions: compileWhere(namespace, options.where),
    order: compileOrder(namespace, options.order),
    // Only the top level gets the implicit result cap. A nested level is
    // bounded per parent (see `hydrateChild`), never by one shared LIMIT.
    limit: options.limit ?? (depth === 0 ? DEFAULT_QUERY_LIMIT : null),
    explicitLimit: options.limit !== undefined,
    children,
  };
}

function selectColumns(namespace: NamespaceDefinition): string[] {
  const columns = new Set<string>(["id"]);
  for (const attribute of Object.keys(namespace.attributes)) {
    columns.add(toSnakeCase(attribute));
  }
  columns.add("created_at");
  columns.add("updated_at");
  columns.add("updated_seq");
  return [...columns];
}

function compileWhere(
  namespace: NamespaceDefinition,
  where: QueryWhere | undefined
): CompiledCondition[] {
  if (where === undefined) return [];

  const conditions: CompiledCondition[] = [];
  for (const [attribute, value] of Object.entries(where)) {
    const resolved = resolveAttribute(namespace, attribute);
    if (!resolved) {
      throw new TxError(
        "unknown_attribute",
        `Unknown attribute "${attribute}" on namespace "${namespace.apiName}".`
      );
    }

    if (resolved.type === "json" || resolved.type === "any") {
      throw invalidValue(
        `Cannot filter on non-scalar attribute "${attribute}".`
      );
    }

    conditions.push(
      isPlainObject(value)
        ? compileComparison(
            resolved.column,
            resolved.type,
            attribute,
            value as QueryComparison
          )
        : compileEquality(resolved, attribute, value as QueryScalar)
    );
  }
  return conditions;
}

function compileOrder(
  namespace: NamespaceDefinition,
  order: Record<string, SortDirection> | undefined
): CompiledOrder[] {
  if (order === undefined) return [];

  const compiled: CompiledOrder[] = [];
  for (const [attribute, direction] of Object.entries(order)) {
    const resolved = resolveAttribute(namespace, attribute);
    if (!resolved) {
      throw new TxError(
        "unknown_attribute",
        `Unknown attribute "${attribute}" on namespace "${namespace.apiName}".`
      );
    }
    if (resolved.type === "json" || resolved.type === "any") {
      throw invalidValue(
        `Cannot order by non-scalar attribute "${attribute}".`
      );
    }
    compiled.push({ column: resolved.column, direction });
  }
  return compiled;
}

function resolveAttribute(
  namespace: NamespaceDefinition,
  attribute: string
): ResolvedAttribute | undefined {
  if (attribute === "id") {
    return { column: "id", type: "string" };
  }

  const definition: AttributeDefinition | undefined =
    namespace.attributes[attribute];
  if (!definition) return undefined;

  return { column: toSnakeCase(attribute), type: definition.type };
}

function compileEquality(
  attribute: ResolvedAttribute,
  name: string,
  value: QueryScalar
): CompiledCondition {
  const normalised = normaliseFilterValue(attribute.type, value, name);
  const column = quoteIdentifier(attribute.column);

  if (normalised === null) {
    return { sql: `${column} IS NULL`, params: [] };
  }
  return { sql: `${column} = ?`, params: [normalised] };
}

function compileComparison(
  columnName: string,
  type: AttributeType,
  name: string,
  comparison: QueryComparison
): CompiledCondition {
  const column = quoteIdentifier(columnName);
  const clauses: string[] = [];
  const params: SqlValue[] = [];

  for (const [operator, operand] of Object.entries(comparison)) {
    if (operand === undefined) continue;

    switch (operator) {
      case "$ne": {
        const value = normaliseOperand(type, operand, name);
        if (value === null) {
          clauses.push(`${column} IS NOT NULL`);
        } else {
          // `$ne` also matches entities where the attribute is
          // null or missing. Bare `<>` drops those rows through SQL's
          // three-valued logic, which silently hides every entity that never
          // set the field.
          clauses.push(`(${column} IS NULL OR ${column} <> ?)`);
          params.push(value);
        }
        break;
      }
      case "$in": {
        if (!Array.isArray(operand)) {
          throw invalidValue(`"$in" on "${name}" requires an array.`);
        }
        const values = operand.map((item, index) =>
          normaliseFilterValue(type, item, `${name}.$in[${index}]`)
        );
        const nonNull = values.filter(
          (item): item is Exclude<SqlValue, null> => item !== null
        );
        const hasNull = values.length !== nonNull.length;

        if (nonNull.length === 0 && !hasNull) {
          clauses.push("0 = 1");
        } else {
          const parts: string[] = [];
          if (nonNull.length > 0) {
            parts.push(`${column} IN (${nonNull.map(() => "?").join(", ")})`);
            params.push(...nonNull);
          }
          if (hasNull) parts.push(`${column} IS NULL`);
          clauses.push(parts.join(" OR "));
        }
        break;
      }
      case "$gt":
      case "$gte":
      case "$lt":
      case "$lte": {
        const value = normaliseOperand(type, operand, name);
        if (value === null) {
          throw invalidValue(
            `Comparison "${operator}" on "${name}" cannot use null.`
          );
        }
        const sqlOperator =
          operator === "$gt"
            ? ">"
            : operator === "$gte"
              ? ">="
              : operator === "$lt"
                ? "<"
                : "<=";
        clauses.push(`${column} ${sqlOperator} ?`);
        params.push(value);
        break;
      }
    }
  }

  return {
    sql:
      clauses.length > 0
        ? clauses.map((clause) => `(${clause})`).join(" AND ")
        : "1 = 1",
    params,
  };
}

function normaliseOperand(
  type: AttributeType,
  value: unknown,
  name: string
): SqlValue {
  if (typeof value === "object" && value !== null) {
    throw invalidValue(`Comparison value for "${name}" must be a scalar.`);
  }
  return normaliseFilterValue(type, value, name);
}

function normaliseFilterValue(
  type: AttributeType,
  value: unknown,
  name: string
): SqlValue {
  if (value === null) return null;

  switch (type) {
    case "string":
      if (typeof value !== "string") {
        throw invalidValue(`"${name}" must be a string.`);
      }
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw invalidValue(`"${name}" must be a finite number.`);
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") {
        throw invalidValue(`"${name}" must be a boolean.`);
      }
      return value ? 1 : 0;
    case "date": {
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === "string" && isIsoDate(value)) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      throw invalidValue(
        `"${name}" must be epoch milliseconds or an ISO-8601 date.`
      );
    }
    case "json":
    case "any":
      throw invalidValue(`Cannot filter on non-scalar attribute "${name}".`);
  }
}

function buildLinkLabels(): Map<string, Map<string, LinkLabelInfo>> {
  const byNamespace = new Map<string, Map<string, LinkLabelInfo>>();

  for (const link of Object.values(LINKS)) {
    addLinkLabel(byNamespace, link.forward.namespace, link.forward.label, {
      link,
      direction: "forward",
    });
    addLinkLabel(byNamespace, link.reverse.namespace, link.reverse.label, {
      link,
      direction: "reverse",
    });
  }

  return byNamespace;
}

function addLinkLabel(
  byNamespace: Map<string, Map<string, LinkLabelInfo>>,
  namespace: string,
  label: string,
  info: LinkLabelInfo
): void {
  let labels = byNamespace.get(namespace);
  if (!labels) {
    labels = new Map<string, LinkLabelInfo>();
    byNamespace.set(namespace, labels);
  }
  labels.set(label, info);
}

function findLinkLabel(
  namespace: string,
  label: string
): LinkLabelInfo | undefined {
  return linkLabels().get(namespace)?.get(label);
}

function linkTarget(info: LinkLabelInfo): { namespace: string } {
  return info.direction === "forward"
    ? { namespace: info.link.foreignKey.namespace }
    : { namespace: info.link.forward.namespace };
}

function linkMultiplicity(info: LinkLabelInfo): LinkMultiplicity {
  return info.direction === "forward"
    ? info.link.forward.has
    : info.link.reverse.has;
}
