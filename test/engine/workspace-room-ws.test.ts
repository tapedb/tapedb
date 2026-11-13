import { useLegacyFixture } from "../fixtures/registry";
useLegacyFixture();

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../../src/claims";
import { encodeTrustedRoleClaim } from "../../src/verify";
import type { Env } from "../../src/types";
import { FakeR2Bucket } from "../fixtures/test-support";

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

class FakeWebSocket {
  readonly sent: string[] = [];
  attachment: unknown = null;
  closeInfo: { code: number; reason: string } | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  serializeAttachment(value: unknown): void {
    this.attachment = clone(value);
  }

  deserializeAttachment(): unknown {
    return clone(this.attachment);
  }

  close(code = 1000, reason = ""): void {
    this.closeInfo = { code, reason };
  }

  messages(): Array<Record<string, unknown>> {
    return this.sent.map(
      (message) => JSON.parse(message) as Record<string, unknown>
    );
  }

  clear(): void {
    this.sent.length = 0;
  }
}

class FakeWebSocketPair {
  0: FakeWebSocket;
  1: FakeWebSocket;

  constructor() {
    this[0] = new FakeWebSocket();
    this[1] = new FakeWebSocket();
  }
}

function clone<T>(value: T): T {
  return value === undefined || value === null
    ? value
    : (JSON.parse(JSON.stringify(value)) as T);
}

(globalThis as { WebSocketPair?: unknown }).WebSocketPair = FakeWebSocketPair;

const { WorkspaceRoom } = await import("../../src/engine/workspace-room");
const { configureTopics } = await import("../../src/engine/topics");

const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";
const MIGRATIONS_DIR = resolve(
  import.meta.dir,
  "../fixtures/migrations/"
);

const SCHEMA = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"))
  .join("\n");

interface SqlCursor<T> {
  toArray(): T[];
  one(): T;
  rowsWritten: number;
}

function createSqlStorage(db: Database) {
  return {
    exec<T extends Record<string, unknown>>(
      query: string,
      ...params: unknown[]
    ): SqlCursor<T> {
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
      if (statements.length > 1) {
        db.exec(query);
      } else {
        changes = db.prepare(query).run(...(params as never[])).changes;
      }

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

class FakeContext {
  ready: Promise<unknown> = Promise.resolve();
  alarm: number | null = null;
  readonly sockets: FakeWebSocket[] = [];
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
      getAlarm: async () => this.alarm,
      setAlarm: async (at: number) => {
        this.alarm = at;
      },
    };
  }

  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    const promise = fn();
    this.ready = promise;
    return promise;
  }

  acceptWebSocket(ws: FakeWebSocket): void {
    this.sockets.push(ws);
  }

  getWebSockets(): FakeWebSocket[] {
    return this.sockets;
  }
}

function claim(role: number): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "user-1",
    workspaceId: WORKSPACE,
    role: role as RoleClaim["role"],
    exp: now + 60,
    iat: now,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

describe("WorkspaceRoom live queries", () => {
  let db: Database;
  let context: FakeContext;
  let room: InstanceType<typeof WorkspaceRoom>;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.exec(SCHEMA);
    db.prepare(
      `INSERT INTO "kanban_boards"
        (id, name, created_at, updated_at, updated_seq)
       VALUES (?, ?, ?, ?, ?)`
    ).run("board1", "Board", 1, 1, 0);
    db.prepare(
      `INSERT INTO "kanban_columns"
        (id, board_id, name, "order", created_at, updated_at, updated_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("col1", "board1", "Todo", 0, 1, 1, 0);
    db.prepare(
      `INSERT INTO "kanban_tasks"
        (id, column_id, title, "order", created_at, updated_at, updated_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("task1", "col1", "First", 0, 1, 1, 0);

    context = new FakeContext(db, WORKSPACE);
    room = new WorkspaceRoom(
      context as unknown as DurableObjectState,
      { DATA: new FakeR2Bucket() } as unknown as Env
    );
    await context.ready;
  });

  async function connect(
    role: number | null = WORKSPACE_ROLE_LEVELS.MEMBER
  ): Promise<FakeWebSocket> {
    const before = context.sockets.length;
    const headers: Record<string, string> = { upgrade: "websocket" };
    if (role !== null) {
      headers["x-tapedb-claims"] = encodeTrustedRoleClaim(claim(role));
    }

    const response = await room.fetch(
      new Request("http://test/websocket", { headers })
    );
    expect(response.status).toBe(101);
    const socket = context.sockets[before];
    expect(socket).toBeDefined();
    return socket;
  }

  async function send(
    ws: FakeWebSocket,
    message: Record<string, unknown>
  ): Promise<void> {
    await room.webSocketMessage(
      ws as unknown as WebSocket,
      JSON.stringify(message)
    );
  }

  async function transact(
    ops: unknown[],
    txId: string,
    role = WORKSPACE_ROLE_LEVELS.EDITOR
  ): Promise<number> {
    const response = await room.fetch(
      new Request("http://test/transact", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tapedb-claims": encodeTrustedRoleClaim(claim(role)),
        },
        body: JSON.stringify({ txId, ops }),
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { seq: number } };
    return body.result.seq;
  }

  function queryMessages(ws: FakeWebSocket): Array<Record<string, unknown>> {
    return ws
      .messages()
      .filter((message) => String(message.type).startsWith("query:"));
  }

  test("accepts a socket, sends session:ready and pushes initial data", async () => {
    const socket = await connect();

    const ready = socket.messages()[0];
    expect(ready).toMatchObject({
      type: "session:ready",
      workspaceId: WORKSPACE,
      connections: 1,
    });

    await send(socket, {
      type: "query:subscribe",
      id: "q1",
      query: { kanbanBoards: {} },
    });

    const data = socket.messages()[1];
    expect(data?.type).toBe("query:data");
    expect(data?.id).toBe("q1");
    expect(data?.seq).toBe(1);
    expect(data?.data).toEqual({
      kanbanBoards: [expect.objectContaining({ id: "board1", name: "Board" })],
    });

    expect(socket.attachment).toMatchObject({
      subscriptions: [{ id: "q1", seq: 1 }],
    });
  });

  test("pushes a diff for a touched namespace to the subscribed socket only", async () => {
    const subscribed = await connect();
    const other = await connect();

    await send(subscribed, {
      type: "query:subscribe",
      id: "q1",
      query: { kanbanBoards: {} },
    });
    subscribed.clear();
    other.clear();

    expect(
      await transact(
        [
          {
            op: "update",
            namespace: "kanbanBoards",
            id: "board1",
            values: { name: "Renamed" },
          },
        ],
        "t1"
      )
    ).toBe(1);

    await delay(100);

    const messages = queryMessages(subscribed);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "query:diff",
      id: "q1",
      seq: 2,
      namespace: "kanbanBoards",
      added: [],
      removed: [],
    });
    expect(messages[0]?.updated).toEqual([
      expect.objectContaining({ id: "board1", name: "Renamed" }),
    ]);

    expect(queryMessages(other)).toHaveLength(0);
  });

  test("pushes to a subscriber whose rows a cascade rewrote", async () => {
    await transact(
      [
        { op: "update", namespace: "folders", id: "f1", values: { name: "F" } },
        {
          op: "update",
          namespace: "documents",
          id: "d1",
          values: { title: "Doc", content: "Body", folderId: "f1" },
        },
      ],
      "seed-cascade"
    );
    // Let the seed transaction's debounced invalidation flush before the
    // subscription exists, so the only push under test is the delete's.
    await delay(100);

    const socket = await connect();
    await send(socket, {
      type: "query:subscribe",
      id: "q1",
      query: { documents: {} },
    });
    socket.clear();

    // Deleting the folder SET NULLs documents.folder_id. No op names
    // `documents`, so only dependent-namespace resolution can invalidate it.
    await transact(
      [{ op: "delete", namespace: "folders", id: "f1" }],
      "t-cascade",
      WORKSPACE_ROLE_LEVELS.MODERATOR
    );
    await delay(100);

    const messages = queryMessages(socket);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toMatchObject({
      type: "query:diff",
      id: "q1",
      namespace: "documents",
    });
    expect(messages[0]?.updated).toEqual([
      expect.objectContaining({ id: "d1", folderId: null }),
    ]);
  });

  test("pushes nothing for an unrelated transaction", async () => {
    const socket = await connect();
    await send(socket, {
      type: "query:subscribe",
      id: "q1",
      query: { kanbanBoards: {} },
    });
    socket.clear();

    await transact(
      [
        {
          op: "merge",
          namespace: "folders",
          id: "f1",
          values: { name: "Inbox" },
        },
      ],
      "t1"
    );

    await delay(100);
    expect(queryMessages(socket)).toHaveLength(0);
  });

  test("unsubscribe removes the subscription and stops further pushes", async () => {
    const socket = await connect();
    await send(socket, {
      type: "query:subscribe",
      id: "q1",
      query: { kanbanBoards: {} },
    });

    await send(socket, { type: "query:unsubscribe", id: "q1" });
    expect(socket.messages().at(-1)).toEqual({
      type: "query:unsubscribed",
      id: "q1",
    });

    socket.clear();

    await transact(
      [
        {
          op: "update",
          namespace: "kanbanBoards",
          id: "board1",
          values: { name: "Renamed" },
        },
      ],
      "t1"
    );

    await delay(100);
    expect(queryMessages(socket)).toHaveLength(0);
  });

  test("re-runs a nested subscription when a traversed namespace changes", async () => {
    const socket = await connect();
    await send(socket, {
      type: "query:subscribe",
      id: "nested",
      query: { kanbanBoards: { $: {}, columns: { tasks: {} } } },
    });

    expect(socket.messages()[1]?.type).toBe("query:data");
    socket.clear();

    await transact(
      [
        {
          op: "update",
          namespace: "kanbanTasks",
          id: "task1",
          values: { title: "Changed" },
        },
      ],
      "t1"
    );

    await delay(100);

    const diff = queryMessages(socket)[0];
    expect(diff?.type).toBe("query:diff");
    expect(diff?.namespace).toBe("kanbanBoards");

    const updated = diff?.updated as Array<Record<string, unknown>>;
    const columns = updated[0]?.columns as Array<Record<string, unknown>>;
    const tasks = columns[0]?.tasks as Array<Record<string, unknown>>;
    expect(tasks[0]).toMatchObject({ id: "task1", title: "Changed" });
  });

  test("sends page metadata when a row lands past the window", async () => {
    const socket = await connect();
    await send(socket, {
      type: "query:subscribe",
      id: "paged",
      query: { kanbanTasks: { $: { order: { title: "asc" }, limit: 1 } } },
    });
    expect(socket.messages()[1]).toMatchObject({
      type: "query:data",
      pageInfo: { kanbanTasks: { returned: 1, hasMore: false } },
    });
    socket.clear();

    // "Zed" sorts after "First": the one-row window is unchanged, but there is
    // now a next page. Before, this produced no message at all.
    await transact(
      [
        {
          op: "update",
          namespace: "kanbanTasks",
          id: "task2",
          values: { columnId: "col1", title: "Zed", order: 1 },
        },
      ],
      "t1"
    );
    await delay(100);

    const messages = queryMessages(socket);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "query:diff",
      added: [],
      updated: [],
      removed: [],
      pageInfo: { kanbanTasks: { returned: 1, hasMore: true } },
    });
    expect(
      (messages[0]?.pageInfo as Record<string, { nextCursor?: string }>).kanbanTasks.nextCursor
    ).toBeString();
  });

  test("a live count updates when a matching row is added", async () => {
    const socket = await connect();
    await send(socket, {
      type: "query:subscribe",
      id: "count",
      query: { kanbanTasks: { $: { count: true, limit: 0 } } },
    });
    expect(socket.messages()[1]).toMatchObject({
      pageInfo: { kanbanTasks: { count: 1, returned: 0 } },
    });
    socket.clear();

    await transact(
      [{ op: "insert", namespace: "kanbanTasks", id: "task2", values: { columnId: "col1", title: "Two", order: 1 } }],
      "t1"
    );
    await delay(100);

    expect(queryMessages(socket)).toEqual([
      expect.objectContaining({ type: "query:diff", pageInfo: { kanbanTasks: expect.objectContaining({ count: 2 }) } }),
    ]);
  });

  test("a live select pushes only the selected fields", async () => {
    const socket = await connect();
    await send(socket, {
      type: "query:subscribe",
      id: "picked",
      query: { kanbanTasks: { $: { select: ["title"] } } },
    });
    expect(socket.messages()[1]?.data).toEqual({
      kanbanTasks: [{ id: "task1", title: "First" }],
    });
    socket.clear();

    await transact(
      [{ op: "update", namespace: "kanbanTasks", id: "task1", values: { title: "Renamed", progress: 3 } }],
      "t1"
    );
    await delay(100);

    const [diff] = queryMessages(socket);
    expect(diff).toMatchObject({ type: "query:diff", namespace: "kanbanTasks" });
    expect(diff?.updated).toEqual([{ id: "task1", title: "Renamed" }]);
    socket.clear();

    // A change to a field the select leaves out changes nothing it sends.
    await transact([{ op: "update", namespace: "kanbanTasks", id: "task1", values: { progress: 7 } }], "t2");
    await delay(100);
    expect(queryMessages(socket)).toEqual([]);
  });

  test("a live aggregate updates when a matching row is written", async () => {
    const socket = await connect();
    await send(socket, {
      type: "query:subscribe",
      id: "agg",
      query: { kanbanTasks: { $: { aggregate: { groupBy: ["columnId"], count: true, sum: ["progress"] } } } },
    });
    expect(socket.messages()[1]).toMatchObject({
      pageInfo: { kanbanTasks: { aggregate: [{ key: { columnId: "col1" }, count: 1, sum: { progress: null } }] } },
    });
    socket.clear();

    await transact(
      [
        { op: "insert", namespace: "kanbanTasks", id: "task2", values: { columnId: "col1", title: "Two", order: 1, progress: 4 } },
        { op: "insert", namespace: "kanbanTasks", id: "task3", values: { title: "Loose", order: 2, progress: 2 } },
      ],
      "t1"
    );
    await delay(100);

    expect(queryMessages(socket)).toEqual([
      expect.objectContaining({
        type: "query:diff",
        pageInfo: {
          kanbanTasks: expect.objectContaining({
            aggregate: [
              { key: { columnId: null }, count: 1, sum: { progress: 2 } },
              { key: { columnId: "col1" }, count: 2, sum: { progress: 4 } },
            ],
          }),
        },
      }),
    ]);
  });

  test("re-runs a subscription whose relation filter reads a changed namespace", async () => {
    const socket = await connect();
    await send(socket, {
      type: "query:subscribe",
      id: "filtered",
      query: { kanbanTasks: { $: { where: { $link: [{ label: "column", mode: "parent", where: { name: "Todo" } }] } } } },
    });
    expect((socket.messages()[1]?.data as { kanbanTasks: unknown[] }).kanbanTasks).toHaveLength(1);
    socket.clear();

    // No task changed; the column the filter reads did.
    await transact([{ op: "update", namespace: "kanbanColumns", id: "col1", values: { name: "Doing" } }], "t1");
    await delay(100);

    expect(queryMessages(socket)).toEqual([
      expect.objectContaining({ type: "query:diff", id: "filtered", removed: ["task1"] }),
    ]);
  });

  test("a diff carries the order when rows moved or arrived out of place", async () => {
    await transact([{ op: "insert", namespace: "kanbanTasks", id: "task2", values: { columnId: "col1", title: "Second", order: 2 } }], "t0");
    const socket = await connect();
    await send(socket, {
      type: "query:subscribe",
      id: "ordered",
      query: { kanbanTasks: { $: { order: { order: "asc" }, select: ["title"] } } },
    });
    socket.clear();

    // Sorts between the two existing rows.
    await transact([{ op: "insert", namespace: "kanbanTasks", id: "task3", values: { columnId: "col1", title: "Between", order: 1 } }], "t1");
    await delay(100);
    expect(queryMessages(socket)).toEqual([
      expect.objectContaining({ type: "query:diff", added: [expect.objectContaining({ id: "task3" })], order: ["task1", "task3", "task2"] }),
    ]);
    socket.clear();

    // An edit that keeps the order sends none.
    await transact([{ op: "update", namespace: "kanbanTasks", id: "task3", values: { title: "Renamed" } }], "t2");
    await delay(100);
    const [unchanged] = queryMessages(socket);
    expect(unchanged).toMatchObject({ type: "query:diff", updated: [expect.objectContaining({ id: "task3" })] });
    expect(unchanged?.order).toBeUndefined();
  });

  describe("broadcast topics", () => {
    const topicMessages = (ws: FakeWebSocket) =>
      ws.messages().filter((message) => String(message.type).startsWith("topic:"));

    test("a message reaches every other joined socket, not the sender or the unjoined", async () => {
      const sender = await connect();
      const joined = await connect();
      const elsewhere = await connect();
      await send(sender, { type: "topic:join", topic: "board:1" });
      await send(joined, { type: "topic:join", topic: "board:1" });
      await send(elsewhere, { type: "topic:join", topic: "board:2" });
      // Joined topics are on the attachment, so they survive hibernation.
      expect(joined.attachment).toMatchObject({ topics: ["board:1"] });

      await send(sender, { type: "topic:send", topic: "board:1", message: { ping: 1 } });
      expect(topicMessages(joined)).toEqual([
        {
          type: "topic:message",
          topic: "board:1",
          message: { ping: 1 },
          from: { clientId: (sender.attachment as { clientId: string }).clientId, sub: "user-1" },
        },
      ]);
      expect(topicMessages(sender)).toEqual([]);
      expect(topicMessages(elsewhere)).toEqual([]);

      // Sending does not need a join; leaving stops delivery.
      await send(elsewhere, { type: "topic:send", topic: "board:1", message: "hi" });
      expect(topicMessages(sender).map((message) => message.message)).toEqual(["hi"]);
      await send(joined, { type: "topic:leave", topic: "board:1" });
      joined.clear();
      await send(sender, { type: "topic:send", topic: "board:1", message: "gone" });
      expect(topicMessages(joined)).toEqual([]);
    });

    test("an authorize hook decides who may join and send", async () => {
      configureTopics({
        authorize: ({ auth, topic, action }) =>
          !topic.startsWith("admin:") || (action === "join" ? auth.role >= WORKSPACE_ROLE_LEVELS.ADMIN : false),
      });
      try {
        const member = await connect(WORKSPACE_ROLE_LEVELS.MEMBER);
        const admin = await connect(WORKSPACE_ROLE_LEVELS.ADMIN);
        await send(member, { type: "topic:join", topic: "admin:alerts" });
        expect(topicMessages(member)).toEqual([expect.objectContaining({ type: "topic:error", code: "permission_denied", topic: "admin:alerts" })]);
        expect(member.attachment).not.toHaveProperty("topics");

        await send(admin, { type: "topic:join", topic: "admin:alerts" });
        await send(member, { type: "topic:send", topic: "admin:alerts", message: "spoof" });
        expect(topicMessages(admin)).toEqual([]);
      } finally {
        configureTopics(undefined);
      }
    });

    test("refuses a malformed topic", async () => {
      const socket = await connect();
      await send(socket, { type: "topic:join", topic: "has spaces" });
      await send(socket, { type: "topic:send", topic: "ok" });
      expect(topicMessages(socket).map((message) => message.code)).toEqual(["invalid_topic", "invalid_topic_message"]);
    });
  });

  test("GET /export streams NDJSON for the verified claim", async () => {
    const response = await room.fetch(
      new Request("http://test/export", {
        headers: { "x-tapedb-claims": encodeTrustedRoleClaim(claim(WORKSPACE_ROLE_LEVELS.MEMBER)) },
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ type: "header", workspaceId: WORKSPACE });
    expect(lines).toContainEqual(expect.objectContaining({ type: "row", model: "kanbanTasks", data: expect.objectContaining({ id: "task1" }) }));
    expect(lines.at(-1)).toMatchObject({ type: "end", consistent: true });

    const unverified = await room.fetch(new Request("http://test/export"));
    expect(unverified.status).toBe(403);
  });

  test("leaves page metadata off a diff when it did not change", async () => {
    const socket = await connect();
    await send(socket, {
      type: "query:subscribe",
      id: "paged",
      query: { kanbanTasks: { $: { order: { title: "asc" }, limit: 5 } } },
    });
    socket.clear();

    await transact(
      [{ op: "update", namespace: "kanbanTasks", id: "task1", values: { title: "Renamed" } }],
      "t1"
    );
    await delay(100);

    const [diff] = queryMessages(socket);
    expect(diff?.type).toBe("query:diff");
    expect(diff).not.toHaveProperty("pageInfo");
  });

  test("rejects subscriptions the role cannot view", async () => {
    const guest = await connect(WORKSPACE_ROLE_LEVELS.GUEST);

    await send(guest, {
      type: "query:subscribe",
      id: "q1",
      query: { kanbanBoards: {} },
    });

    const error = guest.messages().at(-1);
    expect(error).toMatchObject({
      type: "query:error",
      id: "q1",
      code: "permission_denied",
    });
    expect(queryMessages(guest).some((m) => m.type === "query:data")).toBe(
      false
    );

    guest.clear();

    await transact(
      [
        {
          op: "update",
          namespace: "kanbanBoards",
          id: "board1",
          values: { name: "Renamed" },
        },
      ],
      "t1"
    );

    await delay(100);
    expect(queryMessages(guest)).toHaveLength(0);
  });

  test("closes a socket that has no verified claim", async () => {
    const socket = await connect(null);

    expect(socket.messages()[0]).toMatchObject({
      type: "session:error",
      code: "permission_denied",
    });
    expect(socket.closeInfo?.code).toBe(1008);
  });

  test("answers ping and rejects unsupported message types", async () => {
    const socket = await connect();

    await send(socket, { type: "ping", at: "client-clock" });
    expect(socket.messages().at(-1)).toMatchObject({
      type: "pong",
      at: "client-clock",
    });
    expect(typeof socket.messages().at(-1)?.now).toBe("number");

    await send(socket, { type: "nope" });
    expect(socket.messages().at(-1)).toEqual({
      type: "error",
      code: "unsupported_message_type",
    });
  });

  test("returns 426 without an upgrade header", async () => {
    const response = await room.fetch(
      new Request("http://test/websocket", {
        headers: {
          "x-tapedb-claims": encodeTrustedRoleClaim(
            claim(WORKSPACE_ROLE_LEVELS.MEMBER)
          ),
        },
      })
    );

    expect(response.status).toBe(426);
  });
});
