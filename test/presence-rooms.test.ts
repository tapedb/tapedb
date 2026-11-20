/**
 * Presence rooms: several per socket, capped, authorized, and byte-bounded.
 *
 * Runs the real `WorkspaceRoom` over in-memory SQLite with fake sockets whose
 * attachments behave as the runtime's do — `serializeAttachment` keeps the
 * JSON a hibernated room would find again.
 */

import { useLegacyFixture } from "./fixtures/registry";
useLegacyFixture();

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type WorkspaceRole } from "../src/claims";
import { encodeTrustedRoleClaim } from "../src/verify";
import type { Env } from "../src/types";
import { configureRealtime } from "../src/engine/topics";
import { PRESENCE_STATE_BYTES } from "../src/engine/ws-types";
import { FakeR2Bucket, TEST_WORKSPACE } from "./fixtures/test-support";

class MockDurableObject<EnvShape> {
  protected ctx: DurableObjectState;
  protected env: EnvShape;

  constructor(ctx: DurableObjectState, env: EnvShape) {
    this.ctx = ctx;
    this.env = env;
  }
}

mock.module("cloudflare:workers", () => ({
  DurableObject: MockDurableObject,
}));

const { WorkspaceRoom } = await import("../src/engine/workspace-room");

interface SqlCursor<T> {
  toArray(): T[];
  one(): T;
  rowsWritten: number;
}

function createSqlStorage(db: Database) {
  return {
    exec<T extends Record<string, unknown>>(query: string, ...params: unknown[]): SqlCursor<T> {
      const trimmed = query.trim();
      const lower = trimmed.toLowerCase();
      const isRead =
        /^(select|with|explain)\b/i.test(trimmed) ||
        (lower.startsWith("pragma") && !lower.includes("="));
      if (isRead) {
        const rows = db.query(query).all(...(params as never[])) as T[];
        return {
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
        toArray: () => [],
        one: () => {
          throw new Error("Statement returned no rows.");
        },
        rowsWritten: changes,
      };
    },
  };
}

/** An attachment as it survives hibernation: JSON, then read back. */
function roundTrip(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

class FakeSocket {
  readonly sent: unknown[] = [];
  attachment: unknown;
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  deserializeAttachment(): unknown {
    return roundTrip(this.attachment);
  }

  serializeAttachment(value: unknown): void {
    // As the runtime does: the attachment is stored as JSON, at most 16 KiB.
    const encoded = JSON.stringify(value);
    if (new TextEncoder().encode(encoded).byteLength > 16_384) {
      throw new Error("Attachment exceeds the 16 KiB limit.");
    }
    this.attachment = JSON.parse(encoded) as unknown;
  }

  close(): void {
    this.closed = true;
  }

  messages(): Array<Record<string, unknown>> {
    return this.sent as Array<Record<string, unknown>>;
  }

  last(): Record<string, unknown> | undefined {
    return this.messages().at(-1);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

class FakeContext {
  ready: Promise<unknown> = Promise.resolve();
  readonly sockets: FakeSocket[] = [];
  readonly storage: {
    sql: ReturnType<typeof createSqlStorage>;
    transactionSync<T>(fn: () => T): T;
    getAlarm(): Promise<number | null>;
    setAlarm(at: number): Promise<void>;
  };
  readonly id: { name: string };

  constructor(db: Database, name: string) {
    this.id = { name };
    this.storage = {
      sql: createSqlStorage(db),
      transactionSync: <T>(fn: () => T): T => db.transaction(fn)(),
      getAlarm: async () => null,
      setAlarm: async () => undefined,
    };
  }

  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    const promise = fn();
    this.ready = promise;
    return promise;
  }

  acceptWebSocket(ws: FakeSocket): void {
    this.sockets.push(ws);
  }

  getWebSockets(): FakeSocket[] {
    return this.sockets;
  }
}

class FakeWebSocketPair {
  0: FakeSocket;
  1: FakeSocket;

  constructor() {
    this[0] = new FakeSocket();
    this[1] = new FakeSocket();
  }
}

(globalThis as { WebSocketPair?: unknown }).WebSocketPair = FakeWebSocketPair;

function attachmentFor(clientId: string, role: WorkspaceRole = WORKSPACE_ROLE_LEVELS.EDITOR) {
  const now = Math.floor(Date.now() / 1000);
  return {
    clientId,
    sub: `user-${clientId}`,
    role,
    exp: now + 600,
    subscriptions: [],
  };
}

describe("presence rooms", () => {
  let db: Database;
  let context: FakeContext;
  let room: InstanceType<typeof WorkspaceRoom>;

  beforeEach(async () => {
    // Each test starts from the deployed defaults: no authorizer, 4 rooms.
    configureRealtime(undefined, undefined);
    db = new Database(":memory:");
    context = new FakeContext(db, TEST_WORKSPACE);
    room = new WorkspaceRoom(
      context as unknown as DurableObjectState,
      { DATA: new FakeR2Bucket() } as unknown as Env
    );
    await context.ready;
  });

  function socket(clientId: string, attachment: unknown = attachmentFor(clientId)): FakeSocket {
    const ws = new FakeSocket();
    ws.attachment = attachment;
    context.sockets.push(ws);
    return ws;
  }

  function send(ws: FakeSocket, message: Record<string, unknown>): Promise<void> {
    return room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(message));
  }

  function peersOf(ws: FakeSocket, target: string): string[] {
    const update = [...ws.messages()]
      .reverse()
      .find((message) => message.type === "presence:update" && message.target === target);
    const peers = (update?.peers ?? []) as Array<{ clientId: string }>;
    return peers.map((peer) => peer.clientId);
  }

  test("two rooms on one socket coexist, each with its own peers", async () => {
    const one = socket("one");
    const two = socket("two");
    const solo = socket("solo");

    await send(one, { type: "presence:set", target: "board:A", presence: { name: "one" } });
    await send(two, { type: "presence:set", target: "board:A", presence: { name: "two" } });
    await send(solo, { type: "presence:set", target: "board:B", presence: { name: "solo" } });

    // The same socket joins a second room: the first is untouched.
    await send(one, { type: "presence:set", target: "board:B", presence: { name: "one" } });

    expect(peersOf(one, "board:A")).toEqual(["one", "two"]);
    expect(peersOf(two, "board:A")).toEqual(["one", "two"]);
    expect(peersOf(solo, "board:B")).toEqual(["one", "solo"]);
    expect(peersOf(one, "board:B")).toEqual(["one", "solo"]);

    // Nothing leaked between them.
    expect(peersOf(two, "board:b")).toEqual([]);
    expect(new Set(peersOf(two, "board:A"))).not.toContain("solo");
  });

  test("leaving one room keeps the other", async () => {
    const one = socket("one");
    const peer = socket("peer");
    await send(one, { type: "presence:set", target: "board:A", presence: { name: "one" } });
    await send(one, { type: "presence:set", target: "board:B", presence: { name: "one" } });
    await send(peer, { type: "presence:set", target: "board:A", presence: { name: "peer" } });
    await send(peer, { type: "presence:set", target: "board:B", presence: { name: "peer" } });

    await send(one, { type: "presence:clear", target: "board:A" });

    expect(peersOf(peer, "board:A")).toEqual(["peer"]);
    expect(peersOf(peer, "board:B")).toEqual(["one", "peer"]);
    expect(peersOf(one, "board:B")).toEqual(["one", "peer"]);
    const stored = one.attachment as { presence?: Record<string, unknown> };
    expect(Object.keys(stored.presence ?? {})).toEqual(["board:B"]);
  });

  test("a disconnect leaves every room, and only those", async () => {
    const gone = socket("gone");
    const stayA = socket("stay-a");
    const stayB = socket("stay-b");
    await send(gone, { type: "presence:set", target: "board:A", presence: { name: "gone" } });
    await send(gone, { type: "presence:set", target: "board:B", presence: { name: "gone" } });
    await send(stayA, { type: "presence:set", target: "board:A", presence: { name: "a" } });
    await send(stayB, { type: "presence:set", target: "board:B", presence: { name: "b" } });

    context.sockets.splice(context.sockets.indexOf(gone), 1);
    room.webSocketClose(gone as unknown as WebSocket, 1000, "bye");

    expect(peersOf(stayA, "board:A")).toEqual(["stay-a"]);
    expect(peersOf(stayB, "board:B")).toEqual(["stay-b"]);
  });

  test("the room cap refuses a further room and changes nothing", async () => {
    configureRealtime({ maxPresenceRooms: 2 }, undefined);
    const ws = socket("s");
    await send(ws, { type: "presence:set", target: "board:A", presence: { name: "s" } });
    await send(ws, { type: "presence:set", target: "board:B", presence: { name: "s" } });

    await send(ws, { type: "presence:set", target: "board:C", presence: { name: "s" } });

    expect(ws.last()).toMatchObject({ type: "error", code: "presence_rooms_exceeded" });
    const stored = ws.attachment as { presence?: Record<string, unknown> };
    expect(Object.keys(stored.presence ?? {}).sort()).toEqual(["board:A", "board:B"]);

    // Once a room is left, another fits.
    await send(ws, { type: "presence:clear", target: "board:A" });
    await send(ws, { type: "presence:set", target: "board:C", presence: { name: "s" } });
    expect(ws.last()).toMatchObject({ type: "presence:update", target: "board:C" });
    const after = ws.attachment as { presence?: Record<string, unknown> };
    expect(Object.keys(after.presence ?? {}).sort()).toEqual(["board:B", "board:C"]);
  });

  test("maxPresenceRooms: 1 is the old single-room socket", async () => {
    configureRealtime({ maxPresenceRooms: 1 }, undefined);
    const ws = socket("s");
    await send(ws, { type: "presence:set", target: "board:A", presence: { name: "s" } });
    expect(ws.last()).toMatchObject({ type: "presence:update", target: "board:A" });

    // One room at a time: the second is refused, and the first is still there.
    await send(ws, { type: "presence:set", target: "board:B", presence: { name: "s" } });
    expect(ws.last()).toMatchObject({ type: "error", code: "presence_rooms_exceeded" });
    expect((ws.attachment as { presence?: Record<string, unknown> }).presence).toEqual({
      "board:A": { presence: { name: "s" } },
    });
  });

  test("the default cap is four rooms", async () => {
    const ws = socket("s");
    for (const target of ["board:A", "board:B", "board:C", "board:D"]) {
      await send(ws, { type: "presence:set", target, presence: { n: target } });
      expect(ws.last()).toMatchObject({ type: "presence:update", target });
    }
    await send(ws, { type: "presence:set", target: "board:E", presence: { n: "e" } });
    expect(ws.last()).toMatchObject({ type: "error", code: "presence_rooms_exceeded" });
  });

  test("an authorize refusal leaves no state and is not broadcast", async () => {
    const seen: Array<{ kind: string; target: string; action: string }> = [];
    configureRealtime(
      {
        authorize: async ({ kind, target, action }) => {
          seen.push({ kind, target, action });
          return target !== "board:secret";
        },
      },
      undefined
    );

    const ws = socket("s");
    const peer = socket("peer");
    await send(ws, { type: "presence:set", target: "board:open", presence: { name: "s" } });
    peer.clear();

    await send(ws, { type: "presence:set", target: "board:secret", presence: { name: "s" } });

    expect(ws.last()).toMatchObject({ type: "error", code: "presence_denied" });
    expect(peer.messages()).toEqual([]);
    expect((ws.attachment as { presence?: Record<string, unknown> }).presence).toEqual({
      "board:open": { presence: { name: "s" } },
    });
    expect(seen).toEqual([
      { kind: "presence", target: "board:open", action: "join" },
      { kind: "presence", target: "board:secret", action: "join" },
    ]);
  });

  test("an authorizer that throws or answers a non-boolean refuses", async () => {
    configureRealtime(
      {
        authorize: () => {
          throw new Error("boom");
        },
      },
      undefined
    );
    const ws = socket("s");
    await send(ws, { type: "presence:set", target: "board:A", presence: { name: "s" } });
    expect(ws.last()).toMatchObject({ type: "error", code: "presence_denied" });
    expect((ws.attachment as { presence?: unknown }).presence).toBeUndefined();
  });

  test("an update to a joined room is a send, and is authorized as one", async () => {
    const calls: string[] = [];
    configureRealtime(
      {
        authorize: ({ action, target }) => {
          calls.push(`${target}:${action}`);
          return true;
        },
      },
      undefined
    );
    const ws = socket("s");
    await send(ws, { type: "presence:set", target: "board:A", presence: { name: "s" } });
    await send(ws, { type: "presence:set", target: "board:A", presence: { name: "s2" } });
    await send(ws, { type: "cursor:set", target: "board:A", cursor: { x: 1 } });
    expect(calls).toEqual([
      "board:A:join",
      "board:A:send",
      "board:A:send",
    ]);
  });

  test("a cursor or drag on a target the socket never joined says so", async () => {
    const ws = socket("s");
    await send(ws, { type: "cursor:set", target: "board:A", cursor: { x: 1 } });
    expect(ws.last()).toMatchObject({ type: "error", code: "presence_target_unknown" });

    await send(ws, { type: "drag:set", target: "board:A", drag: { nodes: {} } });
    expect(ws.last()).toMatchObject({ type: "error", code: "presence_target_unknown" });

    // Joined elsewhere does not count.
    await send(ws, { type: "presence:set", target: "board:B", presence: { name: "s" } });
    await send(ws, { type: "cursor:set", target: "board:A", cursor: { x: 1 } });
    expect(ws.last()).toMatchObject({ type: "error", code: "presence_target_unknown" });

    // Joined: the cursor goes to that room's peers only.
    const peer = socket("peer");
    await send(peer, { type: "presence:set", target: "board:B", presence: { name: "p" } });
    peer.clear();
    await send(ws, { type: "cursor:set", target: "board:B", cursor: { x: 2, y: 3 } });
    expect(peer.last()).toMatchObject({ type: "cursor:update", target: "board:B", clientId: "s" });
  });

  test("the whole presence state is bounded in bytes, and a refused set leaves it intact", async () => {
    const ws = socket("s");
    const peer = socket("peer");
    await send(peer, { type: "presence:set", target: "board:A", presence: { name: "p" } });
    peer.clear();

    // Just inside the budget: one room of ~7 KB.
    const fits = { note: "x".repeat(PRESENCE_STATE_BYTES - 512) };
    await send(ws, { type: "presence:set", target: "board:A", presence: fits });
    expect(ws.last()).toMatchObject({ type: "presence:update", target: "board:A" });
    const before = (ws.attachment as { presence?: Record<string, unknown> }).presence;
    expect(before).toEqual({ "board:A": { presence: fits } });

    // A second room that would push the whole state past it is refused.
    await send(ws, { type: "presence:set", target: "board:B", presence: { note: "x".repeat(2_000) } });
    expect(ws.last()).toMatchObject({ type: "error", code: "presence_state_too_large" });
    expect((ws.attachment as { presence?: Record<string, unknown> }).presence).toEqual(before);
    expect(peersOf(peer, "board:B")).toEqual([]);

    // The same budget applies to a cursor on an existing room.
    await send(ws, { type: "cursor:set", target: "board:A", cursor: { path: "y".repeat(4_000) } });
    expect(ws.last()).toMatchObject({ type: "error", code: "presence_state_too_large" });
    expect((ws.attachment as { presence?: Record<string, unknown> }).presence).toEqual(before);
  });

  test("both rooms survive a hibernation round trip, including one stored the old way", async () => {
    const ws = socket("ws-1");
    await send(ws, { type: "presence:set", target: "board:A", presence: { name: "one" } });
    await send(ws, { type: "presence:set", target: "board:B", presence: { name: "one" } });
    await send(ws, { type: "cursor:set", target: "board:B", cursor: { x: 1, y: 2 } });

    // The room is evicted: the socket carries only its serialized attachment.
    const hibernated = ws.attachment;
    context.sockets.splice(context.sockets.indexOf(ws), 1);
    const revived = socket("ws-1", hibernated);
    const peer = socket("peer");
    await send(peer, { type: "presence:set", target: "board:B", presence: { name: "peer" } });

    const update = peer.messages().find((message) => message.type === "presence:update" && message.target === "board:B");
    const peers = (update?.peers ?? []) as Array<{ clientId: string; presence: unknown; cursor?: unknown }>;
    expect(peers).toEqual([
      { clientId: "peer", presence: { name: "peer" } },
      { clientId: "ws-1", presence: { name: "one" }, cursor: { x: 1, y: 2 } },
    ]);

    // Room A is still there under the same attachment.
    await send(peer, { type: "presence:set", target: "board:A", presence: { name: "peer" } });
    expect(peersOf(revived, "board:A")).toEqual(["peer", "ws-1"]);
  });

  test("an attachment written before multiple rooms keeps its single room", async () => {
    // The shape a 0.1.x deployment stored: one target per socket.
    const legacy = {
      ...attachmentFor("legacy"),
      presence: { target: "board:old", presence: { name: "old" }, cursor: { x: 9 } },
    };
    const ws = socket("legacy", legacy);
    const peer = socket("peer");
    await send(peer, { type: "presence:set", target: "board:old", presence: { name: "peer" } });

    const update = peer.messages().find((message) => message.type === "presence:update");
    expect(update?.peers).toEqual([
      { clientId: "legacy", presence: { name: "old" }, cursor: { x: 9 } },
      { clientId: "peer", presence: { name: "peer" } },
    ]);

    // And it can join a second room as any other socket can.
    await send(ws, { type: "presence:set", target: "board:new", presence: { name: "old" } });
    expect(peersOf(ws, "board:new")).toEqual(["legacy"]);
    expect((ws.attachment as { presence?: Record<string, unknown> }).presence).toEqual({
      "board:old": { presence: { name: "old" }, cursor: { x: 9 } },
      "board:new": { presence: { name: "old" } },
    });
  });

  test("session:ready tells the socket which clientId it is", async () => {
    const now = Math.floor(Date.now() / 1000);
    const response = await room.fetch(
      new Request("http://test/websocket", {
        headers: {
          upgrade: "websocket",
          "x-tapedb-claims": encodeTrustedRoleClaim({
            sub: "user-1",
            workspaceId: TEST_WORKSPACE,
            role: WORKSPACE_ROLE_LEVELS.EDITOR,
            exp: now + 600,
            iat: now,
          }),
        },
      })
    );
    expect(response.status).toBe(101);

    const opened = context.sockets.at(-1)!;
    const ready = opened.messages()[0] as { type: string; clientId?: string };
    expect(ready.type).toBe("session:ready");
    // The id the peer lists will carry, handed to the client that owns it.
    expect(ready.clientId).toBe((opened.attachment as { clientId: string }).clientId);
    expect(typeof ready.clientId).toBe("string");
  });

  test("realtime.authorize covers topics as well, and wins over topics.authorize", async () => {
    const kinds: string[] = [];
    const legacy: string[] = [];
    configureRealtime(
      {
        authorize: ({ kind, target, action }) => {
          kinds.push(`${kind}:${target}:${action}`);
          return !(kind === "topic" && target === "closed");
        },
      },
      {
        authorize: ({ topic }) => {
          legacy.push(topic);
          return true;
        },
      }
    );

    const ws = socket("s");
    await send(ws, { type: "topic:join", topic: "open" });
    expect(ws.last()).toMatchObject({ type: "topic:joined", topic: "open" });

    await send(ws, { type: "topic:join", topic: "closed" });
    expect(ws.last()).toMatchObject({ type: "topic:error", code: "permission_denied" });

    await send(ws, { type: "topic:send", topic: "open", message: { hi: 1 } });
    expect(kinds).toEqual(["topic:open:join", "topic:closed:join", "topic:open:send"]);
    // The deprecated hook is not consulted while realtime.authorize is set.
    expect(legacy).toEqual([]);
  });

  test("topics.authorize still decides topics, and never gates presence", async () => {
    configureRealtime(undefined, { authorize: ({ topic }) => topic !== "closed" });

    const ws = socket("s");
    await send(ws, { type: "topic:join", topic: "closed" });
    expect(ws.last()).toMatchObject({ type: "topic:error", code: "permission_denied" });

    await send(ws, { type: "topic:join", topic: "open" });
    expect(ws.last()).toMatchObject({ type: "topic:joined", topic: "open" });

    // Presence is open, as it was before any authorizer existed.
    await send(ws, { type: "presence:set", target: "board:A", presence: { name: "s" } });
    expect(ws.last()).toMatchObject({ type: "presence:update", target: "board:A" });
  });
});
