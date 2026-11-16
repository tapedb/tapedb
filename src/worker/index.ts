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
import { configureTopics, type TopicOptions } from "../engine/topics";
import { configureAudit } from "../engine/audit";
import { configureFileAccess, fileRulesConfigured } from "../engine/file-access";
import { configureRetention, type RetentionOptions } from "../engine/durability/retention";
import { isWorkspaceId } from "../engine/r2-keys";
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
export { MAX_UPLOAD_BYTES } from "../engine/storage-routes";

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
   * or send to it; without it anyone with a claim for the workspace may,
   * guests included, as with presence. `replaySeconds` (default 60) is how
   * much of each topic the room keeps for clients that reconnect.
   *
   * @experimental May change in a minor release.
   */
  topics?: TopicOptions;
  /**
   * Records who changed each row: the claim's subject and role on every log
   * entry (also in R2), and a per-row history read with `db.$history`.
   * Off by default; the history is pruned with `retention`.
   */
  audit?: boolean;
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

/**
 * Headers the Worker forwards to a room: the client's, minus every
 * `x-tapedb-*` header. Only the Worker sets those (the verified claim).
 */
function forwardableHeaders(source: HeadersInit | undefined): Headers {
  const headers = new Headers(source);
  for (const name of [...headers.keys()]) {
    if (name.startsWith("x-tapedb-")) headers.delete(name);
  }
  return headers;
}

/** A room URL with exactly this path; never resolved relative to anything. */
function roomUrl(path: string, search = ""): URL {
  const url = new URL("https://room.internal/");
  url.pathname = path;
  url.search = search;
  return url;
}

function roomRequest(request: Request, path: string): Request {
  const init: RequestInit = { method: request.method, headers: forwardableHeaders(request.headers) };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }
  return new Request(roomUrl(path, new URL(request.url).search), init);
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
  const headers = forwardableHeaders(init.headers);
  headers.set(TRUSTED_CLAIM_HEADER, trustedClaim);

  const queryAt = path.indexOf("?");
  const request = new Request(queryAt === -1 ? roomUrl(path) : roomUrl(path.slice(0, queryAt), path.slice(queryAt)), {
    ...init,
    headers,
  });

  return workspaceStub(env, workspaceId).fetch(request);
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
  configureAudit(options.audit);
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
      // An empty segment ("//") would let one route stand in for another
      // that the Worker keeps internal. No room route has one; a file path
      // may, and is passed to the byte routes as data, never as the path.
      if (!roomPath.startsWith("/files/") && roomPath.includes("//")) {
        await discardBody(request);
        return apiError(404, "no_route", `No route for ${request.method} ${url.pathname}.`);
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

          if (roomPath.startsWith("/move/") || roomPath.startsWith("/storage/")) return apiError(404, "not_found", "No public route.");
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
            return callRoom(env, workspaceId, `/storage/${roomPath.slice("/files/".length)}${url.search}`, {
              method: request.method,
              headers: request.headers,
              ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }),
            }, trustedClaim);
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
export type { TopicAction, TopicAuthorizer, TopicOptions } from "../engine/topics";
export { WORKSPACE_ROLE_LEVELS };
export type { Env, TapeDBSchema, BundledWorkspaceMigration };

// A named type for downstream declaration emission; no runtime room export.
export type { WorkspaceRoom as TapeDBRoom };
