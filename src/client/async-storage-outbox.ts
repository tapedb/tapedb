/**
 * An `Outbox` over any async key-value store.
 *
 * React Native has no IndexedDB, so the browser's durable queue has nowhere to
 * live there; without one, every write in an app that is backgrounded or
 * killed before the socket answers is simply lost. The stores RN does have —
 * `@react-native-async-storage/async-storage`, MMKV behind a promise, a SQLite
 * driver — all answer the five calls below, so this adapter takes the store
 * instead of importing it. An app passes the real one (or lets
 * `@tapedb/react-native` do it); a test passes a Map.
 *
 * One key per entry, `<prefix><clientTxId>`, holding the entry as JSON. A retry
 * of the same optimistic write overwrites its own key rather than appending a
 * second copy, and a new client lists the previous session's queue straight
 * back — the same shape the IndexedDB store gives, so `data-client.ts` replays
 * both without knowing which one it has.
 */

import {
  isOutboxEntry,
  MemoryOutbox,
  sortOutboxEntries,
  type Outbox,
} from "./outbox";
import type { OutboxEntry } from "./types";

/**
 * The part of `@react-native-async-storage/async-storage` the queue uses.
 * Structural on purpose: the package is a peer dependency, not an import.
 */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  /**
   * v1 and v2 name the batch delete `multiRemove`; v3 renamed it `removeMany`.
   * Either satisfies this interface, and a store with neither still works one
   * key at a time.
   */
  multiRemove?(keys: readonly string[]): Promise<void>;
  removeMany?(keys: readonly string[]): Promise<void>;
}

/** Every key this outbox writes starts here, so a shared store keeps other keys intact. */
export const ASYNC_STORAGE_OUTBOX_PREFIX = "tapedb-outbox:";

export interface AsyncStorageOutboxOptions {
  /**
   * Key prefix. Pass `scopedOutboxName(apiUrl, userId) + ":"` to scope the
   * queue the way the browser scopes its IndexedDB one, so one account's
   * pending writes are never replayed with another's claim.
   */
  prefix?: string;
}

export class AsyncStorageOutbox implements Outbox {
  private readonly storage: AsyncStorageLike;
  private readonly prefix: string;
  /**
   * A store that refuses a write (full disk, a locked app group) must not cost
   * the caller the write: the entry stays in memory, where a later flush still
   * sees it. Retained until the same `clientTxId` commits or is removed.
   */
  private readonly fallback = new MemoryOutbox();

  /**
   * Delete a batch on whatever the installed release calls the batch delete.
   * The rename in v3 is silent otherwise: `clear()` would throw, fall back to
   * the in-memory queue, and leave every entry on disk looking cleared.
   */
  private async removeMany(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    if (typeof this.storage.multiRemove === "function") {
      await this.storage.multiRemove(keys);
      return;
    }
    if (typeof this.storage.removeMany === "function") {
      await this.storage.removeMany(keys);
      return;
    }
    for (const key of keys) await this.storage.removeItem(key);
  }

  constructor(storage: AsyncStorageLike, options: AsyncStorageOutboxOptions = {}) {
    this.storage = storage;
    this.prefix = options.prefix ?? ASYNC_STORAGE_OUTBOX_PREFIX;
  }

  async add(entry: OutboxEntry): Promise<void> {
    try {
      await this.storage.setItem(this.key(entry.clientTxId), JSON.stringify(entry));
      await this.fallback.remove(entry.clientTxId);
    } catch {
      await this.fallback.add(entry);
    }
  }

  async list(workspaceId: string): Promise<OutboxEntry[]> {
    let stored: OutboxEntry[];
    try {
      const keys = (await this.storage.getAllKeys()).filter((key) =>
        key.startsWith(this.prefix)
      );
      const values = await Promise.all(keys.map((key) => this.storage.getItem(key)));
      stored = values
        // A corrupt or half-written key is one lost write, not a wedged queue.
        .map(parseEntry)
        .filter((entry): entry is OutboxEntry => entry !== null)
        .filter((entry) => entry.workspaceId === workspaceId);
    } catch {
      return this.fallback.list(workspaceId);
    }

    // The fallback wins a tie: it holds the later attempt of a write whose
    // storage call failed after an earlier one committed.
    const merged = new Map<string, OutboxEntry>();
    for (const entry of stored) merged.set(entry.clientTxId, entry);
    for (const entry of await this.fallback.list(workspaceId)) {
      merged.set(entry.clientTxId, entry);
    }
    return sortOutboxEntries([...merged.values()]);
  }

  async remove(clientTxId: string): Promise<void> {
    await this.fallback.remove(clientTxId);
    try {
      await this.storage.removeItem(this.key(clientTxId));
    } catch {
      // Nothing left to do: the entry is gone from memory, which is what this
      // client will list, and the key will be replaced by any later attempt.
    }
  }

  async clear(workspaceId?: string): Promise<void> {
    await this.fallback.clear(workspaceId);
    try {
      const keys = (await this.storage.getAllKeys()).filter((key) =>
        key.startsWith(this.prefix)
      );
      if (workspaceId === undefined) {
        if (keys.length > 0) await this.removeMany(keys);
        return;
      }

      const values = await Promise.all(keys.map((key) => this.storage.getItem(key)));
      const doomed = keys.filter((_key, index) => {
        const entry = parseEntry(values[index]);
        return entry !== null && entry.workspaceId === workspaceId;
      });
      if (doomed.length > 0) await this.removeMany(doomed);
    } catch {
      // The memory fallback is already empty; a store that cannot be read has
      // no entries this client can vouch for.
    }
  }

  private key(clientTxId: string): string {
    return `${this.prefix}${clientTxId}`;
  }
}

function parseEntry(value: string | null): OutboxEntry | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isOutboxEntry(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
