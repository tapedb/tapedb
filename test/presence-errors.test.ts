/**
 * Presence refusals, end to end: the engine names the room it refused, and the
 * client carries that frame to the app instead of dropping it.
 *
 * Two halves. The first drives the real `WorkspaceRoom` over in-memory SQLite
 * with fake sockets and asserts the wire: every presence refusal says which
 * room it refused. The second drives a real client over a fake socket and
 * asserts what the app sees: an `onError` callback, with the peer list and the
 * subscription untouched.
 */

import { useLegacyFixture } from "./fixtures/registry";
useLegacyFixture();

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type WorkspaceRole } from "../src/claims";
import { configureRealtime } from "../src/engine/topics";
import { PRESENCE_STATE_BYTES } from "../src/engine/ws-types";
import type { Env } from "../src/types";
import { MemoryOutbox } from "../src/client/outbox";
import type { PresenceError } from "../src/client/types";
import { createClient } from "../src/model/client";
import { model, schema, t } from "../src/schema";
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
  return { clientId, sub: `user-${clientId}`, role, exp: now + 600, subscriptions: [] };
}

describe("presence refusals name the room they refused", () => {
  let db: Database;
  let context: FakeContext;
  let room: InstanceType<typeof WorkspaceRoom>;

  beforeEach(async () => {
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

  test("an authorizer refusal answers presence_denied with the room", async () => {
    configureRealtime({ authorize: ({ target }) => target !== "board:secret" }, undefined);
    const ws = socket("s");

    await send(ws, { type: "presence:set", target: "board:secret", presence: { name: "s" } });

    // The whole frame: a client that wants to route it needs the room, and an
    // older client's `toMatchObject` still ignores the extra field.
    expect(ws.last()).toEqual({ type: "error", code: "presence_denied", target: "board:secret" });
    expect((ws.attachment as { presence?: unknown }).presence).toBeUndefined();
  });

  test("the room cap answers presence_rooms_exceeded with the room it refused", async () => {
    configureRealtime({ maxPresenceRooms: 1 }, undefined);
    const ws = socket("s");
    await send(ws, { type: "presence:set", target: "board:A", presence: { name: "s" } });

    await send(ws, { type: "presence:set", target: "board:B", presence: { name: "s" } });

    expect(ws.last()).toEqual({ type: "error", code: "presence_rooms_exceeded", target: "board:B" });
    expect(Object.keys((ws.attachment as { presence?: Record<string, unknown> }).presence ?? {})).toEqual([
      "board:A",
    ]);
  });

  test("the byte budget answers presence_state_too_large with the room, for a set and a cursor", async () => {
    const ws = socket("s");
    const fits = { note: "x".repeat(PRESENCE_STATE_BYTES - 512) };
    await send(ws, { type: "presence:set", target: "board:A", presence: fits });

    await send(ws, { type: "presence:set", target: "board:B", presence: { note: "x".repeat(2_000) } });
    expect(ws.last()).toEqual({ type: "error", code: "presence_state_too_large", target: "board:B" });

    await send(ws, { type: "cursor:set", target: "board:A", cursor: { path: "y".repeat(4_000) } });
    expect(ws.last()).toEqual({ type: "error", code: "presence_state_too_large", target: "board:A" });
  });

  test("a cursor on a room the socket never joined names that room", async () => {
    const ws = socket("s");

    await send(ws, { type: "cursor:set", target: "board:A", cursor: { x: 1 } });

    expect(ws.last()).toEqual({ type: "error", code: "presence_target_unknown", target: "board:A" });
  });

  test("an error that is not about a room carries no target", async () => {
    const ws = socket("s");

    await send(ws, { type: "presence:set", target: "board.A", presence: { name: "s" } });

    // A room name with a dot is invalid, so there is no room to name.
    expect(ws.last()).toEqual({ type: "error", code: "invalid_target" });
  });
});

// ---- The client side -------------------------------------------------------

const WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";

const appSchema = schema({ task: model({ title: t.string() }) });

class ClientSocket {
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
  const sockets: ClientSocket[] = [];
  const db = createClient(
    { schema: appSchema, url: "http://engine.test", workspace: WORKSPACE, getToken: async () => "token" },
    {
      fetch: async () => {
        throw new Error("presence does not go over HTTP");
      },
      outbox: new MemoryOutbox(),
      createWebSocket: () => {
        const socket = new ClientSocket();
        sockets.push(socket);
        return socket;
      },
    }
  );
  return { db, sockets };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function session(sockets: ClientSocket[], clientId = "self-1"): Promise<ClientSocket> {
  for (let attempt = 0; attempt < 50 && sockets.length === 0; attempt += 1) await tick();
  const socket = sockets.at(-1)!;
  socket.onopen?.({});
  socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1, clientId });
  await tick();
  return socket;
}

const peers = [
  { clientId: "self-1", presence: { name: "Me" } },
  { clientId: "other-2", presence: { name: "You" } },
];

describe("presence refusals reach the app", () => {
  test("a denied set lands in onError with its code and room, and changes nothing", async () => {
    const { db, sockets } = client();
    const errors: PresenceError[] = [];
    const seen: unknown[] = [];
    const room = db.$presence("board:secret");
    room.subscribe((list) => seen.push(list), { onError: (error) => errors.push(error) });
    const socket = await session(sockets);

    socket.push({ type: "presence:update", target: "board:secret", peers });
    await tick();
    const before = await room.peers();
    // The subscription already spoke on subscribe and on session:ready; a
    // refusal must not add another.
    const notifications = seen.length;

    socket.push({ type: "error", code: "presence_denied", target: "board:secret" });
    await tick();

    expect(errors).toEqual([{ code: "presence_denied", target: "board:secret" }]);
    // The refusal is not a peer change: the list is what it was...
    expect(await room.peers()).toEqual(before);
    expect(seen).toHaveLength(notifications);
    expect(seen.at(-1)).toEqual(before);
    // ...and the subscription still carries the next update.
    socket.push({
      type: "presence:update",
      target: "board:secret",
      peers: [...peers, { clientId: "third-3", presence: { name: "Them" } }],
    });
    await tick();
    expect((seen.at(-1) as Array<{ clientId: string }>).map((peer) => peer.clientId)).toEqual([
      "self-1",
      "other-2",
      "third-3",
    ]);
  });

  test("each refusal code arrives as it was sent", async () => {
    const { db, sockets } = client();
    const errors: PresenceError[] = [];
    db.$presence("board:A").subscribe(() => {}, { onError: (error) => errors.push(error) });
    const socket = await session(sockets);

    socket.push({ type: "error", code: "presence_rooms_exceeded", target: "board:A" });
    socket.push({ type: "error", code: "presence_state_too_large", target: "board:A" });
    socket.push({ type: "error", code: "presence_target_unknown", target: "board:A" });
    await tick();

    expect(errors).toEqual([
      { code: "presence_rooms_exceeded", target: "board:A" },
      { code: "presence_state_too_large", target: "board:A" },
      { code: "presence_target_unknown", target: "board:A" },
    ]);
  });

  test("two rooms: a refusal for one fires only that room's callback", async () => {
    const { db, sockets } = client();
    const one: PresenceError[] = [];
    const two: PresenceError[] = [];
    db.$presence("board:A").subscribe(() => {}, { onError: (error) => one.push(error) });
    db.$presence("board:B").subscribe(() => {}, { onError: (error) => two.push(error) });
    const socket = await session(sockets);

    socket.push({ type: "error", code: "presence_denied", target: "board:B" });
    await tick();

    expect(one).toEqual([]);
    expect(two).toEqual([{ code: "presence_denied", target: "board:B" }]);
  });

  test("a refusal for a room with no handle reaches every room rather than vanishing", async () => {
    const { db, sockets } = client();
    const one: PresenceError[] = [];
    const two: PresenceError[] = [];
    db.$presence("board:A").subscribe(() => {}, { onError: (error) => one.push(error) });
    db.$presence("board:B").subscribe(() => {}, { onError: (error) => two.push(error) });
    const socket = await session(sockets);

    // Nothing listens to board:C: the frame is still delivered, still naming
    // board:C, so an app can tell that the room it opened has no subscription
    // of its own yet.
    expect(() => socket.push({ type: "error", code: "presence_rooms_exceeded", target: "board:C" })).not.toThrow();
    await tick();

    const expected = [{ code: "presence_rooms_exceeded", target: "board:C" }];
    expect(one).toEqual(expected);
    expect(two).toEqual(expected);
  });

  test("an older Worker's refusal with no target is delivered, with target null", async () => {
    const { db, sockets } = client();
    const errors: PresenceError[] = [];
    db.$presence("board:A").subscribe(() => {}, { onError: (error) => errors.push(error) });
    const socket = await session(sockets);

    socket.push({ type: "error", code: "presence_denied" });
    await tick();

    expect(errors).toEqual([{ code: "presence_denied", target: null }]);
  });

  test("an unknown error code is ignored and the socket keeps working", async () => {
    const { db, sockets } = client();
    const errors: PresenceError[] = [];
    const seen: unknown[] = [];
    db.$presence("board:A").subscribe((list) => seen.push(list), {
      onError: (error) => errors.push(error),
    });
    const socket = await session(sockets);

    expect(() => socket.push({ type: "error", code: "something_new", target: "board:A" })).not.toThrow();
    expect(() => socket.push({ type: "error", code: "topic_nonsense", target: 7 })).not.toThrow();
    await tick();
    expect(errors).toEqual([]);

    socket.push({ type: "presence:update", target: "board:A", peers });
    await tick();
    expect((seen.at(-1) as Array<{ clientId: string }>).map((peer) => peer.clientId)).toEqual([
      "self-1",
      "other-2",
    ]);
  });

  test("a throwing onError does not stop the next one", async () => {
    const { db, sockets } = client();
    const heard: string[] = [];
    db.$presence("board:A").subscribe(() => {}, {
      onError: () => {
        heard.push("first");
        throw new Error("boom");
      },
    });
    db.$presence("board:A").subscribe(() => {}, {
      onError: () => heard.push("second"),
    });
    const socket = await session(sockets);

    socket.push({ type: "error", code: "presence_denied", target: "board:A" });

    expect(heard).toEqual(["first", "second"]);
  });

  test("a topic refusal shaped as an error reaches that topic's handler", async () => {
    const { db, sockets } = client();
    const heard: Array<{ code: string }> = [];
    db.$broadcast("board:1").subscribe(() => {}, { onError: (error) => heard.push(error) });
    const socket = await session(sockets);
    await tick();

    socket.push({ type: "error", code: "topic_permission_denied", target: "board:1", message: "no" });
    await tick();

    expect(heard).toEqual([{ code: "topic_permission_denied", message: "no" }]);
  });
});
