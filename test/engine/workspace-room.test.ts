import { useLegacyFixture } from "../fixtures/registry";
useLegacyFixture();

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../../src/claims";
import { encodeTrustedRoleClaim } from "../../src/verify";
import type { Env } from "../../src/types";
import { DEFAULT_HISTORY_RETENTION_MS, readFlushState, readSnapshotState, snapshotDueAt } from "../../src/engine/durability";
import { SUPERSEDED_GRACE_MS } from "../../src/engine/durability/retention";
import { FakeR2Bucket, TEST_WORKSPACE } from "../fixtures/test-support";
import { logSegmentKey, readManifest, type WorkspaceManifest } from "../../src/engine/r2-keys";

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

const { WorkspaceRoom } = await import("../../src/engine/workspace-room");

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
      if (/^(drop table(?: if exists)?|delete from)\s+"?_cf_/i.test(trimmed)) throw new Error("not authorized: SQLITE_AUTH");
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

class FakeSocket {
  readonly sent: unknown[] = [];
  attachment: unknown;
  closed = false;

  constructor(private readonly id: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }

  close(): void {
    this.closed = true;
  }

  messages(): Array<Record<string, unknown>> {
    return this.sent as Array<Record<string, unknown>>;
  }
}

class FakeContext {
  ready: Promise<unknown> = Promise.resolve();
  alarm: number | null = null;
  readonly storage: {
    sql: ReturnType<typeof createSqlStorage>;
    transactionSync<T>(fn: () => T): T;
    getAlarm(): Promise<number | null>;
    setAlarm(at: number): Promise<void>;
    deleteAlarm(): Promise<void>;
    deleteAll(): Promise<void>;
  };

  readonly id: { name: string };
  readonly sockets: FakeSocket[] = [];

  constructor(db: Database, name: string) {
    this.id = { name };
    this.storage = {
      sql: createSqlStorage(db),
      transactionSync: <T>(fn: () => T): T => db.transaction(fn)(),
      getAlarm: async () => this.alarm,
      setAlarm: async (at: number) => {
        this.alarm = at;
      },
      deleteAlarm: async () => {
        this.alarm = null;
      },
      // A SQLite-backed object's deleteAll() empties its whole database.
      deleteAll: async () => {
        const tables = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>;
        db.exec("PRAGMA foreign_keys = OFF");
        for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`);
      },
    };
  }

  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    const promise = fn();
    this.ready = promise;
    return promise;
  }

  getWebSockets(): FakeSocket[] {
    return this.sockets;
  }
}

function claim(role: number = WORKSPACE_ROLE_LEVELS.EDITOR): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "user-1",
    workspaceId: TEST_WORKSPACE,
    role: role as RoleClaim["role"],
    exp: now + 60,
    iat: now,
  };
}

describe("WorkspaceRoom durability wiring", () => {
  let db: Database;
  let context: FakeContext;
  let bucket: FakeR2Bucket;
  let room: InstanceType<typeof WorkspaceRoom>;

  beforeEach(async () => {
    db = new Database(":memory:");
    context = new FakeContext(db, TEST_WORKSPACE);
    bucket = new FakeR2Bucket();
    room = new WorkspaceRoom(
      context as unknown as DurableObjectState,
      { DATA: bucket } as unknown as Env
    );
    await context.ready;
  });

  async function transact(name: string, txId: string): Promise<number> {
    const response = await room.fetch(
      new Request("http://test/transact", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tapedb-claims": encodeTrustedRoleClaim(claim()),
        },
        body: JSON.stringify({
          txId,
          ops: [
            {
              op: "update",
              namespace: "folders",
              id: "f1",
              values: { name },
            },
          ],
        }),
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { seq: number } };
    return body.result.seq;
  }

  test("schedules, flushes, snapshots the baseline, then flushes only", async () => {
    expect(await transact("Inbox", "t1")).toBe(1);
    expect(context.alarm).not.toBeNull();
    expect(context.alarm!).toBeGreaterThan(Date.now());

    context.alarm = null;
    await room.alarm();

    expect(readFlushState(context.storage.sql).lastSeq).toBe(1);
    expect(readSnapshotState(context.storage.sql).status).toBe("completed");
    expect(readSnapshotState(context.storage.sql).baseSeq).toBe(1);
    // The baseline snapshot covers seq 1, but the segment is retained inside
    // the idempotency horizon: it is the only remaining copy of that
    // transaction's clientTxId, which a retry after an eviction needs.
    expect(
      bucket.puts.some(
        (entry) => entry.key === logSegmentKey(TEST_WORKSPACE, 1, 1)
      )
    ).toBe(true);
    expect(bucket.objects.has(logSegmentKey(TEST_WORKSPACE, 1, 1))).toBe(true);
    // Nothing pending, but history ages out: the room wakes once the
    // superseded-snapshot grace has passed.
    const snapshottedAt = readSnapshotState(context.storage.sql).completedAt!;
    expect(context.alarm).toBe(snapshottedAt + SUPERSEDED_GRACE_MS);

    const first = await readManifest(
      bucket as unknown as R2Bucket,
      TEST_WORKSPACE
    );
    const firstManifest = first?.manifest as WorkspaceManifest;
    expect(firstManifest.baseSeq).toBe(1);
    expect(firstManifest.logSeq).toBe(1);
    expect(
      firstManifest.tables.find((table) => table.name === "folders")?.chunks
        .length
    ).toBeGreaterThan(0);

    expect(await transact("Archive", "t2")).toBe(2);
    expect(context.alarm).not.toBeNull();

    context.alarm = null;
    await room.alarm();

    expect(readFlushState(context.storage.sql).lastSeq).toBe(2);
    expect(readSnapshotState(context.storage.sql).baseSeq).toBe(1);
    expect(bucket.objects.has(logSegmentKey(TEST_WORKSPACE, 2, 2))).toBe(true);
    // A change since the snapshot: still the earlier prune, then a snapshot
    // at half the retention.
    expect(context.alarm).toBe(snapshottedAt + SUPERSEDED_GRACE_MS);
    expect(snapshotDueAt(context.storage.sql)).toBe(snapshottedAt + DEFAULT_HISTORY_RETENTION_MS / 2);

    const second = await readManifest(
      bucket as unknown as R2Bucket,
      TEST_WORKSPACE
    );
    expect((second?.manifest as WorkspaceManifest).logSeq).toBe(2);
  });
});

describe("WorkspaceRoom presence", () => {
  let db: Database;
  let context: FakeContext;
  let room: InstanceType<typeof WorkspaceRoom>;

  beforeEach(async () => {
    db = new Database(":memory:");
    context = new FakeContext(db, TEST_WORKSPACE);
    room = new WorkspaceRoom(
      context as unknown as DurableObjectState,
      { DATA: new FakeR2Bucket() } as unknown as Env
    );
    await context.ready;
  });

  function socket(clientId: string) {
    const ws = new FakeSocket(clientId);
    const now = Math.floor(Date.now() / 1000);
    ws.attachment = {
      clientId,
      sub: `user-${clientId}`,
      role: WORKSPACE_ROLE_LEVELS.EDITOR,
      exp: now + 60,
      subscriptions: [],
    };
    context.sockets.push(ws);
    return ws;
  }

  function send(ws: FakeSocket, message: unknown) {
    return room.webSocketMessage(
      ws as unknown as WebSocket,
      JSON.stringify(message)
    );
  }

  const target = "diagram-1";

  test("broadcasts presence snapshots to peers in the same target", async () => {
    const a = socket("a");
    const b = socket("b");

    await send(a, {
      type: "presence:set",
      target,
      presence: { name: "Alice", color: "#f00" },
    });
    expect(a.messages().at(-1)).toEqual({
      type: "presence:update",
      target,
      peers: [{ clientId: "a", presence: { name: "Alice", color: "#f00" } }],
    });

    await send(b, {
      type: "presence:set",
      target,
      presence: { name: "Bob", color: "#00f" },
    });
    expect(a.messages().at(-1)).toMatchObject({
      type: "presence:update",
      target,
      peers: [
        { clientId: "a", presence: { name: "Alice" } },
        { clientId: "b", presence: { name: "Bob" } },
      ],
    });
    expect(b.messages().at(-1)).toMatchObject({
      type: "presence:update",
      peers: [{ clientId: "a" }, { clientId: "b" }],
    });
  });

  test("broadcasts cursor and drag only to the target peers", async () => {
    const a = socket("a");
    const b = socket("b");
    const other = socket("c");
    await send(a, { type: "presence:set", target, presence: { name: "A" } });
    await send(b, { type: "presence:set", target, presence: { name: "B" } });
    await send(other, {
      type: "presence:set",
      target: "other-diagram",
      presence: { name: "C" },
    });

    await send(a, { type: "cursor:set", target, cursor: { x: 10, y: 20 } });
    expect(b.messages().at(-1)).toEqual({
      type: "cursor:update",
      target,
      clientId: "a",
      cursor: { x: 10, y: 20 },
    });
    expect(other.messages().at(-1)?.type).toBe("presence:update");

    await send(a, {
      type: "drag:set",
      target,
      drag: { nodes: { n1: { x: 1, y: 2 } } },
    });
    expect(b.messages().at(-1)).toMatchObject({
      type: "drag:update",
      clientId: "a",
      drag: { nodes: { n1: { x: 1, y: 2 } } },
    });

    await send(a, { type: "drag:clear", target });
    expect(b.messages().at(-1)).toMatchObject({
      type: "drag:update",
      clientId: "a",
      drag: null,
    });
  });

  test("clears presence on leave and disconnect", async () => {
    const a = socket("a");
    const b = socket("b");
    await send(a, { type: "presence:set", target, presence: { name: "A" } });
    await send(b, { type: "presence:set", target, presence: { name: "B" } });

    await send(a, { type: "presence:clear", target });
    expect(b.messages().at(-1)).toEqual({
      type: "presence:update",
      target,
      peers: [{ clientId: "b", presence: { name: "B" } }],
    });

    await send(a, { type: "presence:set", target, presence: { name: "A" } });
    room.webSocketClose(a as unknown as WebSocket, 1000, "bye");
    expect(b.messages().at(-1)).toEqual({
      type: "presence:update",
      target,
      peers: [{ clientId: "b", presence: { name: "B" } }],
    });
  });

  test("rejects cursor updates outside the presence target", async () => {
    const a = socket("a");
    await send(a, { type: "cursor:set", target, cursor: { x: 1, y: 2 } });
    expect(a.messages().at(-1)).toMatchObject({
      type: "error",
      code: "not_in_target",
    });
  });
});

describe("WorkspaceRoom erase", () => {
  const OTHER = "99999999-9999-4999-8999-999999999999";

  test("an owner erases the workspace's history, files and storage; it stays erased", async () => {
    const db = new Database(":memory:");
    const context = new FakeContext(db, TEST_WORKSPACE);
    const data = new FakeR2Bucket();
    const files = new FakeR2Bucket();
    const env = { DATA: data, FILES: files } as unknown as Env;
    const room = new WorkspaceRoom(context as unknown as DurableObjectState, env);
    await context.ready;
    db.exec('CREATE TABLE "_cf_KV" (key TEXT PRIMARY KEY, value BLOB)');

    const write = await room.fetch(new Request("http://test/transact", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tapedb-claims": encodeTrustedRoleClaim(claim()) },
      body: JSON.stringify({ txId: "t", ops: [{ op: "update", namespace: "folders", id: "f1", values: { name: "alice@example.com" } }] }),
    }));
    expect(write.status).toBe(200);
    await room.alarm();
    files.seed(`workspaces/${TEST_WORKSPACE}/files/cv.pdf`, "cv");
    data.seed(`ws/${OTHER}/manifest.json`, "{}");
    files.seed(`workspaces/${OTHER}/files/keep.txt`, "keep");
    expect([...data.objects.keys()].filter((key) => key.includes(TEST_WORKSPACE)).length).toBeGreaterThan(1);

    const erase = (role: number) =>
      room.fetch(new Request("http://test/", { method: "DELETE", headers: { "x-tapedb-claims": encodeTrustedRoleClaim(claim(role)) } }));

    const editor = await erase(WORKSPACE_ROLE_LEVELS.EDITOR);
    expect(editor.status).toBe(403);
    expect(data.objects.size).toBeGreaterThan(1);

    const owner = await erase(WORKSPACE_ROLE_LEVELS.OWNER);
    expect(owner.status).toBe(200);
    expect([...data.objects.keys()]).toEqual([`ws/${OTHER}/manifest.json`]);
    expect([...files.objects.keys()]).toEqual([`workspaces/${OTHER}/files/keep.txt`]);
    expect(context.alarm).toBeNull();
    const tables = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*'`).all();
    expect(tables).toEqual([{ name: "_tapedb_erased" }]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = '_cf_KV'").get()).not.toBeNull();

    // Everything after answers 410, including after a restart.
    expect((await room.fetch(new Request("http://test/status", { headers: { "x-tapedb-claims": encodeTrustedRoleClaim(claim()) } }))).status).toBe(410);
    const restarted = new WorkspaceRoom(new FakeContext(db, TEST_WORKSPACE) as unknown as DurableObjectState, env);
    const again = await restarted.fetch(new Request("http://test/transact", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tapedb-claims": encodeTrustedRoleClaim(claim()) },
      body: JSON.stringify({ txId: "late", ops: [{ op: "update", namespace: "folders", id: "f1", values: { name: "back" } }] }),
    }));
    expect(again.status).toBe(410);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("workspace_erased");
    await restarted.alarm();
    expect(data.objects.size).toBe(1);
  });

  test("a failed erase can be retried", async () => {
    const db = new Database(":memory:");
    const context = new FakeContext(db, TEST_WORKSPACE);
    const data = new FakeR2Bucket();
    const room = new WorkspaceRoom(context as unknown as DurableObjectState, { DATA: data } as unknown as Env);
    await context.ready;
    data.seed(`ws/${TEST_WORKSPACE}/log/1-1.ndjson`, "x");

    const erase = () => room.fetch(new Request("http://test/", { method: "DELETE", headers: { "x-tapedb-claims": encodeTrustedRoleClaim(claim(WORKSPACE_ROLE_LEVELS.OWNER)) } }));
    data.failDeletes = true;
    expect((await erase()).status).toBe(500);
    data.failDeletes = false;
    expect((await erase()).status).toBe(200);
    expect(data.objects.size).toBe(0);
  });

  test("checks roles on the file index itself", async () => {
    const db = new Database(":memory:");
    const context = new FakeContext(db, TEST_WORKSPACE);
    const room = new WorkspaceRoom(context as unknown as DurableObjectState, { DATA: new FakeR2Bucket() } as unknown as Env);
    await context.ready;
    const files = (method: string, role: number, body?: unknown) =>
      room.fetch(new Request("http://test/files", {
        method,
        headers: { "content-type": "application/json", "x-tapedb-claims": encodeTrustedRoleClaim(claim(role)) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
    const entry = { path: "a.txt", key: `workspaces/${TEST_WORKSPACE}/files/a.txt`, size: 1 };

    expect((await files("POST", WORKSPACE_ROLE_LEVELS.MEMBER, entry)).status).toBe(403);
    expect((await files("GET", WORKSPACE_ROLE_LEVELS.USER)).status).toBe(403);
    expect((await files("POST", WORKSPACE_ROLE_LEVELS.EDITOR, entry)).status).toBe(201);
    expect((await files("DELETE", WORKSPACE_ROLE_LEVELS.MEMBER, { path: "a.txt" })).status).toBe(403);
    const listed = await files("GET", WORKSPACE_ROLE_LEVELS.MEMBER);
    expect(((await listed.json()) as { data: Array<{ path: string }> }).data.map((row) => row.path)).toEqual(["a.txt"]);
  });
});


describe("erasure is isolated from ongoing work", () => {
  const erase = (room: InstanceType<typeof WorkspaceRoom>) => room.fetch(new Request("http://test/", { method: "DELETE", headers: { "x-tapedb-claims": encodeTrustedRoleClaim(claim(WORKSPACE_ROLE_LEVELS.OWNER)) } }));
  test("waits for an in-flight R2 flush and rejects socket writes before deleting", async () => {
    const db = new Database(":memory:");
    const context = new FakeContext(db, TEST_WORKSPACE);
    const data = new FakeR2Bucket();
    const room = new WorkspaceRoom(context as unknown as DurableObjectState, { DATA: data } as unknown as Env);
    await context.ready;
    await room.fetch(new Request("http://test/transact", { method: "POST", headers: { "content-type": "application/json", "x-tapedb-claims": encodeTrustedRoleClaim(claim()) }, body: JSON.stringify({ txId: "seed", ops: [{ op: "update", namespace: "folders", id: "f", values: { name: "before" } }] }) }));
    let began!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => began = resolve);
    const held = new Promise<void>(resolve => release = resolve);
    const put = data.put.bind(data);
    let first = true;
    data.put = async (...args: Parameters<typeof data.put>) => {
      if (first) { first = false; began(); await held; }
      return put(...args);
    };
    const flush = room.alarm();
    await entered;
    const deleting = erase(room);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(db.query("SELECT name FROM folders WHERE id = 'f'").get()).toEqual({ name: "before" });
    expect(db.query("SELECT name FROM sqlite_master WHERE name = '_tapedb_erasing'").get()).toBeNull();
    const socket = new FakeSocket("late");
    socket.attachment = { clientId: "late", sub: "user-1", role: WORKSPACE_ROLE_LEVELS.OWNER, exp: Math.floor(Date.now() / 1000) + 60, subscriptions: [] };
    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "part", id: "late", index: 0, last: false, data: "unfinished" }));
    expect(socket.closed).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM _socket_parts WHERE client_id = 'late'").get()).toEqual({ n: 0 });
    release();
    await flush;
    expect((await deleting).status).toBe(200);
    expect(data.objects.size).toBe(0);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()).toEqual([{ name: "_tapedb_erased" }]);
  });

  test("a restart after failed cleanup refuses writes and resumes from durable intent", async () => {
    const db = new Database(":memory:");
    const data = new FakeR2Bucket();
    const context = new FakeContext(db, TEST_WORKSPACE);
    const env = { DATA: data } as unknown as Env;
    const room = new WorkspaceRoom(context as unknown as DurableObjectState, env);
    await context.ready;
    data.seed(`ws/${TEST_WORKSPACE}/log/1-1.ndjson`, "history");
    data.failDeletes = true;
    expect((await erase(room)).status).toBe(500);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = '_tapedb_erasing'").get()).not.toBeNull();
    const nextContext = new FakeContext(db, TEST_WORKSPACE);
    const restarted = new WorkspaceRoom(nextContext as unknown as DurableObjectState, env);
    await nextContext.ready;
    const write = await restarted.fetch(new Request("http://test/transact", { method: "POST", headers: { "x-tapedb-claims": encodeTrustedRoleClaim(claim()) }, body: "{}" }));
    expect(write.status).toBe(410);
    data.failDeletes = false;
    await restarted.alarm();
    expect(data.objects.size).toBe(0);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()).toEqual([{ name: "_tapedb_erased" }]);
  });

  test("a failure installing the tombstone rolls local cleanup back, leaving durable intent", async () => {
    const db = new Database(":memory:");
    const context = new FakeContext(db, TEST_WORKSPACE);
    const data = new FakeR2Bucket();
    const room = new WorkspaceRoom(context as unknown as DurableObjectState, { DATA: data } as unknown as Env);
    await context.ready;
    const exec = context.storage.sql.exec.bind(context.storage.sql);
    context.storage.sql.exec = ((query: string, ...args: unknown[]) => {
      if (query.startsWith('CREATE TABLE "_tapedb_erased"')) throw new Error("interrupted local cleanup");
      return exec(query, ...args);
    }) as typeof context.storage.sql.exec;
    expect((await erase(room)).status).toBe(500);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = '_tapedb_erasing'").get()).not.toBeNull();
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'folders'").get()).not.toBeNull();
    context.storage.sql.exec = exec;
    expect((await erase(room)).status).toBe(200);
  });
});
