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

import { capturedEmails } from "../email/dev";
import { serveAuthPage, type TapeDBAuthPage } from "../auth/page";
import { AuthRoom } from "../auth/room";
import { authIdentity, authManagement, type TapeDBAuthServer } from "../auth/server";
import type { TapeDBStudio } from "../studio";
import { configureRegistry, registryConfigured } from "../engine/registry";
import { configureMigrations } from "../engine/migrations-bundle";
import { configurePermissions } from "../engine/tx-permissions";
import { resolveRealtime, type RealtimeOptions, type TopicOptions } from "../engine/topics";
import { resolveWebhooks, type WebhookOptions } from "../engine/webhooks";
import { resolveWriteLimits, type LimitsOptions } from "../engine/rate-limits";
import { fileRulesConfigured, resolveFileRules } from "../engine/file-access";
import { deploymentConfig, type DeploymentConfig } from "../engine/config";
import { configureRetention, type RetentionOptions } from "../engine/durability/retention";
import { isWorkspaceId } from "../engine/r2-keys";
import { WorkspaceRoom, type WorkspaceRoomOptions } from "../engine/workspace-room";
import { sourceEnvironment, readMove } from "../engine/workspace-move";
import { ADMIN_PREFIX, handleAdminRequest, resolveHttpApi, type HttpApiOptions } from "./admin";
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
  /** Browser bundle generated from the project's tapedb.auth.tsx override. */
  authPage?: TapeDBAuthPage;
  /** Better Auth server, or a factory using this request's bindings. */
  auth?: TapeDBAuthServer | ((env:Env, request:Request)=>TapeDBAuthServer);
  /**
   * Development-only issuer: mints an OWNER claim for any workspace with no
   * session. Always refused when `ENVIRONMENT` is `production`.
   */
  devClaims?: boolean;
  /**
   * The studio, served at /_tapedb/studio: `import { studio } from
   * "@tapedb/tapedb/studio"`. It signs in through POST /_tapedb/claim with
   * the app's own session, so `identity` decides the role, and the access
   * rules apply as in the app. Leave it out and nothing is served there.
   */
  studio?: TapeDBStudio;
  /**
   * Realtime channels: presence rooms and broadcast topics.
   *
   * `authorize` decides whether a caller may join a presence room or a topic,
   * or send to one, and may answer asynchronously; presence is checked before
   * anything is stored. `maxPresenceRooms` (default 4) is how many presence
   * rooms one socket may hold. `replaySeconds` (default 60) is how much of
   * each topic the room keeps for clients that reconnect.
   *
   * @experimental May change in a minor release.
   */
  realtime?: RealtimeOptions;
  /**
   * Broadcast topics. Kept as a deprecated alias: `authorize` applies to
   * topic kinds only, and only when `realtime.authorize` is absent;
   * `replaySeconds` still works on its own.
   *
   * @experimental May change in a minor release.
   * @deprecated Use `realtime`.
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
  /**
   * Write budgets, checked in the Durable Object before a row moves.
   *
   *   limits: { writes: {
   *     models: { tasks: { count: 60, windowSeconds: 60 } },
   *     workspace: { count: 600, windowSeconds: 60 },
   *   } }
   *
   * A budget is a fixed window: `count` writes per `windowSeconds`, counted
   * per model (one operation each) and, for `workspace`, across every model.
   * A write past its budget is refused with `rate_limited` (429) carrying the
   * model, the limit, the window and `retryAfterMs`; a write that fails
   * validation, or does not commit, spends nothing. The counters are kept in
   * the workspace's own SQLite, so they survive eviction and restarts.
   *
   * Leave it out and no table is created and no write is checked.
   *
   * @experimental May change in a minor release.
   */
  limits?: LimitsOptions;
  /**
   * Outbound webhooks: one POST per changed row, in the transaction's
   * sequence order, signed with `X-Tapedb-Signature`.
   *
   *   webhooks: [{ url, events: ["create"], models: ["tasks"], secret }]
   *
   * The change is captured inside the write transaction, so a webhook can
   * never fail or slow a commit. Delivery follows the commit, from the
   * durability alarm; it is retried with backoff for up to 24 hours, then
   * dead-lettered and counted on `GET /status`. Personal fields never appear
   * in a payload.
   *
   * @experimental May change in a minor release.
   */
  webhooks?: readonly WebhookOptions[];
  /**
   * The admin HTTP API for backends: `POST /v1/query`, `/v1/transact` and
   * `/v1/claim`, in front of the same room routes a client uses.
   *
   *   http: { token: (env) => env.TAPEDB_API_TOKEN }
   *
   * A caller sends `authorization: Bearer <token>` and names who it acts as
   * (`as: { sub, role }`); the access rules are evaluated for that identity,
   * exactly as for a socket holding that claim, and writes spend the
   * `limits.writes` budget. The token must be at least 32 bytes and is
   * compared in constant time.
   *
   * Optional, and off by default: without it these paths answer 404, so an
   * API nobody enabled is not visible.
   *
   * @experimental May change in a minor release.
   */
  http?: HttpApiOptions;
}

export interface TapeDBWorker {
  /** The database room class. Export it from the Worker entry. */
  WorkspaceRoom: typeof WorkspaceRoom;
  AuthRoom: typeof AuthRoom;
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
      throw new Error(`TAPEDB_JURISDICTION is "${env.TAPEDB_JURISDICTION}" but this runtime has no jurisdictions (${error instanceof Error ? error.message : String(error)}). Run locally with \`npx tapedb-cli dev\`, which leaves it out.`);
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

/**
 * The studio `tapedb dev` started, when this is that local dev run: dev claims
 * on in code and in the environment, not production, and a loopback address,
 * so `/` never redirects anywhere else.
 */
function localStudio(env: Env, devClaims: boolean): string | null {
  if (!devClaims || env.TAPEDB_DEV_CLAIMS !== "true" || env.ENVIRONMENT === "production") return null;
  try {
    const studio = new URL(env.TAPEDB_STUDIO_URL ?? "");
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(studio.hostname);
    return studio.protocol === "http:" && loopback ? studio.href : null;
  } catch {
    return null;
  }
}

const WORKSPACES_WAIT_MS = 25_000;
const WORKSPACES_POLL_MS = 500;

/** Where `tapedb dev` notes the workspaces the app opened; never written deployed. */
const LOCAL_WORKSPACES = "dev/workspaces/";

async function noteLocalWorkspace(bucket: R2Bucket, request: { json(): Promise<unknown> }): Promise<void> {
  const body = (await request.json().catch(() => null)) as { workspaceId?: unknown } | null;
  const id = body?.workspaceId;
  if (typeof id === "string" && isWorkspaceId(id)) await bucket.put(`${LOCAL_WORKSPACES}${id}`, "");
}

/**
 * The local workspaces, most recently opened or written first: those the app
 * opened during `tapedb dev`, and those with data in the bucket.
 */
async function localWorkspaces(bucket: R2Bucket): Promise<Array<{ id: string; updatedAt: number | null }>> {
  const seen = new Map<string, number | null>();
  const note = (id: string, at: number | null) => {
    if (!isWorkspaceId(id)) return;
    const known = seen.get(id) ?? null;
    seen.set(id, at === null ? known : Math.max(known ?? 0, at));
  };
  for (const [prefix, delimiter] of [[LOCAL_WORKSPACES, undefined], ["ws/", "/"]] as const) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, ...(delimiter ? { delimiter } : {}), ...(cursor ? { cursor } : {}) });
      for (const object of page.objects) note(object.key.slice(prefix.length), object.uploaded.getTime());
      for (const found of page.delimitedPrefixes ?? []) note(found.slice(prefix.length, -1), null);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && seen.size < 1000);
  }
  const listed = await Promise.all([...seen].map(async ([id, at]) => {
    const manifest = await bucket.head(`ws/${id}/manifest.json`);
    return { id, updatedAt: Math.max(at ?? 0, manifest ? manifest.uploaded.getTime() : 0) || null };
  }));
  return listed.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export function defineTapeDB(options: DefineTapeDBOptions): TapeDBWorker {
  const { schema, devClaims = false, migrations } = options;
  const usesUsers=schema.registry.namespaces.some(namespace=>namespace.apiName==="$users");
  if(usesUsers&&!options.auth)throw new Error("$users requires built-in auth.");
  if(options.auth && options.identity)throw new Error("Use auth or identity, not both.");
  // Validated once, when the Worker is defined.
  const claimLimits = resolveClaimLimits(options.identity?.limits);

  // One schema per Worker instance. Installed at module evaluation, before any
  // request or Durable Object is constructed.
  configureRegistry(schema.registry);
  configureMigrations(
    migrations === undefined ? schema.migrations : [schema.migrations[0], ...migrations]
  );
  configurePermissions(schema.permissions);
  configureRetention(options.retention);

  // This deployment's own settings, built once from its options and handed to
  // every room it constructs. They are values, not module globals: a second
  // deployment in the same process (a test, `@tapedb/tapedb/backend` in Node)
  // cannot change this one's audit flag, file rules, realtime caps, webhooks or
  // log part size. Validated here, so a bad option fails at definition time.
  const config: DeploymentConfig = deploymentConfig({
    audit: options.audit === true,
    files: resolveFileRules(schema.files),
    realtime: resolveRealtime(options.realtime, options.topics),
    webhooks: resolveWebhooks(options.webhooks),
  });
  // Refused here, when the Worker is defined, rather than on the first write.
  // Each room resolves its own copy from these options; nothing is shared.
  resolveWriteLimits(options.limits?.writes);
  // The admin API's token: refused here when it is a string and too short, so
  // a mistyped secret fails at deploy rather than on the first backend call.
  const httpApi = resolveHttpApi(options.http);

  const worker = {
    async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
      if (!registryConfigured()) {
        return apiError(500, "engine_not_configured", "Call defineTapeDB({ schema }) first.");
      }

      const url = new URL(request.url);
      const auth=typeof options.auth==='function'?options.auth(env,request):options.auth;
      const identity=auth?authIdentity(auth,request,env,usesUsers):options.identity;
      if(auth && (url.pathname==='/api/auth' || url.pathname.startsWith('/api/auth/')))return auth.handler(request);
      if(auth && options.authPage){const page=serveAuthPage(request,options.authPage);if(page)return page;}
      if(auth && url.pathname==='/auth' && options.studio)return options.studio.serve(new Request(new URL('/_tapedb/studio/users'+url.search,url),request));
      if(auth && (url.pathname==='/_tapedb/workspaces' || url.pathname==='/_tapedb/auth/members'))return authManagement(request,env,auth);

      if(url.pathname==='/_tapedb/dev/emails'){
        if(request.method!=='GET'||env.ENVIRONMENT==='production'||env.TAPEDB_DEV_CLAIMS!=='true'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname))return apiError(404,"no_route","No route.");
        return json({emails:capturedEmails()});
      }
      if (url.pathname === "/status" || url.pathname === "/health") {
        return json({ ok: true, service: "tapedb", ...(auth?{auth:true}:{}) });
      }

      if(auth && options.studio && (url.pathname==='/_tapedb/studio' || url.pathname==='/_tapedb/studio/' || url.pathname==='/_tapedb/studio/users')){
        if(!await auth.api.getSession({headers:request.headers}))return Response.redirect(new URL('/auth?returnTo='+encodeURIComponent(url.pathname+url.search),url).href,302);
      }
      if (url.pathname === "/" && request.method === "GET") {
        const studio = localStudio(env, devClaims);
        if (studio && !auth) return Response.redirect(studio, 302);
        // With the studio on, the Worker's own address opens it.
        if (options.studio) return Response.redirect(new URL("/_tapedb/studio", url).href, 302);
      }

      // The studio's workspace picker, during `tapedb dev` only.
      if (url.pathname === "/_tapedb/workspaces" && request.method === "GET" && localStudio(env, devClaims)) {
        // `?known=<count>`: answer when the list grows past that, or after 25 s, so
        // the studio waits for the first workspace with one request, not a stream.
        const known = Number(url.searchParams.get("known"));
        let workspaces = await localWorkspaces(env.DATA);
        if (url.searchParams.has("known") && Number.isFinite(known)) {
          for (const deadline = Date.now() + WORKSPACES_WAIT_MS; workspaces.length <= known && Date.now() < deadline; ) {
            await new Promise((resolve) => setTimeout(resolve, WORKSPACES_POLL_MS));
            workspaces = await localWorkspaces(env.DATA);
          }
        }
        return json({ workspaces });
      }

      if (options.studio && (url.pathname === "/_tapedb/studio" || url.pathname.startsWith("/_tapedb/studio/"))) {
        return options.studio.serve(request);
      }

      if (url.pathname === "/_tapedb/claim") {
        const opened = localStudio(env, devClaims) ? request.clone() : null;
        const claimed = await handleClaimRequest(request, {
          env,
          identity,
          devClaims:auth?false:devClaims,
          ...(claimLimits.ip || claimLimits.subject ? { limit: (kind, value) => takeClaimToken(env, claimLimits, kind, value) } : {}),
        });
        // During `tapedb dev`, note the workspace so the studio lists it before its first flush.
        if (opened && claimed.ok) await noteLocalWorkspace(env.DATA, opened);
        return claimed;
      }

      // The admin HTTP API. Off unless `http` is configured: without it these
      // paths fall through to the 404 below, so an API nobody enabled cannot
      // be probed for.
      if (httpApi !== undefined && url.pathname.startsWith(ADMIN_PREFIX)) {
        return handleAdminRequest({
          request,
          env,
          http: httpApi,
          callRoom: (workspaceId, path, body, claim) =>
            callRoom(
              env,
              workspaceId,
              path,
              { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
              encodeTrustedRoleClaim(claim)
            ),
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
            if (!fileRulesConfigured(config.files) && role < WORKSPACE_ROLE_LEVELS.MEMBER) {
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

  /**
   * This deployment's room: the engine's class with this deployment's
   * configuration and limits attached. A module-level variable would let two
   * deployments — or two rooms — in one process share one audit flag, one rule
   * set and one budget, so both travel with the class.
   */
  class ConfiguredWorkspaceRoom extends WorkspaceRoom {
    constructor(context: DurableObjectState, environment: Env, roomOptions: WorkspaceRoomOptions = {}) {
      super(context, environment, {
        ...roomOptions,
        config: roomOptions.config ?? config,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      });
    }
  }

  return { WorkspaceRoom: ConfiguredWorkspaceRoom, AuthRoom, worker };
}

// The public surface of `@tapedb/tapedb/worker`; see API.md. Everything else in this
// module (trusted-claim plumbing, dev claims, the room class itself) is
// internal: the Durable Object class reaches the Worker as
// `defineTapeDB(...).WorkspaceRoom`.
export { ClaimError, verifyRoleClaim };
export { signRoleClaim } from "../mint";
export type { ClaimIdentity } from "../mint";
export type { ClaimLimit, ClaimLimits } from "../engine/claim-limits";
export type { TopicAction, TopicAuthorizer, TopicOptions } from "../engine/topics";
export type { WebhookEvent, WebhookEventPayload, WebhookOptions } from "../engine/webhooks";
export type { LimitsOptions, WriteLimit, WriteLimitsOptions } from "../engine/rate-limits";
export type { HttpApiOptions, HttpApiToken } from "./admin";
export type {
  RealtimeAuthorizeContext,
  RealtimeAuthorizer,
  RealtimeKind,
  RealtimeOptions,
} from "../engine/topics";
export { WORKSPACE_ROLE_LEVELS };
export type { Env, TapeDBSchema, BundledWorkspaceMigration };

// A named type for downstream declaration emission; no runtime room export.
export type { WorkspaceRoom as TapeDBRoom };

export { AuthRoom };
export type { TapeDBAuthServer } from "../auth/server";

export type { TapeDBAuthPage } from "../auth/page";
