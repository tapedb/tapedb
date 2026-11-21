/**
 * `t.enum(...)`: a string with a closed set of values.
 *
 * The column is TEXT, the migration snapshot does not record the set, and the
 * engine refuses a write outside it. These tests cover the refusal, the
 * metadata that reaches the registry, and the builder's own guards.
 */

import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import { model, schema, t } from "../src/schema";
import { signRoleClaim } from "../src/mint";
import { FakeR2Bucket } from "./fixtures/test-support";
import { FakeRoomContext } from "./fixtures/room-harness";
import { SeedContext, type SeedTransport } from "../src/seed/context";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));

const { defineTapeDB } = await import("../src/worker/index");

const SECRET = "enum-test-secret-32-characters-long";  // gitleaks:allow (test fixture, not a credential)

const orders = schema({
  order: model({
    reference: t.string(),
    status: t.enum(["pending", "paid", "shipped"]).default("pending"),
    channel: t.enum(["web", "app"]).optional(),
    tier: t.enum(["basic", "plus"]).index(),
    code: t.enum(["a", "b"]).unique(),
  }),
});

async function room(definition: typeof orders, id: string) {
  const app = defineTapeDB({ schema: definition });
  const env: any = { DATA: new FakeR2Bucket(), FILES: new FakeR2Bucket(), TAPEDB_CLAIM_SECRET: SECRET };
  const context = new FakeRoomContext(new Database(":memory:"), id);
  const instance = new app.WorkspaceRoom(context as never, env);
  await context.ready;
  env.WORKSPACE = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: (request: Request) => instance.fetch(request) }),
  };
  const token = (await signRoleClaim(SECRET, { sub: "test", workspaceId: id, role: 6 })).token;
  return async (path: string, body?: unknown) => {
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
}

const row = { reference: "A-1", status: "paid", channel: "web", tier: "plus", code: "a" };

test("a declared value is written", async () => {
  const call = await room(orders, "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5aa1");
  const body = await call("transact", {
    txId: "ok",
    ops: [{ op: "insert", namespace: "order", id: "o1", values: row }],
  });
  expect(body.ok).toBe(true);
  const read = await call("query", { query: { order: {} } });
  expect(read.data.order[0]).toMatchObject({ status: "paid", channel: "web" });
});

test("a value outside the set is refused, on insert and on patch", async () => {
  const call = await room(orders, "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5aa2");

  const inserted = await call("transact", {
    txId: "bad-insert",
    ops: [{ op: "insert", namespace: "order", id: "o1", values: { ...row, status: "PICKED" } }],
  });
  expect(inserted.ok).toBe(false);
  expect(inserted.error.code).toBe("invalid_value");
  expect(inserted.error.message).toContain("pending, paid, shipped");

  await call("transact", { txId: "ok", ops: [{ op: "insert", namespace: "order", id: "o1", values: row }] });
  const patched = await call("transact", {
    txId: "bad-patch",
    ops: [{ op: "patch", namespace: "order", id: "o1", values: { status: "cancelled" } }],
  });
  expect(patched.ok).toBe(false);
  expect(patched.error.code).toBe("invalid_value");
});

test("the registry carries the values, the default, and the flags", () => {
  const attributes = orders.registry.namespaces.find((namespace) => namespace.apiName === "order")?.attributes ?? {};
  expect(attributes.status).toMatchObject({ type: "string", values: ["pending", "paid", "shipped"], default: "pending" });
  expect(attributes.channel).toMatchObject({ optional: true, values: ["web", "app"] });
  expect(attributes.tier?.indexed).toBe(true);
  expect(attributes.code?.unique).toBe(true);
  // An enum is a string in the table, so nothing about the DDL changes.
  expect(attributes.tier?.type).toBe("string");
});

test("the builder refuses an empty set, a repeat, and a default outside the set", () => {
  expect(() => t.enum([])).toThrow(/at least one value/);
  expect(() => t.enum(["a", "a"])).toThrow(/repeats "a"/);
  expect(() => t.enum(["a", "b"]).default("c" as never)).toThrow(/is not one of/);
  expect(() => t.enum(["a"]).personal()).toThrow(/cannot be personal/);
});

test("a seeder can read the set from the model view", async () => {
  const transport: SeedTransport = {
    async transact() {
      return { seq: 0, applied: 0 };
    },
    async query() {
      return {};
    },
  };
  const ctx = new SeedContext({ schema: orders, transport, seed: "enum" });
  expect(ctx.model("order").fields.status).toMatchObject({ values: ["pending", "paid", "shipped"], hasDefault: true });
  expect(ctx.model("order").fields.channel?.values).toEqual(["web", "app"]);
});
