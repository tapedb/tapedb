/**
 * Named SQL queries: SQL written in the schema file, run by name from the
 * client with parameters.
 *
 * The SQL is the developer's, reviewed like a migration; a request only names
 * a query and passes values, which are always bound. The engine runs a query
 * read-only (it refuses one that would write, and rolls every run back), at
 * or above its role, and only over models whose read rules let the caller
 * read every row, unless the query is marked to apply its own filtering.
 */

import type { Field, KindInput, KindOutput, ScalarKind } from "./fields";
import type { RoleName } from "./schema";

type QueryKind = Exclude<ScalarKind, "vector">;
type QueryField = Field<QueryKind, boolean, boolean>;

export type QueryParams = Record<string, QueryField>;
export type QueryColumns = Record<string, QueryField>;

/** Parameters a caller passes: optional fields may be left out or null. */
export type QueryParamValues<P extends QueryParams> = {
  [K in keyof P as P[K] extends Field<QueryKind, true, boolean> ? never : K]: P[K] extends Field<infer Kind, boolean, boolean>
    ? KindInput[Kind & QueryKind]
    : never;
} & {
  [K in keyof P as P[K] extends Field<QueryKind, true, boolean> ? K : never]?: P[K] extends Field<infer Kind, boolean, boolean>
    ? KindInput[Kind & QueryKind] | null
    : never;
};

/** One result row: the declared columns, null where the column is optional. */
export type QueryRow<R extends QueryColumns> = {
  [K in keyof R]: R[K] extends Field<infer Kind, infer Optional, boolean>
    ? KindOutput[Kind & QueryKind] | (Optional extends true ? null : never)
    : never;
};

export interface SqlQueryOptions<P extends QueryParams, R extends QueryColumns> {
  /** The SQLite statement: one SELECT (a WITH, recursive or not, is fine). Parameters as :name. */
  sql: string;
  /** What a caller passes, bound to the statement's :name placeholders. */
  params?: P;
  /** The columns the statement returns, by name, with their types. */
  returns: R;
  /** The lowest role that may run it. Default: member, the default read role. */
  role?: RoleName;
  /**
   * Run even over models whose read rule decides per row (filter or check).
   * The statement must then apply that filtering itself, with the
   * :authSub and :authRole parameters the engine binds for the caller.
   */
  bypassReadRules?: boolean;
}

export interface SqlQuery<P extends QueryParams = QueryParams, R extends QueryColumns = QueryColumns> {
  readonly tag: "sqlQuery";
  readonly sql: string;
  readonly params: P;
  readonly returns: R;
  readonly role: RoleName;
  readonly bypassReadRules: boolean;
}

export type SqlQueries = Record<string, SqlQuery>;

/** Parameters the engine binds for every run: who is asking. */
export const AUTH_PARAMS = ["authSub", "authRole"] as const;

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A named SQL query for `schema(models, { queries })`. */
export function sqlQuery<P extends QueryParams = {}, R extends QueryColumns = QueryColumns>(
  options: SqlQueryOptions<P, R>
): SqlQuery<P, R> {
  return {
    tag: "sqlQuery",
    sql: options.sql,
    params: (options.params ?? {}) as P,
    returns: options.returns,
    role: options.role ?? "member",
    bypassReadRules: options.bypassReadRules === true,
  };
}

export interface PreparedSql {
  /** The statement with every :name replaced by ?. */
  text: string;
  /** The parameter each ? binds, in order. */
  names: string[];
}

/**
 * Checks a statement's shape and turns its :name placeholders into the ?
 * bindings Durable Object SQL takes. Strings, quoted identifiers and
 * comments are skipped, so a ':' inside them is left alone.
 */
export function prepareSql(sql: string, label = "query"): PreparedSql {
  let text = "";
  const names: string[] = [];
  let at = 0;
  let code = "";
  while (at < sql.length) {
    const char = sql[at];
    const next = sql[at + 1];
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", at);
      const stop = end < 0 ? sql.length : end;
      text += sql.slice(at, stop);
      at = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", at + 2);
      if (end < 0) throw new Error(`${label}: a /* comment is never closed.`);
      text += sql.slice(at, end + 2);
      at = end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      let end = at + 1;
      for (;;) {
        end = sql.indexOf(close, end);
        if (end < 0) throw new Error(`${label}: a ${char} quote is never closed.`);
        if (close !== "]" && sql[end + 1] === close) {
          end += 2;
          continue;
        }
        break;
      }
      text += sql.slice(at, end + 1);
      code += " _ ";
      at = end + 1;
      continue;
    }
    if (char === ":" || char === "@" || char === "$") {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(at + 1))?.[0];
      if (char === ":" && name) {
        names.push(name);
        text += "?";
        code += " ? ";
        at += 1 + name.length;
        continue;
      }
      if (name) throw new Error(`${label}: write parameters as :${name}, not ${char}${name}.`);
    }
    if (char === "?") throw new Error(`${label}: name every parameter (:name); ? placeholders are not used.`);
    text += char;
    code += char;
    at++;
  }
  const statements = code.split(";").map((part) => part.trim());
  if (statements.filter((part) => part !== "").length !== 1 || statements.slice(0, -1).some((part) => part === "")) {
    throw new Error(`${label}: write exactly one statement.`);
  }
  if (!/^(select|with|values)\b/i.test(statements[0])) {
    throw new Error(`${label}: a query is one SELECT (or WITH ... SELECT); writes go through transactions.`);
  }
  return { text: text.trim().replace(/;\s*$/, ""), names };
}

/** Validates one query for `schema()`: names, kinds and placeholders that match the params. */
export function checkSqlQuery(name: string, query: unknown): SqlQuery {
  const label = `queries.${name}`;
  if (!NAME.test(name)) throw new Error(`${label}: a query name is letters, digits and _, starting with a letter.`);
  const definition = query as SqlQuery;
  if (!definition || definition.tag !== "sqlQuery") throw new Error(`${label} is not a sqlQuery({ ... }).`);
  if (typeof definition.sql !== "string" || definition.sql.trim() === "") throw new Error(`${label}: sql is empty.`);
  const prepared = prepareSql(definition.sql, label);
  const checkFields = (what: string, fields: Record<string, QueryField>) => {
    for (const [field, member] of Object.entries(fields)) {
      if (!NAME.test(field)) throw new Error(`${label}.${what}.${field}: a name is letters, digits and _, starting with a letter.`);
      const kind = (member as { kind?: string } | undefined)?.kind;
      if (!member || (member as { tag?: string }).tag !== "field" || kind === "vector" || "personalSubject" in member) {
        throw new Error(`${label}.${what}.${field}: use t.string(), t.number(), t.boolean(), t.date() or t.json().`);
      }
    }
  };
  checkFields("params", definition.params);
  checkFields("returns", definition.returns);
  if (Object.keys(definition.returns).length === 0) throw new Error(`${label}: returns names no columns.`);
  for (const param of Object.keys(definition.params)) {
    if ((AUTH_PARAMS as readonly string[]).includes(param)) throw new Error(`${label}.params.${param}: the engine binds :${param} itself.`);
    if (!prepared.names.includes(param)) throw new Error(`${label}: params.${param} is never used as :${param}.`);
  }
  for (const used of prepared.names) {
    if (!(used in definition.params) && !(AUTH_PARAMS as readonly string[]).includes(used)) {
      throw new Error(`${label}: :${used} is not in params.`);
    }
  }
  return definition;
}
