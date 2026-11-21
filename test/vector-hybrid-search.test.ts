/**
 * Hybrid search: the workspace's own FTS5 index joins the vector candidates.
 *
 * The point of the keyword half is what an embedding blurs or has not seen yet:
 * an exact term, and a row whose text changed after its vector was published
 * (the version gate drops the vector candidate; the lexical hit is on the
 * current row, so it stays).
 */

import { Database } from "bun:sqlite";
import { afterEach, expect, mock, setSystemTime, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { model, schema, t } from "../src/schema";
import type { Env } from "../src/types";
import { encodeTrustedRoleClaim } from "../src/verify";
import { fuseRanks, type VectorIndex } from "../src/engine/vector-index";
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

const ID = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5b01";
const BINDING = "NOTES_VECTORIZE";
const DIMENSIONS = 384;

const appSchema = schema({
  note: model({
    title: t.string(),
    excerpt: t.string(),
    archived: t.boolean().default(false),
    embedding: t.vector({ dimensions: DIMENSIONS }).optional(),
  }),
});

function claim(): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "reader", workspaceId: ID, role: WORKSPACE_ROLE_LEVELS.DEVELOPER, exp: now + 3600, iat: now };
}

function embedWord(word: string): number[] {
  const values = new Array<number>(DIMENSIONS).fill(0);
  for (const [position, char] of [...word].entries()) {
    const at = (char.codePointAt(0)! * 31 + position * 97) % DIMENSIONS;
    values[at] = (values[at] ?? 0) + 1;
  }
  if (values.every((value) => value === 0)) values[0] = (values[0] ?? 0) + 1;
  return values;
}

function fakeAi() {
  return {
    async run(_model: string, input: { text: string[] }) {
      return { data: [embedWord(input.text[0]!)] };
    },
  };
}

afterEach(() => setSystemTime());

async function makeWorkspace(options: { keywordFields?: boolean } = {}) {
  const vectorize = {
    index: BINDING,
    model: "note",
    field: "embedding",
    filterFields: ["archived"],
    embed: { binding: "AI", model: "@cf/baai/bge-small-en-v1.5" },
    ...(options.keywordFields === false ? {} : { keywordFields: ["title", "excerpt"] }),
  };
  const app = defineTapeDB({ schema: appSchema, vectorize });
  const db = new Database(":memory:");
  const context = new FakeRoomContext(db, ID);
  const env = { DATA: new FakeR2Bucket(), FILES: new FakeR2Bucket(), AI: fakeAi() } as unknown as Env;
  const index = new MemoryVectorIndex(BINDING, DIMENSIONS);
  const room = new app.WorkspaceRoom(context as never, env, { vectorIndex: index as VectorIndex });
  await context.ready;
  return { app, db, context, env, index, room };
}

type Workspace = Awaited<ReturnType<typeof makeWorkspace>>;

async function call(workspace: Workspace, path: string, body: unknown) {
  const response = await workspace.room.fetch(
    new Request(`http://test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tapedb-claims": encodeTrustedRoleClaim(claim()) },
      body: JSON.stringify(body),
    })
  );
  return { status: response.status, body: (await response.json()) as any };
}

const write = (workspace: Workspace, ops: unknown[]) =>
  call(workspace, "/transact", { txId: crypto.randomUUID(), ops });

const note = (id: string, title: string, word: string, values: Record<string, unknown> = {}) => ({
  op: "insert",
  namespace: "note",
  id,
  values: { title, excerpt: `${title} excerpt`, archived: false, embedding: embedWord(word), ...values },
});

const search = (workspace: Workspace, body: Record<string, unknown>) =>
  call(workspace, "/search", { model: "note", limit: 5, ...body });

test("a term only the text carries is found, and the answer says it was hybrid", async () => {
  const workspace = await makeWorkspace();
  await write(workspace, [note("parts", "Spare parts SKU-4471", "parts"), note("other", "Unrelated", "other")]);
  await workspace.room.alarm();

  const answer = await search(workspace, { text: "SKU-4471" });
  expect(answer.status).toBe(200);
  expect(answer.body.search.mode).toBe("hybrid");
  expect(answer.body.data.note[0].id).toBe("parts");
});

test("a row whose text changed after its vector was published stays findable by the new words", async () => {
  const workspace = await makeWorkspace();
  await write(workspace, [note("edited", "aardvark", "aardvark")]);
  await workspace.room.alarm();

  // The title changes, the embedding does not: the vector candidate is dropped
  // by the version gate, the lexical hit is on the current row.
  await write(workspace, [
    { op: "update", namespace: "note", id: "edited", values: { title: "aardvark SKU-9912" } },
  ]);

  const answer = await search(workspace, { text: "SKU-9912" });
  expect(answer.body.data.note.map((row: { id: string }) => row.id)).toContain("edited");
  expect(answer.body.search.mode).toBe("hybrid");
});

test("filters narrow the keyword side too", async () => {
  const workspace = await makeWorkspace();
  await write(workspace, [
    note("open", "Quarterly planning", "planning"),
    note("old", "Old planning", "planning", { archived: true }),
  ]);
  await workspace.room.alarm();

  const open = await search(workspace, { text: "planning", filter: { archived: false } });
  expect(open.body.data.note.map((row: { id: string }) => row.id)).toEqual(["open"]);

  const archived = await search(workspace, { text: "planning", filter: { archived: true } });
  expect(archived.body.data.note.map((row: { id: string }) => row.id)).toEqual(["old"]);
});

test("FTS operators in a query are words, not syntax", async () => {
  const workspace = await makeWorkspace();
  await write(workspace, [note("one", "Quarterly planning", "planning")]);
  await workspace.room.alarm();

  for (const text of ['planning" OR "x', "planning AND NEAR(x) -y", "***", "()"]) {
    const answer = await search(workspace, { text });
    expect(answer.status).toBe(200);
    expect(Array.isArray(answer.body.data.note)).toBe(true);
  }
});

test("a deployment without keyword fields answers in vector mode", async () => {
  const workspace = await makeWorkspace({ keywordFields: false });
  await write(workspace, [note("one", "Quarterly planning", "planning")]);
  await workspace.room.alarm();

  const answer = await search(workspace, { text: "planning" });
  expect(answer.body.search.mode).toBe("vector");
  expect(answer.body.data.note).toHaveLength(1);
});

test("the keyword index is maintained inside the write's transaction", async () => {
  const workspace = await makeWorkspace();
  await write(workspace, [note("one", "Quarterly planning", "planning")]);
  const before = await search(workspace, { text: "planning" });
  expect(before.body.data.note).toHaveLength(1);

  // A delete removes the row from the lexical index as part of the same write.
  await write(workspace, [{ op: "delete", namespace: "note", id: "one" }]);
  const after = await search(workspace, { text: "planning" });
  expect(after.body.data.note).toHaveLength(0);
});

test("keywordFields without an embedding binding is refused when the Worker is defined", () => {
  expect(() =>
    defineTapeDB({
      schema: appSchema,
      vectorize: { index: BINDING, model: "note", field: "embedding", keywordFields: ["title"] },
    })
  ).toThrow(/keywordFields needs vectorize\.embed/);
});

test("keywordFields may only name string attributes", () => {
  const withNumber = schema({
    note: model({ rank: t.number(), embedding: t.vector({ dimensions: DIMENSIONS }).optional() }),
  });
  expect(() =>
    defineTapeDB({
      schema: withNumber,
      vectorize: {
        index: BINDING,
        model: "note",
        field: "embedding",
        embed: { binding: "AI", model: "@cf/baai/bge-small-en-v1.5" },
        keywordFields: ["rank"],
      },
    })
  ).toThrow(/names a number attribute; keyword recall indexes text/);
});

test("a workspace with keyword fields erases, FTS shadow tables and all", async () => {
  const workspace = await makeWorkspace();
  await write(workspace, [note("one", "Quarterly planning", "planning")]);
  await workspace.room.alarm();

  // The keyword table is FTS5, and its shadow tables refuse a direct DELETE;
  // the erase path has to drop the virtual table rather than wipe its shadows.
  const response = await workspace.room.fetch(
    new Request("http://test/", {
      method: "DELETE",
      headers: { "x-tapedb-claims": encodeTrustedRoleClaim(claim()) },
    })
  );
  const body = (await response.json()) as { ok?: boolean; error?: { message?: string } };
  expect(body.error?.message ?? "").not.toContain("may not be modified");
  expect(response.status).toBe(200);
  expect(body.ok).toBe(true);
});

test("fusion ranks a row that both sides found above one only a single side found", () => {
  const fused = fuseRanks([["both", "vector-only"], ["keyword-only", "both"]], 10);
  expect(fused.map((entry) => entry.id)).toEqual(["both", "keyword-only", "vector-only"]);
  expect(fused[0]!.score).toBeGreaterThan(fused[1]!.score);
});
