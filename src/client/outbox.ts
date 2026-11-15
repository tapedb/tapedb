/**
 * IndexedDB-backed outbox for unacknowledged writes.
 *
 * The outbox is keyed by `clientTxId`, so retrying the same optimistic write
 * replaces the pending entry instead of appending a duplicate. When
 * IndexedDB is unavailable (server render, tests, private-mode failures) the
 * same operations run against an in-memory map.
 */

import type { OutboxEntry } from "./types";

export const OUTBOX_DB_NAME = "tapedb-data-outbox";
export const OUTBOX_STORE_NAME = "pending";

export interface Outbox {
  add(entry: OutboxEntry): Promise<void>;
  list(workspaceId: string): Promise<OutboxEntry[]>;
  remove(clientTxId: string): Promise<void>;
  clear(workspaceId?: string): Promise<void>;
}

export interface OutboxOptions {
  /** Pass `null` to force the in-memory store (tests, SSR). */
  indexedDB?: IDBFactory | null;
  dbName?: string;
}

function sortEntries(entries: OutboxEntry[]): OutboxEntry[] {
  return [...entries].sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      left.clientTxId.localeCompare(right.clientTxId)
  );
}

function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.clientTxId === "string" &&
    typeof candidate.txId === "string" &&
    typeof candidate.workspaceId === "string" &&
    Array.isArray(candidate.ops) &&
    typeof candidate.createdAt === "number"
  );
}

export class MemoryOutbox implements Outbox {
  private readonly entries = new Map<string, OutboxEntry>();

  async add(entry: OutboxEntry): Promise<void> {
    this.entries.set(entry.clientTxId, entry);
  }

  async list(workspaceId: string): Promise<OutboxEntry[]> {
    return sortEntries(
      [...this.entries.values()].filter(
        (entry) => entry.workspaceId === workspaceId
      )
    );
  }

  async remove(clientTxId: string): Promise<void> {
    this.entries.delete(clientTxId);
  }

  async clear(workspaceId?: string): Promise<void> {
    if (workspaceId === undefined) {
      this.entries.clear();
      return;
    }
    for (const [clientTxId, entry] of this.entries) {
      if (entry.workspaceId === workspaceId) this.entries.delete(clientTxId);
    }
  }
}

export class IndexedDbOutbox implements Outbox {
  private readonly factory: IDBFactory;
  private readonly dbName: string;
  private openPromise: Promise<IDBDatabase> | null = null;
  private readonly fallback = new MemoryOutbox();

  constructor(factory: IDBFactory, dbName: string) {
    this.factory = factory;
    this.dbName = dbName;
  }

  async add(entry: OutboxEntry): Promise<void> {
    try {
      await this.request("readwrite", (store) => store.put(entry));
      await this.fallback.remove(entry.clientTxId);
    } catch {
      await this.fallback.add(entry);
    }
  }

  async list(workspaceId: string): Promise<OutboxEntry[]> {
    try {
      const values = await this.request<OutboxEntry[]>("readonly", (store) =>
        store.getAll()
      );
      return sortEntries(
        [...new Map([
          ...values.filter(isOutboxEntry).filter((entry) => entry.workspaceId === workspaceId),
          ...await this.fallback.list(workspaceId),
        ].map((entry) => [entry.clientTxId, entry])).values()]
      );
    } catch {
      return this.fallback.list(workspaceId);
    }
  }

  async remove(clientTxId: string): Promise<void> {
    await this.fallback.remove(clientTxId);
    try {
      await this.request("readwrite", (store) => store.delete(clientTxId));
    } catch {
      await this.fallback.remove(clientTxId);
    }
  }

  async clear(workspaceId?: string): Promise<void> {
    await this.fallback.clear(workspaceId);
    try {
      if (workspaceId === undefined) {
        await this.request("readwrite", (store) => store.clear());
        return;
      }

      const values = await this.request<OutboxEntry[]>("readonly", (store) =>
        store.getAll()
      );
      const clientTxIds = values
        .filter(isOutboxEntry)
        .filter((entry) => entry.workspaceId === workspaceId)
        .map((entry) => entry.clientTxId);

      for (const clientTxId of clientTxIds) {
        await this.request("readwrite", (store) => store.delete(clientTxId));
      }
    } catch {
      await this.fallback.clear(workspaceId);
    }
  }

  private open(): Promise<IDBDatabase> {
    if (this.openPromise) return this.openPromise;

    this.openPromise = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.factory.open(this.dbName, 1);
      } catch (error) {
        reject(error);
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(OUTBOX_STORE_NAME)) {
          db.createObjectStore(OUTBOX_STORE_NAME, { keyPath: "clientTxId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB open failed."));
      request.onblocked = () =>
        reject(new Error("IndexedDB open was blocked."));
    });

    return this.openPromise;
  }

  private async request<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    const db = await this.open();

    return new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction(OUTBOX_STORE_NAME, mode);
      } catch (error) {
        reject(error);
        return;
      }

      const request = run(transaction.objectStore(OUTBOX_STORE_NAME));
      // A successful request is not a committed write. Quota errors or an
      // explicit abort can still roll the transaction back afterwards.
      let result: T;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB request failed."));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("IndexedDB transaction failed."));
      transaction.onabort = () =>
        reject(
          transaction.error ?? new Error("IndexedDB transaction aborted.")
        );
    });
  }
}

function defaultIndexedDb(): IDBFactory | null {
  try {
    return typeof indexedDB === "undefined" ? null : indexedDB;
  } catch {
    return null;
  }
}

export function createOutbox(options: OutboxOptions = {}): Outbox {
  const factory =
    options.indexedDB === undefined ? defaultIndexedDb() : options.indexedDB;
  if (!factory) return new MemoryOutbox();

  return new IndexedDbOutbox(factory, options.dbName ?? OUTBOX_DB_NAME);
}
