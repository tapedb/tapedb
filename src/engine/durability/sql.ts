/**
 * Minimal SQL surface shared by the workspace Durable Object
 * (`DurableObjectStorage.sql`) and the in-memory test adapter (`bun:sqlite`).
 *
 * Durability code only needs parameterised `exec` with `toArray`/`one`; keeping
 * the interface this small makes the modules trivially testable outside a DO.
 */

export type SqlValue = ArrayBuffer | string | number | null;

export interface SqlCursor<T> {
  toArray(): T[];
  one(): T;
}

export interface SqlExecutor {
  exec<T extends Record<string, SqlValue> = Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): SqlCursor<T>;
}
