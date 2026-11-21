/**
 * Reranking: a cross-encoder scores the candidate window against the question,
 * and its order replaces the fused one.
 *
 * The reranker is a Workers AI binding (`@cf/baai/bge-reranker-base` by
 * default), so this suite drives it through the same seam a deployment uses: a
 * fake binding that answers like the model, including the failure that must not
 * turn into an empty answer.
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

const ID = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5c01";
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

interface RerankBehaviour {
  /** Score per passage, in the order the passages were sent. */
  scores?: number[];
  fail?: string;
}

/** One AI binding that embeds and reranks, as the deployment's would. */
function fakeAi(behaviour: RerankBehaviour = {}) {
  const rerankCalls: Array<{ query: string; passages: string[] }> = [];
  return {
    rerankCalls,
    binding: {
      async run(_model: string, input: any) {
        if (Array.isArray(input?.contexts)) {
          rerankCalls.push({ query: String(input.query), passages: input.contexts.map((c: { text: string }) => c.text) });
          if (behaviour.fail !== undefined) throw new Error(behaviour.fail);
          const scores = behaviour.scores ?? input.contexts.map(() => 0.5);
          return {
            response: input.contexts.map((_: unknown, id: number) => ({ id, score: scores[id] ?? 0.5 })),
          };
        }
        return { data: [embedWord(String(input.text?.[0] ?? ""))] };
      },
    },
  };
}

afterEach(() => setSystemTime());

async function makeWorkspace(behaviour: RerankBehaviour = {}) {
  const ai = fakeAi(behaviour);
  const app = defineTapeDB({
    schema: appSchema,
    vectorize: {
      index: BINDING,
      model: "note",
      field: "embedding",
      filterFields: ["archived"],
      embed: { binding: "AI", model: "@cf/baai/bge-small-en-v1.5" },
      keywordFields: ["title", "excerpt"],
      rerank: { binding: "AI" },
    },
  });
  const db = new Database(":memory:");
  const context = new FakeRoomContext(db, ID);
  const env = { DATA: new FakeR2Bucket(), FILES: new FakeR2Bucket(), AI: ai.binding } as unknown as Env;
  const index = new MemoryVectorIndex(BINDING, DIMENSIONS);
  const room = new app.WorkspaceRoom(context as never, env, { vectorIndex: index as VectorIndex });
  await context.ready;
  return { app, db, context, env, index, room, ai };
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

async function seed(workspace: Workspace) {
  const written = await call(workspace, "/transact", {
    txId: crypto.randomUUID(),
    ops: [
      {
        op: "insert",
        namespace: "note",
        id: "first",
        values: { title: "Planning notes", excerpt: "quarterly", archived: false, embedding: embedWord("planning") },
      },
      {
        op: "insert",
        namespace: "note",
        id: "second",
        values: { title: "Planning appendix", excerpt: "quarterly", archived: false, embedding: embedWord("planning") },
      },
    ],
  });
  expect(written.status).toBe(200);
  await workspace.room.alarm();
}

const search = (workspace: Workspace, body: Record<string, unknown>) =>
  call(workspace, "/search", { model: "note", limit: 5, ...body });

test("the reranker decides the order, and its relevance is the score", async () => {
  // It scores the second passage it is sent highest, whatever retrieval said.
  const workspace = await makeWorkspace({ scores: [0.2, 0.9] });
  await seed(workspace);

  const answer = await search(workspace, { text: "planning" });
  expect(answer.status).toBe(200);
  expect(answer.body.search.reranked).toBe(true);
  expect(answer.body.search.mode).toBe("hybrid");
  expect(answer.body.data.note[0].id).toBe("second");
  expect(answer.body.search.scores.second).toBe(0.9);
  expect(answer.body.search.scores.first).toBe(0.2);
  // The passages sent were the keyword fields, not the whole row.
  expect(workspace.ai.rerankCalls).toHaveLength(1);
  expect(workspace.ai.rerankCalls[0]!.query).toBe("planning");
  expect(workspace.ai.rerankCalls[0]!.passages[0]).toContain("Planning");
});

test("a reranker that fails leaves the retrieval order and says it was not reranked", async () => {
  const workspace = await makeWorkspace({ fail: "reranker unavailable" });
  await seed(workspace);

  const answer = await search(workspace, { text: "planning" });
  expect(answer.status).toBe(200);
  expect(answer.body.search.reranked).toBe(false);
  expect(answer.body.data.note).toHaveLength(2);
  expect(answer.body.search.scores).toBeDefined();
});

test("a vector query is not reranked, because a cross-encoder reads words", async () => {
  const workspace = await makeWorkspace({ scores: [0.2, 0.9] });
  await seed(workspace);

  const answer = await search(workspace, { vector: embedWord("planning") });
  expect(answer.status).toBe(200);
  expect(answer.body.search.reranked).toBe(false);
  expect(workspace.ai.rerankCalls).toHaveLength(0);
});

test("a reranker without keyword fields, or without an embedding binding, is refused when the Worker is defined", () => {
  expect(() =>
    defineTapeDB({
      schema: appSchema,
      vectorize: {
        index: BINDING,
        model: "note",
        field: "embedding",
        embed: { binding: "AI", model: "@cf/baai/bge-small-en-v1.5" },
        rerank: { binding: "AI" },
      },
    })
  ).toThrow(/rerank needs vectorize\.keywordFields/);

  expect(() =>
    defineTapeDB({
      schema: appSchema,
      vectorize: {
        index: BINDING,
        model: "note",
        field: "embedding",
        keywordFields: ["title"],
        rerank: { binding: "AI" },
      },
    })
  // `keywordFields` already requires `embed`, so the first refusal is the one a
  // caller sees; both name the missing option.
  ).toThrow(/needs vectorize\.embed/);
});
