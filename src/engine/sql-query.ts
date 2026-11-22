/**
 * Runs the schema's named SQL queries (POST /sql).
 *
 * The statement is the developer's; a request names it and passes values,
 * always bound. Before a query's first run, the engine reads SQLite's own
 * plan for it (EXPLAIN) to learn exactly which tables and columns it reads,
 * whatever CTEs, views or subqueries it uses. From that plan it refuses a
 * statement that would write, one that reads anything but a model's table
 * (engine tables, sqlite_schema), and one that reads a personal field, whose
 * stored value is ciphertext. On each run it checks the caller: the query's
 * role, and for every model read, that the model's read rule lets the caller
 * read every row (a role they meet), unless the query is marked to filter
 * per-row rules itself. Every run happens inside a transaction that is rolled
 * back, so nothing a statement does can last.
 */

import type { RoleClaim } from "../claims";
import { NAMESPACES, toSnakeCase, type NamespaceDefinition } from "./registry";
import { fitBindings } from "./sql-binding";
import { readRoleFor } from "./tx-permissions";
import type { SqlValue } from "./tx-sql";
import { fromStoredValue } from "./value-to-api";

type Kind = "string" | "number" | "boolean" | "date" | "json";

export interface ConfiguredQuery {
  name: string;
  /** The statement with ? bindings, and the parameter each one binds. */
  text: string;
  names: readonly string[];
  role: number;
  bypassReadRules: boolean;
  params: Readonly<Record<string, { kind: Kind; optional: boolean }>>;
  returns: Readonly<Record<string, { kind: Kind; optional: boolean }>>;
}

/** What the engine needs from storage: rows as arrays with their column names, and a transaction. */
export interface SqlQueryStorage {
  query(sql: string, params: SqlValue[]): { columns: string[]; rows: SqlValue[][] };
  transactionSync<T>(fn: () => T): T;
}

/** Every code a named query answers with besides the route's own (`unknown_query`, `query_failed`). */
export type SqlQueryErrorCode = "invalid_query_params" | "query_forbidden" | "query_refused" | "query_result_mismatch";

export class SqlQueryError extends Error {
  constructor(
    readonly status: number,
    readonly code: SqlQueryErrorCode,
    message: string
  ) {
    super(message);
  }
}

/** The plan's reading of a statement: the models it reads and the columns of each. */
export interface QueryAnalysis {
  reads: ReadonlyMap<string, ReadonlySet<string>>;
}

class Rollback extends Error {}

function modelForTable(table: string): NamespaceDefinition | undefined {
  return Object.values(NAMESPACES).find((namespace) => namespace.table === table);
}

/**
 * Reads the statement's plan. Throws `query_refused` for a write, a read of
 * something that is not a model's table, or a read of a personal field.
 */
export function analyzeQuery(storage: SqlQueryStorage, query: ConfiguredQuery): QueryAnalysis {
  const nulls = query.names.map(() => null);
  let plan: SqlValue[][];
  let columns: string[];
  try {
    ({ columns, rows: plan } = storage.query(`EXPLAIN ${query.text}`, nulls));
  } catch (error) {
    throw new SqlQueryError(400, "query_refused", `"${query.name}" does not prepare: ${(error as Error).message}`);
  }
  const at = (name: string) => columns.indexOf(name);
  const [opcode, p1, p2, p3] = [at("opcode"), at("p1"), at("p2"), at("p3")];

  const objects = new Map<number, { type: string; name: string; table: string }>();
  for (const row of storage.query(`SELECT type, name, tbl_name, rootpage FROM sqlite_schema`, []).rows) {
    objects.set(Number(row[3]), { type: String(row[0]), name: String(row[1]), table: String(row[2]) });
  }
  const columnsOf = (object: { type: string; name: string }) =>
    object.type === "index"
      ? storage.query(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`, [object.name]).rows.map((row) => String(row[0]))
      : storage.query(`SELECT name FROM pragma_table_info(?) ORDER BY cid`, [object.name]).rows.map((row) => String(row[0]));

  const cursors = new Map<number, { model: NamespaceDefinition; columns: string[] }>();
  const reads = new Map<string, Set<string>>();
  for (const step of plan) {
    const op = String(step[opcode]);
    if (op === "OpenWrite") {
      throw new SqlQueryError(400, "query_refused", `"${query.name}" writes; a query reads. Write through transactions.`);
    }
    if (op !== "OpenRead" && op !== "ReopenIdx") continue;
    const object = objects.get(Number(step[p2]));
    const model = object && Number(step[p3]) === 0 ? modelForTable(object.table) : undefined;
    if (!object || !model) {
      throw new SqlQueryError(
        400,
        "query_refused",
        `"${query.name}" reads ${object ? `"${object.table}"` : "a table"} that is not a model's. A query reads models only.`
      );
    }
    cursors.set(Number(step[p1]), { model, columns: columnsOf(object) });
    if (!reads.has(model.apiName)) reads.set(model.apiName, new Set());
  }
  for (const step of plan) {
    if (String(step[opcode]) !== "Column") continue;
    const cursor = cursors.get(Number(step[p1]));
    const column = cursor?.columns[Number(step[p2])];
    if (cursor && column) reads.get(cursor.model.apiName)!.add(column);
  }
  for (const [apiName, read] of reads) {
    for (const [field, attribute] of Object.entries(NAMESPACES[apiName].attributes)) {
      if (attribute.personal && read.has(toSnakeCase(field))) {
        throw new SqlQueryError(
          400,
          "query_refused",
          `"${query.name}" reads ${apiName}.${field}, a personal field: it is stored encrypted. Read it with findMany.`
        );
      }
    }
  }
  return { reads };
}

function storedParam(query: ConfiguredQuery, name: string, kind: Kind, value: unknown): SqlValue {
  const fail = (expected: string): never => {
    throw new SqlQueryError(400, "invalid_query_params", `"${query.name}": ${name} is ${expected}.`);
  };
  switch (kind) {
    case "string":
      return typeof value === "string" ? value : fail("text");
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : fail("a number");
    case "boolean":
      return typeof value === "boolean" ? (value ? 1 : 0) : fail("true or false");
    case "date": {
      const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
      return Number.isFinite(ms) ? ms : fail("a date (epoch milliseconds or an ISO 8601 string)");
    }
    case "json":
      return JSON.stringify(value);
  }
}

/** Runs one named query for one caller. */
export function runQuery(
  storage: SqlQueryStorage,
  analysis: QueryAnalysis,
  query: ConfiguredQuery,
  claim: RoleClaim,
  input: unknown
): Array<Record<string, unknown>> {
  if (claim.role < query.role) {
    throw new SqlQueryError(403, "query_forbidden", `"${query.name}" needs a higher role than this caller's.`);
  }
  for (const model of analysis.reads.keys()) {
    const role = readRoleFor(model);
    if (role === null && !query.bypassReadRules) {
      throw new SqlQueryError(
        403,
        "query_forbidden",
        `"${query.name}" reads ${model}, whose read rule decides row by row. Filter it in the SQL with :authSub and :authRole, and set bypassReadRules.`
      );
    }
    if (role !== null && claim.role < role) {
      throw new SqlQueryError(403, "query_forbidden", `"${query.name}" reads ${model}, which this caller's role may not read.`);
    }
  }

  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
    throw new SqlQueryError(400, "invalid_query_params", `"${query.name}": params are an object.`);
  }
  const given = (input ?? {}) as Record<string, unknown>;
  for (const name of Object.keys(given)) {
    if (!(name in query.params)) throw new SqlQueryError(400, "invalid_query_params", `"${query.name}" has no parameter ${name}.`);
  }
  const values: Record<string, SqlValue> = { authSub: claim.sub, authRole: claim.role };
  for (const [name, param] of Object.entries(query.params)) {
    const value = given[name];
    if (value === undefined || value === null) {
      if (!param.optional) throw new SqlQueryError(400, "invalid_query_params", `"${query.name}" needs ${name}.`);
      values[name] = null;
    } else {
      values[name] = storedParam(query, name, param.kind, value);
    }
  }

  let answer: { columns: string[]; rows: SqlValue[][] } | undefined;
  const bound = fitBindings(query.text, query.names.map((name) => values[name]));
  try {
    storage.transactionSync(() => {
      answer = storage.query(bound.sql, bound.params);
      // Every run is rolled back: whatever the statement did, nothing lasts.
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  const { columns, rows } = answer!;

  const declared = Object.keys(query.returns);
  const extra = columns.filter((column) => !(column in query.returns));
  const missing = declared.filter((column) => !columns.includes(column));
  const repeated = columns.filter((column, index) => columns.indexOf(column) !== index);
  if (extra.length || missing.length || repeated.length) {
    throw new SqlQueryError(
      500,
      "query_result_mismatch",
      `"${query.name}" returns ${JSON.stringify(columns)}; returns declares ${JSON.stringify(declared)}.` +
        (repeated.length ? ` Name each column once (${[...new Set(repeated)].join(", ")}).` : "")
    );
  }
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      const shape = query.returns[column];
      const value = fromStoredValue(shape.kind, row[index] ?? null);
      if (value === null && !shape.optional) {
        throw new SqlQueryError(
          500,
          "query_result_mismatch",
          `"${query.name}" returned null in ${column}; declare it optional in returns, or make the SQL return a value.`
        );
      }
      out[column] = value;
    });
    return out;
  });
}

/** The deployment's queries from the schema, validated when the Worker is defined. */
export function resolveQueries(
  queries: Record<string, { sql: string; params: Record<string, unknown>; returns: Record<string, unknown>; role: string; bypassReadRules: boolean }> | undefined,
  roleLevel: (name: string) => number,
  prepare: (sql: string, label: string) => { text: string; names: string[] }
): Readonly<Record<string, ConfiguredQuery>> {
  const out: Record<string, ConfiguredQuery> = {};
  const shape = (fields: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(fields).map(([name, field]) => {
        const member = field as { kind: Kind; isOptional: boolean };
        return [name, { kind: member.kind, optional: member.isOptional }];
      })
    );
  for (const [name, query] of Object.entries(queries ?? {})) {
    const prepared = prepare(query.sql, `queries.${name}`);
    out[name] = Object.freeze({
      name,
      text: prepared.text,
      names: Object.freeze([...prepared.names]),
      role: roleLevel(query.role),
      bypassReadRules: query.bypassReadRules,
      params: Object.freeze(shape(query.params)),
      returns: Object.freeze(shape(query.returns)),
    });
  }
  return Object.freeze(out);
}
