/**
 * The seeder runner, exercised against a real workspace room.
 *
 * Everything here goes through the engine's own routes, so the tests cover the
 * properties a seeder is trusted for: the same seed gives the same rows, foreign
 * keys point at rows that exist, a `unique()` column does not repeat, one
 * transaction per batch, and a clear that empties children before parents.
 */

import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import { model, schema, t } from "../src/schema";
import { signRoleClaim } from "../src/mint";
import { FakeR2Bucket } from "./fixtures/test-support";
import { FakeRoomContext } from "./fixtures/room-harness";
import { NAMESPACES } from "../src/engine/registry";
import { defineSeeder, runSeeder } from "../src/seed";
import { SeedContext, type SeedOp, type SeedTransport } from "../src/seed/context";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));

const { defineTapeDB } = await import("../src/worker/index");

const SECRET = "seeder-test-secret-32-characters-long";

const boards = schema({
  board: model({ name: t.string(), archived: t.boolean().default(false) }),
  column: model({ name: t.string(), board: t.belongsTo("board") }),
  task: model({ title: t.string(), column: t.belongsTo("column"), done: t.boolean().default(false) }),
});

/** A room, and a transport over its own routes, so nothing is mocked out. */
async function room(definition: typeof boards, id: string) {
  const app = defineTapeDB({ schema: definition });
  const env: any = { DATA: new FakeR2Bucket(), FILES: new FakeR2Bucket(), TAPEDB_CLAIM_SECRET: SECRET };
  const context = new FakeRoomContext(new Database(":memory:"), id);
  const instance = new app.WorkspaceRoom(context as never, env);
  await context.ready;
  env.WORKSPACE = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: (request: Request) => instance.fetch(request) }),
  };
  const token = (await signRoleClaim(SECRET, { sub: "seed", workspaceId: id, role: 6 })).token;
  const call = async (path: string, body?: unknown) => {
    const response = await app.worker.fetch(
      new Request(`https://worker.test/engine/workspaces/${id}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      {} as ExecutionContext
    );
    return (await response.json()) as Record<string, any>;
  };

  const batches: SeedOp[][] = [];
  const transport: SeedTransport = {
    async transact(ops) {
      batches.push(ops);
      const body = await call("transact", { txId: crypto.randomUUID(), ops });
      if (body.ok !== true) throw new Error(JSON.stringify(body.error));
      return body.result;
    },
    async query(document) {
      const body = await call("query", { query: document });
      if (body.ok !== true) throw new Error(JSON.stringify(body.error));
      return body.data;
    },
  };
  return { call, transport, batches };
}

const rows = async (call: (path: string, body?: unknown) => Promise<Record<string, any>>, name: string) => {
  const body = await call("query", { query: { [name]: {} } });
  return body.data[name] as Array<Record<string, any>>;
};

test("the same seed gives the same rows", async () => {
  const seeder = defineSeeder<typeof boards.models>(async ({ ctx }) => {
    await ctx.create("board", 5, (rng, index) => ({
      name: `board ${index} ${rng.int(1, 1_000_000)}`,
      archived: rng.bool(0.2),
    }));
  });

  const first = await room(boards, "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b");
  const second = await room(boards, "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6c");
  const one = await runSeeder({ schema: boards, seeder, transport: first.transport, seed: "lab" });
  const two = await runSeeder({ schema: boards, seeder, transport: second.transport, seed: "lab" });

  expect(one.total).toBe(5);
  expect(two.total).toBe(5);
  const left = (await rows(first.call, "board")).map((row) => row.name);
  const right = (await rows(second.call, "board")).map((row) => row.name);
  expect(left).toEqual(right);

  const third = await room(boards, "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6d");
  await runSeeder({ schema: boards, seeder, transport: third.transport, seed: "other" });
  expect((await rows(third.call, "board")).map((row) => row.name)).not.toEqual(left);
});

test("a parent id from ctx.create satisfies the child's foreign key", async () => {
  const seeder = defineSeeder<typeof boards.models>(async ({ ctx }) => {
    const parents = await ctx.create("board", 3, (rng, index) => ({ name: `board ${index}` }));
    const columns = await ctx.create("column", 6, (rng) => ({ name: `column ${rng.int(1, 99)}`, boardId: ctx.ref(parents) }));
    await ctx.create("task", 9, (rng) => ({ title: `task ${rng.int(1, 99)}`, columnId: ctx.ref(columns) }));
  });

  const { call, transport } = await room(boards, "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6e");
  const summary = await runSeeder({ schema: boards, seeder, transport });

  expect(summary.written).toEqual({ board: 3, column: 6, task: 9 });
  const boardIds = new Set((await rows(call, "board")).map((row) => row.id));
  for (const column of await rows(call, "column")) expect(boardIds.has(column.boardId)).toBe(true);
  const columnIds = new Set((await rows(call, "column")).map((row) => row.id));
  for (const task of await rows(call, "task")) expect(columnIds.has(task.columnId)).toBe(true);
});

test("ctx.unique refuses to repeat a value", async () => {
  const seeder = defineSeeder<typeof boards.models>(async ({ ctx }) => {
    await ctx.create("board", 50, () => ({
      name: ctx.unique("board", "name", (rng) => `board-${rng.int(1, 60)}`),
    }));
  });
  const { call, transport } = await room(boards, "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a70");
  await runSeeder({ schema: boards, seeder, transport });
  const names = (await rows(call, "board")).map((row) => row.name);
  expect(names).toHaveLength(50);
  expect(new Set(names).size).toBe(50);

  const stuck = defineSeeder<typeof boards.models>(async ({ ctx }) => {
    await ctx.create("board", 2, () => ({ name: ctx.unique("board", "name", () => "same") }));
  });
  const second = await room(boards, "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a71");
  await expect(runSeeder({ schema: boards, seeder: stuck, transport: second.transport })).rejects.toThrow(
    /ran out of values/
  );
});

test("rows are written one transaction per batch, not one per row", async () => {
  const seeder = defineSeeder<typeof boards.models>(async ({ ctx }) => {
    await ctx.create("board", 1200, (_rng, index) => ({ name: `board ${index}` }));
  });
  const { call, transport, batches } = await room(boards, "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a72");
  const summary = await runSeeder({ schema: boards, seeder, transport });

  expect(summary.total).toBe(1200);
  expect(batches).toHaveLength(3);
  expect(batches.map((batch) => batch.length)).toEqual([500, 500, 200]);
  expect((await rows(call, "board")).length).toBe(1200);
});

test("clear empties children before parents", async () => {
  const seeder = defineSeeder<typeof boards.models>(async ({ ctx }) => {
    const parents = await ctx.create("board", 2, (rng, index) => ({ name: `board ${index}` }));
    const columns = await ctx.create("column", 2, (rng) => ({ name: "column", boardId: ctx.ref(parents) }));
    await ctx.create("task", 2, (rng) => ({ title: "task", columnId: ctx.ref(columns) }));
  });
  const { call, transport, batches } = await room(boards, "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a73");
  await runSeeder({ schema: boards, seeder, transport });

  const ctx = new SeedContext({ schema: boards, transport, seed: "clear" });
  const removed = await ctx.clear();
  expect(removed).toBe(6);

  const order = batches.flat().filter((op) => op.op === "delete").map((op) => op.namespace);
  expect(order[0]).toBe("task");
  expect(order[order.length - 1]).toBe("board");
  for (const name of ["board", "column", "task"]) expect((await rows(call, name)).length).toBe(0);
});

test("a dry run reports the rows and writes none", async () => {
  const seeder = defineSeeder<typeof boards.models>(async ({ ctx }) => {
    await ctx.create("board", 4, (rng, index) => ({ name: `board ${index}` }));
  });
  const { call, transport, batches } = await room(boards, "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a74");
  const summary = await runSeeder({ schema: boards, seeder, transport, dryRun: true });

  expect(summary).toMatchObject({ dryRun: true, total: 4, written: { board: 4 } });
  expect(batches).toHaveLength(0);
  expect((await rows(call, "board")).length).toBe(0);
});

test("--if-empty skips a model that already has rows", async () => {
  const seeder = defineSeeder<typeof boards.models>(async ({ ctx }) => {
    await ctx.create("board", 2, () => ({ name: "board" }));
  });
  const { call, transport } = await room(boards, "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a75");
  await runSeeder({ schema: boards, seeder, transport });
  const again = await runSeeder({ schema: boards, seeder, transport, ifEmpty: true });

  expect(again.skipped).toBe(true);
  expect(again.reason).toContain("already has");
  expect((await rows(call, "board")).length).toBe(2);
});

test("a bad row is refused with a message that names the field", async () => {
  const unknownField = defineSeeder<typeof boards.models>(async ({ ctx }) => {
    await ctx.insert("board", [{ name: "ok", nope: 1 }]);
  });
  const missing = defineSeeder<typeof boards.models>(async ({ ctx }) => {
    await ctx.insert("board", [{ archived: true }]);
  });

  const first = await room(boards, "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a76");
  await expect(runSeeder({ schema: boards, seeder: unknownField, transport: first.transport })).rejects.toThrow(
    /"board.nope" is not a field/
  );

  const second = await room(boards, "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a77");
  await expect(runSeeder({ schema: boards, seeder: missing, transport: second.transport })).rejects.toThrow(
    /missing required field\(s\): name/
  );
});

test("a personal field is refused rather than written in the clear", async () => {
  const withPersonal = schema({
    person: model({ email: t.string(), nickname: t.string().personal({ subject: "self" }) }),
  });
  const seeder = defineSeeder<typeof withPersonal.models>(async ({ ctx }) => {
    await ctx.create("person", 1, () => ({ email: "a@example.com", nickname: "Ada" }));
  });
  const transport: SeedTransport = {
    async transact() {
      throw new Error("a personal field must not reach the transport");
    },
    async query() {
      return {};
    },
  };
  await expect(runSeeder({ schema: withPersonal, seeder, transport })).rejects.toThrow(/is a personal field/);
});

test("--model restricts what a run may write", async () => {
  const seeder = defineSeeder<typeof boards.models>(async ({ ctx }) => {
    const written = await ctx.create("board", 1, () => ({ name: "board" }));
    await ctx.create("column", 1, () => ({ name: "column", boardId: ctx.ref(written) }));
  });
  const { transport } = await room(boards, "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a78");
  await expect(
    runSeeder({ schema: boards, seeder, transport, models: ["board"] })
  ).rejects.toThrow(/restricted to board and cannot write "column"/);
});

test("the model view reports uniqueness, defaults and relations", async () => {
  const transport: SeedTransport = {
    async transact() {
      return { seq: 0, applied: 0 };
    },
    async query() {
      return {};
    },
  };
  expect(NAMESPACES).toBeDefined();
  const ctx = new SeedContext({ schema: boards, transport, seed: "view" });
  const view = ctx.model("task");
  expect(view.table).toBe("task");
  expect(view.fields.title).toMatchObject({ kind: "string", optional: false });
  expect(view.fields.done).toMatchObject({ hasDefault: true });
  expect(Object.keys(view.relations)).toContain("column");
  expect(ctx.models().sort()).toEqual(["board", "column", "task"]);
});
