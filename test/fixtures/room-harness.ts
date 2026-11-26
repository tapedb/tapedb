/**
 * A WorkspaceRoom's storage on in-memory SQLite, for tests that run the real
 * room (and, through `roomNamespace`, the real Worker in front of it).
 */

import { Database } from "bun:sqlite";

export function createSqlStorage(db: Database) {
  return {
    /**
     * What a Durable Object's `databaseSize` reports, worked out the same way:
     * pages times page size, so a test reads a real figure that grows with the
     * data rather than a constant.
     */
    get databaseSize(): number {
      const pages = db.query(`PRAGMA page_count`).get() as { page_count: number } | null;
      const size = db.query(`PRAGMA page_size`).get() as { page_size: number } | null;
      return (pages?.page_count ?? 0) * (size?.page_size ?? 0);
    },
    exec<T extends Record<string, unknown>>(query: string, ...params: unknown[]) {
      // Leading comments do not make a read a write.
      const trimmed = query.trim().replace(/^(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)+/, "");
      const lower = trimmed.toLowerCase();
      const isRead = /^(select|with|explain)\b/i.test(trimmed) || (lower.startsWith("pragma") && !lower.includes("="));
      if (isRead) {
        const statement = db.query(query);
        const rows = statement.all(...(params as never[])) as T[];
        return {
          columnNames: statement.columnNames,
          raw: () => (statement.values(...(params as never[])) as unknown[][])[Symbol.iterator](),
          toArray: () => rows,
          one: () => {
            if (rows.length === 0) throw new Error("Query returned no rows.");
            return rows[0];
          },
          rowsWritten: 0,
        };
      }
      const statements = trimmed.split(";").filter((part) => part.trim());
      let changes = 0;
      if (statements.length > 1) db.exec(query);
      else changes = db.prepare(query).run(...(params as never[])).changes;
      return {
        toArray: () => [] as T[],
        one: (): T => {
          throw new Error("Statement returned no rows.");
        },
        rowsWritten: changes,
      };
    },
  };
}

export class FakeRoomContext {
  ready: Promise<unknown> = Promise.resolve();
  alarm: number | null = null;
  /** Sockets this room accepted; a test pushes one in to act as a client. */
  readonly sockets: unknown[] = [];
  readonly id: { name: string };
  readonly storage;

  constructor(readonly db: Database, name: string) {
    this.id = { name };
    this.storage = {
      sql: createSqlStorage(db),
      transactionSync: <T>(fn: () => T): T => db.transaction(fn)(),
      transaction: async <T>(fn: () => Promise<T>): Promise<T> => {
        db.exec("BEGIN");
        try { const result = await fn(); db.exec("COMMIT"); return result; }
        catch (error) { db.exec("ROLLBACK"); throw error; }
      },
      getAlarm: async () => this.alarm,
      setAlarm: async (at: number) => {
        this.alarm = at;
      },
      deleteAlarm: async () => {
        this.alarm = null;
      },
      deleteAll: async () => {
        const tables = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>;
        db.exec("PRAGMA foreign_keys = OFF");
        for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`);
      },
    };
  }

  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    const promise = fn();
    this.ready = promise;
    return promise;
  }

  getWebSockets(): unknown[] {
    return this.sockets;
  }

  acceptWebSocket(ws: unknown): void {
    this.sockets.push(ws);
  }
}
