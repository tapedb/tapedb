/**
 * The admin HTTP API: `POST /v1/query`, `/v1/transact` and `/v1/claim`.
 *
 * A backend that wants to read or write a workspace had two options before
 * this: hold a browser socket, or reimplement claim signing and the engine's
 * routes. Neither is a server-to-server API. This module is that API, and it
 * is **opt-in**: a deployment that does not pass `http` has no routes here at
 * all, so the paths answer 404 like any other unknown path rather than 401 —
 * an API nobody enabled should not be discoverable.
 *
 * **What it is not.** It is not a way around the access rules. Every request
 * names who it acts as (`as: { sub, role }`) and the engine evaluates the
 * same rules against that identity it would evaluate for a socket holding
 * that claim: role levels, `filter` view rules, `check` write rules. A backend
 * acting as `admin` still fails a rule that denies admins, and a `filter` rule
 * still hides the rows that subject may not read. That is deliberate — the
 * alternative, an admin claim that skips rules, would mean one leaked token
 * reads every row in every workspace of the deployment, and the rules people
 * wrote would be documentation rather than enforcement.
 *
 * The routes are thin: the Worker verifies the token here, builds the claim
 * `as` asks for, and hands the request to the workspace's Durable Object
 * through the same `/query` and `/transact` paths a client reaches. So
 * validation, rules, write budgets, the log, webhooks and live-query
 * invalidation all happen exactly once, in the place they already happen.
 *
 * Kept out of the Worker entry so the token check and the body shapes can be
 * tested without a Durable Object; the room is reached through `callRoom`.
 */

import {
  claimSecretProblem,
  isRoleLevel,
  MIN_CLAIM_SECRET_BYTES,
  type RoleClaim,
  type WorkspaceRole,
} from "../claims";
import { isWorkspaceId } from "../engine/r2-keys";
import { apiError, discardBody, json } from "../http";
import { signRoleClaim } from "../mint";
import type { Env } from "../types";

/** Everything on this API lives under one prefix. */
export const ADMIN_PREFIX = "/v1/";

/**
 * The shared secret a backend sends as `authorization: Bearer <token>`.
 *
 * A string is checked when the Worker is defined. A function is the shape a
 * deployment actually uses — a Worker has no `env` at module scope, where
 * `defineTapeDB` runs — so it is checked on the request that resolves it.
 * Its parameter is the deployment's vars and secrets, narrowed to the strings
 * this option can read:
 *
 *   http: { token: (env) => env.TAPEDB_API_TOKEN }
 */
export type HttpApiToken = string | ((env: Record<string, string | undefined>) => string | undefined);

/** `defineTapeDB({ http })`. */
export interface HttpApiOptions {
  /**
   * The API token. At least 32 bytes, the same rule `TAPEDB_CLAIM_SECRET`
   * follows: a shorter secret is guessable from one observed request, and
   * then the whole deployment answers to whoever guessed it.
   */
  token: HttpApiToken;
}

/** The option, validated once at definition time. */
export interface ResolvedHttpApi {
  readonly token: HttpApiToken;
}

/**
 * Why `token` cannot guard this API, or null when it can. The same 32-byte
 * rule `claimSecretProblem` applies to the claim secret, with a message that
 * names this option instead of that variable.
 */
export function apiTokenProblem(token: string | undefined): string | null {
  if (!token) return "http.token is not configured; the admin HTTP API has no token to check.";
  if (new TextEncoder().encode(token).length < MIN_CLAIM_SECRET_BYTES) {
    return `http.token must be at least ${MIN_CLAIM_SECRET_BYTES} bytes; generate one with \`openssl rand -base64 32\`.`;
  }
  return null;
}

/**
 * Validates `http` when the Worker is defined and returns `undefined` when
 * the option is absent, which is the whole cost of the feature then. A token
 * given as a string is refused here, at module evaluation, rather than
 * answering 500 on the first request in production; a token resolved from the
 * request's `env` can only be checked when it is read.
 */
export function resolveHttpApi(http: HttpApiOptions | undefined): ResolvedHttpApi | undefined {
  if (http === undefined) return undefined;
  if (typeof http.token === "string") {
    const problem = apiTokenProblem(http.token);
    if (problem !== null) throw new Error(problem);
  }
  return { token: http.token };
}

/**
 * How long the claim this API acts under is valid. One request: the claim is
 * built and used before the Worker answers, so this bounds a slow room call,
 * not a session.
 */
const REQUEST_CLAIM_TTL_SECONDS = 60;

export interface AdminRequestOptions {
  request: Request;
  env: Env;
  http: ResolvedHttpApi;
  /**
   * Sends one request to `workspaceId`'s Durable Object with `claim` as the
   * verified identity. The Worker implements this by encoding the claim into
   * the trusted header and addressing the room; tests implement it by calling
   * the room directly.
   */
  callRoom(workspaceId: string, path: string, body: unknown, claim: RoleClaim): Promise<Response>;
}

const BEARER_PATTERN = /^Bearer[ \t]+(.+)$/i;
const MAX_SUB_LENGTH = 256;

/**
 * Routes one `/v1/...` request: token, then method, then the body.
 *
 * The order is the security property. A caller without the token learns
 * nothing — not which routes exist, not which method one takes, not whether a
 * workspace has data.
 */
export async function handleAdminRequest(options: AdminRequestOptions): Promise<Response> {
  const { request, env, http, callRoom } = options;
  const url = new URL(request.url);

  // `Env` has no index signature — the bindings are not all strings — while a
  // resolver only ever reads a var or secret, so the read is narrowed here.
  const expected = typeof http.token === "string" ? http.token : http.token(env as unknown as Record<string, string | undefined>);
  const problem = apiTokenProblem(expected);
  if (problem !== null) {
    // A misconfigured deployment, not a caller failure: the token came from
    // `env` and is unusable, so no caller can be authorised. The message never
    // carries the token itself.
    await discardBody(request);
    return apiError(500, "api_token_misconfigured", problem);
  }

  const given = bearerToken(request);
  if (given === null) {
    await discardBody(request);
    return apiError(401, "unauthorized", "This route needs `Authorization: Bearer <token>` with the deployment's API token.");
  }
  // Constant time, as the claim route compares its development token: a
  // byte-by-byte comparison would let a caller recover the token from timing.
  if (!sameToken(given, expected!)) {
    await discardBody(request);
    return apiError(401, "unauthorized", "This route needs `Authorization: Bearer <token>` with the deployment's API token.");
  }

  const route = url.pathname;
  if (route !== `${ADMIN_PREFIX}query` && route !== `${ADMIN_PREFIX}transact` && route !== `${ADMIN_PREFIX}claim`) {
    await discardBody(request);
    return apiError(404, "no_route", `No route for ${request.method} ${route}.`);
  }
  if (request.method !== "POST") {
    await discardBody(request);
    return apiError(405, "method_not_allowed", `${request.method} is not supported for ${route}.`);
  }

  const body = await readBody(request);
  if (body instanceof Response) return body;

  const workspace = body.workspace;
  if (typeof workspace !== "string" || !isWorkspaceId(workspace)) {
    return apiError(400, "invalid_workspace_id", "workspace must be a workspace id (a UUID).");
  }

  const grant = readGrant(body.as);
  if (grant instanceof Response) return grant;

  if (route === `${ADMIN_PREFIX}claim`) {
    return mintForSubject(env, workspace, grant.sub, grant.role);
  }

  if (route === `${ADMIN_PREFIX}query`) {
    const query = body.query;
    if (typeof query !== "object" || query === null || Array.isArray(query)) {
      return apiError(400, "invalid_query", "query must be a query document.");
    }
    return callRoom(workspace, "/query", { query }, claimFor(workspace, grant));
  }

  const writes = body.writes;
  if (!Array.isArray(writes) || writes.length === 0) {
    return apiError(400, "invalid_envelope", "writes must contain at least one operation.");
  }
  const clientTxId = body.clientTxId;
  if (clientTxId !== undefined && (typeof clientTxId !== "string" || clientTxId.trim().length === 0)) {
    return apiError(400, "invalid_envelope", "clientTxId must be a non-empty string when present.");
  }
  // A fresh txId per call: `clientTxId` is the caller's retry key, and the
  // engine's receipt table makes a repeat of it a replay rather than a second
  // write. A caller that sends neither gets at-most-once semantics, exactly as
  // a socket client without a `clientTxId` does.
  return callRoom(
    workspace,
    "/transact",
    {
      txId: crypto.randomUUID(),
      ...(clientTxId === undefined ? {} : { clientTxId }),
      ops: writes,
    },
    claimFor(workspace, grant)
  );
}

/** `POST /v1/claim`: the same answer a claim route mints, for a named subject. */
async function mintForSubject(
  env: Env,
  workspace: string,
  sub: string,
  role: WorkspaceRole
): Promise<Response> {
  const problem = claimSecretProblem(env.TAPEDB_CLAIM_SECRET);
  if (problem !== null) return apiError(500, "claim_secret_missing", problem);

  const minted = await signRoleClaim(env.TAPEDB_CLAIM_SECRET, {
    sub,
    workspaceId: workspace,
    role,
    ...(env.TAPEDB_CLAIM_ISSUER === undefined ? {} : { iss: env.TAPEDB_CLAIM_ISSUER }),
    ...(env.TAPEDB_CLAIM_AUDIENCE === undefined ? {} : { aud: env.TAPEDB_CLAIM_AUDIENCE }),
  });

  return json({
    token: minted.token,
    workspaceId: workspace,
    roleLevel: role,
    expiresAt: minted.expiresAt,
    expiresIn: minted.expiresIn,
  });
}

interface Grant {
  sub: string;
  role: WorkspaceRole;
}

/**
 * `as: { sub, role }`, validated as a claim is: a non-empty subject of at most
 * 256 characters and a whole role level from 0 to 8. Nothing else is
 * accepted, and the role is whoever the backend names — the rules decide what
 * that role may do, which is the point.
 */
function readGrant(value: unknown): Grant | Response {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return apiError(400, "invalid_as", "as must be an object: { sub, role }.");
  }
  const fields = value as Record<string, unknown>;
  const sub = fields.sub;
  if (typeof sub !== "string" || sub.trim().length === 0 || sub.length > MAX_SUB_LENGTH) {
    return apiError(400, "invalid_sub", "as.sub must be a non-empty user id of at most 256 characters.");
  }
  const role = fields.role;
  if (!isRoleLevel(role)) {
    return apiError(400, "invalid_role", "as.role must be a role level from 0 to 8.");
  }
  return { sub, role };
}

function claimFor(workspace: string, grant: Grant): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: grant.sub,
    workspaceId: workspace,
    role: grant.role,
    iat: now,
    exp: now + REQUEST_CLAIM_TTL_SECONDS,
  };
}

/** The request body as a plain object, or the refusal to return. */
async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return apiError(400, "invalid_body", "Request body must be a JSON object.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return apiError(400, "invalid_body", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

/** The token from `authorization: Bearer <token>`, or null. Never the URL. */
function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = BEARER_PATTERN.exec(header.trim());
  const token = match?.[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

/**
 * Constant-time comparison, the same loop the claim route uses for its
 * development token: the differing bytes are folded into one accumulator and
 * the length into the starting value, so neither the matching prefix nor the
 * length short-circuits.
 */
function sameToken(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let index = 0; index < b.length; index += 1) diff |= (a[index] ?? 0) ^ b[index]!;
  return diff === 0;
}
