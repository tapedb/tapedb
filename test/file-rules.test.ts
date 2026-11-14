/**
 * Per-file access rules, through the real Worker and the real WorkspaceRoom.
 *
 * Without rules, file access is the workspace role: every member reads every
 * file. These tests run the byte routes and the listing end to end with
 * rules that look at the file and at the row a file is attached to.
 */

import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS } from "../src/claims";
import { signRoleClaim } from "../src/mint";
import { attachedTo, check, fileCheck, filter, model, role, schema, t } from "../src/schema";
import { FakeR2Bucket } from "./fixtures/test-support";
import { FakeRoomContext } from "./fixtures/room-harness";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");
const { executeQuery } = await import("../src/engine/query-execute");
const { durableObjectSqlExecutor } = await import("../src/engine/tx-sql");

const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";
const SECRET = "test-secret-test-secret-test-secret";
const { EDITOR, MEMBER, GUEST } = WORKSPACE_ROLE_LEVELS;

const task = model({ title: t.string(), ownerId: t.string().index() }).access({
  read: filter(({ auth }) => ({ ownerId: auth.sub })),
  create: role("guest"),
  update: check(({ auth, row }) => row?.ownerId === auth.sub),
});

/** One Worker and one room for a schema; the last one defined is installed. */
async function deployment(files: Parameters<typeof schema>[1] extends infer O ? (O extends { files?: infer F } ? F : never) : never) {
  const tapedb = defineTapeDB({ schema: schema({ task }, { files }) });
  const context = new FakeRoomContext(new Database(":memory:"), WORKSPACE);
  const bucket = new FakeR2Bucket();
  const env: Record<string, unknown> = { FILES: bucket, DATA: new FakeR2Bucket(), TAPEDB_CLAIM_SECRET: SECRET, ENVIRONMENT: "development" };
  const room = new tapedb.WorkspaceRoom(context as never, env as never);
  await context.ready;
  env.WORKSPACE = { idFromName: (name: string) => name, get: () => ({ fetch: (request: Request) => room.fetch(request) }) };

  const as = async (sub: string, level: number) => {
    const { token } = await signRoleClaim(SECRET, { sub, workspaceId: WORKSPACE, role: level as never });
    const call = (method: string, path: string, body?: BodyInit, contentType = "application/octet-stream") =>
      tapedb.worker.fetch(
        new Request(`http://worker.test/engine/workspaces/${WORKSPACE}/${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": contentType },
          ...(body === undefined ? {} : { body }),
        }),
        env as never,
        {} as ExecutionContext
      );
    return {
      put: (path: string, body = "bytes") => call("PUT", `files/${path}`, body),
      get: (path: string) => call("GET", `files/${path}`),
      del: (path: string) => call("DELETE", `files/${path}`),
      startUpload: (path: string) => call("POST", `files/${path}?uploads`),
      list: async () => {
        const response = await call("GET", "files");
        return response.ok ? ((await response.json()) as { data: Array<{ path: string; uploadedBy: string | null }> }).data : response.status;
      },
      insertTask: async (id: string, ownerId: string) => {
        const response = await call(
          "POST",
          "transact",
          JSON.stringify({ txId: crypto.randomUUID(), ops: [{ op: "insert", namespace: "task", id, values: { title: id, ownerId } }] }),
          "application/json"
        );
        expect(response.status).toBe(200);
      },
    };
  };
  return { as, bucket, sql: durableObjectSqlExecutor(context.storage as never) };
}

describe("file rules attached to rows", () => {
  test("a file follows its row: readers of the row read it, its updaters write it", async () => {
    const { as, bucket } = await deployment({
      read: attachedTo("task", (path) => path.split("/")[1]),
      write: attachedTo("task", (path) => path.split("/")[1]),
      delete: attachedTo("task", (path) => path.split("/")[1]),
    });
    const alice = await as("alice", MEMBER);
    const bob = await as("bob", MEMBER);
    await alice.insertTask("t1", "alice");
    await bob.insertTask("t2", "bob");

    expect((await alice.put("tasks/t1/plan.pdf")).status).toBe(201);
    expect((await bob.put("tasks/t2/notes.txt")).status).toBe(201);
    // Bob may not update Alice's task, so he may not attach to it, and the
    // bytes never reach R2.
    expect((await bob.put("tasks/t1/evil.txt")).status).toBe(403);
    expect((await bob.startUpload("tasks/t1/evil.bin")).status).toBe(403);
    expect([...bucket.objects.keys()].some((key) => key.includes("evil"))).toBe(false);
    // A path that names no row, or a row that does not exist, denies.
    expect((await alice.put("loose.txt")).status).toBe(403);
    expect((await alice.put("tasks/nope/x.txt")).status).toBe(403);

    // Reading: Bob cannot see Alice's task, so her file is "not found", and
    // the list leaves it out.
    expect((await alice.get("tasks/t1/plan.pdf")).status).toBe(200);
    expect((await bob.get("tasks/t1/plan.pdf")).status).toBe(404);
    expect((await alice.list()) as unknown[]).toEqual([expect.objectContaining({ path: "tasks/t1/plan.pdf", uploadedBy: "alice" })]);
    expect(((await bob.list()) as Array<{ path: string }>).map((file) => file.path)).toEqual(["tasks/t2/notes.txt"]);

    // Deleting: refused to Bob (as "not found": he cannot see it), allowed to Alice.
    expect((await bob.del("tasks/t1/plan.pdf")).status).toBe(404);
    expect((await alice.get("tasks/t1/plan.pdf")).status).toBe(200);
    expect((await alice.del("tasks/t1/plan.pdf")).status).toBe(204);
    expect((await alice.get("tasks/t1/plan.pdf")).status).toBe(404);
  });
});

describe("executeQuery", () => {
  test("applies the caller's read rules", async () => {
    // It compiled the rules but ran the query without the claim, so a
    // filter() read rule returned every matching row.
    const { as, sql } = await deployment(undefined);
    await (await as("alice", MEMBER)).insertTask("t1", "alice");
    const now = Math.floor(Date.now() / 1000);
    const bob = { sub: "bob", workspaceId: WORKSPACE, role: MEMBER, exp: now + 60, iat: now } as never;
    expect(executeQuery(sql, bob, { query: { task: { $: { where: { id: { $in: ["t1"] } } } } } }).task).toEqual([]);
    expect(executeQuery(sql, bob, { query: { task: {} } }).task).toEqual([]);
  });
});

describe("file rules over the file", () => {
  test("paths per user, deletes by the uploader, and roles below member", async () => {
    const own = fileCheck(({ auth, file }) => file.path.startsWith(`users/${auth.sub}/`));
    const { as } = await deployment({
      read: own,
      write: own,
      delete: fileCheck(({ auth, file }) => file.uploadedBy === auth.sub),
    });
    // Guests are below the default read and write roles; a rule lets them in.
    const guest = await as("g1", GUEST);
    const other = await as("g2", GUEST);
    const editor = await as("e1", EDITOR);

    expect((await guest.put("users/g1/avatar.png")).status).toBe(201);
    expect((await guest.get("users/g1/avatar.png")).status).toBe(200);
    expect((await other.get("users/g1/avatar.png")).status).toBe(404);
    expect((await other.put("users/g1/avatar.png")).status).toBe(403);
    // An editor's role does not override a rule.
    expect((await editor.get("users/g1/avatar.png")).status).toBe(404);
    expect(((await other.list()) as unknown[]).length).toBe(0);
    expect(((await guest.list()) as Array<{ uploadedBy: string }>).map((file) => file.uploadedBy)).toEqual(["g1"]);

    expect((await other.del("users/g1/avatar.png")).status).toBe(404);
    expect((await guest.del("users/g1/avatar.png")).status).toBe(204);
  });

  test("a rule that throws denies", async () => {
    const { as } = await deployment({
      write: fileCheck(() => {
        throw new Error("broken");
      }),
    });
    expect((await (await as("e1", EDITOR)).put("a.txt")).status).toBe(403);
  });

  test("without rules, roles decide as before", async () => {
    const { as } = await deployment(undefined);
    const member = await as("m1", MEMBER);
    const editor = await as("e1", EDITOR);
    expect((await member.put("a.txt")).status).toBe(403);
    expect((await editor.put("a.txt")).status).toBe(201);
    expect((await member.get("a.txt")).status).toBe(200);
    expect(await (await as("g1", GUEST)).list()).toBe(403);
  });

  test("an attachment to an unknown model is refused when the schema is built", () => {
    expect(() => schema({ task }, { files: { read: attachedTo("nope" as "task", () => "x") } })).toThrow(/not a model/);
  });
});
