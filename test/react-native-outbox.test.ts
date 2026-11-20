/**
 * The offline queue in a runtime with no IndexedDB, which is every React
 * Native app.
 *
 * A browser client's pending writes live in IndexedDB and are replayed when
 * the page loads. React Native has no IndexedDB, so until `createClient` could
 * take an `Outbox` of its own, a mobile write that had not been acknowledged
 * when the app was backgrounded or killed was simply gone. These tests hold
 * the two halves of that fix: an `Outbox` a caller can inject, and a durable
 * implementation over the store React Native does have.
 *
 * `AsyncStorageOutbox` is contract-tested against an in-memory fake of the
 * AsyncStorage interface. No device or simulator is involved anywhere in this
 * repository, so nothing here claims the adapter has run on one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";

import {
  AsyncStorageOutbox,
  ASYNC_STORAGE_OUTBOX_PREFIX,
  type AsyncStorageLike,
} from "../src/client/async-storage-outbox";
import { MemoryOutbox, scopedOutboxName, type Outbox } from "../src/client/outbox";
import type { FetchLike, FetchResponseLike } from "../src/client/data-client";
import type { WebSocketLike } from "../src/client/socket";
import type { OutboxEntry } from "../src/client/types";
import { createClient } from "../src/model/client";
import { model, schema, t } from "../src/schema";

const WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";
const OTHER_WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9b";

const appSchema = schema({
  task: model({ title: t.string(), done: t.boolean().default(false) }),
});

/** The AsyncStorage surface the adapter uses, over a Map. */
class FakeStorage implements AsyncStorageLike {
  readonly values = new Map<string, string>();
  /** Every `setItem`, so a test can say the store received the write. */
  writes = 0;
  /** Set to make the store behave like a full disk. */
  failing = false;

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    if (this.failing) throw new Error("disk full");
    this.writes += 1;
    this.values.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }

  async getAllKeys(): Promise<readonly string[]> {
    return [...this.values.keys()];
  }

  async multiRemove(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.values.delete(key);
  }

  /** Keys this outbox owns, without the prefix. */
  queued(prefix = ASYNC_STORAGE_OUTBOX_PREFIX): string[] {
    return [...this.values.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }
}

class FakeSocket implements WebSocketLike {
  sent: Array<Record<string, unknown>> = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {}
  open(): void {
    this.onopen?.({});
  }
  push(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

/** A network that starts down: every send fails until the test says otherwise. */
function network() {
  const bodies: Array<Record<string, unknown>> = [];
  const state = { up: false };
  const fetch: FetchLike = async (_url, init) => {
    if (!state.up) throw new TypeError("network down");
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, result: { seq: bodies.length } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as unknown as FetchResponseLike;
  };
  return { fetch, bodies, state };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const entry = (
  clientTxId: string,
  createdAt: number,
  workspaceId = WORKSPACE
): OutboxEntry => ({
  clientTxId,
  txId: clientTxId,
  workspaceId,
  createdAt,
  attempts: 1,
  ops: [{ op: "insert", namespace: "task", id: clientTxId, values: { title: clientTxId } }],
});

/** A claim whose subject is `sub`: the browser default checks it against `userId`. */
const token = (sub: string) => `e30.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.test`;

/** The status a model write resolves to: `"queued"` while offline. */
async function write(db: ReturnType<typeof client>["db"], title = "offline") {
  return (await db.task.create({ data: { title } })).status;
}

/** The titles in the order the engine received them. */
function sentTitles(bodies: Array<Record<string, unknown>>): string[] {
  return bodies.map(
    (body) => (body.ops as Array<{ values: { title: string } }>)[0].values.title
  );
}

/** A client over `outbox`, with a socket the test drives. */
function client(
  outbox: Outbox | (() => Outbox) | undefined,
  net: ReturnType<typeof network>,
  options: { userId?: string } = {}
) {
  const sockets: FakeSocket[] = [];
  const db = createClient(
    {
      schema: appSchema,
      url: "http://127.0.0.1:8787",
      workspace: WORKSPACE,
      getToken: async () => (options.userId ? token(options.userId) : "token"),
      ...(outbox ? { outbox } : {}),
      ...(options.userId ? { userId: options.userId } : {}),
    },
    {
      fetch: net.fetch,
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    }
  );
  return { db, sockets };
}

const realIndexedDb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;

afterEach(() => {
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = realIndexedDb;
});

describe("AsyncStorageOutbox", () => {
  test("a queued write is still there after a fresh client is created over the same storage", async () => {
    const storage = new FakeStorage();
    const first = network();

    const session = client(new AsyncStorageOutbox(storage), first);
    expect(await write(session.db)).toBe("queued");
    expect(storage.queued()).toHaveLength(1);
    session.db.$close();

    // The app was killed here. A new client, a new outbox instance, same
    // storage: the queue is what the last session left behind.
    const reloaded = new AsyncStorageOutbox(storage);
    expect((await reloaded.list(WORKSPACE))[0].ops[0]).toMatchObject({
      op: "insert",
      namespace: "task",
      values: { title: "offline" },
    });

    const second = network();
    second.state.up = true;
    const resumed = client(reloaded, second);
    await tick();

    expect(sentTitles(second.bodies)).toEqual(["offline"]);
    expect(await reloaded.list(WORKSPACE)).toEqual([]);
    resumed.db.$close();
  });

  test("entries are replayed in createdAt order, not the order the store lists keys", async () => {
    const storage = new FakeStorage();
    const outbox = new AsyncStorageOutbox(storage);
    // Written out of order, and the store hands keys back in insertion order.
    await outbox.add(entry("c", 300));
    await outbox.add(entry("a", 100));
    await outbox.add(entry("b", 200));

    expect((await new AsyncStorageOutbox(storage).list(WORKSPACE)).map((item) => item.clientTxId)).toEqual([
      "a",
      "b",
      "c",
    ]);

    const net = network();
    net.state.up = true;
    const { db, sockets } = client(new AsyncStorageOutbox(storage), net);
    await tick();
    expect(net.bodies.map((body) => (body.ops as Array<{ id: string }>)[0].id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    db.$close();
    expect(sockets).toHaveLength(0);
  });

  test("an acknowledged write is removed from the store", async () => {
    const storage = new FakeStorage();
    const net = network();
    net.state.up = true;
    const { db } = client(new AsyncStorageOutbox(storage), net);

    expect(await write(db)).toBe("applied");
    expect(await new AsyncStorageOutbox(storage).list(WORKSPACE)).toEqual([]);
    expect(storage.queued()).toEqual([]);
    db.$close();
  });

  test("clear empties the queue, for one workspace or all of them", async () => {
    const storage = new FakeStorage();
    const outbox = new AsyncStorageOutbox(storage);
    await outbox.add(entry("a", 1));
    await outbox.add(entry("b", 2, OTHER_WORKSPACE));

    await outbox.clear(WORKSPACE);
    expect(storage.queued()).toEqual(["b"]);
    expect(await outbox.list(OTHER_WORKSPACE)).toHaveLength(1);

    await outbox.clear();
    expect(storage.queued()).toEqual([]);
    expect(await outbox.list(OTHER_WORKSPACE)).toEqual([]);
  });

  test("a retry replaces its own entry instead of queueing twice", async () => {
    const storage = new FakeStorage();
    const outbox = new AsyncStorageOutbox(storage);
    await outbox.add(entry("same", 1));
    await outbox.add({ ...entry("same", 1), attempts: 2 });

    expect(storage.queued()).toEqual(["same"]);
    expect(await outbox.list(WORKSPACE)).toEqual([{ ...entry("same", 1), attempts: 2 }]);
  });

  test("a store that refuses a write still queues it, so the flush can land it", async () => {
    const storage = new FakeStorage();
    const net = network();
    net.state.up = true;
    const outbox = new AsyncStorageOutbox(storage);
    const { db } = client(outbox, net);
    storage.failing = true;

    expect(await write(db)).toBe("applied");
    expect(storage.queued()).toEqual([]);
    expect(net.bodies).toHaveLength(1);
    db.$close();
  });

  test("the default prefix keeps a shared store's other keys, and a scoped one keeps accounts apart", async () => {
    const storage = new FakeStorage();
    await storage.setItem("some-other-app-key", "untouched");

    const scoped = `${scopedOutboxName("http://127.0.0.1:8787", "user-a")}:`;
    const alice = new AsyncStorageOutbox(storage, { prefix: scoped });
    const bob = new AsyncStorageOutbox(storage, {
      prefix: `${scopedOutboxName("http://127.0.0.1:8787", "user-b")}:`,
    });

    await alice.add(entry("a", 1));
    await bob.add(entry("b", 2));

    expect((await alice.list(WORKSPACE)).map((item) => item.clientTxId)).toEqual(["a"]);
    expect((await bob.list(WORKSPACE)).map((item) => item.clientTxId)).toEqual(["b"]);

    await alice.clear();
    expect(await bob.list(WORKSPACE)).toHaveLength(1);
    expect(await storage.getItem("some-other-app-key")).toBe("untouched");
  });
});

describe("createClient({ outbox })", () => {
  test("a write made while offline is sent once the socket opens", async () => {
    const storage = new FakeStorage();
    const net = network();
    const { db, sockets } = client(new AsyncStorageOutbox(storage), net);

    expect(await write(db)).toBe("queued");
    expect(net.bodies).toEqual([]);
    expect(storage.queued()).toHaveLength(1);

    const socket = sockets.at(-1)!;
    socket.open();
    net.state.up = true;
    socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1 });
    await tick();

    expect(sentTitles(net.bodies)).toEqual(["offline"]);
    expect(storage.queued()).toEqual([]);
    db.$close();
  });

  test("the injected outbox is used instead of IndexedDB", async () => {
    // A browser-shaped global, and no `userId`: if the default were chosen
    // this client would refuse every write as unscoped.
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();
    const storage = new FakeStorage();
    const net = network();
    const { db } = client(new AsyncStorageOutbox(storage), net);

    expect(await write(db)).toBe("queued");
    expect(storage.writes).toBe(1);
    expect(storage.queued()).toHaveLength(1);
    db.$close();
  });

  test("a factory is called once, and the browser default is unchanged when nothing is injected", async () => {
    let made = 0;
    const storage = new FakeStorage();
    const net = network();
    const { db } = client(() => {
      made += 1;
      return new AsyncStorageOutbox(storage);
    }, net);
    expect(made).toBe(1);
    await write(db);
    expect(storage.writes).toBe(1);
    db.$close();

    // Nothing injected, IndexedDB present: the queue is the browser's, and it
    // is what a second client replays from after a reload.
    const factory = new IDBFactory();
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = factory;
    const offline = network();
    const browser = client(undefined, offline, { userId: "dev-user" });
    expect(await write(browser.db)).toBe("queued");
    browser.db.$close();

    const online = network();
    online.state.up = true;
    const reloaded = client(undefined, online, { userId: "dev-user" });
    await tick();
    expect(sentTitles(online.bodies)).toEqual(["offline"]);
    reloaded.db.$close();
  });

  test("MemoryOutbox stays the in-memory queue, with no store behind it", async () => {
    const net = network();
    const outbox = new MemoryOutbox();
    const { db } = client(outbox, net);
    await write(db);
    expect(await outbox.list(WORKSPACE)).toHaveLength(1);
    db.$close();
  });
});
