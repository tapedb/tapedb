/**
 * Aggregates over one namespace: count, sum, avg, min and max, optionally
 * grouped.
 *
 * An aggregate is a top-level `$.aggregate` option. It reads no rows: the
 * result rides `pageInfo[namespace].aggregate`, which live subscriptions
 * already push when it changes, and which optimistic writes never touch.
 *
 * It runs over exactly the conditions a read of the same `where` uses, `where`
 * read rules included, so an aggregate never counts a row the caller could not
 * read. A namespace whose read rule is a function cannot be aggregated in SQL;
 * the executor then walks the matching rows in bounded chunks, applies the rule
 * to each, and folds the visible ones here, in the same shape.
 */

import { invalidOp, invalidValue, isPlainObject } from "./query-types";
import { toSnakeCase, type AttributeType, type NamespaceDefinition } from "./registry";
import { balancedJoin } from "./sql-binding";
import { quoteIdentifier } from "./tx-apply";
import type { SqlValue } from "./tx-sql";
import { TxError } from "./tx-types";

/** The wire shape of `$.aggregate`. Attribute names are API names. */
export interface QueryAggregate {
  /** Group by these attributes. Omitted: one group over every matching row. */
  groupBy?: string[];
  /** Count matching rows. */
  count?: boolean;
  /** Count rows where each attribute is not null. */
  countOf?: string[];
  sum?: string[];
  avg?: string[];
  min?: string[];
  max?: string[];
  /** Order groups by their keys. Default: every key ascending. */
  order?: Record<string, "asc" | "desc">;
  /** At most this many groups. */
  limit?: number;
}

/** One group of an aggregate result. */
export interface AggregateGroup {
  /** The group's key values; empty without `groupBy`. */
  key: Record<string, unknown>;
  count?: number;
  countOf?: Record<string, number>;
  sum?: Record<string, number | null>;
  avg?: Record<string, number | null>;
  min?: Record<string, unknown>;
  max?: Record<string, unknown>;
}

interface AggregateField {
  name: string;
  column: string;
  type: AttributeType;
}

export interface CompiledAggregate {
  groupBy: AggregateField[];
  count: boolean;
  countOf: AggregateField[];
  sum: AggregateField[];
  avg: AggregateField[];
  min: AggregateField[];
  max: AggregateField[];
  order: Array<{ field: AggregateField; direction: "asc" | "desc" }>;
  limit: number | null;
}

const AGGREGATE_KEYS = new Set([
  "groupBy",
  "count",
  "countOf",
  "sum",
  "avg",
  "min",
  "max",
  "order",
  "limit",
]);

const FIELD_LISTS = ["groupBy", "countOf", "sum", "avg", "min", "max"] as const;

/** Validates `$.aggregate` without the registry. */
export function parseAggregate(value: unknown): QueryAggregate {
  if (!isPlainObject(value)) {
    throw invalidOp('"aggregate" must be an object.');
  }
  for (const key of Object.keys(value)) {
    if (!AGGREGATE_KEYS.has(key)) {
      throw invalidOp(`Unknown aggregate option "${key}".`);
    }
  }

  const aggregate: QueryAggregate = {};
  for (const key of FIELD_LISTS) {
    if (!(key in value)) continue;
    const list = value[key];
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      !list.every((name) => typeof name === "string" && name.length > 0)
    ) {
      throw invalidOp(`"aggregate.${key}" must be a non-empty array of attribute names.`);
    }
    aggregate[key] = [...new Set(list as string[])];
  }
  if ("count" in value) {
    if (typeof value.count !== "boolean") {
      throw invalidValue('"aggregate.count" must be true or false.');
    }
    aggregate.count = value.count;
  }
  if ("order" in value) {
    if (!isPlainObject(value.order)) {
      throw invalidOp('"aggregate.order" must be an object.');
    }
    const order: Record<string, "asc" | "desc"> = {};
    for (const [name, direction] of Object.entries(value.order)) {
      if (direction !== "asc" && direction !== "desc") {
        throw invalidValue(`Order for "${name}" must be "asc" or "desc".`);
      }
      order[name] = direction;
    }
    aggregate.order = order;
  }
  if ("limit" in value) {
    const limit = value.limit;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
      throw invalidValue('"aggregate.limit" must be a positive integer.');
    }
    aggregate.limit = limit;
  }

  const measures =
    aggregate.count === true ||
    aggregate.countOf !== undefined ||
    aggregate.sum !== undefined ||
    aggregate.avg !== undefined ||
    aggregate.min !== undefined ||
    aggregate.max !== undefined;
  if (!measures && aggregate.groupBy === undefined) {
    throw invalidOp('"aggregate" needs count, countOf, sum, avg, min, max or groupBy.');
  }
  return aggregate;
}

function resolve(namespace: NamespaceDefinition, name: string): AggregateField {
  if (name === "id") return { name, column: "id", type: "string" };
  if (name === "createdAt" && !("createdAt" in namespace.attributes)) {
    return { name, column: "created_at", type: "date" };
  }
  if (name === "updatedAt" && !("updatedAt" in namespace.attributes)) {
    return { name, column: "updated_at", type: "date" };
  }
  const definition = namespace.attributes[name];
  if (definition === undefined) {
    throw new TxError(
      "unknown_attribute",
      `Unknown attribute "${name}" on namespace "${namespace.apiName}".`
    );
  }
  return { name, column: toSnakeCase(name), type: definition.type };
}

function fields(
  namespace: NamespaceDefinition,
  names: string[] | undefined,
  measure: string,
  allowed: ReadonlySet<AttributeType>
): AggregateField[] {
  return (names ?? []).map((name) => {
    const field = resolve(namespace, name);
    if (!allowed.has(field.type)) {
      throw invalidValue(`Cannot ${measure} "${name}": it is a ${field.type} attribute.`);
    }
    return field;
  });
}

const NUMERIC = new Set<AttributeType>(["number"]);
const ORDERED = new Set<AttributeType>(["number", "date", "string"]);
const SCALAR = new Set<AttributeType>(["number", "date", "string", "boolean"]);
const ANY = new Set<AttributeType>(["number", "date", "string", "boolean", "json", "any"]);

/** Resolves every attribute against the registry. */
export function compileAggregate(
  namespace: NamespaceDefinition,
  aggregate: QueryAggregate
): CompiledAggregate {
  const groupBy = fields(namespace, aggregate.groupBy, "group by", SCALAR);
  const order = Object.entries(aggregate.order ?? {}).map(([name, direction]) => {
    const field = groupBy.find((candidate) => candidate.name === name);
    if (field === undefined) {
      throw invalidOp(`"aggregate.order" can only name a groupBy attribute; "${name}" is not one.`);
    }
    return { field, direction };
  });
  for (const field of groupBy) {
    if (!order.some((entry) => entry.field === field)) order.push({ field, direction: "asc" });
  }
  if (aggregate.limit !== undefined && groupBy.length === 0) {
    throw invalidOp('"aggregate.limit" needs a groupBy: without one there is a single group.');
  }

  return {
    groupBy,
    count: aggregate.count === true,
    countOf: fields(namespace, aggregate.countOf, "count", ANY),
    sum: fields(namespace, aggregate.sum, "sum", NUMERIC),
    avg: fields(namespace, aggregate.avg, "average", NUMERIC),
    min: fields(namespace, aggregate.min, "take the minimum of", ORDERED),
    max: fields(namespace, aggregate.max, "take the maximum of", ORDERED),
    order,
    limit: aggregate.limit ?? null,
  };
}

/** The physical columns the in-memory fold reads. */
export function aggregateColumns(aggregate: CompiledAggregate): string[] {
  return [
    ...aggregate.groupBy,
    ...aggregate.countOf,
    ...aggregate.sum,
    ...aggregate.avg,
    ...aggregate.min,
    ...aggregate.max,
  ].map((field) => field.column);
}

/** One `SELECT ... GROUP BY` over the read's conditions (joined like `buildSelectSql`). */
export function buildAggregateSql(
  table: string,
  aggregate: CompiledAggregate,
  conditions: ReadonlyArray<{ sql: string; params: SqlValue[] }>
): { sql: string; params: SqlValue[] } {
  const columns: string[] = [];
  aggregate.groupBy.forEach((field, index) =>
    columns.push(`${quoteIdentifier(field.column)} AS "g${index}"`)
  );
  if (aggregate.count) columns.push(`COUNT(*) AS "count"`);
  const measure = (fn: string, list: AggregateField[], prefix: string) =>
    list.forEach((field, index) =>
      columns.push(`${fn}(${quoteIdentifier(field.column)}) AS "${prefix}${index}"`)
    );
  measure("COUNT", aggregate.countOf, "c");
  measure("SUM", aggregate.sum, "s");
  measure("AVG", aggregate.avg, "a");
  measure("MIN", aggregate.min, "lo");
  measure("MAX", aggregate.max, "hi");
  // A select list needs one column even when only groups are asked for.
  if (columns.length === 0) columns.push(`COUNT(*) AS "count"`);

  const params = conditions.flatMap((condition) => condition.params);
  const whereSql =
    conditions.length > 0
      ? ` WHERE ${balancedJoin(conditions.map((condition) => condition.sql), " AND ")}`
      : "";
  const groupSql =
    aggregate.groupBy.length > 0
      ? ` GROUP BY ${aggregate.groupBy.map((field) => quoteIdentifier(field.column)).join(", ")}`
      : "";
  const orderSql =
    aggregate.order.length > 0
      ? ` ORDER BY ${aggregate.order
          .map((entry) => `${quoteIdentifier(entry.field.column)} ${entry.direction.toUpperCase()}`)
          .join(", ")}`
      : "";
  let limitSql = "";
  if (aggregate.limit !== null) {
    limitSql = " LIMIT ?";
    params.push(aggregate.limit);
  }

  return {
    sql: `SELECT ${columns.join(", ")} FROM ${quoteIdentifier(table)}${whereSql}${groupSql}${orderSql}${limitSql}`,
    params,
  };
}

type Convert = (type: AttributeType, value: SqlValue | undefined) => unknown;

/** Turns the statement's rows into groups with API-shaped values. */
export function groupsFromSql(
  aggregate: CompiledAggregate,
  rows: Array<Record<string, SqlValue>>,
  convert: Convert
): AggregateGroup[] {
  return rows.map((row) => {
    const group: AggregateGroup = { key: {} };
    aggregate.groupBy.forEach((field, index) => {
      group.key[field.name] = convert(field.type, row[`g${index}`]);
    });
    if (aggregate.count) group.count = Number(row.count ?? 0);
    const fill = (
      list: AggregateField[],
      prefix: string,
      read: (field: AggregateField, value: SqlValue | undefined) => unknown
    ): Record<string, never> | undefined => {
      if (list.length === 0) return undefined;
      const out: Record<string, unknown> = {};
      list.forEach((field, index) => {
        out[field.name] = read(field, row[`${prefix}${index}`]);
      });
      return out as Record<string, never>;
    };
    const number = (_field: AggregateField, value: SqlValue | undefined) =>
      value === null || value === undefined ? null : Number(value);
    const same = (field: AggregateField, value: SqlValue | undefined) => convert(field.type, value);
    const countOf = fill(aggregate.countOf, "c", (_field, value) => Number(value ?? 0));
    const sum = fill(aggregate.sum, "s", number);
    const avg = fill(aggregate.avg, "a", number);
    const min = fill(aggregate.min, "lo", same);
    const max = fill(aggregate.max, "hi", same);
    if (countOf) group.countOf = countOf;
    if (sum) group.sum = sum;
    if (avg) group.avg = avg;
    if (min) group.min = min;
    if (max) group.max = max;
    return group;
  });
}

/**
 * SQLite's ordering for one value: NULL, then numbers, then text. The fold
 * sorts and compares with it so its groups come out in the order, and with
 * the extremes, the SQL path would give.
 */
function compareStored(a: SqlValue, b: SqlValue): number {
  const rank = (value: SqlValue) =>
    value === null ? 0 : typeof value === "number" ? 1 : typeof value === "string" ? 2 : 3;
  const difference = rank(a) - rank(b);
  if (difference !== 0) return difference;
  if (a === null || b === null) return 0;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return Number(a) - Number(b);
}

interface Accumulator {
  keyValues: SqlValue[];
  count: number;
  countOf: number[];
  sum: Array<number | null>;
  avgSum: number[];
  avgCount: number[];
  min: SqlValue[];
  max: SqlValue[];
}

/**
 * The same aggregate folded in memory, for rows a function read rule has
 * already filtered. Feed it chunks with `add`, then read `groups()`.
 */
export class AggregateFold {
  private readonly accumulators = new Map<string, Accumulator>();

  constructor(private readonly aggregate: CompiledAggregate) {
    if (aggregate.groupBy.length === 0) this.accumulator([]);
  }

  private accumulator(keyValues: SqlValue[]): Accumulator {
    const key = JSON.stringify(keyValues);
    let accumulator = this.accumulators.get(key);
    if (accumulator === undefined) {
      const { countOf, sum, avg, min, max } = this.aggregate;
      accumulator = {
        keyValues,
        count: 0,
        countOf: countOf.map(() => 0),
        sum: sum.map(() => null),
        avgSum: avg.map(() => 0),
        avgCount: avg.map(() => 0),
        min: min.map(() => null),
        max: max.map(() => null),
      };
      this.accumulators.set(key, accumulator);
    }
    return accumulator;
  }

  add(row: Record<string, SqlValue>): void {
    const { groupBy, countOf, sum, avg, min, max } = this.aggregate;
    const accumulator = this.accumulator(groupBy.map((field) => row[field.column] ?? null));
    accumulator.count += 1;
    countOf.forEach((field, index) => {
      if (row[field.column] !== null && row[field.column] !== undefined) accumulator.countOf[index] += 1;
    });
    sum.forEach((field, index) => {
      const value = row[field.column];
      if (value === null || value === undefined) return;
      accumulator.sum[index] = (accumulator.sum[index] ?? 0) + Number(value);
    });
    avg.forEach((field, index) => {
      const value = row[field.column];
      if (value === null || value === undefined) return;
      accumulator.avgSum[index] += Number(value);
      accumulator.avgCount[index] += 1;
    });
    min.forEach((field, index) => {
      const value = row[field.column] ?? null;
      // MIN and MAX ignore nulls, as SQL's do.
      if (value === null) return;
      const current = accumulator.min[index];
      if (current === null || compareStored(value, current) < 0) accumulator.min[index] = value;
    });
    max.forEach((field, index) => {
      const value = row[field.column] ?? null;
      if (value === null) return;
      const current = accumulator.max[index];
      if (current === null || compareStored(value, current) > 0) accumulator.max[index] = value;
    });
  }

  groups(convert: Convert): AggregateGroup[] {
    const { order, limit } = this.aggregate;
    const list = [...this.accumulators.values()];
    list.sort((a, b) => {
      for (const entry of order) {
        const index = this.aggregate.groupBy.indexOf(entry.field);
        const difference = compareStored(a.keyValues[index], b.keyValues[index]);
        if (difference !== 0) return entry.direction === "asc" ? difference : -difference;
      }
      return 0;
    });
    const kept = limit === null ? list : list.slice(0, limit);

    // Shaped as the statement's rows, so one conversion serves both paths.
    const rows = kept.map((accumulator) => {
      const row: Record<string, SqlValue> = {};
      accumulator.keyValues.forEach((value, index) => (row[`g${index}`] = value));
      row.count = accumulator.count;
      accumulator.countOf.forEach((value, index) => (row[`c${index}`] = value));
      accumulator.sum.forEach((value, index) => (row[`s${index}`] = value));
      accumulator.avgCount.forEach((count, index) => {
        row[`a${index}`] = count === 0 ? null : accumulator.avgSum[index] / count;
      });
      accumulator.min.forEach((value, index) => (row[`lo${index}`] = value));
      accumulator.max.forEach((value, index) => (row[`hi${index}`] = value));
      return row;
    });
    return groupsFromSql(this.aggregate, rows, convert);
  }
}
