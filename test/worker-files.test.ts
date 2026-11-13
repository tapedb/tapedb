/**
 * Uploads through the Worker: bytes to R2, then a row in the workspace index.
 *
 * The two writes cannot share a transaction, so the Worker orders them and
 * cleans up when the second fails: an object no index lists would cost
 * storage forever and never show up anywhere.
 */

import { describe, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS } from "../src/claims";
import { signRoleClaim } from "../src/mint";
import { model, schema, t } from "../src/schema";
import { FakeR2Bucket } from "./fixtures/test-support";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");

const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";
const SECRET = "test-secret-test-secret-test-secret";
const tapedb = defineTapeDB({ schema: schema({ note: model({ body: t.string() }) }) });

function env(roomStatus: number) {
  const files = new FakeR2Bucket();
  const roomCalls: string[] = [];
  return {
    files,
    roomCalls,
    env: {
      FILES: files,
      DATA: new FakeR2Bucket(),
      TAPEDB_CLAIM_SECRET: SECRET,
      ENVIRONMENT: "development",
      WORKSPACE: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (request: Request) => {
            roomCalls.push(`${request.method} ${new URL(request.url).pathname}`);
            return new Response(JSON.stringify({ ok: roomStatus < 300 }), { status: roomStatus });
          },
        }),
      },
    },
  };
}

async function upload(target: ReturnType<typeof env>) {
  const { token } = await signRoleClaim(SECRET, { sub: "u1", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.EDITOR });
  return tapedb.worker.fetch(
    new Request(`http://worker.test/engine/workspaces/${WORKSPACE}/files/avatars/me.png`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    }),
    target.env as never,
    {} as ExecutionContext
  );
}

describe("uploads", () => {
  test("store the bytes and record them in the index", async () => {
    const target = env(201);
    const response = await upload(target);
    expect(response.status).toBe(201);
    expect(target.roomCalls).toEqual(["POST /files"]);
    expect([...target.files.objects.keys()]).toHaveLength(1);
  });

  test("take the bytes back out when the index write fails", async () => {
    const target = env(500);
    const response = await upload(target);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("file_index_failed");
    // Before, the object stayed in R2 with nothing pointing at it.
    expect([...target.files.objects.keys()]).toEqual([]);
  });
});
