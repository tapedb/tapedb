/**
 * The read side of an indexed vector field: `POST /search`, answered by the
 * real `WorkspaceRoom` over in-memory SQLite with `MemoryVectorIndex` standing
 * in for the provider.
 *
 * What this proves is the engine's own contract: that the index's ranking is
 * kept, that the ceiling is refused rather than clamped, that the caller's read
 * rules decide what comes back, and that a row the index still holds but SQLite
 * no longer does never reaches a caller. What it cannot prove is the provider —
 * visibility lag, metadata-index requirements and the `topK` ceiling were
 * measured on a live index and are cited in the design, not here.
 */

import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { createClient } from "../src/model/client";
import { MemoryOutbox } from "../src/client/outbox";
import { encodeVector } from "../src/model/vector";
import { filter, model, schema, t } from "../src/schema";
import type { Env } from "../src/types";
import { encodeTrustedRoleClaim } from "../src/verify";
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
    ownerId: t.string(),
    title: t.string(),
    archived: t.boolean().default(false),
    embedding: t.vector({ dimensions: DIMENSIONS }).optional(),
  }).access({ read: filter(({ auth }) => ({ ownerId: auth.sub })) }),
  task: model({ title: t.string() }),
});

const VECTORIZE: VectorizeOptions = {
  index: BINDING,
  model: "note",
  field: "embedding",
  filterFields: ["archived"],
};

function claim(sub = "user-1"): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return { sub, workspaceId: ID, role: WORKSPACE_ROLE_LEVELS.DEVELOPER, exp: now + 3600, iat: now };
}

/** A workspace with its own SQLite, a fake R2 and an in-memory index. */
async function makeWorkspace() {
  const app = defineTapeDB({ schema: appSchema, vectorize: VECTORIZE });
  const db = new Database(":memory:");
  const context = new FakeRoomContext(db, ID);
  const env = { DATA: new FakeR2Bucket(), FILES: new FakeR2Bucket() } as unknown as Env;
  const index = new MemoryVectorIndex(BINDING, DIMENSIONS);
  const room = new app.WorkspaceRoom(context as never, env, { vectorIndex: index as VectorIndex });
  await context.ready;
  return { app, db, context, env, index, room };
}

type Workspace = Awaited<ReturnType<typeof makeWorkspace>>;

interface Answer<T> {
  status: number;
  body: T;
}

/** Writes rows, then drains the queue so they are in the index. */
async function writeAndDrain(
  workspace: Workspace,
  rows: Array<Record<string, unknown> & { id: string }>,
  sub?: string
): Promise<void> {
  const response = await workspace.room.fetch(
    new Request("http://test/transact", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tapedb-claims": encodeTrustedRoleClaim(claim(sub)) },
      body: JSON.stringify({
        txId: crypto.randomUUID(),
        ops: rows.map(({ id, ...values }) => ({
          op: "insert",
          namespace: "note",
          id,
          values: { ownerId: "user-1", title: id, archived: false, ...values },
        })),
      }),
    })
  );
  expect(response.status).toBe(200);
  await workspace.room.alarm();
}

/** One search, as a client sends it. */
async function search(
  workspace: Workspace,
  body: Record<string, unknown>,
  sub?: string
): Promise<
  Answer<{
    ok?: boolean;
    data?: Record<string, Array<Record<string, unknown>>>;
    search?: { scores?: Record<string, number>; truncated?: boolean };
    error?: { code: string; message: string };
  }>
> {
  const response = await workspace.room.fetch(
    new Request("http://test/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tapedb-claims": encodeTrustedRoleClaim(claim(sub)) },
      body: JSON.stringify({ model: "note", ...body }),
    })
  );
  return { status: response.status, body: (await response.json()) as never };
}

/** The rows a successful search answered with. */
function rowsOf(answer: Awaited<ReturnType<typeof search>>): Array<Record<string, unknown>> {
  expect(answer.status).toBe(200);
  expect(answer.body.ok).toBe(true);
  return answer.body.data?.note ?? [];
}

const QUERY = [1, 0, 0];

describe("ranking", () => {
  test("rows come back nearest first, with the score each was found by", async () => {
    const workspace = await makeWorkspace();
    // Written out of rank order, so the answer cannot be insertion order.
    await writeAndDrain(workspace, [
      { id: "far", embedding: [0, 1, 0] },
      { id: "near", embedding: [1, 0, 0] },
      { id: "middle", embedding: [0.8, 0.6, 0] },
    ]);

    const answer = await search(workspace, { vector: QUERY });
    const rows = rowsOf(answer);

    expect(rows.map((row) => row.id)).toEqual(["near", "middle", "far"]);
    const scores = answer.body.search?.scores ?? {};
    expect(scores.near).toBeCloseTo(1, 5);
    expect(scores.middle).toBeCloseTo(0.8, 5);
    expect(scores.far).toBeCloseTo(0, 5);
    expect(answer.body.search?.truncated).toBe(false);
    // A search answers with rows to show, never with the embedding itself.
    for (const row of rows) expect(row).not.toHaveProperty("embedding");
  });
});

describe("the limit", () => {
  /** Twelve rows, all matching, in decreasing score order n0 … n11. */
  async function twelve(): Promise<Workspace> {
    const workspace = await makeWorkspace();
    await writeAndDrain(
      workspace,
      Array.from({ length: 12 }, (_, i) => ({ id: `n${String(i).padStart(2, "0")}`, embedding: [1, i / 100, 0] }))
    );
    return workspace;
  }

  test("defaults to ten, and says the answer was cut off", async () => {
    const workspace = await twelve();

    const answer = await search(workspace, { vector: QUERY });
    const rows = rowsOf(answer);

    expect(rows).toHaveLength(10);
    expect(rows.map((row) => row.id)).toEqual(Array.from({ length: 10 }, (_, i) => `n${String(i).padStart(2, "0")}`));
    expect(answer.body.search?.truncated).toBe(true);
  });

  test("50 is the ceiling: it is answered, and 51 is refused rather than clamped", async () => {
    const workspace = await twelve();

    const atCeiling = await search(workspace, { vector: QUERY, limit: 50 });
    expect(rowsOf(atCeiling)).toHaveLength(12);
    expect(atCeiling.body.search?.truncated).toBe(false);

    const above = await search(workspace, { vector: QUERY, limit: 51 });
    expect(above.status).toBe(400);
    expect(above.body.error?.code).toBe("invalid_value");
    expect(above.body.error?.message).toContain("at most 50");

    const zero = await search(workspace, { vector: QUERY, limit: 0 });
    expect(zero.status).toBe(400);
    expect(zero.body.error?.code).toBe("invalid_value");
  });
});

describe("what the database knows wins over the index", () => {
  test("a row deleted after it was indexed is not in the answer", async () => {
    const workspace = await makeWorkspace();
    await writeAndDrain(workspace, [
      { id: "gone", embedding: [1, 0, 0] },
      { id: "kept", embedding: [0.8, 0.6, 0] },
    ]);
    // The index still holds both: the provider has not processed the delete.
    expect(workspace.index.size).toBe(2);

    // Deleted behind the queue's back — as a stale index would be.
    workspace.db.exec(`DELETE FROM note WHERE id = 'gone'`);

    const answer = await search(workspace, { vector: QUERY });
    expect(rowsOf(answer).map((row) => row.id)).toEqual(["kept"]);
    expect(Object.keys(answer.body.search?.scores ?? {})).toEqual(["kept"]);
  });

  test("a row whose vector changed since it was published is ranked on nothing", async () => {
    const workspace = await makeWorkspace();
    await writeAndDrain(workspace, [{ id: "n1", embedding: [1, 0, 0] }]);

    // The embedding was replaced and the new one is not in the index yet: the
    // index's candidate describes a state of the row that no longer exists.
    workspace.db.exec(`UPDATE note SET embedding = '${encodeVector([0, 1, 0], DIMENSIONS)}' WHERE id = 'n1'`);

    const answer = await search(workspace, { vector: QUERY });
    expect(rowsOf(answer)).toEqual([]);
  });
});

describe("the filter", () => {
  test("equality on a declared field narrows the rows before they are ranked", async () => {
    const workspace = await makeWorkspace();
    await writeAndDrain(workspace, [
      { id: "open-near", embedding: [1, 0, 0], archived: false },
      { id: "filed-middle", embedding: [0.8, 0.6, 0], archived: true },
      { id: "open-far", embedding: [0.6, 0.8, 0], archived: false },
      { id: "filed-far", embedding: [0, 1, 0], archived: true },
    ]);

    const filed = await search(workspace, { vector: QUERY, filter: { archived: true } });
    expect(rowsOf(filed).map((row) => row.id)).toEqual(["filed-middle", "filed-far"]);

    const open = await search(workspace, { vector: QUERY, filter: { archived: false } });
    expect(rowsOf(open).map((row) => row.id)).toEqual(["open-near", "open-far"]);
  });

  test("an attribute the deployment did not declare is refused, not ignored", async () => {
    const workspace = await makeWorkspace();
    await writeAndDrain(workspace, [{ id: "n1", embedding: [1, 0, 0] }]);

    const answer = await search(workspace, { vector: QUERY, filter: { title: "n1" } });
    expect(answer.status).toBe(400);
    expect(answer.body.error?.code).toBe("invalid_value");
    expect(answer.body.error?.message).toContain("not a filter field");
  });
});

describe("what a caller can get wrong", () => {
  test("a vector of the wrong length is refused with the message a write gives", async () => {
    const workspace = await makeWorkspace();

    const write = await workspace.room.fetch(
      new Request("http://test/transact", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tapedb-claims": encodeTrustedRoleClaim(claim()) },
        body: JSON.stringify({
          txId: crypto.randomUUID(),
          ops: [{ op: "insert", namespace: "note", id: "bad", values: { ownerId: "user-1", title: "bad", embedding: [1, 0] } }],
        }),
      })
    );
    const written = (await write.json()) as { error?: { code: string; message: string } };
    expect(written.error?.code).toBe("invalid_value");

    const answer = await search(workspace, { vector: [1, 0] });
    expect(answer.status).toBe(400);
    expect(answer.body.error?.code).toBe("invalid_value");
    expect(answer.body.error?.message).toBe(written.error?.message);
  });

  test("a model this deployment does not index is refused", async () => {
    const workspace = await makeWorkspace();

    const answer = await search(workspace, { model: "task", vector: QUERY });
    expect(answer.status).toBe(400);
    expect(answer.body.error?.code).toBe("invalid_op");
  });

  test("a deployment without vectorize has nothing to search", async () => {
    const app = defineTapeDB({ schema: appSchema });
    const context = new FakeRoomContext(new Database(":memory:"), ID);
    const env = { DATA: new FakeR2Bucket(), FILES: new FakeR2Bucket() } as unknown as Env;
    const room = new app.WorkspaceRoom(context as never, env);
    await context.ready;

    const response = await room.fetch(
      new Request("http://test/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tapedb-claims": encodeTrustedRoleClaim(claim()) },
        body: JSON.stringify({ model: "note", vector: QUERY }),
      })
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error?: { code: string } }).error?.code).toBe("invalid_op");
    // The deployment's own vectorize config is what the route looks at.
    expect(resolveVectorize(undefined)).toBeNull();
  });
});

describe("read rules", () => {
  test("a caller does not receive a row their read rules exclude", async () => {
    const workspace = await makeWorkspace();
    await writeAndDrain(workspace, [
      { id: "mine", ownerId: "user-1", embedding: [1, 0, 0] },
      { id: "theirs", ownerId: "user-2", embedding: [0.8, 0.6, 0] },
    ]);
    // Both are indexed: the exclusion is the read's, not the index's.
    expect(workspace.index.size).toBe(2);

    const mine = await search(workspace, { vector: QUERY }, "user-1");
    expect(rowsOf(mine).map((row) => row.id)).toEqual(["mine"]);
    expect(Object.keys(mine.body.search?.scores ?? {})).toEqual(["mine"]);

    const theirs = await search(workspace, { vector: QUERY }, "user-2");
    expect(rowsOf(theirs).map((row) => row.id)).toEqual(["theirs"]);
    expect(Object.keys(theirs.body.search?.scores ?? {})).toEqual(["theirs"]);
  });
});

describe("the client", () => {
  interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }

  /** One canned answer per route: the client's half is what is under test. */
  function recordingFetch(answer: () => Response) {
    const calls: Call[] = [];
    const fetch = async (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => {
      calls.push({
        url,
        method: init.method,
        headers: init.headers ?? {},
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      });
      return answer();
    };
    return { calls, fetch };
  }

  function client(fetch: (url: string, init: never) => Promise<Response>) {
    return createClient(
      { schema: appSchema, url: "http://engine.test", workspace: ID, getToken: async () => "token" },
      {
        fetch: fetch as never,
        outbox: new MemoryOutbox(),
        createWebSocket: () => {
          throw new Error("no socket in this test");
        },
      }
    );
  }

  const ROWS = [
    { id: "n1", ownerId: "user-1", title: "one", archived: false },
    { id: "n2", ownerId: "user-1", title: "two", archived: false },
  ];

  test("sends one search request and puts each row's score on the row", async () => {
    const { calls, fetch } = recordingFetch(() =>
      Response.json({
        ok: true,
        data: { note: ROWS },
        search: { scores: { n1: 0.9, n2: 0.4 }, truncated: true },
      })
    );

    const answer = await client(fetch).note.search({
      vector: [1, 0, 0],
      limit: 2,
      filter: { archived: false },
      where: { title: { equals: "one" } },
      select: { id: true, title: true },
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`http://engine.test/engine/workspaces/${ID}/search`);
    expect(call?.method).toBe("POST");
    expect(call?.headers.authorization).toBe("Bearer token");
    // `select` is a read's field map; the engine takes a list of names.
    expect(call?.body).toEqual({
      model: "note",
      vector: [1, 0, 0],
      limit: 2,
      filter: { archived: false },
      where: { title: "one" },
      select: ["id", "title"],
    });

    expect(answer.truncated).toBe(true);
    expect(answer.rows.map((row) => [row.id, row.score])).toEqual([
      ["n1", 0.9],
      ["n2", 0.4],
    ]);
  });

  test("a refusal reaches the caller as the engine's code and message", async () => {
    const { fetch } = recordingFetch(() =>
      Response.json(
        { ok: false, error: { code: "invalid_value", message: "\"limit\" is 51; a search returns at most 50 matches." } },
        { status: 400 }
      )
    );

    await expect(client(fetch).note.search({ vector: [1, 0, 0], limit: 51 })).rejects.toMatchObject({
      code: "invalid_value",
      message: expect.stringContaining("at most 50"),
    });
  });
});
