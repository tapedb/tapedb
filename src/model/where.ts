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
import type { FilterKeys, Fields, ModelInfo } from "./schema";

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

export type Where<F extends Fields = Fields> = {
  [K in FilterKeys<F>]?: Scalar | FieldFilter;
} & {
  AND?: Where<F> | Where<F>[];
  OR?: Where<F>[];
  NOT?: Where<F> | Where<F>[];
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

/** Translates a public filter into the engine's `where`. */
export function toEngineWhere(model: ModelInfo, where: Where): QueryWhere {
  const conditions: EngineWhere[] = [];

  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (key === "AND") {
      for (const branch of asList(value as Where | Where[])) {
        conditions.push(toEngineWhere(model, branch) as EngineWhere);
      }
    } else if (key === "OR") {
      const branches = value as Where[];
      if (!Array.isArray(branches) || branches.length === 0) {
        throw new Error(`"OR" on "${model.key}" needs a non-empty array.`);
      }
      conditions.push({ $or: branches.map((branch) => toEngineWhere(model, branch)) });
    } else if (key === "NOT") {
      for (const branch of asList(value as Where | Where[])) {
        conditions.push({ $not: toEngineWhere(model, branch) });
      }
    } else if (model.filterable.has(key)) {
      conditions.push(...fieldConditions(key, value));
    } else if (key in model.relations) {
      throw new Error(
        `Filtering "${model.key}" on its relation "${key}" is not supported yet; filter on "${key}Id" or query "${model.relations[key].target}" instead.`
      );
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
    if (Object.keys(condition).length === 1 && !(entry[0] in merged) && entry[0] !== "$and") {
      merged[entry[0]] = entry[1];
    } else {
      rest.push(condition);
    }
  }
  if (rest.length > 0) merged.$and = rest;
  return merged as QueryWhere;
}

export function toEngineOrder(
  model: ModelInfo,
  orderBy: unknown
): Record<string, "asc" | "desc"> | undefined {
  if (orderBy === undefined) return undefined;
  const order: Record<string, "asc" | "desc"> = {};
  for (const entry of asList(orderBy as Record<string, string> | Record<string, string>[])) {
    for (const [field, direction] of Object.entries(entry)) {
      if (!model.filterable.has(field)) {
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
}

/** One level of an engine query document: `{ $: options, label: child, ... }`. */
export function toEngineNode(
  graph: Record<string, ModelInfo>,
  model: ModelInfo,
  args: NodeArgs,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const options: Record<string, unknown> = { ...extra };
  if (args.where !== undefined) options.where = toEngineWhere(model, args.where as Where);
  const order = toEngineOrder(model, args.orderBy);
  if (order !== undefined) options.order = order;
  if (args.take !== undefined) options.limit = args.take;
  if (args.after !== undefined) options.after = args.after;

  const node: Record<string, unknown> = { $: options };
  for (const [name, value] of Object.entries(args.include ?? {})) {
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
