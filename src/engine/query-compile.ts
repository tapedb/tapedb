/**
 * Query-document-to-SQLite compiler for the workspace engine.
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
 * returned but cannot be filtered or ordered on. Links nest as deep as the
 * document asks (one statement per level); relation filters nest until
 * SQLite's expression depth (about eight hops in a Durable Object), past
 * which the query is a bad request (`sqliteLimitError`).
 */

import { compileAggregate, type CompiledAggregate } from "./query-aggregate";
import { balancedJoin } from "./sql-binding";
import {
  invalidOp,
  invalidValue,
  isIsoDate,
  isPlainObject,
  parseQueryOptions,
  parseWhere,
  decodeQueryCursor,
  type QueryComparison,
  type QueryOptions,
  type QueryScalar,
  type QueryRelationFilter,
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
  /** The `after` keyset predicate: a count ignores it. */
  cursor?: true;
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
  /**
   * Physical columns to read. With a `select` this is the selected columns
   * plus what the engine itself needs: id, sequence, ordering keys and the
   * foreign keys that join link levels.
   */
  columns: string[];
  /** API attribute names to return, or null for every attribute. */
  select: string[] | null;
  conditions: CompiledCondition[];
  order: CompiledOrder[];
  /** `null` means "no SQL LIMIT" (nested levels are unbounded by default). */
  limit: number | null;
  /** True when the caller asked for `limit`; false for the implicit default. */
  explicitLimit: boolean;
  /** Top level only: also count every matching row. */
  count: boolean;
  /**
   * Namespaces this level's filters read through relation subqueries, and
   * through the read rules compiled into them. A write to one changes which
   * rows match, so live subscriptions re-run on it.
   */
  references: string[];
  /** Top level only: aggregate the matching rows instead of reading them. */
  aggregate: CompiledAggregate | null;
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

/**
 * Compiles a query document.
 *
 * `view` is how relation filters learn what the caller may read: their
 * subqueries run over rows that are never returned, so without it a filter on
 * a linked namespace could reveal rows a read rule hides. Omitting it compiles
 * without read rules, which matches executing without a claim.
 */
export function compileQuery(value: unknown, view?: ViewAccess): CompiledQuery {
  if (!isPlainObject(value)) {
    throw invalidOp("Query must be a plain object keyed by namespace.");
  }

  try {
    const nodes = Object.entries(value).map(([namespace, node]) =>
      compileNode(namespace, node, 0, view)
    );
    return { nodes };
  } catch (error) {
    // Links, relation filters and logical filters nest as deep as the
    // document does. A document deep enough to exhaust the stack is a bad
    // request, not a server fault.
    if (error instanceof RangeError) {
      throw invalidOp("The query nests too deeply to compile.");
    }
    throw error;
  }
}

/**
 * SQLite's own bounds on one statement, reported as a bad request naming
 * the bound. The one a query can realistically reach is expression depth:
 * a Durable Object's SQLite allows 100, and each relation filter nested
 * inside another costs more than the last (SQLite counts the enclosing
 * expression again for every subquery), so about eight hops fit in one
 * filter, measured in workerd. Wide filters do not count against it:
 * `balancedJoin` keeps AND/OR chains logarithmic and lists travel as one
 * JSON parameter.
 */
export function sqliteLimitError(error: unknown): TxError | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/expression tree is too large|recursion limit|too many terms|parser stack overflow|too many SQL variables|string or blob too big/i.test(message)) {
    return invalidOp(`The query is larger than SQLite can run as one statement (${message}). Split the filter.`);
  }
  return null;
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
      // One parameter for the whole list: a page of parents can hold a
      // thousand ids, and a Durable Object binds at most 100 parameters.
      conditions.push({
        sql: `${quoteIdentifier(extra.column)} IN ${valueList()}`,
        params: [JSON.stringify(extra.ids)],
      });
    }
  }

  const params = conditions.flatMap((condition) => condition.params);
  const whereSql =
    conditions.length > 0
      ? ` WHERE ${balancedJoin(conditions.map((condition) => condition.sql), " AND ")}`
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
  depth: number,
  view?: ViewAccess
): CompiledNode {
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
  /** Columns this level must read for its links, whatever it selects. */
  const linkColumns: string[] = [];
  for (const [label, raw] of Object.entries(value)) {
    if (label === "$") continue;

    const info = findLinkLabel(namespaceName, label);
    if (!info) {
      throw new TxError(
        "unknown_link",
        `Unknown link "${label}" on namespace "${namespaceName}".`
      );
    }

    if (!isPlainObject(raw)) {
      throw invalidOp(`Link "${label}" must be an object.`);
    }

    const target = linkTarget(info);
    const foreignKeyColumn = toSnakeCase(info.link.foreignKey.attribute);
    const node = compileNode(target.namespace, raw, depth + 1, view);
    // Forward links group the child rows by their key; reverse links look
    // the target up by this row's key. Either way the key is read.
    if (info.direction === "forward") {
      if (!node.columns.includes(foreignKeyColumn)) node.columns.push(foreignKeyColumn);
    } else {
      linkColumns.push(foreignKeyColumn);
    }
    children.push({
      label,
      target: target.namespace,
      direction: info.direction,
      multiplicity: linkMultiplicity(info),
      foreignKeyColumn,
      node,
    });
  }

  if (options.count === true && depth > 0) {
    throw invalidOp('"count" is only available on a top-level namespace.');
  }
  if (options.limit === 0 && children.length > 0) {
    throw invalidOp('"limit: 0" reads no rows, so it cannot traverse links.');
  }
  if (options.aggregate !== undefined) {
    if (depth > 0) {
      throw invalidOp('"aggregate" is only available on a top-level namespace.');
    }
    if (options.limit !== undefined && options.limit !== 0) {
      throw invalidOp('"aggregate" reads no rows: leave "limit" out or set it to 0.');
    }
    for (const key of ["after", "order", "select"] as const) {
      if (options[key] !== undefined) {
        throw invalidOp(`"aggregate" cannot be combined with "${key}"; order groups with "aggregate.order".`);
      }
    }
    if (children.length > 0) {
      throw invalidOp('"aggregate" reads no rows, so it cannot traverse links.');
    }
  }

  const order = compileOrder(namespace, options.order);
  const references = new Set<string>();
  const conditions = compileWhere(namespace, options.where, { view, references });
  // The caller's own `where` read rule is ANDed in at execution; a relation
  // filter inside it reads other namespaces just the same.
  const ownRule = view?.branches(namespaceName);
  if (ownRule !== undefined && ownRule !== null) {
    try {
      compileViewCondition(namespaceName, ownRule, undefined, references);
    } catch {
      // An invalid rule is refused when the query executes.
    }
  }
  if (options.after !== undefined) {
    conditions.push({ ...cursorCondition(options.after, order), cursor: true });
  }

  const select =
    options.select === undefined ? null : compileSelect(namespace, options.select);
  const columns =
    select === null
      ? selectColumns(namespace)
      : unique([
          "id",
          "updated_seq",
          ...select.map((name) => selectableColumn(namespace, name)!),
          ...order.map((entry) => entry.column),
          ...linkColumns,
        ]);

  return {
    namespace: namespaceName,
    table: namespace.table,
    depth,
    columns,
    select,
    conditions,
    references: [...references],
    order,
    // No limit reads every matching row. A nested level's limit is applied
    // per parent (see `hydrateChild`), never as one shared LIMIT.
    limit: options.aggregate !== undefined ? 0 : (options.limit ?? null),
    explicitLimit: options.limit !== undefined,
    count: options.count === true,
    aggregate:
      options.aggregate === undefined ? null : compileAggregate(namespace, options.aggregate),
    children,
  };
}

/**
 * Lexicographic "after the cursor row" predicate.
 *
 * For order (a ASC, b DESC) the next page starts at
 * `a > va OR (a = va AND b < vb)`. The cursor becomes an ordinary WHERE
 * clause, so the executor needs no pagination awareness.
 */
function cursorCondition(
  after: string,
  order: CompiledOrder[]
): CompiledCondition {
  if (order.length === 0) {
    throw invalidOp('"after" requires an explicit "$.order".');
  }

  const cursor = decodeQueryCursor(after);
  const columns = order.map((entry) => entry.column);

  if (
    cursor.cols.length !== columns.length ||
    cursor.cols.some((column, index) => column !== columns[index])
  ) {
    throw invalidOp('"after" cursor does not match this query\'s "$.order".');
  }

  return conditionAfterValues(order, cursor.vals);
}

/** SQLite puts NULL first in ascending order and last in descending order. */
export function conditionAfterValues(
  order: CompiledOrder[],
  values: readonly (string | number | null)[]
): CompiledCondition {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  for (let index = 0; index < order.length; index += 1) {
    const entry = order[index];
    const value = values[index];
    if (value === null && entry.direction === "desc") continue;
    const parts: string[] = [];
    for (let prior = 0; prior < index; prior += 1) {
      parts.push(`${quoteIdentifier(order[prior].column)} IS ?`);
      params.push(values[prior]);
    }
    const column = quoteIdentifier(entry.column);
    if (value === null) {
      parts.push(`${column} IS NOT NULL`);
    } else {
      parts.push(entry.direction === "desc" ? `(${column} < ? OR ${column} IS NULL)` : `${column} > ?`);
      params.push(value);
    }
    clauses.push(balancedJoin(parts, " AND "));
  }
  return { sql: clauses.length ? balancedJoin(clauses, " OR ") : "0 = 1", params };
}

/**
 * Compiles a `where` view rule's branches into one condition: AND inside a
 * branch, OR across branches. No branches compiles to "no rows".
 *
 * Branches are validated with the same parser as client filters, so an
 * unsupported operator is refused instead of being ignored. Ignoring one would
 * compile to `1 = 1` and widen access.
 */
export function compileViewCondition(
  namespaceName: string,
  branches: readonly unknown[],
  alias?: string,
  references?: Set<string>
): CompiledCondition {
  const namespace = findNamespace(namespaceName);
  if (!namespace) {
    throw new TxError(
      "unknown_namespace",
      `Unknown namespace "${namespaceName}".`
    );
  }
  if (branches.length === 0) return { sql: "0 = 1", params: [] };

  const parts: string[] = [];
  const params: SqlValue[] = [];
  for (const branch of branches) {
    let conditions: CompiledCondition[];
    try {
      conditions = compileWhere(namespace, parseWhere(branch), { alias, references });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new TxError(
        "permission_denied",
        `View rule for "${namespaceName}" returned an invalid filter: ${reason}`
      );
    }
    if (conditions.length === 0) {
      parts.push("1 = 1");
      continue;
    }
    parts.push(balancedJoin(conditions.map((condition) => condition.sql), " AND "));
    for (const condition of conditions) params.push(...condition.params);
  }

  return { sql: balancedJoin(parts, " OR "), params };
}

/** The physical column behind a selectable API name, or undefined. */
function selectableColumn(
  namespace: NamespaceDefinition,
  name: string
): string | undefined {
  switch (name) {
    case "id":
      return "id";
    case "createdAt":
      return "created_at";
    case "updatedAt":
      return "updated_at";
    case "updatedSeq":
      return "updated_seq";
  }
  return name in namespace.attributes ? toSnakeCase(name) : undefined;
}

function compileSelect(namespace: NamespaceDefinition, names: string[]): string[] {
  for (const name of names) {
    if (selectableColumn(namespace, name) === undefined) {
      throw new TxError(
        "unknown_attribute",
        `Unknown attribute "${name}" on namespace "${namespace.apiName}".`
      );
    }
  }
  return names;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Every column of a namespace: what a read without `select` returns. */
export function selectColumns(namespace: NamespaceDefinition): string[] {
  const columns = new Set<string>(["id"]);
  for (const attribute of Object.keys(namespace.attributes)) {
    columns.add(toSnakeCase(attribute));
  }
  columns.add("created_at");
  columns.add("updated_at");
  columns.add("updated_seq");
  return [...columns];
}

/**
 * How a subquery sees the caller's access to a namespace. Supplied by the
 * executor, which holds the claim; the compiler only places what it returns.
 */
export interface ViewAccess {
  /** `where` view-rule branches to AND into a read, or null when there is none. */
  branches(namespace: string): readonly QueryWhere[] | null;
  /** A reason the namespace cannot be filtered on in SQL, or null. */
  refusal(namespace: string): string | null;
}

interface WhereContext {
  /** Table alias to qualify columns with, for correlated subqueries. */
  alias?: string;
  view?: ViewAccess;
  /** Relation nesting so far. */
  depth?: number;
  /** Shared counter, so every subquery in one statement gets its own alias. */
  aliases?: { next: number };
  /** Collects every namespace a relation subquery reads. */
  references?: Set<string>;
}

function compileWhere(
  namespace: NamespaceDefinition,
  where: QueryWhere | undefined,
  context: WhereContext = {}
): CompiledCondition[] {
  if (where === undefined) return [];

  const conditions: CompiledCondition[] = [];
  for (const [attribute, value] of Object.entries(where)) {
    if (attribute === "$link") {
      for (const relation of value as QueryRelationFilter[]) {
        conditions.push(compileRelationFilter(namespace, relation, context));
      }
      continue;
    }
    if (attribute === "$or" || attribute === "$and") {
      const branches = (value as QueryWhere[]).map((branch) =>
        conjunction(compileWhere(namespace, branch, context))
      );
      conditions.push(
        joinConditions(branches, attribute === "$or" ? " OR " : " AND ")
      );
      continue;
    }
    if (attribute === "$not") {
      const inner = conjunction(compileWhere(namespace, value as QueryWhere, context));
      // SQL's NOT of an unknown is unknown, which drops the row. A row whose
      // field is null does not match `{ status: "done" }`, so it should match
      // its negation: COALESCE treats unknown as false before negating.
      conditions.push({
        sql: `NOT COALESCE((${inner.sql}), 0)`,
        params: inner.params,
      });
      continue;
    }

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
            value as QueryComparison,
            context.alias
          )
        : compileEquality(resolved, attribute, value as QueryScalar, context.alias)
    );
  }
  return conditions;
}

/**
 * One relation filter, as a correlated subquery over the linked table.
 *
 *   parent  the row this one points at matches      fk IN (SELECT id ...)
 *   some    at least one child matches              EXISTS (...)
 *   none    no child matches                        NOT EXISTS (...)
 *   every   no child fails                          NOT EXISTS (... AND NOT inner)
 *
 * The linked rows are never returned, so the caller could otherwise learn
 * about rows a read rule hides. The target's `where` view rule is therefore
 * compiled into the subquery, and a target whose rule is a function — which
 * only runs after fetch — is refused rather than filtered without it.
 */
function compileRelationFilter(
  namespace: NamespaceDefinition,
  relation: QueryRelationFilter,
  context: WhereContext
): CompiledCondition {
  const depth = context.depth ?? 0;

  const info = findLinkLabel(namespace.apiName, relation.label);
  if (!info) {
    throw new TxError(
      "unknown_link",
      `Unknown link "${relation.label}" on namespace "${namespace.apiName}".`
    );
  }

  const target = findNamespace(linkTarget(info).namespace);
  if (!target) {
    throw new TxError(
      "unknown_namespace",
      `Link "${relation.label}" points at an unregistered namespace.`
    );
  }

  context.references?.add(target.apiName);
  const refusal = context.view?.refusal(target.apiName);
  if (refusal !== undefined && refusal !== null) {
    throw new TxError("invalid_op", refusal);
  }

  const multiplicity = linkMultiplicity(info);
  if (relation.mode === "parent" && multiplicity !== "one") {
    throw invalidOp(
      `"${relation.label}" is a to-many link: filter it with some, every or none.`
    );
  }
  if (relation.mode !== "parent" && multiplicity === "one") {
    throw invalidOp(
      `"${relation.label}" is a to-one link: filter it directly, not with ${relation.mode}.`
    );
  }

  const aliases = context.aliases ?? { next: 0 };
  const alias = `__r${aliases.next++}`;
  const foreignKey = toSnakeCase(info.link.foreignKey.attribute);
  const inner = compileWhere(target, relation.where, {
    alias,
    view: context.view,
    depth: depth + 1,
    aliases,
    references: context.references,
  });

  const viewBranches = context.view?.branches(target.apiName);
  if (viewBranches !== undefined && viewBranches !== null) {
    inner.push(compileViewCondition(target.apiName, viewBranches, alias, context.references));
  }

  const params: SqlValue[] = inner.flatMap((condition) => condition.params);
  const innerSql =
    inner.length === 0 ? "1 = 1" : balancedJoin(inner.map((condition) => condition.sql), " AND ");
  const from = `${quoteIdentifier(target.table)} AS ${quoteIdentifier(alias)}`;

  if (relation.mode === "parent") {
    // The outer row holds the key. A null key matches nothing, which is what
    // "its parent matches" means for a row that has no parent.
    return {
      sql: `${qualify(foreignKey, context.alias ?? namespace.table)} IN (SELECT ${quoteIdentifier(alias)}."id" FROM ${from} WHERE ${innerSql})`,
      params,
    };
  }

  const correlation = `${qualify(foreignKey, alias)} = ${qualify("id", context.alias ?? namespace.table)}`;
  if (relation.mode === "every") {
    // "every child matches" is "no child fails", which is also true when there
    // are no children — the same reading SQL's universal quantifier has.
    return {
      sql: `NOT EXISTS (SELECT 1 FROM ${from} WHERE ${correlation} AND NOT COALESCE((${innerSql}), 0))`,
      params,
    };
  }
  const exists = `EXISTS (SELECT 1 FROM ${from} WHERE ${correlation} AND (${innerSql}))`;
  return { sql: relation.mode === "none" ? `NOT ${exists}` : exists, params };
}

/** AND of a branch's conditions; an empty branch matches everything. */
function conjunction(conditions: CompiledCondition[]): CompiledCondition {
  if (conditions.length === 0) return { sql: "1 = 1", params: [] };
  return joinConditions(conditions, " AND ");
}

function joinConditions(
  conditions: CompiledCondition[],
  joiner: " AND " | " OR "
): CompiledCondition {
  return {
    sql: balancedJoin(conditions.map((condition) => condition.sql), joiner),
    params: conditions.flatMap((condition) => condition.params),
  };
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

/**
 * A list bound as one JSON array parameter. Values compare exactly as bound
 * ones would: the column's affinity applies to the right-hand side either
 * way.
 */
function valueList(): string {
  return "(SELECT value FROM json_each(?))";
}

/** `"column"` or `"alias"."column"`: unqualified names bind to the nearest FROM. */
function qualify(column: string, alias?: string): string {
  return alias === undefined
    ? quoteIdentifier(column)
    : `${quoteIdentifier(alias)}.${quoteIdentifier(column)}`;
}

function compileEquality(
  attribute: ResolvedAttribute,
  name: string,
  value: QueryScalar,
  alias?: string
): CompiledCondition {
  const normalised = normaliseFilterValue(attribute.type, value, name);
  const column = qualify(attribute.column, alias);

  if (normalised === null) {
    return { sql: `${column} IS NULL`, params: [] };
  }
  return { sql: `${column} = ?`, params: [normalised] };
}

function compileComparison(
  columnName: string,
  type: AttributeType,
  name: string,
  comparison: QueryComparison,
  alias?: string
): CompiledCondition {
  const column = qualify(columnName, alias);
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
            parts.push(`${column} IN ${valueList()}`);
            params.push(JSON.stringify(nonNull));
          }
          if (hasNull) parts.push(`${column} IS NULL`);
          clauses.push(parts.join(" OR "));
        }
        break;
      }
      case "$nin": {
        if (!Array.isArray(operand)) {
          throw invalidValue(`"$nin" on "${name}" requires an array.`);
        }
        const values = operand.map((item, index) =>
          normaliseFilterValue(type, item, `${name}.$nin[${index}]`)
        );
        const nonNull = values.filter(
          (item): item is Exclude<SqlValue, null> => item !== null
        );
        const excludesNull = values.length !== nonNull.length;
        const parts: string[] = [];
        if (nonNull.length > 0) {
          parts.push(`${column} NOT IN ${valueList()}`);
          params.push(JSON.stringify(nonNull));
        }
        if (excludesNull) {
          parts.unshift(`${column} IS NOT NULL`);
          clauses.push(parts.join(" AND "));
        } else if (parts.length > 0) {
          // As with $ne, a row whose field is null is not in the list.
          clauses.push(`${column} IS NULL OR ${parts[0]}`);
        } else {
          clauses.push("1 = 1");
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
        ? balancedJoin(clauses, " AND ")
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
