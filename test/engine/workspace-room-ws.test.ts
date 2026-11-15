import { configureAudit } from "../../src/engine/audit";
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
import { framesFor, TopicParts } from "../../src/client/socket";

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
    // As the runtime does: an attachment is at most 16 KiB serialized.
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 16_384) {
      throw new Error("Attachment exceeds the 16 KiB limit.");
    }
    this.attachment = clone(value);
  }

  deserializeAttachment(): unknown {
    return clone(this.attachment);
  }

  close(code = 1000, reason = ""): void {
    // As the runtime does (measured in workerd): reserved codes throw.
    if ([1004, 1005, 1006, 1015].includes(code) || code < 1000 || code > 4999) {
      throw new DOMException(`Invalid close code ${code}.`, "InvalidAccessError");
    }
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

/**
 * Every statement the room ran, for tests that count work. On globalThis:
 * the module's top-level awaits let the room run before a const here exists.
 */
const statementLog = (): string[] =>
  ((globalThis as { __roomStatements?: string[] }).__roomStatements ??= []);

function createSqlStorage(db: Database) {
  return {
    exec<T extends Record<string, unknown>>(
      query: string,
      ...params: unknown[]
    ): SqlCursor<T> {
      statementLog().push(query);
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

function claim(role: number, sub = "user-1"): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub,
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
    role: number | null = WORKSPACE_ROLE_LEVELS.MEMBER,
    sub = "user-1"
  ): Promise<FakeWebSocket> {
    const before = context.sockets.length;
    const headers: Record<string, string> = { upgrade: "websocket" };
    if (role !== null) {
      headers["x-tapedb-claims"] = encodeTrustedRoleClaim(claim(role, sub));
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
    // Join acknowledgements (topic:joined) are covered by the replay tests.
    const topicMessages = (ws: FakeWebSocket) =>
      ws.messages().filter((message) => String(message.type).startsWith("topic:") && message.type !== "topic:joined");

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
          seq: 1,
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

  test("GET /history: who changed a row, for admins and owners, with audit on", async () => {
    const history = (role: number, query = "model=kanbanTasks&id=task2") =>
      room.fetch(new Request(`http://test/history?${query}`, {
        headers: { "x-tapedb-claims": encodeTrustedRoleClaim(claim(role, "user-1")) },
      }));
    await transact([{ op: "update", namespace: "kanbanTasks", id: "task2", values: { columnId: "col1", title: "Two", order: 1 } }], "h1");
    expect((await history(WORKSPACE_ROLE_LEVELS.ADMIN)).status).toBe(409);

    configureAudit(true);
    try {
      // The capture is installed at boot.
      context = new FakeContext(db, WORKSPACE);
      room = new WorkspaceRoom(context as unknown as DurableObjectState, { DATA: new FakeR2Bucket() } as unknown as Env);
      await context.ready;
      await transact([{ op: "merge", namespace: "kanbanTasks", id: "task2", values: { title: "Deux" } }], "h2");
      await transact([{ op: "delete", namespace: "kanbanTasks", id: "task2" }], "h3", WORKSPACE_ROLE_LEVELS.ADMIN);

      const response = await history(WORKSPACE_ROLE_LEVELS.ADMIN);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: Array<Record<string, unknown>> };
      // The write from before audit was on is not in it.
      expect(body.data.map(({ sub, role, action }) => ({ sub, role, action }))).toEqual([
        { sub: "user-1", role: WORKSPACE_ROLE_LEVELS.EDITOR, action: "update" },
        { sub: "user-1", role: WORKSPACE_ROLE_LEVELS.ADMIN, action: "delete" },
      ]);
      expect((await history(WORKSPACE_ROLE_LEVELS.EDITOR)).status).toBe(403);
      expect((await history(WORKSPACE_ROLE_LEVELS.ADMIN, "model=nope&id=x")).status).toBe(400);
      expect((await room.fetch(new Request("http://test/history?model=kanbanTasks&id=task2"))).status).toBe(403);
    } finally {
      configureAudit(false);
    }
  });

  test("answers every client close with a close frame it may send", async () => {
    // A browser or Node client closing without a status arrives as 1005,
    // and an abnormal drop as 1006: neither may be sent back.
    for (const code of [1005, 1006, 1001, 1000, 4000]) {
      const socket = await connect();
      room.webSocketClose(socket as unknown as WebSocket, code, "bye");
      expect(socket.closeInfo?.code).toBe(code === 1005 || code === 1006 ? 1000 : code);
    }
  });

  test("runs identical subscriptions once per flush, and separately per claim", async () => {
    const query = { kanbanBoards: { $: { order: { name: "asc" } } } };
    const first = await connect(WORKSPACE_ROLE_LEVELS.MEMBER);
    const second = await connect(WORKSPACE_ROLE_LEVELS.MEMBER);
    const admin = await connect(WORKSPACE_ROLE_LEVELS.ADMIN);
    for (const socket of [first, second, admin]) {
      await send(socket, { type: "query:subscribe", id: "boards", query });
      socket.clear();
    }

    await transact([{ op: "update", namespace: "kanbanBoards", id: "board1", values: { name: "Renamed" } }], "t1");
    statementLog().length = 0;
    await delay(100);

    const reads = statementLog().filter((statement) => /SELECT .* FROM "kanban_boards"/s.test(statement));
    // The two members share one run; the admin's claim gets its own.
    expect(reads).toHaveLength(2);
    for (const socket of [first, second, admin]) {
      expect(queryMessages(socket)).toEqual([
        expect.objectContaining({ type: "query:diff", updated: [expect.objectContaining({ name: "Renamed" })] }),
      ]);
    }
  });

  test("shares a run across users unless a row rule reads who they are", async () => {
    const query = { kanbanBoards: { $: { order: { name: "asc" } } } };
    const run = async (users: string[]) => {
      const sockets = [];
      for (const sub of users) {
        const socket = await connect(WORKSPACE_ROLE_LEVELS.MEMBER, sub);
        await send(socket, { type: "query:subscribe", id: "boards", query });
        socket.clear();
        sockets.push(socket);
      }
      await transact([{ op: "update", namespace: "kanbanBoards", id: "board1", values: { name: `n${Math.random()}` } }], `t${Math.random()}`);
      statementLog().length = 0;
      await delay(100);
      const reads = statementLog().filter((statement) => /SELECT .* FROM "kanban_boards"/s.test(statement)).length;
      const pushed = sockets.map((socket) => queryMessages(socket));
      for (const socket of sockets) socket.close();
      context.sockets.length = 0;
      return { reads, pushed };
    };

    // Role rules only: three users, one run, everyone told.
    const open = await run(["ann", "bob", "cy"]);
    expect(open.reads).toBe(1);
    for (const messages of open.pushed) expect(messages).toEqual([expect.objectContaining({ type: "query:diff" })]);

    // A where rule sees the subject: only ann may read the board. One run
    // each, and nobody else is sent ann's row.
    const { configurePermissions } = await import("../../src/engine/tx-permissions");
    configurePermissions({ overrides: { kanbanBoards: { view: { where: ({ sub }) => ({ id: sub === "ann" ? "board1" : "none" }) } } } });
    try {
      const ruled = await run(["ann", "bob", "cy"]);
      expect(ruled.reads).toBe(3);
      expect(ruled.pushed[0]).toEqual([expect.objectContaining({ type: "query:diff", updated: [expect.objectContaining({ id: "board1" })] })]);
      expect(ruled.pushed[1]).toEqual([]);
      expect(ruled.pushed[2]).toEqual([]);
    } finally {
      useLegacyFixture();
    }
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

  test("selects the tapedb subprotocol when the client offers it, so browsers accept the handshake", async () => {
    const trusted = encodeTrustedRoleClaim(claim(WORKSPACE_ROLE_LEVELS.MEMBER));
    const offered = await room.fetch(
      new Request("http://test/websocket", {
        headers: { upgrade: "websocket", "x-tapedb-claims": trusted, "sec-websocket-protocol": "tapedb, tapedb.claim.a.b.c" },
      })
    );
    expect(offered.status).toBe(101);
    expect(offered.headers.get("sec-websocket-protocol")).toBe("tapedb");

    const none = await room.fetch(new Request("http://test/websocket", { headers: { upgrade: "websocket", "x-tapedb-claims": trusted } }));
    expect(none.status).toBe(101);
    expect(none.headers.get("sec-websocket-protocol")).toBeNull();
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

  describe("broadcast replay", () => {
    const frames = (ws: FakeWebSocket) => ws.messages().filter((message) => String(message.type).startsWith("topic:"));

    test("a rejoin with the last sequence seen gets what it missed, in order, parts included", async () => {
      const sender = await connect(WORKSPACE_ROLE_LEVELS.MEMBER, "sender");
      const listener = await connect(WORKSPACE_ROLE_LEVELS.MEMBER, "listener");
      await send(listener, { type: "topic:join", topic: "board:1" });
      expect(frames(listener)).toEqual([{ type: "topic:joined", topic: "board:1", seq: 0 }]);

      await send(sender, { type: "topic:send", topic: "board:1", message: "one", origin: "app-a" });
      expect(frames(listener).at(-1)).toMatchObject({ type: "topic:message", seq: 1, message: "one", origin: "app-a" });

      // The listener drops off; three messages go out, one of them in parts.
      room.webSocketClose(listener as unknown as WebSocket, 1006, "gone");
      await send(sender, { type: "topic:send", topic: "board:1", message: "two" });
      const big = "x".repeat(700_000);
      for (const frame of framesFor({ type: "topic:send", topic: "board:1", message: big } as never)) {
        await room.webSocketMessage(sender as unknown as WebSocket, frame);
      }
      await send(sender, { type: "topic:send", topic: "board:1", message: "four" });

      const back = await connect(WORKSPACE_ROLE_LEVELS.MEMBER, "listener");
      await send(back, { type: "topic:join", topic: "board:1", since: 1 });
      const replayed = frames(back);
      expect(replayed.at(-1)).toEqual({ type: "topic:joined", topic: "board:1", seq: replayed.length });
      const parts = new TopicParts();
      const joined = replayed.slice(0, -1).map((frame) => parts.take(frame as never)).filter((value) => value !== null);
      expect(joined.map((message) => (message as { message: unknown }).message)).toEqual(["two", big, "four"]);
      // Sequence numbers only grow.
      const seqs = replayed.slice(0, -1).map((frame) => frame.seq as number);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(seqs[0]).toBe(2);
    });

    test("keeps a bounded window, by count and by age, and nothing when replay is off", async () => {
      const { REPLAY_MESSAGES } = await import("../../src/engine/topics");
      const sender = await connect();
      for (let n = 0; n < REPLAY_MESSAGES + 25; n += 1) {
        await send(sender, { type: "topic:send", topic: "busy", message: n });
      }
      const kept = db.query(`SELECT COUNT(*) AS n, MIN(seq) AS low FROM "_topic_buffer" WHERE topic = 'busy'`).get() as { n: number; low: number };
      expect(kept).toEqual({ n: REPLAY_MESSAGES, low: 26 });

      // Older than the window: not replayed.
      db.exec(`UPDATE "_topic_buffer" SET at = at - 120000 WHERE topic = 'busy'`);
      const late = await connect();
      await send(late, { type: "topic:join", topic: "busy", since: 0 });
      expect(frames(late)).toEqual([{ type: "topic:joined", topic: "busy", seq: REPLAY_MESSAGES + 25 }]);

      configureTopics({ replaySeconds: 0 });
      try {
        await send(sender, { type: "topic:send", topic: "quiet", message: "x" });
        expect(db.query(`SELECT COUNT(*) AS n FROM "_topic_buffer" WHERE topic = 'quiet'`).get()).toEqual({ n: 0 });
      } finally {
        configureTopics(undefined);
      }
    });

    test("replays nothing to a socket the authorize hook refuses", async () => {
      const sender = await connect(WORKSPACE_ROLE_LEVELS.ADMIN, "admin");
      await send(sender, { type: "topic:send", topic: "admin:alerts", message: "secret" });
      configureTopics({ authorize: ({ auth, topic }) => !topic.startsWith("admin:") || auth.role >= WORKSPACE_ROLE_LEVELS.ADMIN });
      try {
        const member = await connect(WORKSPACE_ROLE_LEVELS.MEMBER, "member");
        await send(member, { type: "topic:join", topic: "admin:alerts", since: 0 });
        expect(frames(member)).toEqual([expect.objectContaining({ type: "topic:error", code: "permission_denied" })]);
      } finally {
        configureTopics(undefined);
      }
    });
  });

  describe("socket state and messages of any size", () => {
    async function sendFrames(ws: FakeWebSocket, message: Record<string, unknown>, size?: number): Promise<number> {
      const frames = framesFor(message as never, size);
      for (const frame of frames) await room.webSocketMessage(ws as unknown as WebSocket, frame);
      return frames.length;
    }

    test("keeps any number of live queries on one socket, past the attachment's 16 KiB", async () => {
      // Each query names 100 ids: about 2.5 KB. Stored in the attachment,
      // the seventh would have thrown.
      const socket = await connect();
      socket.clear();
      const ids = (n: number) => Array.from({ length: 100 }, (_, index) => `board-${n}-${index}`).concat("board1");
      for (let n = 0; n < 60; n += 1) {
        await send(socket, { type: "query:subscribe", id: `q${n}`, query: { kanbanBoards: { $: { where: { id: { $in: ids(n) } } } } } });
      }
      const initial = queryMessages(socket);
      expect(initial.filter((message) => message.type === "query:data")).toHaveLength(60);
      expect(initial.filter((message) => message.type === "query:error")).toEqual([]);
      expect(Number(db.query(`SELECT COUNT(*) AS n FROM "_socket_state"`).get()!.n as number)).toBeGreaterThan(0);

      socket.clear();
      await transact([{ op: "update", namespace: "kanbanBoards", id: "board1", values: { name: "Renamed" } }], "t-many");
      await delay(100);
      const updates = queryMessages(socket);
      expect(new Set(updates.map((message) => message.id)).size).toBe(60);
      expect(updates.every((message) => message.type === "query:diff" && message.seq === 2)).toBe(true);

      // Unsubscribing brings it back under the limit, inline again.
      for (let n = 0; n < 60; n += 1) await send(socket, { type: "query:unsubscribe", id: `q${n}` });
      expect(Number(db.query(`SELECT COUNT(*) AS n FROM "_socket_state"`).get()!.n as number)).toBe(0);
    });

    test("runs a message larger than a frame, sent in parts, and refuses parts out of order", async () => {
      const socket = await connect();
      socket.clear();
      const ids = Array.from({ length: 60_000 }, (_, index) => `missing-${index}`).concat("board1");
      const frames = await sendFrames(socket, { type: "query:subscribe", id: "big", query: { kanbanBoards: { $: { where: { id: { $in: ids } } } } } });
      expect(frames).toBeGreaterThan(3);
      const [data] = queryMessages(socket);
      expect(data).toMatchObject({ type: "query:data", id: "big" });
      expect((data.data as { kanbanBoards: Array<{ id: string }> }).kanbanBoards.map((row) => row.id)).toEqual(["board1"]);
      expect(Number(db.query(`SELECT COUNT(*) AS n FROM "_socket_parts"`).get()!.n as number)).toBe(0);

      socket.clear();
      await send(socket, { type: "part", id: "m", index: 1, last: true, data: "{}" });
      expect(socket.messages()).toEqual([expect.objectContaining({ type: "error", code: "part_out_of_order" })]);
    });

    test("relays a topic message in parts without joining it, and receivers join it", async () => {
      const sender = await connect(WORKSPACE_ROLE_LEVELS.MEMBER, "sender");
      const receiver = await connect(WORKSPACE_ROLE_LEVELS.MEMBER, "receiver");
      await send(receiver, { type: "topic:join", topic: "big" });
      receiver.clear();
      const message = { text: "é".repeat(400_000), list: Array.from({ length: 50_000 }, (_, index) => index) };
      const frames = await sendFrames(sender, { type: "topic:send", topic: "big", message });
      expect(frames).toBeGreaterThan(2);

      const relayed = receiver.messages();
      expect(relayed).toHaveLength(frames);
      expect(relayed.every((frame) => frame.type === "topic:message" && "part" in frame)).toBe(true);
      // Nothing was stored to join it.
      expect(Number(db.query(`SELECT COUNT(*) AS n FROM "_socket_parts"`).get()!.n as number)).toBe(0);

      const parts = new TopicParts();
      const joined = relayed.map((frame) => parts.take(frame as never)).filter((value) => value !== null);
      expect(joined).toEqual([expect.objectContaining({ type: "topic:message", topic: "big", message })]);
    });

    test("splits frames without cutting a character in two", () => {
      const message = { type: "topic:send", topic: "t", message: "😀".repeat(1000) + "a" };
      for (const size of [7, 8, 9, 101]) {
        const frames = framesFor(message as never, size).map((frame) => JSON.parse(frame));
        const parts = new TopicParts();
        const joined = frames
          .map((frame) => parts.take({ ...frame, type: "topic:message", from: { clientId: "c", sub: "s" } }))
          .filter((value) => value !== null);
        expect(joined).toEqual([expect.objectContaining({ message: message.message })]);
        expect(frames.every((frame) => !/[\ud800-\udbff]$/.test(frame.data))).toBe(true);
      }
    });

    test("carries presence of any size, and forgets a closed socket's stored state", async () => {
      const big = await connect(WORKSPACE_ROLE_LEVELS.MEMBER, "big");
      const peer = await connect(WORKSPACE_ROLE_LEVELS.MEMBER, "peer");
      const presence = { name: "x".repeat(40_000) };
      await send(peer, { type: "presence:set", target: "doc", presence: { name: "p" } });
      peer.clear();
      await send(big, { type: "presence:set", target: "doc", presence });
      const update = peer.messages().find((message) => message.type === "presence:update") as { peers: Array<{ presence: unknown }> };
      expect(update.peers.map((entry) => entry.presence)).toContainEqual(presence);

      const stored = () => Number(db.query(`SELECT COUNT(*) AS n FROM "_socket_state"`).get()!.n as number);
      expect(stored()).toBeGreaterThan(0);
      room.webSocketClose(big as unknown as WebSocket, 1000, "bye");
      expect(stored()).toBe(0);
    });
  });
});
