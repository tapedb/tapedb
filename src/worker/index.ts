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
import { isWorkspaceId } from "../engine/r2-keys";
import { WorkspaceRoom } from "../engine/workspace-room";
import { apiError, discardBody, json } from "../http";
import { handleClaimRequest } from "../claim-route";
import { mintClaim, mintDevClaim, type ClaimIdentity } from "../mint";
import type { TapeDBSchema } from "../schema";
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

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const ENGINE_PREFIX = "/engine/workspaces";

export interface DefineTapeDBOptions {
  schema: TapeDBSchema;
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

function storageKey(workspaceId: string, objectKey: string): string {
  return `workspaces/${workspaceId}/files/${objectKey}`;
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

  return env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId)).fetch(request);
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

  const required =
    request.method === "GET" || request.method === "HEAD"
      ? WORKSPACE_ROLE_LEVELS.MEMBER
      : WORKSPACE_ROLE_LEVELS.EDITOR;
  if (role < required) {
    await discardBody(request);
    return apiError(403, "insufficient_role", "Insufficient role for this file operation.");
  }

  const key = storageKey(workspaceId, objectKey);

  if (request.method === "PUT") {
    const declared = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      await discardBody(request);
      return apiError(413, "file_too_large", `Files are capped at ${MAX_UPLOAD_BYTES} bytes.`);
    }
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_UPLOAD_BYTES) {
      return apiError(413, "file_too_large", `Files are capped at ${MAX_UPLOAD_BYTES} bytes.`);
    }
    const contentType =
      request.headers.get("content-type") ?? "application/octet-stream";

    await bucket.put(key, body, { httpMetadata: { contentType } });

    // Bytes are stored; now record them where the database can see them. A
    // failure here is reported rather than swallowed: an object nobody can
    // list is worse than a failed upload.
    const recorded = await callRoom(
      env,
      workspaceId,
      "/files",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: objectKey,
          key,
          size: body.byteLength,
          contentType,
        }),
      },
      trustedClaim
    );
    if (!recorded.ok) {
      return apiError(
        502,
        "file_index_failed",
        "Stored the object but could not record it in the workspace index."
      );
    }

    return json({ key, size: body.byteLength }, 201);
  }

  if (request.method === "GET" || request.method === "HEAD") {
    const object = request.method === "HEAD" ? await bucket.head(key) : await bucket.get(key);
    if (!object) return apiError(404, "not_found", "No such object.");
    const headers = new Headers();
    headers.set("etag", object.httpEtag);
    if (object.httpMetadata?.contentType) {
      headers.set("content-type", object.httpMetadata.contentType);
    }
    const body = "body" in object ? (object.body as unknown as BodyInit) : null;
    return new Response(body, { headers });
  }

  if (request.method === "DELETE") {
    await bucket.delete(key);

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

    return new Response(null, { status: 204 });
  }

  await discardBody(request);
  return apiError(405, "method_not_allowed", `${request.method} is not supported for storage.`);
}

export function defineTapeDB(options: DefineTapeDBOptions): TapeDBWorker {
  const { schema, identity, devClaims = false } = options;

  // One schema per Worker instance. Installed at module evaluation, before any
  // request or Durable Object is constructed.
  configureRegistry(schema.registry);
  configureMigrations(schema.migrations);
  configurePermissions(schema.permissions);

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

      const isStatusProbe = request.method === "GET" && roomPath === "/status";

      let trustedClaim: string | null = null;
      let role: number = WORKSPACE_ROLE_LEVELS.GUEST;

      if (!isStatusProbe) {
        try {
          const claim = await authenticateEngineRequest(request, env, workspaceId);
          role = claim.role;
          trustedClaim = encodeTrustedRoleClaim(claim);

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

      return env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId)).fetch(forwarded);
    },
  };

  return { WorkspaceRoom, worker };
}

export {
  authenticateEngineRequest,
  ClaimError,
  encodeTrustedRoleClaim,
  extractClaimToken,
  TRUSTED_CLAIM_HEADER,
  verifyRoleClaim,
};
export { mintClaim, mintDevClaim, signRoleClaim } from "../mint";
export type { ClaimIdentity, MintClaimDependencies } from "../mint";
export { WorkspaceRoom };
export { WORKSPACE_ROLE_LEVELS };
export type { Env };
