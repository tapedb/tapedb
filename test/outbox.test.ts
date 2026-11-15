import { describe, expect, test } from "bun:test";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { createOutbox } from "../src/client/outbox";
import type { OutboxEntry } from "../src/client/types";

const entry = (clientTxId: string, workspaceId = "workspace-a"): OutboxEntry => ({
  clientTxId, txId: clientTxId, workspaceId, createdAt: 1, attempts: 1,
  ops: [{ op: "insert", namespace: "task", id: clientTxId, values: { title: "persisted" } }],
});

describe("IndexedDB outbox", () => {
  test("a new instance reads committed writes and workspace clears leave other workspaces intact", async () => {
    const factory = new IDBFactory();
    const outbox = createOutbox({ indexedDB: factory });
    await outbox.add(entry("a"));
    await outbox.add(entry("b", "workspace-b"));
    const reloaded = createOutbox({ indexedDB: factory });
    expect(await reloaded.list("workspace-a")).toEqual([entry("a")]);
    await reloaded.clear("workspace-a");
    expect(await outbox.list("workspace-a")).toEqual([]);
    expect(await outbox.list("workspace-b")).toEqual([entry("b", "workspace-b")]);
    await reloaded.remove("b");
    expect(await outbox.list("workspace-b")).toEqual([]);
  });

  test("an abort after request success retains the entry when IndexedDB is readable again", async () => {
    const outbox = createOutbox({ indexedDB: new IDBFactory() });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args as [unknown]);
      request.addEventListener("success", () => this.transaction.abort(), { once: true });
      return request;
    };
    try {
      await outbox.add(entry("aborted"));
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    expect(await outbox.list("workspace-a")).toEqual([entry("aborted")]);
    await outbox.remove("aborted");
    expect(await outbox.list("workspace-a")).toEqual([]);
  });

  test("clear also removes fallback entries after persistent storage recovers", async () => {
    const outbox = createOutbox({ indexedDB: new IDBFactory() });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { throw new DOMException("quota", "QuotaExceededError"); };
    try { await outbox.add(entry("quota")); }
    finally { IDBObjectStore.prototype.put = put; }
    expect(await outbox.list("workspace-a")).toEqual([entry("quota")]);
    await outbox.clear("workspace-a");
    expect(await outbox.list("workspace-a")).toEqual([]);
  });

  test("a later committed update replaces an older fallback attempt", async () => {
    const outbox = createOutbox({ indexedDB: new IDBFactory() });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { throw new DOMException("quota", "QuotaExceededError"); };
    try { await outbox.add(entry("retry")); }
    finally { IDBObjectStore.prototype.put = put; }
    await outbox.add({ ...entry("retry"), attempts: 2 });
    expect(await outbox.list("workspace-a")).toEqual([{ ...entry("retry"), attempts: 2 }]);
  });
});
