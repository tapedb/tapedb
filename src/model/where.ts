/**
 * Public filters, ordering and includes, translated into the engine's query
 * document.
 *
 * The public shape is `{ title: "x", due: { lt: now }, OR: [...] }`; the engine
 * reads `{ title: "x", due: { $lt: now }, $or: [...] }`. The translation is
 * strict: an unknown field, operator or relation is an error here rather than
 * a filter the engine silently drops.
 */

import type { QueryWhere } from "../engine/query-types";
import type { EnumField, HasMany } from "./fields";
import type {
  BelongsToKeys,
  FilterKeys,
  Fields,
  HasManyKeys,
  ModelInfo,
  Models,
  RelationKeys,
  TargetFieldsOf,
} from "./schema";

type Scalar = string | number | boolean | null | Date;

export interface FieldFilter<T = Scalar> {
  equals?: T;
  not?: T | FieldFilter<T>;
  in?: T[];
  notIn?: T[];
  gt?: T;
  gte?: T;
  lt?: T;
  lte?: T;
}

/** Filters on a to-many relation: at least one, all, or no related row. */
export interface ManyFilter<W> {
  some?: W;
  every?: W;
  none?: W;
}

/**
 * Filters, typed at every depth. Relation keys resolve lazily, as property
 * types of a mapped object, so models that point at each other (boards hold
 * columns hold boards) are unfolded only as far as a filter actually goes.
 */
type Scalars<F extends Fields> = {
  [K in FilterKeys<F> | { [P in keyof F]: F[P] extends { personalSubject: string } ? P : never }[keyof F]]?: K extends FilterKeys<F>
    ? F[K] extends EnumField<infer V, boolean, boolean>
      ? V | FieldFilter<V>
      : Scalar | FieldFilter
    : never;
};

/**
 * Filters on the columns every row carries: epoch milliseconds for the
 * timestamps, the transaction sequence for `updatedSeq`.
 */
type SystemFilters = {
  createdAt?: Date | number | FieldFilter<Date | number>;
  updatedAt?: Date | number | FieldFilter<Date | number>;
  updatedSeq?: number | FieldFilter<number>;
};

export type Where<F extends Fields = Fields, M extends Models = Models> = Scalars<F> & SystemFilters & {
  [K in RelationKeys<F>]?: F[K] extends HasMany
    ? ManyFilter<Where<TargetFieldsOf<F[K], M>, M>>
    : Where<TargetFieldsOf<F[K], M>, M> | null;
} & {
  AND?: Where<F, M> | Where<F, M>[];
  OR?: Where<F, M>[];
  NOT?: Where<F, M> | Where<F, M>[];
};

const OPERATORS: Record<string, string> = {
  in: "$in",
  notIn: "$nin",
  gt: "$gt",
  gte: "$gte",
  lt: "$lt",
  lte: "$lte",
};

type EngineWhere = Record<string, unknown>;

function scalar(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function isFilterObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function asList<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

/** One field's filter, as engine conditions to AND together. */
function fieldConditions(field: string, value: unknown): EngineWhere[] {
  if (!isFilterObject(value)) return [{ [field]: scalar(value) }];

  const comparison: Record<string, unknown> = {};
  const extra: EngineWhere[] = [];
  for (const [operator, operand] of Object.entries(value)) {
    if (operand === undefined) continue;
    if (operator === "equals") {
      extra.push({ [field]: scalar(operand) });
    } else if (operator === "not") {
      if (isFilterObject(operand)) {
        const inner = fieldConditions(field, operand);
        extra.push({ $not: inner.length === 1 ? inner[0] : { $and: inner } });
      } else {
        comparison.$ne = scalar(operand);
      }
    } else if (operator in OPERATORS) {
      comparison[OPERATORS[operator]] = Array.isArray(operand)
        ? operand.map(scalar)
        : scalar(operand);
    } else {
      throw new Error(`Unknown filter "${operator}" on "${field}".`);
    }
  }
  if (Object.keys(comparison).length > 0) extra.push({ [field]: comparison });
  return extra;
}

/** One relation filter, as the engine's `$link` entry. */
function relationCondition(
  graph: Record<string, ModelInfo>,
  model: ModelInfo,
  key: string,
  value: unknown
): EngineWhere {
  const relation = model.relations[key];
  const target = graph[relation.target];

  if (relation.kind === "belongsTo") {
    if (value === null) return { [relation.foreignKey!]: null };
    if (!isFilterObject(value)) {
      throw new Error(`"${model.key}.${key}" takes a filter object or null.`);
    }
    for (const mode of ["some", "every", "none"]) {
      if (mode in value) {
        throw new Error(
          `"${model.key}.${key}" is a to-one link: filter it directly, as { ${key}: { ... } }, not with ${mode}.`
        );
      }
    }
    return { $link: [{ label: key, mode: "parent", where: toEngineWhere(target, value as Where, graph) }] };
  }

  if (!isFilterObject(value)) {
    throw new Error(`"${model.key}.${key}" takes { some }, { every } or { none }.`);
  }
  const entries = Object.entries(value).filter(([, filter]) => filter !== undefined);
  if (entries.length === 0) {
    throw new Error(`"${model.key}.${key}" needs one of some, every or none.`);
  }
  return {
    $link: entries.map(([mode, filter]) => {
      if (mode !== "some" && mode !== "every" && mode !== "none") {
        throw new Error(`"${model.key}.${key}" takes some, every or none, not "${mode}".`);
      }
      if (!isFilterObject(filter)) {
        throw new Error(`"${model.key}.${key}.${mode}" takes a filter object.`);
      }
      return { label: key, mode, where: toEngineWhere(target, filter as Where, graph) };
    }),
  };
}

/** Translates a public filter into the engine's `where`. */
export function toEngineWhere(
  model: ModelInfo,
  where: Where,
  graph: Record<string, ModelInfo> = {}
): QueryWhere {
  const conditions: EngineWhere[] = [];

  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (key === "AND") {
      for (const branch of asList(value as Where | Where[])) {
        conditions.push(toEngineWhere(model, branch, graph) as EngineWhere);
      }
    } else if (key === "OR") {
      const branches = value as Where[];
      if (!Array.isArray(branches) || branches.length === 0) {
        throw new Error(`"OR" on "${model.key}" needs a non-empty array.`);
      }
      conditions.push({ $or: branches.map((branch) => toEngineWhere(model, branch, graph)) });
    } else if (key === "NOT") {
      for (const branch of asList(value as Where | Where[])) {
        conditions.push({ $not: toEngineWhere(model, branch, graph) });
      }
    } else if (readableField(model, key)) {
      conditions.push(...fieldConditions(key, value));
    } else if (key in model.relations) {
      conditions.push(relationCondition(graph, model, key, value));
    } else {
      throw new Error(`"${model.key}" has no filterable field "${key}".`);
    }
  }

  // Merge conditions on distinct keys into one object; anything that would
  // collide goes under $and.
  const merged: EngineWhere = {};
  const rest: EngineWhere[] = [];
  for (const condition of conditions) {
    const [entry] = Object.entries(condition);
    if (entry[0] === "$link" && Object.keys(condition).length === 1) {
      // Several relation filters are just more entries in the one list; they
      // are ANDed by the compiler like any other condition.
      merged.$link = [
        ...((merged.$link as unknown[] | undefined) ?? []),
        ...(entry[1] as unknown[]),
      ];
    } else if (
      Object.keys(condition).length === 1 &&
      !(entry[0] in merged) &&
      entry[0] !== "$and"
    ) {
      merged[entry[0]] = entry[1];
    } else {
      rest.push(condition);
    }
  }
  if (rest.length > 0) merged.$and = rest;
  return merged as QueryWhere;
}

/**
 * Columns every row carries. They can be read, filtered, ordered and grouped,
 * and they cannot be written: the engine keeps them in step with the log.
 */
const SYSTEM_FIELDS = new Set(["createdAt", "updatedAt", "updatedSeq"]);

/** True when `field` names something a read can address. */
function readableField(model: ModelInfo, field: string): boolean {
  return SYSTEM_FIELDS.has(field) || model.filterable.has(field);
}

export function toEngineOrder(
  model: ModelInfo,
  orderBy: unknown
): Record<string, "asc" | "desc"> | undefined {
  if (orderBy === undefined) return undefined;
  const order: Record<string, "asc" | "desc"> = {};
  for (const entry of asList(orderBy as Record<string, string> | Record<string, string>[])) {
    for (const [field, direction] of Object.entries(entry)) {
      if (!readableField(model, field)) {
        throw new Error(`"${model.key}" cannot be ordered by "${field}".`);
      }
      if (direction !== "asc" && direction !== "desc") {
        throw new Error(`Order for "${model.key}.${field}" must be "asc" or "desc".`);
      }
      order[field] = direction;
    }
  }
  return order;
}

export interface NodeArgs {
  where?: unknown;
  orderBy?: unknown;
  take?: number;
  after?: string;
  include?: Record<string, unknown>;
  select?: Record<string, unknown>;
}

/** Fields a `select` may name besides relations: the keys of a stored row. */
function selectable(model: ModelInfo, name: string): boolean {
  return (
    name === "id" ||
    name === "createdAt" ||
    name === "updatedAt" ||
    name in model.scalars ||
    model.filterable.has(name)
  );
}

/**
 * Splits `select` into the engine's attribute list and the relations it
 * includes. Relations named in `select` are fetched exactly like `include`.
 */
export function splitSelect(
  model: ModelInfo,
  select: Record<string, unknown>
): { fields: string[]; relations: Record<string, unknown> } {
  const fields: string[] = [];
  const relations: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(select)) {
    if (value === undefined || value === false) continue;
    if (name in model.relations) {
      relations[name] = value;
      continue;
    }
    if (!selectable(model, name)) {
      throw new Error(`"${model.key}" has no field "${name}" to select.`);
    }
    if (value !== true) {
      throw new Error(`"${model.key}.${name}" in select takes true or false.`);
    }
    fields.push(name);
  }
  return { fields, relations };
}

/**
 * The relations a level returns: those `select` lists and those `include`
 * adds. A relation named in both gets both sets of arguments; the same
 * argument given two different values is a mistake, not a choice to make.
 */
function relationsOf(
  model: ModelInfo,
  args: NodeArgs,
  split: { relations: Record<string, unknown> } | null
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(args.include ?? {}) };
  for (const [name, value] of Object.entries(split?.relations ?? {})) {
    const other = merged[name];
    if (other === undefined || other === false || other === true) {
      merged[name] = value === true && typeof other === "object" ? other : value;
      continue;
    }
    if (value === true || value === false || value === undefined) continue;
    const a = other as Record<string, unknown>;
    const b = value as Record<string, unknown>;
    const combined: Record<string, unknown> = { ...a };
    for (const [key, item] of Object.entries(b)) {
      if (item === undefined) continue;
      if (key === "select" || key === "include") {
        combined[key] = { ...((a[key] as object | undefined) ?? {}), ...(item as object) };
      } else if (a[key] !== undefined && JSON.stringify(a[key]) !== JSON.stringify(item)) {
        throw new Error(`"${model.key}.${name}" has a different ${key} in select and in include.`);
      } else {
        combined[key] = item;
      }
    }
    merged[name] = combined;
  }
  return merged;
}

/** One level of an engine query document: `{ $: options, label: child, ... }`. */
export function toEngineNode(
  graph: Record<string, ModelInfo>,
  model: ModelInfo,
  args: NodeArgs,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const options: Record<string, unknown> = { ...extra };
  if (args.where !== undefined) options.where = toEngineWhere(model, args.where as Where, graph);
  const order = toEngineOrder(model, args.orderBy);
  if (order !== undefined) options.order = order;
  if (args.take !== undefined) options.limit = args.take;
  if (args.after !== undefined) options.after = args.after;

  const split = args.select === undefined ? null : splitSelect(model, args.select);
  if (split !== null) {
    // The engine always returns the id, so a select of relations alone
    // still asks for one column.
    options.select = split.fields.length > 0 ? split.fields : ["id"];
  }
  const relations = relationsOf(model, args, split);

  const node: Record<string, unknown> = { $: options };
  for (const [name, value] of Object.entries(relations)) {
    if (value === undefined || value === false) continue;
    const relation = model.relations[name];
    if (!relation) {
      throw new Error(`"${model.key}" has no relation "${name}" to include.`);
    }
    node[name] = toEngineNode(
      graph,
      graph[relation.target],
      value === true ? {} : (value as NodeArgs)
    );
  }
  return node;
}

type Shape = (row: Record<string, unknown>) => Record<string, unknown>;

/**
 * Narrows result rows to what the arguments asked for, at every level, or
 * returns null when nothing is narrowed. The engine already sends only the
 * selected fields; this keeps optimistic writes, which patch whole values
 * into cached rows, from widening a narrowed row again.
 */
export function shapeFor(
  graph: Record<string, ModelInfo>,
  model: ModelInfo,
  args: NodeArgs
): Shape | null {
  const split =
    args.select === undefined ? null : splitSelect(model, args.select);
  const relations = relationsOf(model, args, split);

  const nested: Array<[string, Shape | null]> = [];
  for (const [name, value] of Object.entries(relations)) {
    if (value === undefined || value === false) continue;
    const relation = model.relations[name];
    if (!relation) continue;
    nested.push([
      name,
      value === true ? null : shapeFor(graph, graph[relation.target], value as NodeArgs),
    ]);
  }
  if (split === null && nested.every(([, shape]) => shape === null)) return null;

  const fields = split?.fields ?? null;
  return (row) => {
    let output: Record<string, unknown>;
    if (fields === null) {
      output = { ...row };
    } else {
      output = {};
      for (const field of fields) if (field in row) output[field] = row[field];
    }
    for (const [name, shape] of nested) {
      const value = row[name];
      if (value === undefined) continue;
      output[name] =
        shape === null || value === null
          ? value
          : Array.isArray(value)
            ? value.map((child) => shape(child as Record<string, unknown>))
            : shape(value as Record<string, unknown>);
    }
    return output;
  };
}
