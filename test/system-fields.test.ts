/**
 * The system columns every row carries (`createdAt`, `updatedAt`, `updatedSeq`)
 * are addressable on every read path and on no write path.
 *
 * The client already offered them to `select`, `groupBy` and the aggregate
 * measures; the engine resolved them only for `select`, so the same call passed
 * on one side and failed with `unknown_attribute` on the other.
 */

import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import { model, schema, t } from "../src/schema";
import { signRoleClaim } from "../src/mint";
import { FakeR2Bucket } from "./fixtures/test-support";
import { FakeRoomContext } from "./fixtures/room-harness";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));

const { defineTapeDB } = await import("../src/worker/index");

const ID = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";
const SECRET = "system-fields-test-secret-32-characters";

async function harness() {
  const app = defineTapeDB({
    schema: schema({ note: model({ title: t.string(), done: t.boolean().default(false) }) }),
  });
  const data = new FakeR2Bucket();
  const env: any = { DATA: data, FILES: new FakeR2Bucket(), TAPEDB_CLAIM_SECRET: SECRET };
  const context = new FakeRoomContext(new Database(":memory:"), ID);
  const room = new app.WorkspaceRoom(context as never, env);
  await context.ready;
  env.WORKSPACE = {
    idFromName: (id: string) => id,
    get: () => ({ fetch: (request: Request) => room.fetch(request) }),
  };
  const token = (await signRoleClaim(SECRET, { sub: "owner", workspaceId: ID, role: 6 })).token;
  const call = (path: string, body?: unknown) =>
    app.worker.fetch(
      new Request(`https://worker.test/engine/workspaces/${ID}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      {} as ExecutionContext
    );
  return { call };
}

test("system columns are readable, sortable, filterable and groupable", async () => {
  const { call } = await harness();

  for (const [index, title] of ["first", "second", "third"].entries()) {
    const written = await call("transact", {
      txId: `write-${index}`,
      ops: [{ op: "insert", namespace: "note", id: `note-${index}`, values: { title, done: false } }],
    });
    expect(await written.json()).toMatchObject({ ok: true });
  }

  const selected = await call("query", {
    query: { note: { $: { select: ["title", "createdAt", "updatedSeq"], limit: 1 } } },
  });
  const selectedBody: any = await selected.json();
  expect(selectedBody.ok).toBe(true);
  expect(selectedBody.data.note[0]).toHaveProperty("createdAt");
  expect(selectedBody.data.note[0]).toHaveProperty("updatedSeq");

  // Two writes can share a millisecond, so the total order is `updatedSeq`.
  const ordered = await call("query", {
    query: { note: { $: { order: { updatedSeq: "desc" }, select: ["title"] } } },
  });
  const orderedBody: any = await ordered.json();
  expect(orderedBody.ok).toBe(true);
  expect(orderedBody.data.note.map((row: any) => row.title)).toEqual(["third", "second", "first"]);

  const byDate = await call("query", {
    query: { note: { $: { order: { createdAt: "desc" }, select: ["title"] } } },
  });
  expect((await byDate.json()).ok).toBe(true);

  const filtered = await call("query", {
    query: { note: { $: { where: { createdAt: { $gte: 0 } }, select: ["title"] } } },
  });
  const filteredBody: any = await filtered.json();
  expect(filteredBody.ok).toBe(true);
  expect(filteredBody.data.note).toHaveLength(3);

  const filteredOut = await call("query", {
    query: { note: { $: { where: { createdAt: { $lt: 0 } }, select: ["title"] } } },
  });
  const filteredOutBody: any = await filteredOut.json();
  expect(filteredOutBody.ok).toBe(true);
  expect(filteredOutBody.data.note).toHaveLength(0);

  const grouped = await call("query", {
    query: { note: { $: { limit: 0, aggregate: { count: true, groupBy: ["createdAt"] } } } },
  });
  const groupedBody: any = await grouped.json();
  expect(groupedBody.ok).toBe(true);
  const groups = groupedBody.pageInfo.note.aggregate as Array<{ key: { createdAt: number }; count: number }>;
  expect(groups.length).toBeGreaterThan(0);
  expect(groups.every((group) => typeof group.key.createdAt === "number")).toBe(true);
  expect(groups.reduce((total, group) => total + group.count, 0)).toBe(3);
});

test("system columns stay engine-owned on the write paths", async () => {
  const { call } = await harness();

  await call("transact", {
    txId: "write",
    ops: [{ op: "insert", namespace: "note", id: "note-1", values: { title: "one", done: false } }],
  });

  for (const field of ["createdAt", "updatedAt", "updatedSeq"]) {
    const patched = await call("transact", {
      txId: `patch-${field}`,
      ops: [{ op: "patch", namespace: "note", id: "note-1", values: { [field]: 1 } }],
    });
    const body: any = await patched.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("unknown_attribute");
  }
});
