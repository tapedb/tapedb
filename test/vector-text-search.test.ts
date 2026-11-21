/**
 * Searching with words: the deployment's embedding binding turns a text query
 * into the vector the index holds, so a caller never runs the model itself.
 *
 * These run the real `WorkspaceRoom` over in-memory SQLite with the in-memory
 * index double and a fake Workers AI binding that embeds deterministically. The
 * binding's contract with the provider is not what is being proved here; what is
 * proved is that the engine sends the question through the deployment's own
 * model, refuses the ambiguous and the impossible cases, and keeps the answer
 * permission-scoped like any other search.
 */

import { Database } from "bun:sqlite";
import { afterEach, expect, mock, setSystemTime, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { model, schema, t } from "../src/schema";
import type { Env } from "../src/types";
import { encodeTrustedRoleClaim } from "../src/verify";
import type { VectorIndex } from "../src/engine/vector-index";
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
const DIMENSIONS = 384; // what bge-small produces, so the schema and the model agree
const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

const appSchema = schema({
  note: model({
    title: t.string(),
    archived: t.boolean().default(false),
    embedding: t.vector({ dimensions: DIMENSIONS }).optional(),
  }),
});

function claim(): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "reader", workspaceId: ID, role: WORKSPACE_ROLE_LEVELS.DEVELOPER, exp: now + 3600, iat: now };
}

/** The same word embeds to the same vector; different words to different ones. */
function embedWord(word: string): number[] {
  const values = new Array<number>(DIMENSIONS).fill(0);
  for (const [position, char] of [...word].entries()) {
    const at = (char.codePointAt(0)! * 31 + position * 97) % DIMENSIONS;
    values[at] = (values[at] ?? 0) + 1;
  }
  if (values.every((value) => value === 0)) values[0] = 1;
  return values;
}

/** A Workers AI binding that answers like an embedding model. */
function fakeAi(options: { fail?: string } = {}) {
  const calls: Array<{ model: string; text: string[] }> = [];
  return {
    calls,
    binding: {
      async run(aiModel: string, input: { text: string[] }) {
        calls.push({ model: aiModel, text: input.text });
        if (options.fail !== undefined) throw new Error(options.fail);
        return { shape: [1, DIMENSIONS], data: [embedWord(input.text[0]!)] };
      },
    },
  };
}

afterEach(() => {
  setSystemTime();
});

async function makeWorkspace(options: { embed?: boolean; ai?: ReturnType<typeof fakeAi> | null } = {}) {
  const vectorize = {
    index: BINDING,
    model: "note",
    field: "embedding",
    filterFields: ["archived"],
    ...(options.embed === false ? {} : { embed: { binding: "AI", model: EMBEDDING_MODEL } }),
  };
  const app = defineTapeDB({ schema: appSchema, vectorize });
  const db = new Database(":memory:");
  const context = new FakeRoomContext(db, ID);
  const ai = options.ai === undefined ? fakeAi() : options.ai;
  const env = {
    DATA: new FakeR2Bucket(),
    FILES: new FakeR2Bucket(),
    ...(ai === null ? {} : { AI: ai.binding }),
  } as unknown as Env;
  const index = new MemoryVectorIndex(BINDING, DIMENSIONS);
  const room = new app.WorkspaceRoom(context as never, env, { vectorIndex: index as VectorIndex });
  await context.ready;
  return { app, db, context, env, index, room, ai };
}

type Workspace = Awaited<ReturnType<typeof makeWorkspace>>;

const note = (id: string, word: string, values: Record<string, unknown> = {}) => ({
  op: "insert",
  namespace: "note",
  id,
  values: { title: id, archived: false, embedding: embedWord(word), ...values },
});

async function write(workspace: Workspace, ops: unknown[]): Promise<void> {
  const response = await workspace.room.fetch(
    new Request("http://test/transact", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tapedb-claims": encodeTrustedRoleClaim(claim()) },
      body: JSON.stringify({ txId: crypto.randomUUID(), ops }),
    })
  );
  expect(response.status).toBe(200);
  await workspace.room.alarm();
}

async function search(workspace: Workspace, body: Record<string, unknown>) {
  const response = await workspace.room.fetch(
    new Request("http://test/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tapedb-claims": encodeTrustedRoleClaim(claim()) },
      body: JSON.stringify({ model: "note", ...body }),
    })
  );
  return { status: response.status, body: (await response.json()) as any };
}

test("a text query is embedded by the deployment's own model and answered", async () => {
  const workspace = await makeWorkspace();
  await write(workspace, [note("planning", "planning"), note("budget", "budget")]);

  const answer = await search(workspace, { text: "planning", limit: 5 });
  expect(answer.status).toBe(200);
  // Nearest neighbour, not a threshold: the matching row ranks first.
  expect(answer.body.data.note[0].id).toBe("planning");
  expect(answer.body.search.scores.planning).toBeGreaterThan(answer.body.search.scores.budget ?? 0);
  // The question went through the model the deployment declared, once.
  expect(workspace.ai!.calls).toHaveLength(1);
  expect(workspace.ai!.calls[0]!.model).toBe(EMBEDDING_MODEL);
  expect(workspace.ai!.calls[0]!.text).toEqual(["planning"]);
});

test("text and vector together are refused, because the answer would be ambiguous", async () => {
  const workspace = await makeWorkspace();
  await write(workspace, [note("planning", "planning")]);
  const answer = await search(workspace, { text: "planning", vector: embedWord("planning") });
  expect(answer.status).toBe(400);
  expect(answer.body.error.code).toBe("invalid_value");
  expect(answer.body.error.message).toContain("alternatives");
});

test("a deployment with no embedding binding refuses a text query and says what to add", async () => {
  const workspace = await makeWorkspace({ embed: false });
  await write(workspace, [note("planning", "planning")]);

  const answer = await search(workspace, { text: "planning" });
  expect(answer.status).toBe(400);
  expect(answer.body.error.code).toBe("invalid_value");
  expect(answer.body.error.message).toContain("vectorize: { embed: { binding: \"AI\" } }");

  // A vector query still works there: the deployment chooses only how text is
  // turned into numbers, not whether search exists.
  const byVector = await search(workspace, { vector: embedWord("planning") });
  expect(byVector.status).toBe(200);
  expect(byVector.body.data.note).toHaveLength(1);
});

test("an empty or non-string text is refused before the binding is called", async () => {
  const workspace = await makeWorkspace();
  await write(workspace, [note("planning", "planning")]);

  for (const text of ["", "   ", 42, {}]) {
    const answer = await search(workspace, { text });
    expect(answer.status).toBe(400);
    expect(answer.body.error.code).toBe("invalid_value");
  }
  expect(workspace.ai!.calls).toHaveLength(0);
});

test("a configured binding that Env does not carry is a deployment error, not an empty answer", async () => {
  const workspace = await makeWorkspace({ ai: null });
  await write(workspace, [note("planning", "planning")]);

  const answer = await search(workspace, { text: "planning" });
  expect(answer.status).toBe(503);
  expect(answer.body.error.code).toBe("vector_search_unavailable");
  expect(answer.body.error.message).toContain('"AI"');
});

test("an embedding failure is retryable and does not answer as if nothing matched", async () => {
  const workspace = await makeWorkspace({ ai: fakeAi({ fail: "model overloaded" }) });
  await write(workspace, [note("planning", "planning")]);

  const answer = await search(workspace, { text: "planning" });
  expect(answer.status).toBeGreaterThanOrEqual(500);
  expect(answer.body.ok).toBe(false);
  expect(answer.body.error.message).toContain("retry");
});

test("an embedding model whose output length is not the field's is refused when the Worker is defined", () => {
  // bge-base produces 768 values; this field declares the 384 bge-small makes.
  expect(() =>
    defineTapeDB({
      schema: appSchema,
      vectorize: { index: BINDING, model: "note", field: "embedding", embed: { binding: "AI", model: "@cf/baai/bge-base-en-v1.5" } },
    })
  ).toThrow(/produces 768 values, but note\.embedding declares 384 dimensions/);
});

test("the embedding model defaults to a 768-value model, and a mismatch with the field is refused", () => {
  const wide = schema({
    note: model({ embedding: t.vector({ dimensions: 768 }).optional(), archived: t.boolean().default(false) }),
  });
  expect(() =>
    defineTapeDB({ schema: wide, vectorize: { index: BINDING, model: "note", field: "embedding", embed: { binding: "AI" } } })
  ).not.toThrow();
  expect(() =>
    defineTapeDB({
      schema: appSchema,
      vectorize: { index: BINDING, model: "note", field: "embedding", embed: { binding: "AI" } },
    })
  ).toThrow(/bge-base-en-v1\.5" produces 768 values, but note\.embedding declares 384/);
});
