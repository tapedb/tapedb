/**
 * Evaluates an engine filter document against a cached row, so a bulk write
 * can be applied to the cache before the engine answers.
 *
 * Three-valued: `true` and `false` are certain, `undefined` means the cache
 * cannot tell (a relation filter, a field the cached row does not hold, a
 * value whose comparison the engine makes differently). Only rows that
 * certainly match are changed optimistically; the engine's answer, pushed
 * after the write lands, settles the rest. The semantics follow the engine's
 * SQL: equality with null is IS NULL, `$ne` and `$nin` also match a null
 * field, `$in` may list null, and ordered comparisons never match null.
 */

type Truth = boolean | undefined;
type Row = Record<string, unknown>;

function and(values: Truth[]): Truth {
  if (values.some((value) => value === false)) return false;
  return values.every((value) => value === true) ? true : undefined;
}

function or(values: Truth[]): Truth {
  if (values.some((value) => value === true)) return true;
  return values.every((value) => value === false) ? false : undefined;
}

function not(value: Truth): Truth {
  return value === undefined ? undefined : !value;
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A value the cache can compare the way SQLite will, or `unknown`. */
type Comparable = string | number | boolean | null;
const UNKNOWN = Symbol("unknown");

function comparable(value: unknown): Comparable | typeof UNKNOWN {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return UNKNOWN;
}

function same(stored: Comparable, wanted: Comparable): Truth {
  if (stored === null || wanted === null) return stored === wanted;
  // SQLite stores booleans as 0/1; a number and a boolean compare by that.
  const left = typeof stored === "boolean" ? Number(stored) : stored;
  const right = typeof wanted === "boolean" ? Number(wanted) : wanted;
  if (typeof left !== typeof right) return undefined;
  return left === right;
}

const ASCII = /^[\x00-\x7f]*$/;

function order(stored: Comparable, operand: Comparable, operator: string): Truth {
  if (stored === null) return false;
  if (operand === null) return undefined;
  const left = typeof stored === "boolean" ? Number(stored) : stored;
  const right = typeof operand === "boolean" ? Number(operand) : operand;
  if (typeof left !== typeof right) return undefined;
  // SQLite orders text by its UTF-8 bytes; JavaScript by UTF-16 units. They
  // agree on ASCII, so only that is decided here.
  if (typeof left === "string" && !(ASCII.test(left) && ASCII.test(right as string))) return undefined;
  switch (operator) {
    case "$gt":
      return left > right;
    case "$gte":
      return left >= right;
    case "$lt":
      return left < right;
    case "$lte":
      return left <= right;
  }
  return undefined;
}

function field(row: Row, name: string, condition: unknown): Truth {
  if (!(name in row)) return undefined;
  const stored = comparable(row[name]);
  if (stored === UNKNOWN) return undefined;

  if (!plain(condition)) {
    const wanted = comparable(condition);
    return wanted === UNKNOWN ? undefined : same(stored, wanted);
  }

  const results: Truth[] = [];
  for (const [operator, operand] of Object.entries(condition)) {
    if (operand === undefined) continue;
    if (operator === "$in" || operator === "$nin") {
      if (!Array.isArray(operand)) return undefined;
      const items = operand.map(comparable);
      if (items.some((item) => item === UNKNOWN)) return undefined;
      const hit = or(items.map((item) => same(stored, item as Comparable)));
      if (operator === "$in") results.push(hit);
      else results.push(stored === null ? !items.includes(null) : not(hit));
      continue;
    }
    const value = comparable(operand);
    if (value === UNKNOWN) return undefined;
    if (operator === "$ne") results.push(value === null ? stored !== null : stored === null ? true : not(same(stored, value)));
    else if (operator === "$eq") results.push(same(stored, value));
    else if (["$gt", "$gte", "$lt", "$lte"].includes(operator)) results.push(order(stored, value, operator));
    else return undefined;
  }
  return and(results);
}

/** Whether `row` matches the engine filter `where`; `undefined` when the cache cannot tell. */
export function matchesWhere(row: Row, where: unknown): Truth {
  if (where === undefined) return true;
  if (!plain(where)) return undefined;
  const results: Truth[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === "$and") {
      if (!Array.isArray(value)) return undefined;
      results.push(and(value.map((branch) => matchesWhere(row, branch))));
    } else if (key === "$or") {
      if (!Array.isArray(value)) return undefined;
      results.push(or(value.map((branch) => matchesWhere(row, branch))));
    } else if (key === "$not") {
      results.push(not(matchesWhere(row, value)));
    } else if (key.startsWith("$")) {
      // Relation filters ($link) and anything else the cache cannot see.
      results.push(undefined);
    } else {
      results.push(field(row, key, value));
    }
  }
  return and(results);
}
