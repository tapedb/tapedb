/**
 * Claim minting.
 *
 * The engine consumes a short-lived signed claim and never issues one. This
 * module is the other half: it turns a session into that claim, and it is
 * deliberately identity-agnostic. Bring BetterAuth, your own JWT, a session
 * cookie or an API key and implement two methods.
 *
 * Wire format matches the verifier exactly: compact JWS, HS256, base64url with
 * no padding, payload `{ sub, workspaceId, role, iat, exp, iss?, aud? }`.
 */

import { WORKSPACE_ROLE_LEVELS, type RoleClaim, type WorkspaceRole } from "./claims";
import { apiError, discardBody, json } from "./http";

export const DEFAULT_CLAIM_TTL_SECONDS = 300;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MintClaimInput {
  sub: string;
  workspaceId: string;
  role: WorkspaceRole;
  iss?: string;
  aud?: string;
  ttlSeconds?: number;
}

export interface MintedClaim {
  token: string;
  expiresAt: number;
  expiresIn: number;
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
  return base64UrlFromBytes(new TextEncoder().encode(JSON.stringify(value)));
}

/** Signs the compact HS256 claim the engine verifier accepts. */
export async function signRoleClaim(
  secret: string,
  input: MintClaimInput,
  now: number = Date.now()
): Promise<MintedClaim> {
  if (!secret) throw new Error("TAPEDB_CLAIM_SECRET is not configured.");

  const ttlSeconds = input.ttlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS;
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + ttlSeconds;

  const payload: RoleClaim = {
    sub: input.sub,
    workspaceId: input.workspaceId,
    role: input.role,
    iat: issuedAt,
    exp: expiresAt,
    ...(input.iss ? { iss: input.iss } : {}),
    ...(input.aud ? { aud: input.aud } : {}),
  };

  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const body = encodeJson(payload);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${header}.${body}`)
  );

  return {
    token: `${header}.${body}.${base64UrlFromBytes(new Uint8Array(signature))}`,
    expiresAt: expiresAt * 1000,
    expiresIn: ttlSeconds,
  };
}

/**
 * The two methods a deployment implements, and an optional rate limit.
 * Everything else about identity (passwords, magic codes, OAuth, cookies)
 * stays in the host application.
 */
export interface ClaimIdentity {
  /** Resolve the caller's subject from the request. Null means "not signed in". */
  getSubject(headers: Headers): Promise<{ sub: string } | null>;
  /** Resolve the caller's role in a workspace. Null means "not a member". */
  getRole(workspaceId: string, sub: string): Promise<WorkspaceRole | null>;
  /**
   * Optional per-caller limit for the claim route, checked before anything
   * else. `key` is `claim:<cf-connecting-ip>`. Return false to refuse with
   * 429 `rate_limited`; a throw refuses with 500 `rate_limit_unavailable`.
   * Back it with a Cloudflare rate-limit binding when the route is public.
   */
  allowRequest?(key: string): Promise<boolean>;
}

export interface MintClaimDependencies {
  identity: ClaimIdentity;
  secret: string;
  issuer?: string;
  audience?: string;
  ttlSeconds?: number;
  now?: () => number;
  /** Optional per-caller limiter; return false to reject with 429. */
  allowRequest?: (key: string) => Promise<boolean>;
}

/**
 * `POST /_tapedb/claim`: session to workspace role to a short-lived claim.
 *
 * Rate limiting is the deployment's call. If you expose this on the public
 * internet, back `allowRequest` with a Cloudflare rate-limit binding.
 */
export async function mintClaim(
  request: Request,
  deps: MintClaimDependencies
): Promise<Response> {
  if (request.method !== "POST") {
    await discardBody(request);
    return apiError(405, "method_not_allowed", "Use POST.");
  }

  if (deps.allowRequest) {
    const key = `claim:${request.headers.get("cf-connecting-ip") ?? "unknown"}`;
    let allowed: boolean;
    try {
      allowed = await deps.allowRequest(key);
    } catch {
      return apiError(500, "rate_limit_unavailable", "Could not apply the claim rate limit.");
    }
    if (!allowed) {
      await discardBody(request);
      return apiError(429, "rate_limited", "Too many claim requests. Try again shortly.");
    }
  }

  let subject: { sub: string } | null;
  try {
    subject = await deps.identity.getSubject(request.headers);
  } catch {
    return apiError(500, "session_lookup_failed", "Could not resolve the session.");
  }

  if (subject === null || subject.sub.trim().length === 0) {
    await discardBody(request);
    return apiError(401, "unauthenticated", "Sign in first.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "invalid_body", "Request body must be a JSON object.");
  }

  const workspaceId =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).workspaceId
      : undefined;

  if (typeof workspaceId !== "string" || !UUID_PATTERN.test(workspaceId)) {
    return apiError(400, "invalid_workspace_id", "workspaceId must be a UUID.");
  }

  if (!deps.secret) {
    return apiError(500, "claim_secret_missing", "TAPEDB_CLAIM_SECRET is not configured.");
  }

  let role: WorkspaceRole | null;
  try {
    role = await deps.identity.getRole(workspaceId, subject.sub);
  } catch {
    return apiError(500, "membership_lookup_failed", "Could not resolve workspace membership.");
  }

  if (role === null) {
    return apiError(403, "not_a_member", "You are not a member of this workspace.");
  }

  const minted = await signRoleClaim(
    deps.secret,
    {
      sub: subject.sub,
      workspaceId,
      role,
      iss: deps.issuer,
      aud: deps.audience,
      ttlSeconds: deps.ttlSeconds,
    },
    deps.now?.() ?? Date.now()
  );

  return json({
    token: minted.token,
    workspaceId,
    roleLevel: role,
    expiresAt: minted.expiresAt,
    expiresIn: minted.expiresIn,
  });
}

/**
 * Development-only issuer. Mints an OWNER claim for any workspace without a
 * session so `tapedb dev` works with zero configuration.
 *
 * The caller is responsible for refusing this in production; `defineTapeDB`
 * enforces that before this function is reachable.
 */
export async function mintDevClaim(
  workspaceId: string,
  secret: string
): Promise<MintedClaim> {
  return signRoleClaim(secret, {
    sub: "dev-user",
    workspaceId,
    role: WORKSPACE_ROLE_LEVELS.OWNER,
  });
}
