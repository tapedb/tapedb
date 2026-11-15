/**
 * Worker entry.
 *
 * `defineTapeDB()` installs the deployment schema and returns the Durable
 * Object class plus the fetch handler. The consumer's Worker is then two
 * exports and nothing else:
 *
 *   const tapedb = defineTapeDB({ schema });
 *   export const WorkspaceRoom = tapedb.WorkspaceRoom;
 *   export default tapedb.worker;
 */

import { configureRegistry, registryConfigured } from "../engine/registry";
import { configureMigrations } from "../engine/migrations-bundle";
import { configurePermissions } from "../engine/tx-permissions";
import { configureTopics, type TopicAuthorizer } from "../engine/topics";
import { configureFileAccess, fileRulesConfigured } from "../engine/file-access";
import { configureRetention, type RetentionOptions } from "../engine/durability/retention";
import { filesPrefix, isWorkspaceId } from "../engine/r2-keys";
import { WorkspaceRoom } from "../engine/workspace-room";
import { sourceEnvironment, readMove } from "../engine/workspace-move";
import { apiError, discardBody, json } from "../http";
import { handleClaimRequest } from "../claim-route";
import { limiterKey, limiterName, resolveClaimLimits, type ClaimLimits, type LimitDecision } from "../engine/claim-limits";
import { mintClaim, mintDevClaim, type ClaimIdentity } from "../mint";
import type { TapeDBSchema } from "../schema";
import type { BundledWorkspaceMigration } from "../engine/migrations-bundle";
import type { Env } from "../types";
import {
  authenticateEngineRequest,
  ClaimError,
  encodeTrustedRoleClaim,
  extractClaimToken,
  TRUSTED_CLAIM_HEADER,
  verifyRoleClaim,
} from "../verify";
import { WORKSPACE_ROLE_LEVELS } from "../claims";

/**
 * The most one upload request carries: a whole small file in one PUT, or one
 * part of a multipart upload. A file of any size goes up as parts (R2 keeps
 * objects up to 5 TB), so this bounds a request, not a file; it stays well
 * inside the request body size every Workers plan accepts.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const ENGINE_PREFIX = "/engine/workspaces";

/** One app migration, as `tapedb migrate` bundles it. */
export type AppMigration = BundledWorkspaceMigration;

export interface DefineTapeDBOptions {
  schema: TapeDBSchema;
  /**
   * The app's committed migrations, from `tapedb/migrations.gen.ts`. Omit
   * only before the first `tapedb migrate dev`: the schema's generated SQL
   * is used, which cannot evolve.
   */
  migrations?: readonly AppMigration[];
  /**
   * Identity adapter. Implement `getSubject` and `getRole` to serve
   * `POST /_tapedb/claim`. Without it that route returns 501 and the consumer
   * must supply tokens to the client itself.
   */
  identity?: ClaimIdentity;
  /**
   * Development-only issuer: mints an OWNER claim for any workspace with no
   * session. Always refused when `ENVIRONMENT` is `production`.
   */
  devClaims?: boolean;
  /**
   * Broadcast topics. `authorize` decides whether a caller may join a topic
   * or send to it; without it any member of the workspace may, as with
   * presence.
   *
   * @experimental May change in a minor release.
   */
  topics?: { authorize?: TopicAuthorizer };
  /**
   * How long deleted or overwritten values may remain in the workspace's
   * history (R2 log segments, older snapshots, the local replay log).
   * Defaults to 30 days; at least 2.
   */
  retention?: RetentionOptions;
}

export interface TapeDBWorker {
  /** The database room class. Export it from the Worker entry. */
  WorkspaceRoom: typeof WorkspaceRoom;
  worker: { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> };
}

function roomRequest(request: Request, path: string): Request {
  const headers = new Headers(request.headers);
  // Never let a client supply the trusted claim header.
  headers.delete(TRUSTED_CLAIM_HEADER);

  const init: RequestInit = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  return new Request(new URL(path, "https://room.internal"), init);
}

/** The workspace's Durable Object, inside TAPEDB_JURISDICTION when set. */
/**
 * One token from a built-in claim limit. A limiter that cannot be reached
 * lets the request through and logs it: a limiter outage should not lock
 * every user out of every workspace.
 */
async function takeClaimToken(
  env: Env,
  limits: Required<ClaimLimits>,
  kind: "ip" | "subject",
  value: string
): Promise<LimitDecision> {
  const limit = limits[kind];
  if (!limit || !env.TAPEDB_CLAIM_SECRET) return { allowed: true, retryAfterSeconds: 0 };
  try {
    const { key, shard } = await limiterKey(env.TAPEDB_CLAIM_SECRET, `${kind}:${value}`);
    const response = await workspaceStub(env, limiterName(shard)).fetch("https://tapedb.limits/limit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, requests: limit.requests, perSeconds: limit.perSeconds }),
    });
    if (!response.ok) throw new Error(`limiter answered ${response.status}`);
    return (await response.json()) as LimitDecision;
  } catch (error) {
    console.warn(JSON.stringify({ event: "claim_limit_unavailable", kind, message: error instanceof Error ? error.message : String(error) }));
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

function workspaceStub(env: Env, workspaceId: string): DurableObjectStub<WorkspaceRoom> {
  let namespace = env.WORKSPACE;
  if (env.TAPEDB_JURISDICTION) {
    try {
      namespace = env.WORKSPACE.jurisdiction(env.TAPEDB_JURISDICTION as DurableObjectJurisdiction);
    } catch (error) {
      // Plain `wrangler dev`: workerd has no jurisdictions. `tapedb dev` clears the var.
      throw new Error(`TAPEDB_JURISDICTION is "${env.TAPEDB_JURISDICTION}" but this runtime has no jurisdictions (${error instanceof Error ? error.message : String(error)}). Run locally with \`tapedb dev\`, which leaves it out.`);
    }
  }
  return namespace.get(namespace.idFromName(workspaceId));
}

function storageKey(workspaceId: string, objectKey: string): string {
  return `${filesPrefix(workspaceId)}${objectKey}`;
}

/**
 * Calls the Durable Object directly with a trusted claim. Used for the file
 * metadata index, which lives in the workspace's SQLite next to the data, not
 * in R2.
 */
async function callRoom(
  env: Env,
  workspaceId: string,
  path: string,
  init: RequestInit,
  trustedClaim: string
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.delete(TRUSTED_CLAIM_HEADER);
  headers.set(TRUSTED_CLAIM_HEADER, trustedClaim);

  const request = new Request(new URL(path, "https://room.internal"), {
    ...init,
    headers,
  });

  return workspaceStub(env, workspaceId).fetch(request);
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
  const recorded = await callRoom(
    env,
    workspaceId,
    "/files",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: objectKey, key, size, contentType }),
    },
    trustedClaim
  );
  if (!recorded.ok) {
    try {
      await bucket.delete(key);
    } catch {
      // Best effort.
    }
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

export function defineTapeDB(options: DefineTapeDBOptions): TapeDBWorker {
  const { schema, identity, devClaims = false, migrations } = options;
  // Validated once, when the Worker is defined.
  const claimLimits = resolveClaimLimits(identity?.limits);

  // One schema per Worker instance. Installed at module evaluation, before any
  // request or Durable Object is constructed.
  configureRegistry(schema.registry);
  configureMigrations(
    migrations === undefined ? schema.migrations : [schema.migrations[0], ...migrations]
  );
  configurePermissions(schema.permissions);
  configureTopics(options.topics);
  configureFileAccess(schema.files);
  configureRetention(options.retention);

  const worker = {
    async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
      if (!registryConfigured()) {
        return apiError(500, "engine_not_configured", "Call defineTapeDB({ schema }) first.");
      }

      const url = new URL(request.url);

      if (url.pathname === "/status" || url.pathname === "/health") {
        return json({ ok: true, service: "tapedb" });
      }

      if (url.pathname === "/_tapedb/claim") {
        return handleClaimRequest(request, {
          env,
          identity,
          devClaims,
          ...(claimLimits.ip || claimLimits.subject ? { limit: (kind, value) => takeClaimToken(env, claimLimits, kind, value) } : {}),
        });
      }

      if (!url.pathname.startsWith(`${ENGINE_PREFIX}/`)) {
        await discardBody(request);
        return apiError(404, "no_route", `No route for ${request.method} ${url.pathname}.`);
      }

      const rest = url.pathname.slice(ENGINE_PREFIX.length + 1);
      const slash = rest.indexOf("/");
      const workspaceId = slash === -1 ? rest : rest.slice(0, slash);
      const roomPath = slash === -1 ? "/" : rest.slice(slash);

      if (!isWorkspaceId(workspaceId)) {
        await discardBody(request);
        return apiError(400, "invalid_workspace_id", "Workspace id must be a UUID.");
      }

      // Every engine route needs a verified claim before a Durable Object is
      // touched: addressing one by name creates it, runs its migrations and
      // checks R2 for a recovery, so an open route would let anyone create
      // objects for any UUID. The Worker's own /status answers health checks.
      let trustedClaim: string | null = null;
      let role: number = WORKSPACE_ROLE_LEVELS.GUEST;

      {
        try {
          const claim = await authenticateEngineRequest(request, env, workspaceId);
          role = claim.role;
          trustedClaim = encodeTrustedRoleClaim(claim);
          if (roomPath === "/move") {
            if (request.method !== "POST") return apiError(405, "method_not_allowed", "Move a workspace with POST.");
            if (role < WORKSPACE_ROLE_LEVELS.OWNER) return apiError(403, "insufficient_role", "Only an owner can move a workspace.");
            return callRoom(env, workspaceId, "/move/run", { method: "POST", body: request.body, duplex: "half" } as RequestInit, trustedClaim);
          }

          if (roomPath.startsWith("/move/")) return apiError(404, "not_found", "No public route.");
          if (env.TAPEDB_MOVE_FROM !== undefined && (await readMove(env.DATA, workspaceId))?.state !== "ready") {
            env = sourceEnvironment(env);
            const state = await readMove(env.DATA, workspaceId);
            const read = request.method === "GET" || request.method === "HEAD" || roomPath === "/query";
            if (state?.state === "frozen" && !read) return apiError(409, "workspace_moving", "Writes resume after the move.");
          }


          // The file index is written only by the byte routes below, which
          // check roles and keep index and bytes in step. A client may list
          // it with the role that reads files, and nothing else.
          if (roomPath === "/files") {
            if (request.method !== "GET") {
              await discardBody(request);
              return apiError(405, "method_not_allowed", "The file index changes only through uploads and deletes under /files/<path>.");
            }
            // With file rules the room lists only what the caller may read.
            if (!fileRulesConfigured() && role < WORKSPACE_ROLE_LEVELS.MEMBER) {
              return apiError(403, "insufficient_role", "Insufficient role to list files.");
            }
          }

          if (roomPath.startsWith("/files/")) {
            return handleStorage(
              request,
              env,
              workspaceId,
              roomPath.slice("/files/".length),
              role,
              trustedClaim
            );
          }
        } catch (error) {
          await discardBody(request);
          if (error instanceof ClaimError) {
            const status = error.code === "wrong_workspace" ? 403 : 401;
            return apiError(status, error.code, error.message);
          }
          throw error;
        }
      }

      const forwarded = roomRequest(request, roomPath);
      if (trustedClaim !== null) forwarded.headers.set(TRUSTED_CLAIM_HEADER, trustedClaim);

      return workspaceStub(env, workspaceId).fetch(forwarded);
    },
  };

  return { WorkspaceRoom, worker };
}

// The public surface of `tapedb/worker`; see API.md. Everything else in this
// module (trusted-claim plumbing, dev claims, the room class itself) is
// internal: the Durable Object class reaches the Worker as
// `defineTapeDB(...).WorkspaceRoom`.
export { ClaimError, verifyRoleClaim };
export { signRoleClaim } from "../mint";
export type { ClaimIdentity } from "../mint";
export type { ClaimLimit, ClaimLimits } from "../engine/claim-limits";
export type { TopicAction, TopicAuthorizer } from "../engine/topics";
export { WORKSPACE_ROLE_LEVELS };
export type { Env };
