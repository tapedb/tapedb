/**
 * `POST /_tapedb/claim` routing.
 *
 * Kept out of the Worker entry so it can be tested without the Workers runtime:
 * a claim either mints a token or refuses. The built-in limits come in as a
 * function, so the route itself never addresses a Durable Object.
 */

import { apiError, discardBody, json } from "./http";
import { isWorkspaceId } from "./engine/r2-keys";
import { mintClaim, mintDevClaim, type ClaimIdentity } from "./mint";
import type { LimitDecision } from "./engine/claim-limits";

export interface ClaimRouteEnv {
  ENVIRONMENT?: string;
  TAPEDB_CLAIM_SECRET: string;
  TAPEDB_CLAIM_ISSUER?: string;
  TAPEDB_CLAIM_AUDIENCE?: string;
  TAPEDB_DEV_CLAIMS?: string;
  /**
   * When set, the development route mints only for requests that carry it in
   * `x-tapedb-dev-token`. For a deployed test Worker reachable by anyone:
   * without it, the route hands an owner claim for any workspace to anyone.
   */
  TAPEDB_DEV_CLAIMS_TOKEN?: string;
}

/** Header a gated development route expects TAPEDB_DEV_CLAIMS_TOKEN in. */
export const DEV_TOKEN_HEADER = "x-tapedb-dev-token";

export interface ClaimRouteOptions {
  env: ClaimRouteEnv;
  identity?: ClaimIdentity;
  devClaims?: boolean;
  /** Takes one token from a built-in limit (claim-limits.ts); absent when limits are off. */
  limit?: (kind: "ip" | "subject", value: string) => Promise<LimitDecision>;
}

/**
 * Order matters and is the security property: the development issuer is
 * checked first, but two independent conditions must both hold:
 *
 *   1. the code opted in (`devClaims: true`), and
 *   2. the deployment opted in (`TAPEDB_DEV_CLAIMS=true`), and
 *   3. `ENVIRONMENT` is not `production`.
 *
 * With `TAPEDB_DEV_CLAIMS_TOKEN` set, the request must also carry that token
 * (compared in constant time); without it the route answers 401 and mints
 * nothing.
 *
 * The env-var condition is the one that makes a plain `wrangler deploy` safe:
 * `tapedb dev` passes the var on the command line, so a deployed Worker never
 * has it, even if `ENVIRONMENT` is left at the generated default.
 */
export async function handleClaimRequest(
  request: Request,
  options: ClaimRouteOptions
): Promise<Response> {
  const { env, identity, devClaims = false, limit } = options;
  const isProduction = env.ENVIRONMENT === "production";
  const devEnabled = devClaims && env.TAPEDB_DEV_CLAIMS === "true";

  if (devEnabled && !isProduction) {
    const required = env.TAPEDB_DEV_CLAIMS_TOKEN;
    if (required && !sameToken(request.headers.get(DEV_TOKEN_HEADER) ?? "", required)) {
      await discardBody(request);
      return apiError(401, "dev_token_required", `This development claim route needs the ${DEV_TOKEN_HEADER} header.`);
    }
    if (request.method !== "POST") {
      await discardBody(request);
      return apiError(405, "method_not_allowed", "Use POST.");
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

    if (typeof workspaceId !== "string" || !isWorkspaceId(workspaceId)) {
      return apiError(400, "invalid_workspace_id", "workspaceId must be a UUID.");
    }

    if (!env.TAPEDB_CLAIM_SECRET) {
      return apiError(500, "claim_secret_missing", "TAPEDB_CLAIM_SECRET is not configured.");
    }

    const minted = await mintDevClaim(workspaceId, env.TAPEDB_CLAIM_SECRET);
    return json({ token: minted.token, workspaceId, expiresIn: minted.expiresIn });
  }

  if (!identity) {
    await discardBody(request);
    return apiError(
      501,
      "identity_not_configured",
      "Pass defineTapeDB({ identity }) to serve claims."
    );
  }

  return mintClaim(request, {
    identity,
    ...(identity.allowRequest ? { allowRequest: (key: string) => identity.allowRequest!(key) } : {}),
    ...(limit ? { limit } : {}),
    secret: env.TAPEDB_CLAIM_SECRET,
    issuer: env.TAPEDB_CLAIM_ISSUER,
    audience: env.TAPEDB_CLAIM_AUDIENCE,
  });
}

/** Constant-time comparison, so the token cannot be guessed byte by byte from timing. */
function sameToken(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i += 1) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}
