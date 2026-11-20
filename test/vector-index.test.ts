/**
 * The index side of a vector field: the digest, the durable queue, the drain,
 * the retry, and what a deployment without `vectorize` does (nothing).
 *
 * These run the real `WorkspaceRoom` over in-memory SQLite: the capture
 * triggers, the write path, the alarm and the queue are the code a deployed
 * Worker runs. Only the index is replaced, with `MemoryVectorIndex`.
 *
 * **What that double can and cannot prove.** It proves this repository's own
 * work: that a row's intent is committed with its write, that the digest covers
 * the filter values, that an unchanged row is not re-sent, that a failed drain
 * keeps its entry and backs off, that batches are cut at the platform's size
 * and submitted in order, and that the queue outlives the object that wrote it.
 * It says nothing about the provider. The contract it stands in for — accepted-
 * then-visible with a measured ~73–103 s lag, `upsert` replacing a vector whole,
 * idempotent deletion of an absent ID, the 1,000-vector Workers batch ceiling,
 * metadata indexes that must exist before the vectors they index — was measured
 * on a live index during the design spike and is cited in the PR, not proved
 * here. `scripts/e2e/` has no Vectorize emulation, so this suite is not the
 * protocol evidence either.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { encodeVector } from "../src/model/vector";
import { model, schema, t } from "../src/schema";
import type { Env } from "../src/types";
import { encodeTrustedRoleClaim } from "../src/verify";
import { durableObjectSqlExecutor } from "../src/engine/tx-sql";
import {
  VECTOR_DELETE_BATCH,
  VECTOR_UPSERT_BATCH,
  drainVectorQueue,
  readVectorQueue,
  resolveVectorize,
  vectorIdFor,
  vectorRowDigest,
  type VectorIndex,
  type VectorizeOptions,
} from "../src/engine/vector-index";
import { MemoryVectorIndex } from "../src/engine/vector-index/memory";
import { FakeR2Bucket } from "./fixtures/test-support";
import { FakeRoomContext } from "./fixtures/room-harness";

class MockDurableObject<EnvShape> {
  protected ctx: DurableObjectState;
  protected env: EnvShape;

  constructor(ctx: DurableObjectState, env: EnvShape) {
    this.ctx = ctx;
    this.env = env;
  }
}

mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));

const { defineTapeDB } = await import("../src/worker/index");

const ID = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";
const OTHER_ID = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6c";
const BINDING = "NOTES_VECTORIZE";
const DIMENSIONS = 3;

const appSchema = schema({
  note: model({
    title: t.string(),
    archived: t.boolean().default(false),
    embedding: t.vector({ dimensions: DIMENSIONS }).optional(),
  }),
  task: model({ title: t.string(), done: t.boolean().optional() }),
});

const VECTORIZE: VectorizeOptions = {
  index: BINDING,
  model: "note",
  field: "embedding",
  filterFields: ["archived"],
};

function claim(): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "user-1",
    workspaceId: ID,
    role: WORKSPACE_ROLE_LEVELS.DEVELOPER,
    exp: now + 3600,
    iat: now,
  };
}

afterEach(() => {
  setSystemTime();
});

/** A workspace with its own SQLite, a fake R2 and an in-memory index. */
async function makeWorkspace(options: {
  vectorize?: VectorizeOptions;
  dimensions?: number;
} = {}) {
  const app = defineTapeDB({
    schema: appSchema,
    ...(options.vectorize === undefined ? {} : { vectorize: options.vectorize }),
  });
  const db = new Database(":memory:");
  const context = new FakeRoomContext(db, ID);
  const env = { DATA: new FakeR2Bucket(), FILES: new FakeR2Bucket() } as unknown as Env;
  const index = new MemoryVectorIndex(BINDING, options.dimensions ?? DIMENSIONS);
  const room = new app.WorkspaceRoom(context as never, env, {
    vectorIndex: index as VectorIndex,
  });
  await context.ready;
  return { app, db, context, env, index, room };
}

type Workspace = Awaited<ReturnType<typeof makeWorkspace>>;

async function transact(
  workspace: Workspace,
  ops: unknown[]
): Promise<{ status: number; body: { ok?: boolean; result?: { seq: number }; error?: { code: string; message: string } } }> {
  const response = await workspace.room.fetch(
    new Request("http://test/transact", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tapedb-claims": encodeTrustedRoleClaim(claim()),
      },
      body: JSON.stringify({ txId: crypto.randomUUID(), ops }),
    })
  );
  return { status: response.status, body: (await response.json()) as never };
}

/** The room's SQL surface, for reading the queue the way an operator would. */
function sqlOf(workspace: Workspace) {
  return durableObjectSqlExecutor(workspace.context.storage as unknown as DurableObjectStorage);
}

const note = (id: string, values: Record<string, unknown> = {}) => ({
  op: "insert",
  namespace: "note",
  id,
  // `archived` has a schema default, which `create` fills and a raw insert
  // must carry; the filter field has to be present for the digest to cover it.
  values: { title: id, archived: false, embedding: [1, 0, 0], ...values },
});

const VECTOR = [1, 0, 0];

describe("the digest", () => {
  const stored = encodeVector(VECTOR, DIMENSIONS);

  test("is stable for the same row, and covers model, row, bytes and filters", async () => {
    const base = { model: "note", rowId: "n1", vector: stored, dimensions: DIMENSIONS };
    const digest = await vectorRowDigest({ ...base, filters: { archived: false } });

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await vectorRowDigest({ ...base, filters: { archived: false } })).toBe(digest);
    // A filter's order in the object does not matter.
    expect(
      await vectorRowDigest({ ...base, filters: { archived: false, pinned: 1 } })
    ).toBe(
      await vectorRowDigest({
        model: "note",
        rowId: "n1",
        vector: stored,
        dimensions: DIMENSIONS,
        filters: { pinned: 1, archived: false },
      })
    );
    // Everything the index holds is in the digest, so a change to any of it is
    // a change of state.
    expect(await vectorRowDigest({ ...base, filters: { archived: true } })).not.toBe(digest);
    expect(await vectorRowDigest({ ...base, model: "task", filters: { archived: false } })).not.toBe(digest);
    expect(await vectorRowDigest({ ...base, rowId: "n2", filters: { archived: false } })).not.toBe(digest);
    expect(
      await vectorRowDigest({
        ...base,
        vector: encodeVector([0, 1, 0], DIMENSIONS),
        filters: { archived: false },
      })
    ).not.toBe(digest);
  });

  test("two inputs that round to the same float32 are one state", async () => {
    // 0.1 is not representable; both spellings become the same float32 bytes.
    const left = encodeVector([0.1, 0.2, 0.3], DIMENSIONS);
    const right = encodeVector([0.10000000000000001, 0.20000000000000004, 0.30000000000000004], DIMENSIONS);
    expect(right).toBe(left);
    expect(
      await vectorRowDigest({ model: "note", rowId: "n1", vector: left, dimensions: DIMENSIONS, filters: {} })
    ).toBe(
      await vectorRowDigest({ model: "note", rowId: "n1", vector: right, dimensions: DIMENSIONS, filters: {} })
    );
    // `-0` and `+0` are the same direction.
    expect(
      await vectorRowDigest({
        model: "note",
        rowId: "n1",
        vector: encodeVector([-0, 1, 0], DIMENSIONS),
        dimensions: DIMENSIONS,
        filters: {},
      })
    ).toBe(
      await vectorRowDigest({
        model: "note",
        rowId: "n1",
        vector: encodeVector([0, 1, 0], DIMENSIONS),
        dimensions: DIMENSIONS,
        filters: {},
      })
    );
  });

  test("an absent filter value is not the same state as false", async () => {
    const base = { model: "note", rowId: "n1", vector: stored, dimensions: DIMENSIONS };
    expect(await vectorRowDigest({ ...base, filters: {} })).not.toBe(
      await vectorRowDigest({ ...base, filters: { archived: false } })
    );
  });
});

describe("indexing a write", () => {
  test("a row is published once, with its vector and its filters", async () => {
    const workspace = await makeWorkspace({ vectorize: VECTORIZE });

    const write = await transact(workspace, [note("n1")]);
    expect(write.status).toBe(200);
    // Nothing is sent from the request: the alarm drains, after the flush.
    expect(workspace.index.upsertCalls).toHaveLength(0);
    expect(workspace.context.alarm).not.toBeNull();

    await workspace.room.alarm();

    expect(workspace.index.upsertCalls).toHaveLength(1);
    const [vector] = workspace.index.upsertCalls[0];
    expect(vector.values).toEqual(VECTOR);
    expect(vector.metadata).toMatchObject({ archived: false, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(vector.id).toHaveLength(64);
    expect(vector.namespace).toHaveLength(43);
    // Published under the derived ID, in this workspace's namespace only.
    expect(workspace.index.get(vector.id, vector.namespace)?.values).toEqual(VECTOR);
    expect(readVectorQueue(sqlOf(workspace))).toEqual([]);
  });

  test("an unchanged row is not re-upserted", async () => {
    const workspace = await makeWorkspace({ vectorize: VECTORIZE });
    await transact(workspace, [note("n1")]);
    await workspace.room.alarm();
    expect(workspace.index.upsertCalls).toHaveLength(1);

    // A write that touches neither the vector nor a filter attribute changes no
    // state the index can see.
    await transact(workspace, [{ op: "update", namespace: "note", id: "n1", values: { title: "Renamed" } }]);
    await workspace.room.alarm();
    expect(workspace.index.upsertCalls).toHaveLength(1);

    // The same vector written again is also the same state.
    await transact(workspace, [{ op: "update", namespace: "note", id: "n1", values: { embedding: [1, 0, 0] } }]);
    await workspace.room.alarm();
    expect(workspace.index.upsertCalls).toHaveLength(1);
    expect(readVectorQueue(sqlOf(workspace))).toEqual([]);
  });

  test("a changed filter value alone re-publishes, because a metadata filter would otherwise go stale", async () => {
    const workspace = await makeWorkspace({ vectorize: VECTORIZE });
    await transact(workspace, [note("n1", { archived: false })]);
    await workspace.room.alarm();
    expect(workspace.index.upsertCalls).toHaveLength(1);
    const first = workspace.index.upsertCalls[0][0];
    expect(first.metadata?.archived).toBe(false);

    // The embedding does not move; only the indexed filter does.
    await transact(workspace, [{ op: "update", namespace: "note", id: "n1", values: { archived: true } }]);
    await workspace.room.alarm();

    expect(workspace.index.upsertCalls).toHaveLength(2);
    const second = workspace.index.upsertCalls[1][0];
    expect(second.values).toEqual(first.values);
    expect(second.metadata?.archived).toBe(true);
    expect(second.metadata?.digest).not.toBe(first.metadata?.digest);
  });

  test("clearing the vector queues a delete, not an upsert of nothing", async () => {
    const workspace = await makeWorkspace({ vectorize: VECTORIZE });
    await transact(workspace, [note("n1")]);
    await workspace.room.alarm();
    expect(workspace.index.size).toBe(1);

    await transact(workspace, [{ op: "update", namespace: "note", id: "n1", values: { embedding: null } }]);
    await workspace.room.alarm();

    expect(workspace.index.deleteCalls).toHaveLength(1);
    expect(workspace.index.size).toBe(0);
    // The row is still there, and still valid: it is simply not indexed.
    expect(workspace.db.query(`SELECT title FROM note WHERE id = 'n1'`).get()).toEqual({ title: "n1" });
  });

  test("a model that is not indexed captures nothing", async () => {
    const workspace = await makeWorkspace({ vectorize: VECTORIZE });
    await transact(workspace, [
      { op: "insert", namespace: "task", id: "t1", values: { title: "Task", done: false } },
    ]);
    await workspace.room.alarm();
    expect(workspace.index.upsertCalls).toHaveLength(0);
    expect(readVectorQueue(sqlOf(workspace))).toEqual([]);
  });
});

describe("the queue is durable and never touches the write", () => {
  test("a commit succeeds with the index failing, and the queue keeps the intent", async () => {
    const workspace = await makeWorkspace({ vectorize: VECTORIZE });
    workspace.index.failWith = "Vectorize is unavailable";

    const write = await transact(workspace, [note("n1")]);
    expect(write.status).toBe(200);
    expect(write.body.result?.seq).toBeGreaterThan(0);
    // The row is readable and the write answered while the index was down.
    expect(workspace.db.query(`SELECT title FROM note WHERE id = 'n1'`).get()).toEqual({ title: "n1" });

    await workspace.room.alarm();

    const queued = readVectorQueue(sqlOf(workspace));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "upsert", attempts: 1 });
    expect(String(queued[0].last_error)).toContain("Vectorize is unavailable");

    const status = await workspace.room.fetch(
      new Request("http://test/status", { headers: { "x-tapedb-claims": encodeTrustedRoleClaim(claim()) } })
    );
    const body = (await status.json()) as { vectorize: { pending: number; failing: number } };
    expect(body.vectorize).toMatchObject({ pending: 1, failing: 1 });
  });

  test("a failed drain retries with backoff and loses nothing", async () => {
    const workspace = await makeWorkspace({ vectorize: VECTORIZE });
    workspace.index.failWith = "timeout";

    await transact(workspace, [note("n1")]);
    await workspace.room.alarm();

    const afterFirst = readVectorQueue(sqlOf(workspace))[0];
    expect(afterFirst.attempts).toBe(1);
    // 30 s, the log flusher's first backoff — not immediately, not an hour.
    expect(Number(afterFirst.next_attempt_at) - Date.now()).toBeWithin(29_000, 31_000);

    // An alarm before the retry is due does not hammer the index.
    await workspace.room.alarm();
    expect(workspace.index.upsertCalls).toHaveLength(1);

    workspace.index.failWith = null;
    setSystemTime(new Date(Number(afterFirst.next_attempt_at)));
    await workspace.room.alarm();

    expect(workspace.index.upsertCalls).toHaveLength(2);
    expect(workspace.index.size).toBe(1);
    expect(readVectorQueue(sqlOf(workspace))).toEqual([]);
    // The retry sent the same bytes, not a re-read of a changed row.
    expect(workspace.index.upsertCalls[0][0].values).toEqual(workspace.index.upsertCalls[1][0].values);
  });

  test("the queue survives the object that wrote it", async () => {
    const workspace = await makeWorkspace({ vectorize: VECTORIZE });
    await transact(workspace, [note("n1")]);
    expect(workspace.index.upsertCalls).toHaveLength(0);

    // The object is evicted before any alarm ran: a new one, same storage.
    const revived = new FakeRoomContext(workspace.db, ID);
    const room = new workspace.app.WorkspaceRoom(revived as never, workspace.env, {
      vectorIndex: workspace.index,
    });
    await revived.ready;
    expect(readVectorQueue(sqlOf(workspace))).toHaveLength(1);

    await room.alarm();
    expect(workspace.index.upsertCalls).toHaveLength(1);
    expect(workspace.index.size).toBe(1);
    expect(readVectorQueue(sqlOf(workspace))).toEqual([]);
  });

  test("a workspace whose index is missing keeps the intent and keeps serving", async () => {
    // No binding and no override: `vectorize` is configured but nothing to
    // submit to. Writes and reads are unaffected.
    const app = defineTapeDB({ schema: appSchema, vectorize: VECTORIZE });
    const db = new Database(":memory:");
    const context = new FakeRoomContext(db, ID);
    const env = { DATA: new FakeR2Bucket(), FILES: new FakeR2Bucket() } as unknown as Env;
    const room = new app.WorkspaceRoom(context as never, env);
    await context.ready;

    const response = await room.fetch(
      new Request("http://test/transact", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tapedb-claims": encodeTrustedRoleClaim(claim()) },
        body: JSON.stringify({ txId: crypto.randomUUID(), ops: [note("n1")] }),
      })
    );
    expect(response.status).toBe(200);
    await room.alarm();

    expect(db.query(`SELECT COUNT(*) AS n FROM "_vector_queue"`).get()).toEqual({ n: 1 });
    expect(db.query(`SELECT title FROM note WHERE id = 'n1'`).get()).toEqual({ title: "n1" });
  });

  test("an index of the wrong shape is refused, and the queue waits", async () => {
    const workspace = await makeWorkspace({ vectorize: VECTORIZE, dimensions: 4 });
    await transact(workspace, [note("n1")]);
    await workspace.room.alarm();

    expect(workspace.index.upsertCalls).toHaveLength(0);
    expect(readVectorQueue(sqlOf(workspace))).toHaveLength(1);
    // The schema is authoritative and the row is untouched.
    expect(workspace.db.query(`SELECT title FROM note WHERE id = 'n1'`).get()).toEqual({ title: "n1" });
  });
});

describe("batching and ordering", () => {
  test("the platform's ceilings are the ones the drain uses", () => {
    // Cloudflare Vectorize limits (2026-10-30): "Maximum upsert batch size (per
    // batch): 1000 (Workers) / 5000 (HTTP API)". This engine uses the binding,
    // so 1,000 — and the page documents no delete batch ceiling for the
    // binding, so a delete uses the same figure rather than the HTTP API's.
    expect(VECTOR_UPSERT_BATCH).toBe(1_000);
    expect(VECTOR_DELETE_BATCH).toBe(1_000);
  });

  test("deletes are submitted in batches, in the order they were written", async () => {
    const workspace = await makeWorkspace({ vectorize: VECTORIZE });
    await transact(workspace, [note("a"), note("b"), note("c")]);
    await workspace.room.alarm();
    expect(workspace.index.upsertCalls).toHaveLength(1);

    await transact(workspace, [
      { op: "delete", namespace: "note", id: "a" },
      { op: "delete", namespace: "note", id: "b" },
      { op: "delete", namespace: "note", id: "c" },
    ]);

    // Two at a time, from the same drain the alarm calls.
    const config = resolveVectorize(VECTORIZE)!;
    const sql = sqlOf(workspace);
    const first = await drainVectorQueue(sql, workspace.index, config, ID, Date.now(), { deleteBatch: 2 });
    expect(first.deleted).toBe(2);
    expect(workspace.index.deleteCalls).toHaveLength(1);
    expect(workspace.index.deleteCalls[0]).toHaveLength(2);

    const second = await drainVectorQueue(sql, workspace.index, config, ID, Date.now(), { deleteBatch: 2 });
    expect(second.deleted).toBe(1);
    expect(workspace.index.deleteCalls[1]).toHaveLength(1);

    // Written order, not map or hash order.
    const expected = await Promise.all(
      ["a", "b", "c"].map((rowId) =>
        vectorIdFor({ binding: BINDING, workspaceId: ID, model: "note", field: "embedding", rowId })
      )
    );
    expect(workspace.index.deleteCalls.flat()).toEqual(expected);
    expect(workspace.index.size).toBe(0);
    // Nothing left to delete, and nothing left to remember.
    expect(readVectorQueue(sql)).toEqual([]);
    expect(workspace.db.query(`SELECT COUNT(*) AS n FROM "_vector_state"`).get()).toEqual({ n: 0 });
  });

  test("deleting a row enqueues a delete of its vector", async () => {
    const workspace = await makeWorkspace({ vectorize: VECTORIZE });
    await transact(workspace, [note("n1"), note("n2")]);
    await workspace.room.alarm();
    expect(workspace.index.size).toBe(2);

    await transact(workspace, [{ op: "delete", namespace: "note", id: "n1" }]);
    await workspace.room.alarm();

    expect(workspace.index.deleteCalls).toHaveLength(1);
    expect(workspace.index.deleteCalls[0]).toHaveLength(1);
    expect(workspace.index.size).toBe(1);
  });
});

describe("without vectorize", () => {
  test("no table, no binding, no call", async () => {
    const workspace = await makeWorkspace();
    await transact(workspace, [note("n1")]);
    await workspace.room.alarm();

    expect(
      workspace.db
        .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '\\_vector%' ESCAPE '\\'`)
        .all()
    ).toEqual([]);
    expect(
      workspace.db
        .query(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '\\_tapedb\\_vector%' ESCAPE '\\'`)
        .all()
    ).toEqual([]);
    expect(workspace.index.upsertCalls).toHaveLength(0);

    const status = await workspace.room.fetch(
      new Request("http://test/status", { headers: { "x-tapedb-claims": encodeTrustedRoleClaim(claim()) } })
    );
    expect((await status.json()) as Record<string, unknown>).not.toHaveProperty("vectorize");
  });
});

describe("the definition is validated when the Worker is defined", () => {
  const ok = { ...VECTORIZE };

  test("the model, the field and its dimensions come from the schema", () => {
    expect(() => defineTapeDB({ schema: appSchema, vectorize: { ...ok, model: "missing" } })).toThrow(
      /not a model in this schema/
    );
    expect(() => defineTapeDB({ schema: appSchema, vectorize: { ...ok, field: "missing" } })).toThrow(
      /does not have/
    );
    // Not a vector attribute at all.
    expect(() => defineTapeDB({ schema: appSchema, vectorize: { ...ok, field: "title" } })).toThrow(
      /is a string/
    );
    // A binding name, not a binding object and not an arbitrary string.
    expect(() => defineTapeDB({ schema: appSchema, vectorize: { ...ok, index: "not a binding" } })).toThrow(
      /binding name/
    );
  });

  test("a filter must be a flat scalar, and not the vector itself", () => {
    expect(() => defineTapeDB({ schema: appSchema, vectorize: { ...ok, filterFields: ["embedding"] } })).toThrow(
      /vector attribute itself/
    );
    expect(() => defineTapeDB({ schema: appSchema, vectorize: { ...ok, filterFields: ["missing"] } })).toThrow(
      /does not have/
    );
    expect(() => defineTapeDB({ schema: appSchema, vectorize: { ...ok, filterFields: ["archived", "archived"] } })).toThrow(
      /repeats/
    );
  });

  test("a json or date filter is refused, because only a scalar has a metadata index", () => {
    const wide = schema({
      note: model({
        title: t.string(),
        seen: t.date().optional(),
        meta: t.json().optional(),
        embedding: t.vector({ dimensions: DIMENSIONS }).optional(),
      }),
    });
    expect(() =>
      defineTapeDB({ schema: wide, vectorize: { ...ok, filterFields: ["meta"] } })
    ).toThrow(/flat string, number or boolean/);
    expect(() =>
      defineTapeDB({ schema: wide, vectorize: { ...ok, filterFields: ["seen"] } })
    ).toThrow(/flat string, number or boolean/);
  });

  test("a personal filter is refused: its value would leave the workspace", () => {
    const personal = schema({
      note: model({
        title: t.string(),
        owner: t.string().personal({ subject: "self" }),
        embedding: t.vector({ dimensions: DIMENSIONS }).optional(),
      }),
    });
    expect(() =>
      defineTapeDB({ schema: personal, vectorize: { ...ok, filterFields: ["owner"] } })
    ).toThrow(/personal/);
  });

  test("more filter attributes than the platform allows is refused", () => {
    const names = Array.from({ length: 11 }, (_, index) => `f${index}`);
    const fields = Object.fromEntries(names.map((name) => [name, t.string().optional()]));
    const many = schema({
      note: model({ ...fields, embedding: t.vector({ dimensions: DIMENSIONS }).optional() }),
    });
    expect(() =>
      defineTapeDB({
        schema: many,
        vectorize: { ...ok, filterFields: names },
      })
    ).toThrow(/at most 10/);
    // Ten is inside the ceiling and defines fine.
    expect(() =>
      defineTapeDB({
        schema: many,
        vectorize: { ...ok, filterFields: names.slice(0, 10) },
      })
    ).not.toThrow();
  });

  test("the resolved configuration records the codec this build reads", () => {
    defineTapeDB({ schema: appSchema, vectorize: VECTORIZE });
    const config = resolveVectorize(VECTORIZE)!;
    expect(config.codec).toBe("f32le:v1:");
    expect(config.dimensions).toBe(DIMENSIONS);
    expect(config.filters).toEqual([{ attribute: "archived", column: "archived", type: "boolean" }]);
    expect(resolveVectorize(undefined)).toBeNull();
  });
});

describe("the two implementations", () => {
  test("the in-memory index ranks by cosine, filters and cuts at topK", async () => {
    const index = new MemoryVectorIndex(BINDING, DIMENSIONS);
    await index.upsert([
      { id: "near", values: [1, 0.1, 0], namespace: "ns", metadata: { archived: false } },
      { id: "far", values: [0, 1, 0], namespace: "ns", metadata: { archived: false } },
      { id: "hidden", values: [1, 0, 0], namespace: "ns", metadata: { archived: true } },
      { id: "elsewhere", values: [1, 0, 0], namespace: "other" },
    ]);

    const { matches } = await index.query([1, 0, 0], {
      topK: 5,
      namespace: "ns",
      filter: { archived: false },
    });
    expect(matches.map((match) => match.id)).toEqual(["near", "far"]);
    expect(await index.describe()).toMatchObject({ dimensions: DIMENSIONS, metric: "cosine" });
  });

  test("the Cloudflare adapter maps four calls onto the binding's methods", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const binding = {
      async upsert(vectors: unknown[]) {
        calls.push({ method: "upsert", args: [vectors] });
        return { mutationId: "m1" };
      },
      async deleteByIds(ids: string[]) {
        calls.push({ method: "deleteByIds", args: [ids] });
        return { mutationId: "m2" };
      },
      async query(vector: number[], options: unknown) {
        calls.push({ method: "query", args: [vector, options] });
        return { matches: [{ id: "v1", score: 0.9 }], count: 1 };
      },
      async describe() {
        calls.push({ method: "describe", args: [] });
        return { dimensions: DIMENSIONS, metric: "cosine" };
      },
    };

    const { cloudflareVectorIndex } = await import("../src/engine/vector-index/cloudflare");
    const index = cloudflareVectorIndex(binding, BINDING);

    const upserted = await index.upsert([{ id: "v1", values: [1, 0, 0], metadata: { archived: false } }]);
    expect(upserted).toEqual({ mutationId: "m1" });
    // A readonly array becomes the array the binding takes, values included.
    expect(calls[0]).toEqual({
      method: "upsert",
      args: [[{ id: "v1", values: [1, 0, 0], metadata: { archived: false } }]],
    });

    expect(await index.deleteByIds(["v1"])).toEqual({ mutationId: "m2" });
    expect(calls[1]).toEqual({ method: "deleteByIds", args: [["v1"]] });

    const result = await index.query([1, 0, 0], { topK: 3, namespace: "ns", returnMetadata: "indexed" });
    expect(result.matches).toEqual([{ id: "v1", score: 0.9 }]);
    expect(calls[2].args[1]).toMatchObject({ topK: 3, namespace: "ns", returnMetadata: "indexed" });

    expect(await index.describe()).toMatchObject({ name: BINDING, dimensions: DIMENSIONS });
  });
});
