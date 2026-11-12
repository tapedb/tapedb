/**
 * `POST /_tapedb/claim` routing.
 *
 * Kept out of the Worker entry so it can be tested without the Workers runtime:
 * a claim either mints a token or refuses, and never touches a Durable Object.
 */

import { apiError, discardBody, json } from "./http";
import { isWorkspaceId } from "./engine/r2-keys";
import { mintClaim, mintDevClaim, type ClaimIdentity } from "./mint";

export interface ClaimRouteEnv {
  ENVIRONMENT?: string;
  TAPEDB_CLAIM_SECRET: string;
  TAPEDB_CLAIM_ISSUER?: string;
  TAPEDB_CLAIM_AUDIENCE?: string;
}

export interface ClaimRouteOptions {
  env: ClaimRouteEnv;
  identity?: ClaimIdentity;
  devClaims?: boolean;
}

/**
 * Order matters and is the security property: the development issuer is
 * checked first, but it is unreachable when `ENVIRONMENT` is `production`.
 * A deployment that forgets to set `ENVIRONMENT` gets dev claims in a
 * non-production Worker, which is why `tapedb init` writes it explicitly.
 */
export async function handleClaimRequest(
  request: Request,
  options: ClaimRouteOptions
): Promise<Response> {
  const { env, identity, devClaims = false } = options;
  const isProduction = env.ENVIRONMENT === "production";

  if (devClaims && !isProduction) {
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
    secret: env.TAPEDB_CLAIM_SECRET,
    issuer: env.TAPEDB_CLAIM_ISSUER,
    audience: env.TAPEDB_CLAIM_AUDIENCE,
  });
}
