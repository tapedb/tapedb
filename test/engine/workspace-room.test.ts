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

function claim(): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "user-1",
    workspaceId: TEST_WORKSPACE,
    role: WORKSPACE_ROLE_LEVELS.EDITOR,
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
