/**
 * Erasing a workspace from the index: the fence, the ledger, the delete, the
 * watermark, the restart and the restore.
 *
 * **What the double can and cannot prove, stated once.** `MemoryVectorIndex`
 * applies a mutation the moment it is accepted and reports its own last
 * mutation as processed. So it can prove *this repository's* ordering — that a
 * submission refused by the fence never happens, that a delete is recorded
 * before it is confirmed, that a ledger written by one room finishes a purge in
 * another — and it can prove nothing about the provider. The measured provider
 * facts that shaped the design (a ~73–103 s visibility lag, ~18 s for a delete
 * to leave `getByIds` against ~75 s for the watermark to reach it, and a
 * `processedUpToMutation` that moved *backwards* between two reads) are cited
 * in the PR and modelled deliberately, where a test needs them, by making the
 * double's `describe()` lie the way a stale replica does. `scripts/e2e/` has no
 * Vectorize emulation, so this file is not protocol evidence either.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { model, schema, t } from "../src/schema";
import type { Env } from "../src/types";
import { encodeVector } from "../src/model/vector";
import { encodeTrustedRoleClaim } from "../src/verify";
import { durableObjectSqlExecutor } from "../src/engine/tx-sql";
import {
  VectorPurgeErasure,
  readVectorPurgeLedger,
  readVectorQueue,
  resolveVectorize,
  vectorIdFor,
  vectorNamespaceFor,
  type ConfiguredVectorize,
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
const DEPLOYMENT = "test";

const appSchema = schema({
  note: model({
    title: t.string(),
    archived: t.boolean().default(false),
    embedding: t.vector({ dimensions: DIMENSIONS }).optional(),
  }),
});

const VECTORIZE: VectorizeOptions = {
  index: BINDING,
  model: "note",
  field: "embedding",
  filterFields: ["archived"],
};

const VECTOR = [1, 0, 0];

function claim(workspaceId = ID, role = WORKSPACE_ROLE_LEVELS.OWNER): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "user-1", workspaceId, role, exp: now + 3600, iat: now };
}

const owner = (workspaceId = ID) => claim(workspaceId, WORKSPACE_ROLE_LEVELS.OWNER);

afterEach(() => {
  setSystemTime();
});

/** A workspace with its own SQLite, a fake R2 and an in-memory index. */
async function makeWorkspace(options: {
  workspaceId?: string;
  db?: Database;
  env?: Env;
  index?: MemoryVectorIndex;
  now?: () => number;
} = {}) {
  const workspaceId = options.workspaceId ?? ID;
  const app = defineTapeDB({ schema: appSchema, vectorize: VECTORIZE });
  const db = options.db ?? new Database(":memory:");
  const context = new FakeRoomContext(db, workspaceId);
  const env = options.env ?? ({ DATA: new FakeR2Bucket(), FILES: new FakeR2Bucket(), ENVIRONMENT: DEPLOYMENT } as unknown as Env);
  const index = options.index ?? new MemoryVectorIndex(BINDING, DIMENSIONS);
  const room = new app.WorkspaceRoom(context as never, env, {
    vectorIndex: index as VectorIndex,
    ...(options.now === undefined ? {} : { clock: options.now }),
  });
  await context.ready;
  return { app, db, context, env, index, room, workspaceId };
}

type Workspace = Awaited<ReturnType<typeof makeWorkspace>>;

const note = (id: string, values: Record<string, unknown> = {}) => ({
  op: "insert",
  namespace: "note",
  id,
  values: { title: id, archived: false, embedding: VECTOR, ...values },
});

async function transact(workspace: Workspace, ops: unknown[]): Promise<number> {
  const response = await workspace.room.fetch(
    new Request("http://test/transact", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tapedb-claims": encodeTrustedRoleClaim(claim(workspace.workspaceId)) },
      body: JSON.stringify({ txId: crypto.randomUUID(), ops }),
    })
  );
  if (response.status !== 200) {
    throw new Error(`transact failed: ${response.status} ${await response.text()}`);
  }
  return response.status;
}

function sqlOf(workspace: Workspace) {
  return durableObjectSqlExecutor(workspace.context.storage as unknown as DurableObjectStorage);
}

function config(): ConfiguredVectorize {
  return resolveVectorize(VECTORIZE)!;
}

/** The erasure a room builds, for a workspace and bucket a test holds. */
function erasureFor(workspace: Workspace, index: VectorIndex = workspace.index, workspaceId = workspace.workspaceId) {
  return new VectorPurgeErasure({
    bucket: workspace.env.DATA,
    deployment: DEPLOYMENT,
    workspaceId,
    config: config(),
    index: () => index,
  });
}

function target(workspaceId = ID) {
  return { deployment: DEPLOYMENT, workspace: workspaceId };
}

const idOf = (rowId: string, workspaceId = ID) =>
  vectorIdFor({ binding: BINDING, workspaceId, model: "note", field: "embedding", rowId });

async function erase(workspace: Workspace): Promise<Response> {
  return workspace.room.fetch(
    new Request("http://test/", { method: "DELETE", headers: { "x-tapedb-claims": encodeTrustedRoleClaim(owner(workspace.workspaceId)) } })
  );
}

async function status(workspace: Workspace) {
  const response = await workspace.room.fetch(
    new Request("http://test/status", { headers: { "x-tapedb-claims": encodeTrustedRoleClaim(claim(workspace.workspaceId)) } })
  );
  return (await response.json()) as {
    vectorize?: {
      pending: number;
      failing: number;
      deadLettered: number;
      indexed: number;
      fenced: boolean;
      purge: { phase: string; ids: number; confirmed: number; pending: number } | null;
    };
  };
}

/**
 * An index whose `describe()` reports a watermark the test chooses.
 *
 * This is the one thing a live index does that a pure double cannot: answer a
 * read from a replica that is behind, or that went *backwards* between two
 * reads. Everything else is the double's own behaviour, delegated untouched, so
 * the test cannot be accused of writing the implementation it checks.
 */
function laggingIndex(index: MemoryVectorIndex, watermark: { value: string | null }): VectorIndex {
  return {
    upsert: (vectors) => index.upsert(vectors),
    deleteByIds: (ids) => index.deleteByIds(ids),
    query: (vector, options) => index.query(vector, options),
    describe: async () => ({ ...(await index.describe()), processedUpToMutation: watermark.value }),
  };
}

describe("the fence", () => {
  test("a fenced workspace submits nothing, and the intents stay queued", async () => {
    // The control: the same work, unfenced, is submitted.
    const open = await makeWorkspace();
    await transact(open, [note("n1"), note("n2")]);
    await open.room.alarm();
    expect(open.index.upsertCalls).toHaveLength(1);

    const fenced = await makeWorkspace();
    await transact(fenced, [note("n1"), note("n2")]);
    // The fence alone — no erase, no wipe: the queue is intact and due.
    await erasureFor(fenced).fence();
    expect(readVectorQueue(sqlOf(fenced))).toHaveLength(2);

    await fenced.room.alarm();
    await fenced.room.alarm();

    expect(fenced.index.upsertCalls).toHaveLength(0);
    expect(fenced.index.deleteCalls).toHaveLength(0);
    // Refused is not failed: the intent keeps its place and its attempt count.
    const queued = readVectorQueue(sqlOf(fenced));
    expect(queued).toHaveLength(2);
    expect(queued.every((row) => row.attempts === 0)).toBe(true);
    // And an operator can see why.
    expect((await status(fenced)).vectorize).toMatchObject({ pending: 2, fenced: true });
  });

  test("a retry recovered from `_vector_state` still sees the fence", async () => {
    const workspace = await makeWorkspace();
    workspace.index.failWith = "Vectorize is unreachable";
    await transact(workspace, [note("n1")]);
    await workspace.room.alarm();

    const failed = readVectorQueue(sqlOf(workspace))[0]!;
    expect(failed.attempts).toBe(1);
    expect(workspace.index.upsertCalls).toHaveLength(1);

    // A second object over the same storage, booted while the workspace is
    // still open: this is the room that will find the retry, and the fence is
    // written after it booted, by the erase running elsewhere.
    workspace.index.failWith = null;
    const revived = new FakeRoomContext(workspace.db, ID);
    const room = new workspace.app.WorkspaceRoom(revived as never, workspace.env, {
      vectorIndex: workspace.index,
    });
    await revived.ready;
    await erasureFor(workspace).fence();

    setSystemTime(new Date(Number(failed.next_attempt_at)));
    await room.alarm();

    // The retry is due, recovered from storage, and refused: nothing on the
    // double, and the intent is neither lost nor failed.
    expect(workspace.index.upsertCalls).toHaveLength(1);
    const queued = readVectorQueue(sqlOf(workspace));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.attempts).toBe(1);
  });

  test("a boot that finds the fence finishes the erase instead of publishing", async () => {
    const workspace = await makeWorkspace();
    await transact(workspace, [note("n1")]);
    await workspace.room.alarm();
    const vector = workspace.index.upsertCalls[0]![0]!;

    await erasureFor(workspace).fence();

    // The room is destroyed and re-created over the same storage.
    const revived = new FakeRoomContext(workspace.db, ID);
    const room = new workspace.app.WorkspaceRoom(revived as never, workspace.env, {
      vectorIndex: workspace.index,
    });
    await revived.ready;
    await room.alarm();

    // Not one more upsert: the fence is read at boot, before anything is
    // published, and the erase it implies deletes what the workspace wrote.
    expect(workspace.index.upsertCalls).toHaveLength(1);
    expect(workspace.index.size).toBe(0);
    expect(workspace.index.deleteCalls.flat()).toEqual([vector.id]);
    expect((await readVectorPurgeLedger(workspace.env.DATA, target()))?.ledger.phase).toBe("complete");
  });

  test("an erase whose fence cannot be written deletes nothing", async () => {
    const workspace = await makeWorkspace();
    await transact(workspace, [note("n1")]);
    await workspace.room.alarm();
    const before = workspace.index.upsertCalls.length;

    // R2 refuses the marker. An erase may not proceed without it: the record is
    // what makes the purge finishable by anyone afterwards.
    const bucket = workspace.env.DATA as unknown as FakeR2Bucket;
    bucket.failPuts = true;
    const response = await erase(workspace);
    expect(response.status).toBe(500);

    expect(workspace.db.query(`SELECT COUNT(*) AS n FROM note`).get()).toEqual({ n: 1 });
    expect(workspace.index.deleteCalls).toHaveLength(0);
    expect(workspace.index.upsertCalls).toHaveLength(before);
    expect(await readVectorPurgeLedger(bucket, target())).toBeNull();

    // Once R2 answers, the same call finishes the erase it refused before.
    bucket.failPuts = false;
    expect((await erase(workspace)).status).toBe(200);
    expect(workspace.index.size).toBe(0);
  });
});

describe("the purge", () => {
  test("erasing a workspace deletes every ID it could have written, including a gone row", async () => {
    const workspace = await makeWorkspace();
    await transact(workspace, [note("n1"), note("n2"), note("n3")]);
    await workspace.room.alarm();
    expect(workspace.index.size).toBe(3);

    // A row deleted from SQLite whose vector has not been deleted yet: its ID
    // survives only as an intent, and must still be in the inventory.
    await transact(workspace, [{ op: "delete", namespace: "note", id: "n3" }]);
    expect(workspace.db.query(`SELECT COUNT(*) AS n FROM note WHERE id = 'n3'`).get()).toEqual({ n: 0 });

    const response = await erase(workspace);
    expect(response.status).toBe(200);

    const expected = (await Promise.all(["n1", "n2", "n3"].map((rowId) => idOf(rowId)))).sort();
    expect(workspace.index.deleteCalls.flat().sort()).toEqual(expected);
    expect(workspace.index.size).toBe(0);

    const ledger = await readVectorPurgeLedger(workspace.env.DATA, target());
    expect(ledger?.ledger).toMatchObject({ phase: "complete", ids: 3 });
    expect(ledger?.ledger.batches).toHaveLength(1);
    expect(ledger?.ledger.batches[0]).toMatchObject({ confirmedAt: expect.any(Number) });
    // The inventory is durable, and it is what the delete was built from.
    const inventory = await workspace.env.DATA.get(`vector-purge/${DEPLOYMENT}/${ID}/ids/000001.json`);
    expect(inventory).not.toBeNull();
  });

  test("IDs are deleted in platform-sized batches, each its own durable object", async () => {
    const workspace = await makeWorkspace();
    const ids = Array.from({ length: 1001 }, (_, index) => index.toString(16).padStart(64, "0"));

    const status = await erasureFor(workspace).erase({
      binding: BINDING,
      workspaceId: ID,
      model: "note",
      inventory: async () => ids,
    });

    expect(status.phase).toBe("complete");
    expect(status.batches).toBe(2);
    expect(status.ids).toBe(1001);
    // 1,000 per call, the same ceiling row deletes use, then the remainder.
    expect(workspace.index.deleteCalls.map((batch) => batch.length)).toEqual([1_000, 1]);
    expect(await workspace.env.DATA.get(`vector-purge/${DEPLOYMENT}/${ID}/ids/000001.json`)).not.toBeNull();
    expect(await workspace.env.DATA.get(`vector-purge/${DEPLOYMENT}/${ID}/ids/000002.json`)).not.toBeNull();
  });

  test("verification matches the delete's own mutation, never a watermark that moved", async () => {
    const workspace = await makeWorkspace();
    const index = workspace.index;
    // An unrelated earlier mutation: a shared index always has one.
    await index.upsert([{ id: "someone-else", values: VECTOR, namespace: "other" }]);
    const earlier = index.processedUpToMutation;
    expect(earlier).toBe("memory-1");

    // The replica that answers `describe()` is behind the delete it accepted.
    const watermark = { value: earlier };
    const erasure = erasureFor(workspace, laggingIndex(index, watermark));
    const ids = [await idOf("n1"), await idOf("n2")];

    const first = await erasure.erase({
      binding: BINDING,
      workspaceId: ID,
      model: "note",
      inventory: async () => ids,
    });

    // The delete was accepted (and the double applied it), but the watermark
    // names a mutation this purge did not submit: nothing is confirmed.
    expect(first.phase).toBe("verifying");
    expect(first.submitted).toBe(1);
    expect(first.confirmed).toBe(0);
    const stored = await readVectorPurgeLedger(workspace.env.DATA, target());
    expect(stored?.ledger.batches[0]?.mutationId).toBe("memory-2");
    expect(stored?.ledger.batches[0]?.confirmedAt).toBeNull();

    // A second read that went *backwards* changes nothing either.
    watermark.value = earlier;
    expect((await erasure.resume({ binding: BINDING, workspaceId: ID }))?.phase).toBe("verifying");
    expect(stored?.ledger.batches[0]?.confirmedAt).toBeNull();

    // The delete's own mutation arrives: now it is confirmed, by identity.
    watermark.value = "memory-2";
    const done = await erasure.resume({ binding: BINDING, workspaceId: ID });
    expect(done?.phase).toBe("complete");
    expect(done?.confirmed).toBe(1);
  });

  test("an erasure interrupted before the index answered resumes from the ledger alone", async () => {
    const workspace = await makeWorkspace();
    workspace.index.failWith = "Vectorize is unreachable";

    const first = await erasureFor(workspace).erase({
      binding: BINDING,
      workspaceId: ID,
      model: "note",
      inventory: async () => [await idOf("n1")],
    });
    expect(first.phase).toBe("deleting");
    expect(first.confirmed).toBe(0);

    workspace.index.failWith = null;
    // Past the attempt's backoff: a purge retries on the flusher's schedule, it
    // does not hammer an index that just failed.
    setSystemTime(new Date(Date.now() + 31_000));
    // A different instance, with no inventory callback and no SQLite to read:
    // the ledger is the only thing that knows what to delete.
    const resumed = await erasureFor(workspace).resume({ binding: BINDING, workspaceId: ID });
    expect(resumed?.phase).toBe("complete");
    expect(resumed?.ids).toBe(1);

    const stored = await readVectorPurgeLedger(workspace.env.DATA, target());
    expect(stored?.ledger.batches[0]?.attempts).toBeGreaterThan(0);
    expect(stored?.ledger.completedAt).toBeNumber();
  });

  test("the purge finishes after the workspace's own storage is destroyed", async () => {
    const workspace = await makeWorkspace();
    await transact(workspace, [note("n1"), note("n2")]);
    await workspace.room.alarm();
    expect(workspace.index.size).toBe(2);

    // The index is down when the erase runs: the fence and the inventory are
    // written, the workspace is wiped, and the deletion is outstanding.
    workspace.index.failWith = "Vectorize is unreachable";
    const response = await erase(workspace);
    expect(response.status).toBe(200);
    expect(workspace.index.size).toBe(2);
    expect((await readVectorPurgeLedger(workspace.env.DATA, target()))?.ledger.phase).toBe("deleting");

    workspace.index.failWith = null;
    setSystemTime(new Date(Date.now() + 31_000));
    // A brand-new object over empty storage — the room and its alarm are gone.
    const reborn = new Database(":memory:");
    const context = new FakeRoomContext(reborn, ID);
    const room = new workspace.app.WorkspaceRoom(context as never, workspace.env, {
      vectorIndex: workspace.index,
    });
    await context.ready;
    const resumed = await room.resumeVectorPurge();

    expect(resumed?.phase).toBe("complete");
    expect(workspace.index.size).toBe(0);
    // And it published nothing on the way.
    expect(workspace.index.upsertCalls).toHaveLength(1);
  });
});

describe("reads an operator can act on", () => {
  test("pending, dead-lettered and fenced are told apart", async () => {
    const workspace = await makeWorkspace();
    workspace.index.failWith = "Vectorize is unreachable";
    await transact(workspace, [note("n1")]);

    // Twelve attempts is where an intent stops being retried.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      setSystemTime(new Date(Date.now() + 60 * 60 * 1000 * (attempt + 1)));
      await workspace.room.alarm();
    }
    const dead = await status(workspace);
    expect(dead.vectorize).toMatchObject({ pending: 1, failing: 0, deadLettered: 1, fenced: false });

    // A fence is a separate state, and it is not a failure.
    workspace.index.failWith = null;
    await erasureFor(workspace).fence();
    const fenced = await status(workspace);
    expect(fenced.vectorize).toMatchObject({ fenced: true, deadLettered: 1 });
    // A fence with no ledger yet: the inventory has not been taken, which is a
    // state an operator must be able to see.
    expect(fenced.vectorize?.purge).toMatchObject({ phase: "inventory", fenced: true, ids: 0 });
  });
});

describe("restore", () => {
  /** Exports a workspace as the NDJSON `/import` accepts, addressed to `into`. */
  async function exportForImport(source: Workspace, into: string): Promise<string> {
    const response = await source.room.fetch(
      new Request("http://test/export", { headers: { "x-tapedb-claims": encodeTrustedRoleClaim(claim(source.workspaceId)) } })
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const value = JSON.parse(line) as Record<string, unknown>;
        // The one rewrite `tapedb restore --into` performs: a backup is
        // imported as the destination's rows.
        return value.type === "header" ? JSON.stringify({ ...value, workspaceId: into }) : line;
      })
      .join("\n")
      .concat("\n");
  }

  async function restore(source: Workspace, into: Workspace): Promise<Response> {
    return into.room.fetch(
      new Request("http://test/import", {
        method: "POST",
        headers: {
          "content-type": "application/x-ndjson",
          "x-tapedb-claims": encodeTrustedRoleClaim(owner(into.workspaceId)),
          "x-tapedb-exported-from": source.workspaceId,
        },
        body: await exportForImport(source, into.workspaceId),
      })
    );
  }

  test("rows of a fenced source are imported without publishing a vector", async () => {
    const source = await makeWorkspace();
    await transact(source, [note("n1"), note("n2")]);
    await source.room.alarm();
    const sourceIds = [await idOf("n1"), await idOf("n2")];
    await erasureFor(source).fence();

    const destination = await makeWorkspace({ workspaceId: OTHER_ID, index: source.index, env: source.env });
    const response = await restore(source, destination);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { vectorize?: string }).vectorize).toBe("withheld");

    await destination.room.alarm();
    await destination.room.alarm();

    // The rows are the destination's; the vectors they would have had are not
    // published, because the workspace they came from asked to be gone.
    expect(destination.db.query(`SELECT COUNT(*) AS n FROM note`).get()).toEqual({ n: 2 });
    // Two calls in total: the source's own writes, and nothing from the restore.
    expect(source.index.upsertCalls).toHaveLength(1);
    expect(source.index.upsertCalls.flat()).toHaveLength(2);
    // Nothing under the source's identity, and nothing under the destination's.
    const published = source.index.upsertCalls.flat().map((vector) => vector.id);
    expect(published.filter((id) => sourceIds.includes(id))).toHaveLength(2);
    expect(published).not.toContain(await idOf("n1", OTHER_ID));
  });

  test("rows of an open source are re-indexed under the destination identity", async () => {
    const source = await makeWorkspace();
    await transact(source, [note("n1")]);
    await source.room.alarm();
    const sourceVector = source.index.upsertCalls[0]![0]!;

    const destination = await makeWorkspace({ workspaceId: OTHER_ID, index: source.index, env: source.env });
    expect((await restore(source, destination)).status).toBe(200);
    await destination.room.alarm();

    const restored = source.index.upsertCalls.flat().filter((vector) => vector.namespace !== sourceVector.namespace);
    expect(restored).toHaveLength(1);
    // The ID and the namespace are derived from the destination, so nothing the
    // source published can collide with what the copy publishes.
    expect(restored[0]!.id).toBe(await idOf("n1", OTHER_ID));
    expect(restored[0]!.namespace).toBe(await vectorNamespaceFor(BINDING, OTHER_ID));
    expect(restored[0]!.id).not.toBe(sourceVector.id);
  });

  test("bookkeeping that names another workspace is re-derived, not published as it stands", async () => {
    const index = new MemoryVectorIndex(BINDING, DIMENSIONS);
    const destination = await makeWorkspace({
      workspaceId: OTHER_ID,
      index,
      env: { DATA: new FakeR2Bucket(), FILES: new FakeR2Bucket(), ENVIRONMENT: DEPLOYMENT } as unknown as Env,
    });
    // The row and its intent, not yet drained.
    await transact(destination, [note("n1")]);
    const queued = readVectorQueue(sqlOf(destination))[0]!;
    expect(queued.vector_id).toBe(await idOf("n1", OTHER_ID));

    // A copied SQLite: the queue row still carries the *source's* derived ID and
    // digest, and the bookkeeping says it belongs to the source.
    const sourceId = await idOf("n1");
    destination.db
      .query(`UPDATE "_vector_queue" SET vector_id = ?, digest = ? WHERE id = ?`)
      .run(sourceId, "d".repeat(64), queued.id);
    destination.db
      .query(`INSERT OR REPLACE INTO "_engine_meta" ("key", value) VALUES ('vector_identity', ?)`)
      .run(JSON.stringify({ binding: BINDING, workspace: ID }));

    // The object is re-created: boot reads the recorded identity, sees another
    // workspace, and re-derives rather than publishing the inherited ID.
    const revived = new FakeRoomContext(destination.db, OTHER_ID);
    const room = new destination.app.WorkspaceRoom(revived as never, destination.env, {
      vectorIndex: index,
    });
    await revived.ready;
    await room.alarm();

    const published = index.upsertCalls.flat();
    expect(published.map((vector) => vector.id)).toEqual([await idOf("n1", OTHER_ID)]);
    expect(published[0]!.namespace).toBe(await vectorNamespaceFor(BINDING, OTHER_ID));
    expect(published[0]!.metadata?.digest).not.toBe("d".repeat(64));
  });
});
