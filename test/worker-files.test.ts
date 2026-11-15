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
import { createStorageClient, StorageError, UPLOAD_PART_BYTES } from "../src/client/storage-client";
import { FakeR2Bucket } from "./fixtures/test-support";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB, MAX_UPLOAD_BYTES } = await import("../src/worker/index");

const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";
const SECRET = "test-secret-test-secret-test-secret";
const tapedb = defineTapeDB({ schema: schema({ note: model({ body: t.string() }) }) });

function env(roomStatus: number) {
  const files = new FakeR2Bucket();
  const roomCalls: string[] = [];
  let key: string | undefined;
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
            const path = new URL(request.url).pathname;
            roomCalls.push(`${request.method} ${path}`);
            if (path === "/files/locate") return Response.json({ key });
            if (roomStatus < 300 && request.method === "POST") key = (await request.json() as { key?: string }).key;
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

  test("serve bytes with a non-executable content policy", async () => {
    const target = env(201);
    await upload(target);
    const { token } = await signRoleClaim(SECRET, {
      sub: "u1",
      workspaceId: WORKSPACE,
      role: WORKSPACE_ROLE_LEVELS.MEMBER,
    });
    const response = await tapedb.worker.fetch(
      new Request(`http://worker.test/engine/workspaces/${WORKSPACE}/files/avatars/me.png`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      target.env as never,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });

  test("refuse an oversized body without buffering it or waking the room", async () => {
    const target = env(201);
    const { token } = await signRoleClaim(SECRET, {
      sub: "u1",
      workspaceId: WORKSPACE,
      role: WORKSPACE_ROLE_LEVELS.EDITOR,
    });
    const response = await tapedb.worker.fetch(
      new Request(`http://worker.test/engine/workspaces/${WORKSPACE}/files/avatars/big.bin`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
        body: new Uint8Array(MAX_UPLOAD_BYTES + 1),
      }),
      target.env as never,
      {} as ExecutionContext
    );

    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("upload_too_large");
    expect(target.roomCalls).toEqual([]);
    expect([...target.files.objects.keys()]).toEqual([]);
  });
});

async function call(target: ReturnType<typeof env>, method: string, query: string, body?: BodyInit, role: number = WORKSPACE_ROLE_LEVELS.EDITOR, path = "videos/big.mp4") {
  const { token } = await signRoleClaim(SECRET, { sub: "u1", workspaceId: WORKSPACE, role: role as never });
  return tapedb.worker.fetch(
    new Request(`http://worker.test/engine/workspaces/${WORKSPACE}/files/${path}${query}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": method === "POST" && query === "?uploads" ? "video/mp4" : "application/octet-stream" },
      ...(body === undefined ? {} : { body }),
    }),
    target.env as never,
    {} as ExecutionContext
  );
}

const MiB = 1024 * 1024;
function bytes(size: number, fill: number) {
  return new Uint8Array(size).fill(fill);
}

describe("multipart uploads", () => {
  test("store a file larger than one request, recorded once with its full size", async () => {
    const target = env(201);
    const started = await call(target, "POST", "?uploads");
    expect(started.status).toBe(201);
    const { uploadId } = (await started.json()) as { uploadId: string };

    const sizes = [16 * MiB, 16 * MiB, 3 * MiB];
    const parts = [];
    for (const [index, size] of sizes.entries()) {
      const response = await call(target, "PUT", `?uploadId=${uploadId}&partNumber=${index + 1}`, bytes(size, index + 1));
      expect(response.status).toBe(200);
      parts.push(await response.json());
    }
    // Nothing is listed, and nothing is in R2, until the upload completes.
    expect(target.roomCalls).toEqual([]);
    expect([...target.files.objects.keys()]).toEqual([]);

    const done = await call(target, "POST", `?uploadId=${uploadId}`, JSON.stringify({ parts }));
    expect(done.status).toBe(201);
    const total = sizes.reduce((sum, size) => sum + size, 0);
    expect(await done.json()).toMatchObject({ size: total });
    expect(total).toBeGreaterThan(MAX_UPLOAD_BYTES);
    expect(target.roomCalls).toEqual(["POST /files"]);

    const stored = [...target.files.objects.values()][0] as { body: Uint8Array; contentType?: string };
    expect(stored.body.byteLength).toBe(total);
    expect(stored.contentType).toBe("video/mp4");
    expect([stored.body[0], stored.body[16 * MiB], stored.body[total - 1]]).toEqual([1, 2, 3]);
  });

  test("take the object back out when the index write fails", async () => {
    const target = env(500);
    const { uploadId } = (await (await call(target, "POST", "?uploads")).json()) as { uploadId: string };
    const part = await (await call(target, "PUT", `?uploadId=${uploadId}&partNumber=1`, bytes(1024, 7))).json();
    const done = await call(target, "POST", `?uploadId=${uploadId}`, JSON.stringify({ parts: [part] }));
    expect(done.status).toBe(502);
    expect([...target.files.objects.keys()]).toEqual([]);
  });

  test("need an editor, refuse oversized parts, and abort cleanly", async () => {
    const target = env(201);
    expect((await call(target, "POST", "?uploads", undefined, WORKSPACE_ROLE_LEVELS.MEMBER)).status).toBe(403);
    expect(target.files.multipartUploads).toBe(0);

    const { uploadId } = (await (await call(target, "POST", "?uploads")).json()) as { uploadId: string };
    expect((await call(target, "PUT", `?uploadId=${uploadId}&partNumber=1`, bytes(1, 1), WORKSPACE_ROLE_LEVELS.MEMBER)).status).toBe(403);
    const big = await call(target, "PUT", `?uploadId=${uploadId}&partNumber=1`, bytes(MAX_UPLOAD_BYTES + 1, 1));
    expect(big.status).toBe(413);
    expect((await call(target, "PUT", `?uploadId=${uploadId}&partNumber=0`, bytes(1, 1))).status).toBe(400);
    // An upload id is bound to its file: another path cannot complete it.
    expect((await call(target, "POST", `?uploadId=${uploadId}`, JSON.stringify({ parts: [{ partNumber: 1, etag: "part-1" }] }), WORKSPACE_ROLE_LEVELS.EDITOR, "other.bin")).status).toBe(400);

    expect((await call(target, "DELETE", `?uploadId=${uploadId}`)).status).toBe(204);
    expect(target.files.openUploads).toBe(0);
    expect(target.roomCalls).toEqual([]);
  });
});

describe("the storage client", () => {
  async function client(target: ReturnType<typeof env>) {
    const { token } = await signRoleClaim(SECRET, { sub: "u1", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.EDITOR });
    const requests: Array<{ method: string; query: string; bytes: number }> = [];
    const storage = createStorageClient({
      apiUrl: "http://worker.test",
      workspaceId: WORKSPACE,
      getToken: async () => token,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push({ method: request.method, query: new URL(request.url).search, bytes: Number(request.headers.get("content-length") ?? (init?.body instanceof Blob ? init.body.size : 0)) });
        return tapedb.worker.fetch(request, target.env as never, {} as ExecutionContext);
      },
    });
    return { storage, requests };
  }

  test("uploads a file of any size, every request inside the Worker's limit", async () => {
    const target = env(201);
    const { storage, requests } = await client(target);
    const size = 2 * UPLOAD_PART_BYTES + 5 * MiB + 17;
    const file = new Blob([bytes(size, 9)], { type: "video/mp4" });

    expect(await storage.upload("videos/big.mp4", file)).toMatchObject({ size });
    const stored = [...target.files.objects.values()][0] as { body: Uint8Array; contentType?: string };
    expect(stored.body.byteLength).toBe(size);
    expect(stored.contentType).toBe("video/mp4");
    expect(requests.map((request) => request.method)).toEqual(["POST", "PUT", "PUT", "PUT", "POST"]);
    expect(Math.max(...requests.map((request) => request.bytes))).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
    expect(target.roomCalls).toEqual(["POST /files"]);
  });

  test("sends a small file in one request", async () => {
    const target = env(201);
    const { storage, requests } = await client(target);
    await storage.upload("a.txt", new Blob(["hello"], { type: "text/plain" }));
    expect(requests.map((request) => `${request.method} ${request.query}`)).toEqual(["PUT "]);
  });

  test("abandons the upload when a part fails, leaving nothing behind", async () => {
    const target = env(201);
    const { storage, requests } = await client(target);
    const file = new Blob([bytes(UPLOAD_PART_BYTES + 1, 1)]);
    const createMultipartUpload = target.files.createMultipartUpload.bind(target.files);
    target.files.createMultipartUpload = async (...args: Parameters<typeof createMultipartUpload>) => {
      const upload = await createMultipartUpload(...args);
      target.files.failPuts = true;
      return upload;
    };

    await expect(storage.upload("videos/big.mp4", file)).rejects.toBeInstanceOf(StorageError);
    expect(requests.at(-1)?.method).toBe("DELETE");
    expect(target.files.openUploads).toBe(0);
    expect(target.roomCalls).toEqual([]);
  });
});

describe("engine routes", () => {
  test("never reach a Durable Object without a verified claim, status included", async () => {
    for (const path of ["status", "query", "transact", "export", "schema", "websocket"]) {
      const target = env(200);
      const response = await tapedb.worker.fetch(
        new Request(`http://worker.test/engine/workspaces/${WORKSPACE}/${path}`),
        target.env as never,
        {} as ExecutionContext
      );
      expect([path, response.status]).toEqual([path, 401]);
      // No object is woken, migrated or created for an unauthenticated caller.
      expect(target.roomCalls).toEqual([]);
    }

    const target = env(200);
    const { token } = await signRoleClaim(SECRET, { sub: "u1", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.MEMBER });
    const status = await tapedb.worker.fetch(
      new Request(`http://worker.test/engine/workspaces/${WORKSPACE}/status`, { headers: { authorization: `Bearer ${token}` } }),
      target.env as never,
      {} as ExecutionContext
    );
    expect(status.status).toBe(200);
    expect(target.roomCalls).toEqual(["GET /status"]);
  });

  test("the file index changes only through the byte routes, and lists for members", async () => {
    const call = async (method: string, role: number, body?: unknown) => {
      const target = env(200);
      const { token } = await signRoleClaim(SECRET, { sub: "u1", workspaceId: WORKSPACE, role: role as never });
      const response = await tapedb.worker.fetch(
        new Request(`http://worker.test/engine/workspaces/${WORKSPACE}/files`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        target.env as never,
        {} as ExecutionContext
      );
      return { status: response.status, roomCalls: target.roomCalls };
    };

    // Writing the index directly: never, whatever the role.
    const fake = { path: "ghost.txt", key: "workspaces/other/files/secret", size: 1 };
    for (const role of [WORKSPACE_ROLE_LEVELS.GUEST, WORKSPACE_ROLE_LEVELS.EDITOR, WORKSPACE_ROLE_LEVELS.OWNER]) {
      expect(await call("POST", role, fake)).toEqual({ status: 405, roomCalls: [] });
      expect(await call("DELETE", role, { path: "avatars/me.png" })).toEqual({ status: 405, roomCalls: [] });
    }
    // Listing it: the role that reads files.
    expect(await call("GET", WORKSPACE_ROLE_LEVELS.USER)).toEqual({ status: 403, roomCalls: [] });
    expect(await call("GET", WORKSPACE_ROLE_LEVELS.MEMBER)).toEqual({ status: 200, roomCalls: ["GET /files"] });
  });
});
