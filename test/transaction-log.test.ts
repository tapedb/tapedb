/**
 * GET /log: the transaction log, newest first, for admins. Values only for
 * models the caller may read in full; never for personal fields.
 */
import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS } from "../src/claims";
import { encodeTrustedRoleClaim, TRUSTED_CLAIM_HEADER } from "../src/verify";
import { FakeRoomContext } from "./fixtures/room-harness";
import { FakeR2Bucket } from "./fixtures/test-support";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");
const { filter, model, schema, t } = await import("../src/schema");

const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";

async function setUp(personal = false) {
  const tapedb = defineTapeDB({
    schema: schema({
      note: model({ body: t.string(), done: t.boolean().default(false) }),
      secret: model({ ownerId: t.string().index(), text: t.string() }).access({ read: filter(({ auth }) => ({ ownerId: auth.sub })) }),
      ...(personal ? { person: model({ email: t.string(), name: t.string().personal({ subject: "self" }) }) } : {}),
    }),
    audit: true,
  });
  const env = { FILES: new FakeR2Bucket(), DATA: new FakeR2Bucket(), TAPEDB_KEY_SECRET: "k".repeat(32), ENVIRONMENT: "development" };
  const context = new FakeRoomContext(new Database(":memory:"), WORKSPACE);
  const room = new tapedb.WorkspaceRoom(context as never, env as never);
  await context.ready;
  const as = (sub: string, role: number) => {
    const now = Math.floor(Date.now() / 1000);
    return { [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim({ sub, workspaceId: WORKSPACE, role, iat: now, exp: now + 600 } as never), "content-type": "application/json" };
  };
  const owner = as("olivia", WORKSPACE_ROLE_LEVELS.OWNER);
  const write = async (ops: unknown[]) => {
    const response = await room.fetch(new Request("https://room/transact", { method: "POST", headers: owner, body: JSON.stringify({ txId: crypto.randomUUID(), ops }) }));
    expect(response.status).toBe(200);
  };
  const log = async (headers: Record<string, string>, query = "") => {
    const response = await room.fetch(new Request(`https://room/log${query}`, { headers }));
    return { status: response.status, body: (await response.json()) as { data: { entries: Array<Record<string, unknown>>; next: number | null } } };
  };
  return { as, write, log };
}

test("the log lists each transaction newest first, with its writer, rows and values", async () => {
  const { as, write, log } = await setUp();
  await write([
    { op: "insert", namespace: "note", id: "n1", values: { body: "first", done: false } },
    { op: "insert", namespace: "note", id: "n2", values: { body: "second", done: false } },
  ]);
  await write([{ op: "insert", namespace: "secret", id: "s1", values: { ownerId: "olivia", text: "the plan" } }]);
  await write([{ op: "patchMany", namespace: "note", where: {}, values: { done: true } }]);
  await write([{ op: "delete", namespace: "note", id: "n1" }]);

  const admin = as("adam", WORKSPACE_ROLE_LEVELS.ADMIN);
  const { status, body } = await log(admin);
  expect(status).toBe(200);
  const entries = body.data.entries;
  expect(entries.map((entry) => entry.rows)).toEqual([1, 2, 1, 2]);
  expect(entries[0]).toMatchObject({ sub: "olivia", role: WORKSPACE_ROLE_LEVELS.OWNER, counts: { note: { delete: 1 } }, ops: [{ op: "delete", namespace: "note", id: "n1" }], more: 0 });
  expect(entries[1].counts).toEqual({ note: { patchIds: 2 } });
  expect(entries[1].ops).toEqual([{ op: "patchIds", namespace: "note", ids: ["n1", "n2"], count: 2, values: { done: true } }]);
  // A model whose read rule filters rows: which fields, not what was written.
  expect(entries[2].ops).toEqual([{ op: "insert", namespace: "secret", id: "s1", hidden: ["ownerId", "text"] }]);
  expect(JSON.stringify(entries)).not.toContain("the plan");
  expect(entries[3].ops).toEqual([
    { op: "insert", namespace: "note", id: "n1", values: { body: "first", done: false } },
    { op: "insert", namespace: "note", id: "n2", values: { body: "second", done: false } },
  ]);
  expect(body.data.next).toBeNull();
});

test("pages with before and limit, filters by model, and is for admins and owners only", async () => {
  const { as, write, log } = await setUp();
  for (let n = 0; n < 5; n++) await write([{ op: "insert", namespace: "note", id: `n${n}`, values: { body: String(n), done: false } }]);
  await write([{ op: "insert", namespace: "secret", id: "s1", values: { ownerId: "x", text: "y" } }]);
  const owner = as("olivia", WORKSPACE_ROLE_LEVELS.OWNER);

  const first = await log(owner, "?limit=2");
  expect(first.body.data.entries.map((entry) => (entry.ops as Array<{ id: string }>)[0].id)).toEqual(["s1", "n4"]);
  const second = await log(owner, `?limit=2&before=${first.body.data.next}`);
  expect(second.body.data.entries.map((entry) => (entry.ops as Array<{ id: string }>)[0].id)).toEqual(["n3", "n2"]);

  const secrets = await log(owner, "?model=secret");
  expect(secrets.body.data.entries).toHaveLength(1);
  expect(secrets.body.data.next).toBeNull();

  expect((await log(as("ed", WORKSPACE_ROLE_LEVELS.EDITOR))).status).toBe(403);
  expect((await log(owner, "?limit=0")).status).toBe(400);
  expect((await log(owner, "?before=x")).status).toBe(400);
  expect((await log(owner, "?model=nothing")).status).toBe(400);
});

test("with personal fields the log holds whole rows; they read as inserts, updates and deletes, personal values hidden", async () => {
  const { as, write, log } = await setUp(true);
  await write([{ op: "insert", namespace: "person", id: "p1", values: { email: "a@x.io", name: "Ada" } }]);
  await write([{ op: "patch", namespace: "person", id: "p1", values: { email: "b@x.io" } }]);
  await write([{ op: "insert", namespace: "secret", id: "s1", values: { ownerId: "o", text: "the plan" } }]);
  await write([{ op: "delete", namespace: "person", id: "p1" }]);
  const { body } = await log(as("adam", WORKSPACE_ROLE_LEVELS.ADMIN));
  const ops = body.data.entries.map((entry) => entry.ops);
  expect(ops).toEqual([
    [{ op: "delete", namespace: "person", id: "p1" }],
    [{ op: "insert", namespace: "secret", id: "s1", hidden: ["ownerId", "text"], whole: true }],
    [{ op: "update", namespace: "person", id: "p1", values: { email: "b@x.io" }, hidden: ["name"], whole: true }],
    [{ op: "insert", namespace: "person", id: "p1", values: { email: "a@x.io" }, hidden: ["name"], whole: true }],
  ]);
  expect(JSON.stringify(body)).not.toContain("Ada");
  expect(JSON.stringify(body)).not.toContain("the plan");
});
