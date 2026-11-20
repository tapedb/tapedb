/**
 * The adapter against the storage the package actually ships.
 *
 * `test/react-native-outbox.test.ts` exercises `AsyncStorageOutbox` over a fake
 * written in this repo, which proves the adapter matches our reading of the
 * interface and nothing more. This file imports the mock each release of
 * `@react-native-async-storage/async-storage` ships and runs the same contract
 * through it — v2 (the version inside the declared peer range when this was
 * written) and v3, which renamed `multiRemove` to `removeMany`.
 *
 * Why that matters: with the rename unhandled, `clear()` threw, fell back to
 * the in-memory queue and left every entry on disk — a queue that looks cleared
 * and is not. The fake had `multiRemove`, so it could never have seen it.
 */
import { beforeAll, describe, expect, test } from "bun:test";

import { AsyncStorageOutbox } from "../src/client/async-storage-outbox";
import type { AsyncStorageLike } from "../src/client/async-storage-outbox";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";

const entry = (clientTxId: string, createdAt: number, attempts = 1) => ({
  clientTxId,
  txId: `tx-${clientTxId}`,
  workspaceId: WORKSPACE,
  ops: [],
  createdAt,
  attempts,
});

let v2: AsyncStorageLike;
let v3: AsyncStorageLike;

beforeAll(async () => {
  // The v2 mock is written for jest and calls `jest.fn(...)`; the thinnest
  // possible stand-in keeps the package's own storage code under test.
  (globalThis as unknown as { jest: { fn: (impl: unknown) => unknown } }).jest = {
    fn: (impl: unknown) => impl,
  };
  const v2Module = await import("@react-native-async-storage/async-storage/jest/async-storage-mock");
  const v3Module = await import("async-storage-v3/jest");
  v2 = (v2Module.default ?? v2Module) as AsyncStorageLike;
  v3 = (v3Module.default ?? v3Module) as AsyncStorageLike;
});

let counter = 0;

function contract(label: string, storage: () => AsyncStorageLike) {
  describe(`${label} as the storage`, () => {
    const prefix = () => `vendor-${++counter}:`;

    test("the package exposes every read the adapter needs", () => {
      const store = storage();
      for (const method of ["getItem", "setItem", "removeItem", "getAllKeys"] as const) {
        expect(typeof store[method]).toBe("function");
      }
    });

    test("a queued write survives a new outbox over the same storage", async () => {
      const scope = prefix();
      await new AsyncStorageOutbox(storage(), { prefix: scope }).add(entry("a", 1000));
      const listed = await new AsyncStorageOutbox(storage(), { prefix: scope }).list(WORKSPACE);
      expect(listed.map((queued) => queued.clientTxId)).toEqual(["a"]);
    });

    test("listing follows createdAt rather than the store's key order", async () => {
      const scope = prefix();
      const outbox = new AsyncStorageOutbox(storage(), { prefix: scope });
      await outbox.add(entry("c", 3000));
      await outbox.add(entry("a", 1000));
      await outbox.add(entry("b", 2000));
      expect((await outbox.list(WORKSPACE)).map((queued) => queued.clientTxId)).toEqual(["a", "b", "c"]);
    });

    test("a retry replaces its entry instead of queueing twice", async () => {
      const scope = prefix();
      const outbox = new AsyncStorageOutbox(storage(), { prefix: scope });
      await outbox.add(entry("a", 1000));
      await outbox.add(entry("a", 1000, 2));
      const listed = await outbox.list(WORKSPACE);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.attempts).toBe(2);
    });

    test("remove drops exactly one entry", async () => {
      const scope = prefix();
      const outbox = new AsyncStorageOutbox(storage(), { prefix: scope });
      await outbox.add(entry("a", 1000));
      await outbox.add(entry("b", 2000));
      await outbox.remove("a");
      expect((await outbox.list(WORKSPACE)).map((queued) => queued.clientTxId)).toEqual(["b"]);
    });

    test("clear empties the queue AND the storage behind it", async () => {
      const scope = prefix();
      const store = storage();
      const outbox = new AsyncStorageOutbox(store, { prefix: scope });
      await outbox.add(entry("a", 1000));
      await outbox.add(entry("b", 2000));
      const before = (await store.getAllKeys()).filter((key) => key.startsWith(scope));
      expect(before).toHaveLength(2);

      await outbox.clear();

      // The half that matters: clearing in memory while leaving rows on the
      // device is what the v3 rename would have caused.
      const after = (await store.getAllKeys()).filter((key) => key.startsWith(scope));
      expect(after).toHaveLength(0);
      expect(await outbox.list(WORKSPACE)).toHaveLength(0);
    });

    test("two prefixes on one store never see each other", async () => {
      const one = new AsyncStorageOutbox(storage(), { prefix: prefix() });
      const two = new AsyncStorageOutbox(storage(), { prefix: prefix() });
      await one.add(entry("only-in-one", 10));
      expect(await two.list(WORKSPACE)).toHaveLength(0);
      expect(await one.list(WORKSPACE)).toHaveLength(1);
    });
  });
}

contract("async-storage v2 (multiRemove)", () => v2);
contract("async-storage v3 (removeMany)", () => v3);

describe("a store with neither batch delete", () => {
  test("clear still empties it, one key at a time", async () => {
    const values = new Map<string, string>();
    const store: AsyncStorageLike = {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => void values.set(key, value),
      removeItem: async (key) => void values.delete(key),
      getAllKeys: async () => [...values.keys()],
    };
    const outbox = new AsyncStorageOutbox(store, { prefix: "plain:" });
    await outbox.add(entry("a", 1000));
    await outbox.clear();
    expect([...values.keys()]).toHaveLength(0);
  });
});
