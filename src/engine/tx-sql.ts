/**
 * Minimal synchronous SQL surface used by the transaction pipeline.
 *
 * The Durable Object exposes a synchronous SQLite API plus `transactionSync`;
 * tests run the same pipeline against `bun:sqlite`. Keeping the contract here
 * lets the apply/pipeline code stay independent of either driver.
 *
 * Booleans are normalised to 0/1 by validation before they reach a binding.
 */

import { fitBindings } from "./sql-binding";

export type SqlValue = string | number | null | ArrayBuffer;

export type SqlRow = Record<string, SqlValue>;

export interface SqlExecutor {
  decodeRows?(namespace: string, rows: SqlRow[]): SqlRow[];
  /** Runs a statement and returns the number of rows it changed. */
  exec(sql: string, ...params: SqlValue[]): number;
  /** Runs a query and returns every row. */
  all<T extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): T[];
  /** Runs a query and returns the first row, if any. */
  one<T extends SqlRow = SqlRow>(
    sql: string,
    ...params: SqlValue[]
  ): T | undefined;
  /** Runs `fn` atomically; any thrown error rolls the transaction back. */
  transactionSync<T>(fn: () => T): T;
}

/**
 * Adapts a Durable Object's SQLite storage to `SqlExecutor`. Every statement
 * goes through `fitBindings`, which keeps it within the object's limit of 100
 * bound parameters.
 */
/**
 * The Durable Object executor, with every read statement (`all`, `one`)
 * reported to `onRead`: its text and parameter count as they ran, the rows
 * returned, the rows SQLite read (`rowsRead` from the cursor, null where the
 * runtime has none) and the wall time. Writes pass through unrecorded.
 */
export function profiledSqlExecutor(
  storage: DurableObjectStorage,
  onRead: (sql: string, params: number, ms: number, rowsReturned: number, rowsRead: number | null) => void
): SqlExecutor {
  const read = <T extends SqlRow>(sql: string, params: SqlValue[]): T[] => {
    const fitted = fitBindings(sql, params);
    const started = Date.now();
    const cursor = storage.sql.exec<T>(fitted.sql, ...fitted.params);
    const rows = cursor.toArray();
    const rowsRead = (cursor as { rowsRead?: unknown }).rowsRead;
    onRead(fitted.sql, fitted.params.length, Date.now() - started, rows.length, typeof rowsRead === "number" ? rowsRead : null);
    return rows;
  };
  const plain = durableObjectSqlExecutor(storage);
  return {
    ...plain,
    all<T extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): T[] {
      return read<T>(sql, params);
    },
    one<T extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): T | undefined {
      return read<T>(sql, params)[0];
    },
  };
}

export function durableObjectSqlExecutor(
  storage: DurableObjectStorage
): SqlExecutor {
  const run = <T extends SqlRow>(sql: string, params: SqlValue[]) => {
    const fitted = fitBindings(sql, params);
    return storage.sql.exec<T>(fitted.sql, ...fitted.params);
  };
  return {
    exec(sql, ...params) {
      return run(sql, params).rowsWritten;
    },
    all<T extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): T[] {
      return run<T>(sql, params).toArray();
    },
    one<T extends SqlRow = SqlRow>(
      sql: string,
      ...params: SqlValue[]
    ): T | undefined {
      return run<T>(sql, params).toArray()[0];
    },
    transactionSync<T>(fn: () => T): T {
      return storage.transactionSync(fn);
    },
  };
}
