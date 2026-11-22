/**
 * `migrate check` and `deploy` for named SQL queries: each statement is
 * prepared against the tables the migrations build, with the engine's own
 * checks (sql-query.ts), so a renamed column or a refused read fails in CI
 * and at deploy rather than on a request.
 */

import { analyzeQuery, resolveQueries, SqlQueryError, type SqlQueryStorage } from "../engine/sql-query";
import { configureRegistry } from "../engine/registry";
import { prepareSql } from "../model/queries";
import { role, type RoleName } from "../model/schema";
import type { TapeDBSchema } from "../schema";

interface Statement {
  all(...params: unknown[]): unknown[];
  setReturnArrays?(enabled: boolean): void;
  columns?(): Array<{ name: string }>;
}
export interface CheckDatabase {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

/** node:sqlite, without its one-time "experimental" warning on stderr. */
async function openNodeSqlite(): Promise<CheckDatabase> {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes("SQLite is an experimental feature")) return;
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    // Built from parts so the bundler keeps the node: prefix, which sqlite needs.
    const specifier = ["node", "sqlite"].join(":");
    const { DatabaseSync } = (await import(specifier)) as { DatabaseSync: new (path: string) => CheckDatabase };
    return new DatabaseSync(":memory:");
  } finally {
    process.emitWarning = emit;
  }
}

/** Problems with the schema's queries, as lines for `migrate check`; empty when they all prepare and pass. */
export async function checkQueries(
  schema: TapeDBSchema,
  migrations: Array<{ id: string; sql: string }>,
  open: () => Promise<CheckDatabase> = openNodeSqlite
): Promise<string[]> {
  const declared = (schema as { queries?: Parameters<typeof resolveQueries>[0] }).queries;
  if (!declared || Object.keys(declared).length === 0) return [];
  const problems: string[] = [];
  const db = await open();
  try {
    for (const migration of [schema.migrations[0], ...migrations]) {
      try {
        db.exec(migration.sql);
      } catch (error) {
        return [`Queries were not checked: migration ${migration.id} does not apply to SQLite: ${(error as Error).message}`];
      }
    }
    configureRegistry(schema.registry);
    const storage: SqlQueryStorage = {
      query(sql, params) {
        const statement = db.prepare(sql);
        statement.setReturnArrays?.(true);
        const rows = statement.all(...params) as unknown[];
        const columns = statement.columns?.().map((column) => column.name) ?? [];
        return { columns, rows: rows.map((row) => (Array.isArray(row) ? row : Object.values(row as object))) as never };
      },
      transactionSync: (fn) => fn(),
    };
    const queries = resolveQueries(declared, (name) => role(name as RoleName).level, prepareSql);
    for (const query of Object.values(queries)) {
      try {
        analyzeQuery(storage, query);
      } catch (error) {
        problems.push(error instanceof SqlQueryError ? `queries.${query.name}: ${error.message}` : String(error));
      }
    }
  } finally {
    db.close();
  }
  return problems;
}
