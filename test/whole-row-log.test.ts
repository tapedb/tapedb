/**
 * A whole-row log entry records the mutation that happened, not one inferred
 * from the row's timestamps. An insert stamps `created_at` and `updated_at`
 * with the same instant, so a patch in that same millisecond used to leave the
 * two equal and the entry read as an insert: the history and the audit trail
 * then reported an update as a creation.
 *
 * Time is frozen here, which makes the transition deterministic instead of a
 * race that only shows up under a loaded full-suite run.
 */
import { Database } from "bun:sqlite";
import { afterEach, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS } from "../src/claims";
import { encodeTrustedRoleClaim, TRUSTED_CLAIM_HEADER } from "../src/verify";
import { FakeRoomContext } from "./fixtures/room-harness";
import { FakeR2Bucket } from "./fixtures/test-support";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");
const { model, schema, t } = await import("../src/schema");

const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";
const FROZEN = 1_760_000_000_000;

async function setUp() {
  const tapedb = defineTapeDB({
    schema: schema({
      person: model({ email: t.string(), name: t.string().personal({ subject: "self" }) }),
    }),
  });
  const env = { FILES: new FakeR2Bucket(), DATA: new FakeR2Bucket(), TAPEDB_KEY_SECRET: "k".repeat(32), ENVIRONMENT: "development" };
  const context = new FakeRoomContext(new Database(":memory:"), WORKSPACE);
  const room = new tapedb.WorkspaceRoom(context as never, env as never);
  await context.ready;
  const now = Math.floor(realNow() / 1000);
  const write = async (ops: unknown[]) => {
    const headers = { [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim({ sub: "olivia", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.OWNER, iat: now, exp: now + 600 } as never), "content-type": "application/json" };
    const response = await room.fetch(new Request("https://room/transact", { method: "POST", headers, body: JSON.stringify({ txId: crypto.randomUUID(), ops }) }));
    if (response.status !== 200) throw new Error(`write ${response.status}: ${await response.text()}`);
  };
  const log = async () => {
    const headers = { [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim({ sub: "adam", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.ADMIN, iat: now, exp: now + 600 } as never) };
    const response = await room.fetch(new Request("https://room/log", { headers }));
    if (response.status !== 200) throw new Error(`log ${response.status}: ${await response.text()}`);
    return (await response.json()) as { data: { entries: Array<{ ops: Array<Record<string, unknown>> }> } };
  };
  return { write, log };
}

const realNow = Date.now;

afterEach(() => {
  Date.now = realNow;
});

test("a patch in the same millisecond as the insert is logged as an update", async () => {
  const { write, log } = await setUp();
  Date.now = () => FROZEN;
  await write([{ op: "insert", namespace: "person", id: "p1", values: { email: "a@x.io", name: "Ada" } }]);
  await write([{ op: "patch", namespace: "person", id: "p1", values: { email: "b@x.io" } }]);
  Date.now = realNow;

  const entries = (await log()).data.entries;
  expect(entries.map((entry) => entry.ops)).toEqual([
    [{ op: "update", namespace: "person", id: "p1", values: { email: "b@x.io" }, hidden: ["name"], whole: true }],
    [{ op: "insert", namespace: "person", id: "p1", values: { email: "a@x.io" }, hidden: ["name"], whole: true }],
  ]);
});

test("two patches in the insert's millisecond are both updates, and a delete is a delete", async () => {
  const { write, log } = await setUp();
  Date.now = () => FROZEN;
  await write([{ op: "insert", namespace: "person", id: "p1", values: { email: "a@x.io", name: "Ada" } }]);
  await write([{ op: "patch", namespace: "person", id: "p1", values: { email: "b@x.io" } }]);
  await write([{ op: "patch", namespace: "person", id: "p1", values: { email: "c@x.io" } }]);
  await write([{ op: "delete", namespace: "person", id: "p1" }]);
  Date.now = realNow;

  expect((await log()).data.entries.map((entry) => entry.ops)).toEqual([
    [{ op: "delete", namespace: "person", id: "p1" }],
    [{ op: "update", namespace: "person", id: "p1", values: { email: "c@x.io" }, hidden: ["name"], whole: true }],
    [{ op: "update", namespace: "person", id: "p1", values: { email: "b@x.io" }, hidden: ["name"], whole: true }],
    [{ op: "insert", namespace: "person", id: "p1", values: { email: "a@x.io" }, hidden: ["name"], whole: true }],
  ]);
});

test("a row inserted and patched by the same transaction is one insert", async () => {
  const { write, log } = await setUp();
  Date.now = () => FROZEN;
  await write([
    { op: "insert", namespace: "person", id: "p1", values: { email: "a@x.io", name: "Ada" } },
    { op: "patch", namespace: "person", id: "p1", values: { email: "b@x.io" } },
  ]);
  Date.now = realNow;

  expect((await log()).data.entries.map((entry) => entry.ops)).toEqual([
    [{ op: "insert", namespace: "person", id: "p1", values: { email: "b@x.io" }, hidden: ["name"], whole: true }],
  ]);
});

test("an upsert that creates a row is an insert, and one that matches an update", async () => {
  const { write, log } = await setUp();
  Date.now = () => FROZEN;
  await write([{ op: "upsert", namespace: "person", id: "p1", values: { email: "a@x.io" }, create: { email: "a@x.io", name: "Ada" } }]);
  await write([{ op: "upsert", namespace: "person", id: "p1", values: { email: "b@x.io" }, create: { email: "b@x.io", name: "Ada" } }]);
  Date.now = realNow;

  expect((await log()).data.entries.map((entry) => entry.ops)).toEqual([
    [{ op: "update", namespace: "person", id: "p1", values: { email: "b@x.io" }, hidden: ["name"], whole: true }],
    [{ op: "insert", namespace: "person", id: "p1", values: { email: "a@x.io" }, hidden: ["name"], whole: true }],
  ]);
});
