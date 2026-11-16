/**
 * The Worker decides which room paths a client may reach. A path the Worker
 * keeps internal (`/files` writes, `/move/*`) must stay internal however the
 * client spells the URL.
 */

import { describe, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS } from "../src/claims";
import { signRoleClaim } from "../src/mint";
import { model, schema, t } from "../src/schema";
import { Database } from "bun:sqlite";
import { encodeTrustedRoleClaim, TRUSTED_CLAIM_HEADER } from "../src/verify";
import { FakeR2Bucket } from "./fixtures/test-support";
import { FakeRoomContext } from "./fixtures/room-harness";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");

const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";
const SECRET = "test-secret-test-secret-test-secret";
const tapedb = defineTapeDB({ schema: schema({ note: model({ body: t.string() }) }) });

function room() {
  const calls: { method: string; path: string; headers: Headers }[] = [];
  return {
    calls,
    env: {
      FILES: new FakeR2Bucket(),
      DATA: new FakeR2Bucket(),
      TAPEDB_CLAIM_SECRET: SECRET,
      ENVIRONMENT: "development",
      WORKSPACE: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (request: Request) => {
            calls.push({ method: request.method, path: new URL(request.url).pathname, headers: request.headers });
            return Response.json({ ok: true }, { status: 201 });
          },
        }),
      },
    },
  };
}

async function send(target: ReturnType<typeof room>, path: string, init: RequestInit = {}, role: number = WORKSPACE_ROLE_LEVELS.EDITOR) {
  const { token } = await signRoleClaim(SECRET, { sub: "u1", workspaceId: WORKSPACE, role });
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return tapedb.worker.fetch(
    new Request(`http://worker.test/engine/workspaces/${WORKSPACE}${path}`, { ...init, headers }),
    target.env as never,
    {} as ExecutionContext
  );
}

describe("room paths", () => {
  test("a doubled slash does not reach the file index's write route", async () => {
    const target = room();
    const response = await send(target, "//evil.test/files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "a.txt", key: "ws/other/files/secret", size: 1 }),
    });
    expect(target.calls.filter((call) => call.path === "/files" && call.method === "POST")).toEqual([]);
    expect(response.status).toBe(404);
  });

  test("a doubled slash does not reach the internal byte routes", async () => {
    const target = room();
    const response = await send(target, "//x/storage/a.txt", { method: "GET" }, WORKSPACE_ROLE_LEVELS.OWNER);
    expect(target.calls).toEqual([]);
    expect(response.status).toBe(404);
  });

  test("a doubled slash does not reach the internal move controls", async () => {
    const target = room();
    const response = await send(target, "//x/move/freeze", { method: "POST", body: "{}" }, WORKSPACE_ROLE_LEVELS.OWNER);
    expect(target.calls.filter((call) => call.path.startsWith("/move/"))).toEqual([]);
    expect(response.status).toBe(404);
  });

  test("client x-tapedb-* headers never reach the room", async () => {
    const target = room();
    await send(target, "/query", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tapedb-claims": "forged", "x-tapedb-anything": "1" },
      body: JSON.stringify({ model: "note" }),
    });
    expect(target.calls).toHaveLength(1);
    const forwarded = [...target.calls[0]!.headers.keys()].filter((name) => name.startsWith("x-tapedb-"));
    expect(forwarded).toEqual(["x-tapedb-claims"]);
    expect(target.calls[0]!.headers.get("x-tapedb-claims")).not.toBe("forged");
  });

  test("ordinary room paths still arrive unchanged", async () => {
    const target = room();
    await send(target, "/query?x=1", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(target.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /query"]);
  });
});

describe("file paths", () => {
  test("may still contain an empty segment", async () => {
    const target = room();
    const response = await send(target, "/files/a//b.txt", {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "hi",
    });
    expect(response.status).toBe(201);
    expect(target.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["PUT /storage/a//b.txt"]);
  });
});

describe("the file index", () => {
  async function realRoom() {
    const context = new FakeRoomContext(new Database(":memory:"), WORKSPACE);
    const env = { FILES: new FakeR2Bucket(), DATA: new FakeR2Bucket(), TAPEDB_CLAIM_SECRET: SECRET, ENVIRONMENT: "development" };
    const instance = new tapedb.WorkspaceRoom(context as never, env as never);
    await context.ready;
    const claim = encodeTrustedRoleClaim({ sub: "u1", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.OWNER, exp: Math.floor(Date.now() / 1000) + 60, iat: 0 } as never);
    return (body: unknown) =>
      instance.fetch(new Request("https://room.internal/files", {
        method: "POST",
        headers: { "content-type": "application/json", [TRUSTED_CLAIM_HEADER]: claim },
        body: JSON.stringify(body),
      }));
  }

  test("records only an object stored under the file's own path", async () => {
    const record = await realRoom();
    const own = `workspaces/${WORKSPACE}/files/a.txt`;
    expect((await record({ path: "a.txt", key: `${own}/.tapedb/${crypto.randomUUID()}`, size: 1 })).status).toBe(201);
    expect((await record({ path: "a.txt", key: own, size: 1 })).status).toBe(201);
    for (const key of [
      `workspaces/0190a5b2-7c3d-4e8f-9a0b-000000000000/files/a.txt`,
      `workspaces/${WORKSPACE}/files/b.txt`,
      `${own}.other`,
      `ws/${WORKSPACE}/manifest.json`,
    ]) {
      const response = await record({ path: "a.txt", key, size: 1 });
      expect(response.status).toBe(400);
    }
  });
});
