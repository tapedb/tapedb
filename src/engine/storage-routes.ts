/** R2 file operations run inside the owning room's tracked request. */
import { WORKSPACE_ROLE_LEVELS } from "../claims";
import { apiError, discardBody, json } from "../http";
import type { Env } from "../types";
import { fileRulesConfigured } from "./file-access";
import { filesPrefix } from "./r2-keys";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export type StorageDispatch = (env: Env, workspaceId: string, path: string, init: RequestInit, trustedClaim: string) => Promise<Response>;

/** Metadata dispatch is local to the same room, never another binding fetch. */
export function storageHandler(callRoom: StorageDispatch) {
  function storageKey(workspaceId: string, objectKey: string): string {
    return `${filesPrefix(workspaceId)}${objectKey}`;
  }
/**
 * Reads a request body without ever holding more than `limit` bytes. A
 * content-length check is not enough: a chunked request can omit or lie about
 * it, and buffering the whole body first would turn an oversized upload into a
 * Worker memory problem.
 */
async function readBodyWithinLimit(
  request: Request,
  limit: number
): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Records stored bytes in the workspace's file index. A failure is reported
 * rather than swallowed, and the bytes are taken back out: an object nobody
 * can list is an orphan that costs storage forever. If that delete fails too,
 * the 502 still tells the caller to retry, and a retry overwrites the key.
 */
async function recordUpload(
  env: Env,
  bucket: R2Bucket,
  workspaceId: string,
  objectKey: string,
  key: string,
  size: number,
  contentType: string,
  trustedClaim: string
): Promise<Response> {
  let recorded: Response;
  try { recorded = await callRoom(
    env,
    workspaceId,
    "/files",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: objectKey, key, size, contentType }),
    },
    trustedClaim
  ); } catch {
    try { await bucket.delete(key); } catch { /* Erasure also removes unindexed versions. */ }
    return apiError(502, "file_index_failed", "Could not record the upload in the workspace index.");
  }
  if (!recorded.ok) {
    try {
      await bucket.delete(key);
    } catch {
      // Best effort.
    }
    if (recorded.status === 403) return recorded;
    return apiError(502, "file_index_failed", "Could not record the upload in the workspace index; nothing was stored.");
  }
  const indexed = await recorded.json() as { previousKey?: string };
  if (indexed.previousKey && indexed.previousKey !== key) await bucket.delete(indexed.previousKey);
  return json({ key, size }, 201);
}

/**
 * Uploads of any size, as R2 multipart uploads on the file's own URL:
 *
 * - `POST ?uploads` starts one (the request's content type is the file's)
 *   and answers `{ uploadId }`.
 * - `PUT ?uploadId=…&partNumber=n` stores part n (1-10000), at most
 *   `MAX_UPLOAD_BYTES`; every part but the last must be at least 5 MiB, and
 *   all but the last the same size. Answers `{ partNumber, etag }`.
 * - `POST ?uploadId=…` with `{ parts: [{ partNumber, etag }] }` completes it
 *   and records the file in the index, like a single PUT.
 * - `DELETE ?uploadId=…` abandons it; R2 also drops unfinished ones itself.
 *
 * Nothing is listed until the upload completes.
 */
async function handleMultipart(
  request: Request,
  env: Env,
  bucket: R2Bucket,
  workspaceId: string,
  objectKey: string,
  key: string,
  query: URLSearchParams,
  trustedClaim: string
): Promise<Response> {
  if (request.method === "POST" && query.has("uploads")) {
    await discardBody(request);
    const contentType = request.headers.get("content-type") ?? "application/octet-stream";
    const version = crypto.randomUUID();
    const upload = await bucket.createMultipartUpload(`${key}/.tapedb/${version}`, { httpMetadata: { contentType } });
    return json({ uploadId: `${version}:${upload.uploadId}` }, 201);
  }

  const uploadId = query.get("uploadId");
  if (!uploadId) {
    await discardBody(request);
    return apiError(400, "invalid_upload", "A multipart request needs ?uploads or ?uploadId=.");
  }
  const separator = uploadId.indexOf(":");
  if (separator >= 0 && /^[0-9a-f-]{36}$/.test(uploadId.slice(0, separator))) {
    key = `${key}/.tapedb/${uploadId.slice(0, separator)}`;
  }
  const upload = bucket.resumeMultipartUpload(key, separator >= 0 ? uploadId.slice(separator + 1) : uploadId);

  try {
    if (request.method === "PUT") {
      const partNumber = Number(query.get("partNumber"));
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
        await discardBody(request);
        return apiError(400, "invalid_upload", "partNumber must be an integer from 1 to 10000.");
      }
      const body = await readBodyWithinLimit(request, MAX_UPLOAD_BYTES);
      if (body === null) {
        return apiError(413, "upload_too_large", `A part is at most ${MAX_UPLOAD_BYTES} bytes; send the file in more parts.`);
      }
      const part = await upload.uploadPart(partNumber, body);
      return json({ partNumber: part.partNumber, etag: part.etag });
    }

    if (request.method === "POST") {
      const input = (await request.json().catch(() => null)) as { parts?: unknown } | null;
      const parts = Array.isArray(input?.parts) ? input.parts : null;
      if (
        parts === null ||
        parts.length === 0 ||
        !parts.every(
          (part) =>
            typeof part === "object" &&
            part !== null &&
            Number.isInteger((part as { partNumber?: unknown }).partNumber) &&
            typeof (part as { etag?: unknown }).etag === "string"
        )
      ) {
        return apiError(400, "invalid_upload", "Completing an upload needs { parts: [{ partNumber, etag }] }.");
      }
      const object = await upload.complete(parts as R2UploadedPart[]);
      const contentType = object.httpMetadata?.contentType ?? "application/octet-stream";
      return recordUpload(env, bucket, workspaceId, objectKey, key, object.size, contentType, trustedClaim);
    }

    if (request.method === "DELETE") {
      await discardBody(request);
      await upload.abort();
      return new Response(null, { status: 204 });
    }
  } catch (error) {
    // R2 refuses an unknown upload id, a part out of shape, or a part list
    // that does not match what was uploaded: the caller's mistake.
    return apiError(400, "invalid_upload", `R2 refused the upload: ${error instanceof Error ? error.message : String(error)}`);
  }

  await discardBody(request);
  return apiError(405, "method_not_allowed", `${request.method} is not part of a multipart upload.`);
}

async function handleStorage(
  request: Request,
  env: Env,
  workspaceId: string,
  objectKey: string,
  role: number,
  trustedClaim: string
): Promise<Response> {
  const bucket = env.FILES;
  if (!bucket) {
    await discardBody(request);
    return apiError(501, "storage_not_configured", "Bind an FILES R2 bucket to use storage.");
  }

  // Without file rules, roles decide here. With rules, the workspace decides
  // each operation before any byte moves (see engine/file-access.ts).
  const ruled = fileRulesConfigured();
  if (!ruled) {
    const required =
      request.method === "GET" || request.method === "HEAD"
        ? WORKSPACE_ROLE_LEVELS.MEMBER
        : WORKSPACE_ROLE_LEVELS.EDITOR;
    if (role < required) {
      await discardBody(request);
      return apiError(403, "insufficient_role", "Insufficient role for this file operation.");
    }
  }
  const authorize = async (action: "read" | "write" | "delete", details: { size?: number; contentType?: string } = {}) => {
    if (!ruled) return null;
    const decision = await callRoom(
      env,
      workspaceId,
      "/files/authorize",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: objectKey, action, ...details }),
      },
      trustedClaim
    );
    if (decision.ok) {
      await decision.body?.cancel();
      return null;
    }
    await discardBody(request);
    return new Response(decision.body, { status: decision.status, headers: { "content-type": "application/json" } });
  };

  let key = storageKey(workspaceId, objectKey);
  const query = new URL(request.url).searchParams;

  if (query.has("uploads") || query.has("uploadId")) {
    // Starting and completing an upload are writes; its parts and its abort
    // need only the upload id, which only an authorized start handed out.
    const decides = request.method === "POST";
    const refused = decides
      ? await authorize("write", query.has("uploads") ? { contentType: request.headers.get("content-type") ?? "application/octet-stream" } : {})
      : null;
    if (refused) return refused;
    return handleMultipart(request, env, bucket, workspaceId, objectKey, key, query, trustedClaim);
  }

  if (request.method === "PUT") {
    const refused = await authorize("write", {
      ...(Number.isFinite(Number(request.headers.get("content-length") ?? "")) && request.headers.has("content-length")
        ? { size: Number(request.headers.get("content-length")) }
        : {}),
      contentType: request.headers.get("content-type") ?? "application/octet-stream",
    });
    if (refused) return refused;
    const declared = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      await discardBody(request);
      return apiError(413, "upload_too_large", `One request carries at most ${MAX_UPLOAD_BYTES} bytes; send a larger file as a multipart upload (?uploads), as the client does.`);
    }
    const body = await readBodyWithinLimit(request, MAX_UPLOAD_BYTES);
    if (body === null) {
      return apiError(413, "upload_too_large", `One request carries at most ${MAX_UPLOAD_BYTES} bytes; send a larger file as a multipart upload (?uploads), as the client does.`);
    }
    const contentType =
      request.headers.get("content-type") ?? "application/octet-stream";

    key = `${key}/.tapedb/${crypto.randomUUID()}`;
    await bucket.put(key, body, { httpMetadata: { contentType } });

    // Bytes are stored; now record them where the database can see them. A
    // failure here is reported rather than swallowed: an object nobody can
    // list is worse than a failed upload.
    return recordUpload(env, bucket, workspaceId, objectKey, key, body.byteLength, contentType, trustedClaim);
  }

  const locate = async (action: "read" | "delete") => {
    const response = await callRoom(env, workspaceId, "/files/locate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: objectKey, action }) }, trustedClaim);
    if (!response.ok) return null;
    const data = await response.json() as { key?: string };
    return typeof data.key === "string" ? data.key : null;
  };
  if (request.method === "GET" || request.method === "HEAD") {
    const refused = await authorize("read");
    if (refused) return refused;
    const storedKey = await locate("read");
    if (!storedKey) return apiError(404, "not_found", "No such object.");
    const object = request.method === "HEAD" ? await bucket.head(storedKey) : await bucket.get(storedKey);
    if (!object) return apiError(404, "not_found", "No such object.");
    const headers = new Headers();
    headers.set("etag", object.httpEtag);
    if (object.httpMetadata?.contentType) {
      headers.set("content-type", object.httpMetadata.contentType);
    }
    // Uploaded bytes and the content type are user-controlled. Keep a
    // same-origin HTML or SVG upload from becoming script execution.
    headers.set("x-content-type-options", "nosniff");
    headers.set("content-security-policy", "default-src 'none'; sandbox");
    const body = "body" in object ? (object.body as BodyInit) : null;
    return new Response(body, { headers });
  }

  if (request.method === "DELETE") {
    const refused = await authorize("delete");
    if (refused) return refused;
    const storedKey = await locate("delete");

    const forgotten = await callRoom(
      env,
      workspaceId,
      "/files",
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: objectKey }),
      },
      trustedClaim
    );
    if (!forgotten.ok) {
      return apiError(
        502,
        "file_index_failed",
        "Deleted the object but could not remove it from the workspace index."
      );
    }

    if (storedKey) await bucket.delete(storedKey);
    return new Response(null, { status: 204 });
  }

  await discardBody(request);
  return apiError(405, "method_not_allowed", `${request.method} is not supported for storage.`);
}

  return handleStorage;
}
