/**
 * Presence from the client's side: the socket's own `clientId`, and a peer
 * list that leaves the caller out until it asks for itself.
 *
 * No engine and no Worker here — a fake socket plays the room, so every
 * assertion is about what the client shows for what the wire said.
 */

import { describe, expect, test } from "bun:test";

import { MemoryOutbox } from "../src/client/outbox";
import { createClient } from "../src/model/client";
import { model, schema, t } from "../src/schema";

const WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";

const appSchema = schema({
  task: model({ title: t.string() }),
});

class FakeSocket {
  sent: Array<Record<string, unknown>> = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {}

  push(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function client() {
  const sockets: FakeSocket[] = [];
  const db = createClient(
    { schema: appSchema, url: "http://engine.test", workspace: WORKSPACE, getToken: async () => "token" },
    {
      fetch: async () => {
        throw new Error("presence does not go over HTTP");
      },
      outbox: new MemoryOutbox(),
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    }
  );
  return { db, sockets };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Waits for the socket the client opened, then hands it a session. */
async function session(sockets: FakeSocket[], clientId?: string, index = -1): Promise<FakeSocket> {
  for (let attempt = 0; attempt < 50 && sockets.length === 0; attempt += 1) await tick();
  const socket = index < 0 ? sockets.at(-1)! : sockets[index];
  socket.onopen?.({});
  socket.push({
    type: "session:ready",
    workspaceId: WORKSPACE,
    connections: 1,
    ...(clientId === undefined ? {} : { clientId }),
  });
  await tick();
  return socket;
}

/** What a room broadcasts: every socket in it, the caller included. */
const peers = [
  { clientId: "self-1", presence: { name: "Me" }, cursor: { x: 1 } },
  { clientId: "other-2", presence: { name: "You" } },
];

describe("presence peers on the client", () => {
  test("the client knows its own clientId, and peers() leaves it out", async () => {
    const { db, sockets } = client();
    const room = db.$presence("board:1");
    const seen: unknown[] = [];
    room.subscribe((list) => seen.push(list));
    const socket = await session(sockets, "self-1");

    expect(db.clientId).toBe("self-1");

    socket.push({ type: "presence:update", target: "board:1", peers });
    await tick();

    expect(await room.peers()).toEqual([{ clientId: "other-2", presence: { name: "You" } }]);
    expect(seen.at(-1)).toEqual([{ clientId: "other-2", presence: { name: "You" } }]);
  });

  test("includeSelf returns the caller's entry, marked isSelf", async () => {
    const { db, sockets } = client();
    const room = db.$presence("board:1");
    const seen: unknown[] = [];
    room.subscribe((list) => seen.push(list), { includeSelf: true });
    const socket = await session(sockets, "self-1");
    socket.push({ type: "presence:update", target: "board:1", peers });
    await tick();

    const all = await room.peers({ includeSelf: true });
    expect(all).toEqual([
      { clientId: "self-1", presence: { name: "Me" }, cursor: { x: 1 }, isSelf: true },
      { clientId: "other-2", presence: { name: "You" } },
    ]);
    expect(seen.at(-1)).toEqual(all);
  });

  test("a cursor move keeps both views right", async () => {
    const { db, sockets } = client();
    const others: unknown[] = [];
    const all: unknown[] = [];
    db.$presence("board:1").subscribe((list) => others.push(list));
    db.$presence("board:1").subscribe((list) => all.push(list), { includeSelf: true });
    const socket = await session(sockets, "self-1");
    socket.push({ type: "presence:update", target: "board:1", peers });
    await tick();

    socket.push({ type: "cursor:update", target: "board:1", clientId: "self-1", cursor: { x: 9 } });
    socket.push({ type: "cursor:update", target: "board:1", clientId: "other-2", cursor: { x: 4 } });
    await tick();

    expect(others.at(-1)).toEqual([
      { clientId: "other-2", presence: { name: "You" }, cursor: { x: 4 } },
    ]);
    expect(all.at(-1)).toEqual([
      { clientId: "self-1", presence: { name: "Me" }, cursor: { x: 9 }, isSelf: true },
      { clientId: "other-2", presence: { name: "You" }, cursor: { x: 4 } },
    ]);
  });

  test("against a Worker that sends no clientId, the list is passed through", async () => {
    // An older Worker: single-room presence, no `session:ready.clientId`, and
    // peers that include the caller. Nothing may throw, and nothing is
    // filtered, because there is no id to filter by.
    const { db, sockets } = client();
    const seen: unknown[] = [];
    db.$presence("board:1").subscribe((list) => seen.push(list));
    const socket = await session(sockets);

    expect(db.clientId).toBeUndefined();

    socket.push({ type: "presence:update", target: "board:1", peers });
    await tick();

    expect(seen.at(-1)).toEqual(peers);
    expect(await db.$presence("board:1").peers()).toEqual(peers);
    expect(await db.$presence("board:1").peers({ includeSelf: true })).toEqual(peers);
  });

  test("a reconnect brings a new session id, and the old one is not kept", async () => {
    const { db, sockets } = client();
    db.$presence("board:1").subscribe(() => {});
    const first = await session(sockets, "self-1");
    expect(db.clientId).toBe("self-1");

    // The socket drops; the client reconnects with a fresh one, whose
    // `session:ready` carries the id of that session.
    first.onclose?.({});
    for (let attempt = 0; attempt < 100 && sockets.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(sockets.length).toBe(2);

    const second = sockets[1];
    second.onopen?.({});
    second.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1, clientId: "self-2" });
    await tick();

    expect(db.clientId).toBe("self-2");
    db.$close();
  });
});
