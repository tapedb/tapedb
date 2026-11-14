/**
 * Fitting statements into a Durable Object's SQLite limits: 100 bound
 * parameters and an expression depth of 100.
 *
 * SQLite in a Durable Object binds at most 100 parameters per statement
 * (Cloudflare's documented limit; plain SQLite allows 32,766, which is why
 * tests on `bun:sqlite` never hit it). The compiler already keeps lists in
 * one parameter (`IN (SELECT value FROM json_each(?))`), so ordinary queries
 * stay far below it. A statement that still goes over — a filter with a
 * hundred `OR` branches, an insert into a model with a hundred fields — is
 * rewritten here instead of failing: every value travels in one JSON array,
 * bound once, and each placeholder reads its element back with
 * `json_extract`. Blobs cannot travel in JSON, so they keep their own
 * numbered parameters.
 */

import type { SqlValue } from "./tx-sql";

/**
 * Joins conditions as a balanced tree: `((a OR b) OR (c OR d))`, not
 * `a OR b OR c OR d`. SQLite parses a chain into a tree as deep as the chain
 * is long, and a Durable Object's SQLite refuses expressions deeper than 100
 * (measured in workerd; plain SQLite allows 1000), so a filter with a hundred
 * branches would fail as a chain. Balanced, the depth grows with log2 of the
 * branch count. The order of the parts, and so of their parameters, is
 * unchanged.
 */
export function balancedJoin(parts: readonly string[], joiner: " AND " | " OR "): string {
  if (parts.length === 0) return joiner === " AND " ? "1 = 1" : "0 = 1";
  if (parts.length === 1) return `(${parts[0]})`;
  const middle = Math.ceil(parts.length / 2);
  return `(${balancedJoin(parts.slice(0, middle), joiner)}${joiner}${balancedJoin(parts.slice(middle), joiner)})`;
}

/** Cloudflare's per-statement bound-parameter limit for SQLite-backed Durable Objects. */
export const DO_MAX_BOUND_PARAMETERS = 100;

/**
 * Offsets of the anonymous `?` placeholders in `sql`, skipping string
 * literals, quoted identifiers and comments.
 */
function placeholderOffsets(sql: string): number[] {
  const offsets: number[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'" || char === '"' || char === "`") {
      // Quoted: runs to the matching quote; a doubled quote is an escape.
      index += 1;
      while (index < sql.length) {
        if (sql[index] === char) {
          if (sql[index + 1] === char) {
            index += 2;
            continue;
          }
          break;
        }
        index += 1;
      }
      index += 1;
      continue;
    }
    if (char === "[") {
      const end = sql.indexOf("]", index + 1);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index + 2);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (char === "?") {
      // A numbered parameter (?1) is not ours to renumber.
      if (/[0-9]/.test(sql[index + 1] ?? "")) return [];
      offsets.push(index);
    }
    index += 1;
  }
  return offsets;
}

/**
 * Returns the statement unchanged when it fits, or rewritten to bind its
 * values through one JSON parameter when it does not. A statement whose
 * placeholders cannot be matched to its values is returned unchanged, so
 * SQLite reports the problem as it would have.
 */
export function fitBindings(
  sql: string,
  params: readonly SqlValue[],
  limit = DO_MAX_BOUND_PARAMETERS
): { sql: string; params: SqlValue[] } {
  if (params.length <= limit) return { sql, params: [...params] };

  const offsets = placeholderOffsets(sql);
  if (offsets.length !== params.length) return { sql, params: [...params] };

  const values: Array<string | number | null> = [];
  const blobs: ArrayBuffer[] = [];
  const replacements = params.map((value) => {
    if (value instanceof ArrayBuffer) {
      blobs.push(value);
      return `?${blobs.length + 1}`;
    }
    values.push(value);
    return `json_extract(?1, '$[${values.length - 1}]')`;
  });
  if (blobs.length + 1 > limit) return { sql, params: [...params] };

  let rewritten = "";
  let previous = 0;
  offsets.forEach((offset, index) => {
    rewritten += sql.slice(previous, offset) + replacements[index];
    previous = offset + 1;
  });
  rewritten += sql.slice(previous);

  return { sql: rewritten, params: [JSON.stringify(values), ...blobs] };
}
