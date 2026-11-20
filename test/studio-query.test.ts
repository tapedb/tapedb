/**
 * The studio's query editor: a call as written in app code, parsed as data and
 * translated by the client's own model code, over a graph rebuilt from
 * GET /schema.
 */
import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS } from "../src/claims";
import { encodeTrustedRoleClaim } from "../src/verify";
import { createSqlStorage } from "./fixtures/room-harness";
import { FakeR2Bucket, TEST_WORKSPACE } from "./fixtures/test-support";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");
const { WorkspaceRoom } = await import("../src/engine/workspace-room");
const { model, schema, t } = await import("../src/schema");
const { graphFromSchemaDocument } = await import("../src/studio/graph");
const { parseCall } = await import("../src/studio/call");
const { prepare } = await import("../src/studio/runner");
const { createClient } = await import("../src/model/client");
const { MemoryOutbox } = await import("../src/client/outbox");
const { RUNNER } = await import("../src/studio/runner.gen");
const { buildRunner } = await import("../scripts/studio-runner-build.mjs");

const app = schema({
  board: model({
    name: t.string(),
    archived: t.boolean().default(false),
    rank: t.number().default(3),
    due: t.date().optional().default(new Date("2026-01-02T00:00:00Z")),
    meta: t.json().default({ tags: ["a"] }),
    columns: t.hasMany("column"),
    owner: t.belongsTo("person").optional(),
    reviewer: t.belongsTo("person").optional(),
  }),
  column: model({ name: t.string().index(), board: t.belongsTo("board", { onDelete: "cascade" }), cards: t.hasMany("card") }),
  card: model({ title: t.string(), note: t.string().optional(), column: t.belongsTo("column") }),
  person: model({
    email: t.string().unique(),
    name: t.string().personal({ subject: "self" }),
    bio: t.json().personal({ subject: "self" }).optional(),
    owned: t.hasMany("board", { inverse: "owner" }),
  }),
});

async function schemaDocument() {
  const tapedb = defineTapeDB({ schema: app });
  const db = new Database(":memory:");
  const ctx = {
    id: { name: TEST_WORKSPACE },
    storage: { sql: createSqlStorage(db), transactionSync: <T>(fn: () => T) => db.transaction(fn)(), transaction: async <T>(fn: () => Promise<T>) => fn(), getAlarm: async () => null, setAlarm: async () => {} },
    ready: Promise.resolve() as Promise<unknown>,
    blockConcurrencyWhile<T>(fn: () => Promise<T>) {
      this.ready = fn();
      return this.ready as Promise<T>;
    },
    getWebSockets: () => [],
  };
  const room = new tapedb.WorkspaceRoom(ctx as never, { DATA: new FakeR2Bucket(), TAPEDB_KEY_SECRET: "k".repeat(32) } as never);
  await ctx.ready;
  const claim = encodeTrustedRoleClaim({ sub: "u", workspaceId: TEST_WORKSPACE, role: WORKSPACE_ROLE_LEVELS.MEMBER, iat: 0, exp: Math.floor(Date.now() / 1000) + 60 });
  const response = await room.fetch(new Request("http://room/schema", { headers: { "x-tapedb-claims": claim } }));
  return ((await response.json()) as { data: never }).data;
}

/** The graph with defaults in the form a write sends them (dates as epoch ms). */
function written(graph: typeof app.graph) {
  const walk = (value: unknown): unknown =>
    value instanceof Set ? [...value].sort()
      : value instanceof Date ? value.getTime()
        : value !== null && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, walk(v)]))
          : value;
  return walk(graph);
}

test("the graph rebuilt from the schema document is the client's graph", async () => {
  const rebuilt = graphFromSchemaDocument(await schemaDocument());
  expect(written(rebuilt)).toEqual(written(app.graph));
});

test("a call reads as data: comments, quotes, trailing commas, dates", () => {
  const call = parseCall(`
    // open cards
    await db.card.findMany({
      where: { title: { in: ['a', "b\\n", \`c\`] }, note: null, /* any */ },
      orderBy: { createdAt: "desc" },
      take: 20,
      skip: -1.5e2,
      after: new Date("2026-01-02T00:00:00Z"),
    });
  `);
  expect(call.model).toBe("card");
  expect(call.method).toBe("findMany");
  expect(call.args).toEqual({
    where: { title: { in: ["a", "b\n", "c"] }, note: null },
    orderBy: { createdAt: "desc" },
    take: 20,
    skip: -150,
    after: new Date("2026-01-02T00:00:00Z"),
  });
  expect(parseCall("card.count()")).toEqual({ model: "card", method: "count", args: undefined });
});

test("anything that is not data is refused, with where it is", () => {
  const cases: Array<[string, RegExp]> = [
    ['db.card.findMany({ where: { title: name } })', /"name" is not a value here.*line 1, column 36/],
    ["db.card.findMany({ where })", /shorthand fields need variables/],
    ["db.card.findMany(`${x}`)", /Template placeholders/],
    ["db.card.count()\ndb.card.count()", /Run one call at a time.*line 2, column 1/],
    ['db.card.findMany({ "__proto__": {} })', /__proto__/],
    ["db.card.findMany({ take: 1 }, 2)", /one argument/],
    ['db.card.findMany({ where: { title: "open', /never closed/],
    ["fetch('x')", /Expected "\."/],
  ];
  for (const [source, message] of cases) expect(() => parseCall(source)).toThrow(message);
});

test("the editor sends what the client sends for the same call", async () => {
  const document = await schemaDocument();
  const db = createClient(
    { schema: app, url: "http://engine.test", workspace: TEST_WORKSPACE, getToken: async () => "token" },
    { outbox: new MemoryOutbox(), createWebSocket: () => { throw new Error("no socket"); }, fetch: async () => { throw new Error("no fetch"); } }
  ) as unknown as Record<string, Record<string, (args: unknown) => { document?: unknown; ops?: unknown }>>;

  const read = {
    where: { archived: false, owner: { email: { in: ["a@x.io"] } }, columns: { some: { name: "Doing" } } },
    orderBy: { rank: "desc" },
    take: 5,
    select: { name: true, due: true, columns: { include: { cards: { where: { note: null } } } } },
  };
  const prepared = prepare(
    `db.board.findMany({ where: { archived: false, owner: { email: { in: ["a@x.io"] } }, columns: { some: { name: "Doing" } } },
       orderBy: { rank: "desc" }, take: 5,
       select: { name: true, due: true, columns: { include: { cards: { where: { note: null } } } } } })`,
    document
  );
  expect(prepared.plan.kind).toBe("read");
  expect((prepared.plan as { document: unknown }).document).toEqual(db.board.findMany(read).document);

  const write = { where: { id: "b1" }, data: { name: "Q1", due: new Date("2026-03-01T00:00:00Z"), columns: { connect: ["c1"] } } };
  const updated = prepare('db.board.update({ where: { id: "b1" }, data: { name: "Q1", due: new Date("2026-03-01T00:00:00Z"), columns: { connect: ["c1"] } } })', document);
  expect((updated.plan as { ops: unknown }).ops).toEqual(db.board.update(write).ops);

  expect(() => prepare("db.nothing.findMany()", document)).toThrow('There is no model "nothing". Models: board, column, card, person.');
  expect(() => prepare("db.board.drop()", document)).toThrow('"drop" is not a method here.');
  expect(() => prepare("db.person.findMany({ where: { name: \"x\" } })", document)).toThrow();
});

test("the bundled translator in the page is current and runs on its own", async () => {
  const built = await buildRunner(new URL("..", import.meta.url).pathname);
  expect(built).toBe(await Bun.file(new URL("../src/studio/runner.gen.ts", import.meta.url)).text());
  const runner = new Function(`${RUNNER}; return tapedbRunner;`)() as { prepare: typeof prepare };
  const prepared = runner.prepare("db.card.count({ where: { note: null } })", await schemaDocument());
  expect(prepared.plan).toMatchObject({ kind: "read", key: "count", document: { card: { $: { count: true, limit: 0, where: { note: null } } } } });
});
