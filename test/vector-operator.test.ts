/**
 * The operator's surface for one workspace's index: retry, rebuild, and the
 * index state of rows the caller may read.
 *
 * These run the real `WorkspaceRoom` over in-memory SQLite with the real queue
 * and the in-memory index double, so they prove this repository's own work: that
 * a rebuild is one convergent job per workspace, that it survives being asked
 * twice, that search is refused while it runs, that it publishes every row
 * again and deletes entries whose row is gone, and that an operator's retry
 * sends current state. They say nothing about the provider's own behaviour.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim, type WorkspaceRole } from "../src/claims";
import { model, schema, t } from "../src/schema";
import type { Env } from "../src/types";
import { encodeTrustedRoleClaim } from "../src/verify";
import { durableObjectSqlExecutor } from "../src/engine/tx-sql";
import { resolveVectorize, type VectorIndex, type VectorizeOptions } from "../src/engine/vector-index";
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
const BINDING = "NOTES_VECTORIZE";
const DIMENSIONS = 3;

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

function claim(role: WorkspaceRole = WORKSPACE_ROLE_LEVELS.OWNER): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "operator", workspaceId: ID, role, exp: now + 3600, iat: now };
}

afterEach(() => {
  setSystemTime();
});

async function makeWorkspace(options: { vectorize?: VectorizeOptions } = {}) {
  const app = defineTapeDB({ schema: appSchema, vectorize: options.vectorize ?? VECTORIZE });
  const db = new Database(":memory:");
  const context = new FakeRoomContext(db, ID);
  const env = { DATA: new FakeR2Bucket(), FILES: new FakeR2Bucket() } as unknown as Env;
  const index = new MemoryVectorIndex(BINDING, DIMENSIONS);
  const room = new app.WorkspaceRoom(context as never, env, { vectorIndex: index as VectorIndex });
  await context.ready;
  return { app, db, context, env, index, room };
}

type Workspace = Awaited<ReturnType<typeof makeWorkspace>>;

function sqlOf(workspace: Workspace) {
  return durableObjectSqlExecutor(workspace.context.storage as unknown as DurableObjectStorage);
}

async function transact(workspace: Workspace, ops: unknown[]) {
  const response = await workspace.room.fetch(
    new Request("http://test/transact", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tapedb-claims": encodeTrustedRoleClaim(claim()) },
      body: JSON.stringify({ txId: crypto.randomUUID(), ops }),
    })
  );
  return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: { code: string } } };
}

async function post(
  workspace: Workspace,
  path: string,
  body: unknown,
  role: WorkspaceRole = WORKSPACE_ROLE_LEVELS.OWNER
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await workspace.room.fetch(
    new Request(`http://test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tapedb-claims": encodeTrustedRoleClaim(claim(role)) },
      body: JSON.stringify(body),
    })
  );
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const note = (id: string, values: Record<string, unknown> = {}) => ({
  op: "insert",
  namespace: "note",
  id,
  values: { title: id, archived: false, embedding: [1, 0, 0], ...values },
});

/** Drains until the rebuild (if any) has finished, or the bound is reached. */
async function settle(workspace: Workspace, passes = 8): Promise<void> {
  for (let pass = 0; pass < passes; pass += 1) {
    await workspace.room.alarm();
    const status = await (workspace.room.fetch(
      new Request("http://test/status", { headers: { "x-tapedb-claims": encodeTrustedRoleClaim(claim()) } })
    ).then((response) => response.json())) as { vectorize?: { rebuild: unknown } };
    if ((status.vectorize?.rebuild ?? null) === null) return;
  }
}

describe("rebuild one workspace's index", () => {
  test("it republishes every row, refuses search while it runs, and converges", async () => {
    const workspace = await makeWorkspace();
    await transact(workspace, [note("n1"), note("n2")]);
    await workspace.room.alarm();
    expect(workspace.index.size).toBe(2);
    const upsertsBefore = workspace.index.upsertCalls.flat().length;

    const search = await post(workspace, "/search", { model: "note", vector: [1, 0, 0], limit: 5 });
    expect(search.status).toBe(200);

    const started = await post(workspace, "/vector/rebuild", {});
    expect(started.status).toBe(200);
    expect(started.body.data.active).toBe(true);
    expect(started.body.data.enqueued).toBe(2);
    expect(typeof started.body.data.jobId).toBe("string");

    // A half-built index is not searched.
    const refused = await post(workspace, "/search", { model: "note", vector: [1, 0, 0], limit: 5 });
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe("vector_search_unavailable");
    expect(refused.headers.get("retry-after")).toBe("30");

    await settle(workspace);

    // Every row was sent again even though nothing about them changed: the
    // accepted digests were forgotten on purpose.
    expect(workspace.index.upsertCalls.flat().length).toBeGreaterThan(upsertsBefore);
    expect(workspace.index.size).toBe(2);
    const resumed = await post(workspace, "/search", { model: "note", vector: [1, 0, 0], limit: 5 });
    expect(resumed.status).toBe(200);
    expect(resumed.body.data.note).toHaveLength(2);
  });

  test("two concurrent requests converge on one job", async () => {
    const workspace = await makeWorkspace();
    await transact(workspace, [note("n1")]);
    await workspace.room.alarm();

    const first = await post(workspace, "/vector/rebuild", {});
    const second = await post(workspace, "/vector/rebuild", {});
    expect(second.body.data.jobId).toBe(first.body.data.jobId);
    expect(second.body.data.started).toBe(false);
    await settle(workspace);
  });

  test("an ordinary member cannot retry or rebuild", async () => {
    const workspace = await makeWorkspace();
    await transact(workspace, [note("n1")]);
    await workspace.room.alarm();

    const rebuild = await post(workspace, "/vector/rebuild", {}, WORKSPACE_ROLE_LEVELS.EDITOR);
    expect(rebuild.status).toBe(403);
    expect(rebuild.body.error.code).toBe("insufficient_role");
    const retry = await post(workspace, "/vector/retry", {}, WORKSPACE_ROLE_LEVELS.EDITOR);
    expect(retry.status).toBe(403);

    const status = await (workspace.room.fetch(
      new Request("http://test/status", { headers: { "x-tapedb-claims": encodeTrustedRoleClaim(claim()) } })
    ).then((response) => response.json())) as { vectorize: { rebuild: unknown } };
    expect(status.vectorize.rebuild).toBeNull();
  });

  test("an entry whose row is gone is deleted during the rebuild", async () => {
    const workspace = await makeWorkspace();
    await transact(workspace, [note("n1")]);
    await workspace.room.alarm();
    expect(workspace.index.size).toBe(1);

    // Simulate a delete whose provider submission was lost: the row is gone,
    // the intent with it, and only the accepted digest remembers the vector.
    const sql = sqlOf(workspace);
    sql.exec(`DELETE FROM "note" WHERE id = 'n1'`);
    sql.exec(`DELETE FROM "_vector_queue"`);

    const started = await post(workspace, "/vector/rebuild", {});
    expect(started.status).toBe(200);
    await settle(workspace);

    expect(workspace.index.deleteCalls.flat().length).toBeGreaterThan(0);
    expect(workspace.index.size).toBe(0);
  });
});

describe("retry", () => {
  test("requeues work that stopped retrying and sends current state", async () => {
    const workspace = await makeWorkspace();
    await transact(workspace, [note("n1")]);
    workspace.index.failWith = "the index is down";
    await workspace.room.alarm();

    const sql = sqlOf(workspace);
    const dead = sql.one<{ attempts: number }>(`SELECT attempts FROM "_vector_queue" WHERE row_id = 'n1'`);
    expect(Number(dead!.attempts)).toBeGreaterThan(0);

    workspace.index.failWith = null;
    const retried = await post(workspace, "/vector/retry", {});
    expect(retried.status).toBe(200);
    expect(retried.body.data.requeued).toBeGreaterThan(0);

    await workspace.room.alarm();
    expect(workspace.index.size).toBe(1);
    const status = await (workspace.room.fetch(
      new Request("http://test/status", { headers: { "x-tapedb-claims": encodeTrustedRoleClaim(claim()) } })
    ).then((response) => response.json())) as { vectorize: { indexed: number; deadLettered: number } };
    expect(status.vectorize.indexed).toBe(1);
    expect(status.vectorize.deadLettered).toBe(0);
  });
});

describe("the index state of a row", () => {
  test("indexed, pending, unindexed, and rows the caller cannot see", async () => {
    const workspace = await makeWorkspace();
    await transact(workspace, [note("n1"), note("n2"), note("n3", { embedding: undefined })]);
    await workspace.room.alarm();

    const indexed = await post(workspace, "/vector/rows", { model: "note", ids: ["n1", "n2", "n3"] });
    expect(indexed.status).toBe(200);
    expect(indexed.body.data.rows).toEqual([
      { id: "n1", status: "indexed" },
      { id: "n2", status: "indexed" },
      { id: "n3", status: "unindexed" },
    ]);

    // A changed embedding is queued, not yet accepted.
    await transact(workspace, [
      { op: "update", namespace: "note", id: "n1", values: { embedding: [0, 1, 0] } },
    ]);
    const pending = await post(workspace, "/vector/rows", { model: "note", ids: ["n1"] });
    expect(pending.body.data.rows).toEqual([{ id: "n1", status: "pending" }]);

    // A row that does not exist, and one deleted, are absent, not "unindexed".
    await transact(workspace, [{ op: "delete", namespace: "note", id: "n2" }]);
    const after = await post(workspace, "/vector/rows", { model: "note", ids: ["n2", "missing"] });
    expect(after.body.data.rows).toEqual([]);
  });

  test("the request is refused for another model, a bad id list, or a bad body", async () => {
    const workspace = await makeWorkspace();
    const other = await post(workspace, "/vector/rows", { model: "task", ids: ["n1"] });
    expect(other.status).toBe(400);
    expect(other.body.error.code).toBe("invalid_vector_query");

    const empty = await post(workspace, "/vector/rows", { model: "note", ids: [] });
    expect(empty.status).toBe(400);

    const tooMany = await post(workspace, "/vector/rows", {
      model: "note",
      ids: Array.from({ length: 101 }, (_, index) => `n${index}`),
    });
    expect(tooMany.status).toBe(400);

    const wrongMethod = await workspace.room.fetch(
      new Request("http://test/vector/rows", {
        method: "GET",
        headers: { "x-tapedb-claims": encodeTrustedRoleClaim(claim()) },
      })
    );
    expect(wrongMethod.status).toBe(405);
  });
});
