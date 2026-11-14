import {
  WORKSPACE_ROLE_LEVELS,
  type RoleClaim,
  type WorkspaceRole,
} from "./claims";
import { claimFromProtocols } from "./socket-protocol";

/**
 * Engine role-claim verification.
 *
 * The platform mints a short-lived HS256 JWT whose payload matches the frozen
 * `RoleClaim` contract in `./claims.ts`. This module is the Worker half: it
 * validates the signature and the claim before any request reaches a
 * `WorkspaceRoom` Durable Object.
 *
 * There is deliberately no JWKS path: the agreed contract is a shared HS256
 * secret (`TAPEDB_CLAIM_SECRET`), not an asymmetric key set.
 */

/** Trusted header forwarded to the Durable Object after verification. */
export const TRUSTED_CLAIM_HEADER = "x-tapedb-claims";

export type ClaimErrorCode =
  | "missing_token"
  | "invalid_format"
  | "invalid_signature"
  | "expired"
  | "wrong_workspace"
  | "invalid_claim";

/** Typed verification failure; `code` is safe to return to the caller. */
export class ClaimError extends Error {
  readonly code: ClaimErrorCode;

  constructor(code: ClaimErrorCode, message: string) {
    super(message);
    this.name = "ClaimError";
    this.code = code;
  }
}

/** Minimal env view needed to verify a claim. */
export interface ClaimVerificationEnv {
  TAPEDB_CLAIM_SECRET: string;
  TAPEDB_CLAIM_ISSUER?: string;
  TAPEDB_CLAIM_AUDIENCE?: string;
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BEARER_PATTERN = /^Bearer[ \t]+(.+)$/i;
const MAX_IAT_SKEW_SECONDS = 60;

/**
 * Reads a claim token from the request.
 *
 * - `Authorization: Bearer <jwt>` for HTTP requests.
 * - A `tapedb.claim.<jwt>` entry in `Sec-WebSocket-Protocol` for WebSocket
 *   upgrades, where browsers cannot set `Authorization`.
 *
 * Never the URL: a token in a query string ends up in request logs and
 * browser history. A `?claim=` parameter is ignored.
 *
 * A present-but-non-Bearer `Authorization` header returns `null` instead of
 * falling back to the protocol header, so the two transports cannot be confused.
 */
export function extractClaimToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = BEARER_PATTERN.exec(authorization.trim());
    const token = match?.[1]?.trim() ?? "";
    return token.length > 0 ? token : null;
  }

  return claimFromProtocols(request.headers.get("sec-websocket-protocol"));
}

/**
 * Verifies a compact JWS against the frozen `RoleClaim` contract.
 *
 * Throws `ClaimError` for malformed tokens, bad signatures, expiry, workspace
 * mismatches and invalid claim values. A missing server secret throws a plain
 * `Error`: that is a deployment problem, not a client failure.
 */
export async function verifyRoleClaim(
  token: string,
  env: ClaimVerificationEnv,
  expectedWorkspaceId: string
): Promise<RoleClaim> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new ClaimError("invalid_format", "Token is not a compact JWS.");
  }

  const [headerSegment, payloadSegment, signatureSegment] = parts;

  const header = decodeJsonSegment(headerSegment, "header");
  if (header.alg !== "HS256") {
    throw new ClaimError("invalid_format", "Token algorithm must be HS256.");
  }
  // `typ` is optional, but when present it must be exactly JWT.
  if (header.typ !== undefined && header.typ !== "JWT") {
    throw new ClaimError("invalid_format", "Token type must be JWT.");
  }

  const signature = decodeBase64Url(signatureSegment, "signature");
  const secret = env.TAPEDB_CLAIM_SECRET;
  if (!secret) {
    throw new Error("TAPEDB_CLAIM_SECRET is not configured.");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature as unknown as BufferSource,
    new TextEncoder().encode(`${headerSegment}.${payloadSegment}`)
  );
  if (!valid) {
    throw new ClaimError("invalid_signature", "Token signature is invalid.");
  }

  const payload = decodeJsonSegment(payloadSegment, "payload");
  const now = Math.floor(Date.now() / 1000);

  const sub = payload.sub;
  if (typeof sub !== "string" || sub.trim().length === 0) {
    throw new ClaimError("invalid_claim", "Claim subject must be non-empty.");
  }

  const workspaceId = payload.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new ClaimError("invalid_claim", "Claim workspace id must be set.");
  }
  if (workspaceId !== expectedWorkspaceId) {
    throw new ClaimError(
      "wrong_workspace",
      "Token is valid for a different workspace."
    );
  }

  const role = payload.role;
  if (
    typeof role !== "number" ||
    !Number.isInteger(role) ||
    role < WORKSPACE_ROLE_LEVELS.GUEST ||
    role > WORKSPACE_ROLE_LEVELS.DEVELOPER
  ) {
    throw new ClaimError(
      "invalid_claim",
      "Claim role must be an integer from 0 to 8."
    );
  }

  const exp = payload.exp;
  const iat = payload.iat;
  if (
    typeof exp !== "number" ||
    !Number.isInteger(exp) ||
    typeof iat !== "number" ||
    !Number.isInteger(iat)
  ) {
    throw new ClaimError(
      "invalid_claim",
      "Claim exp and iat must be integer seconds."
    );
  }

  if (exp <= now) {
    throw new ClaimError("expired", "Token has expired.");
  }
  if (iat > now + MAX_IAT_SKEW_SECONDS) {
    throw new ClaimError(
      "invalid_claim",
      "Claim iat is too far in the future."
    );
  }

  const issuer = payload.iss;
  const audience = payload.aud;
  if (issuer !== undefined && typeof issuer !== "string") {
    throw new ClaimError("invalid_claim", "Claim issuer must be a string.");
  }
  if (audience !== undefined && typeof audience !== "string") {
    throw new ClaimError("invalid_claim", "Claim audience must be a string.");
  }

  if (env.TAPEDB_CLAIM_ISSUER && issuer !== env.TAPEDB_CLAIM_ISSUER) {
    throw new ClaimError("invalid_claim", "Claim issuer is not accepted.");
  }
  if (env.TAPEDB_CLAIM_AUDIENCE && audience !== env.TAPEDB_CLAIM_AUDIENCE) {
    throw new ClaimError("invalid_claim", "Claim audience is not accepted.");
  }

  const claim: RoleClaim = {
    sub,
    workspaceId,
    role: role as WorkspaceRole,
    exp,
    iat,
  };
  if (issuer !== undefined) claim.iss = issuer;
  if (audience !== undefined) claim.aud = audience;
  return claim;
}

/** Extracts and verifies the claim attached to an engine request. */
export async function authenticateEngineRequest(
  request: Request,
  env: ClaimVerificationEnv,
  workspaceId: string
): Promise<RoleClaim> {
  const token = extractClaimToken(request);
  if (token === null) {
    throw new ClaimError("missing_token", "Missing engine claim token.");
  }
  return verifyRoleClaim(token, env, workspaceId);
}

/**
 * Serialises the verified claim for the Durable Object. Only the fields the
 * engine needs are forwarded; signature material is never re-sent.
 */
export function encodeTrustedRoleClaim(claim: RoleClaim): string {
  const forwarded = {
    sub: claim.sub,
    workspaceId: claim.workspaceId,
    role: claim.role,
    exp: claim.exp,
  };
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(forwarded)));
}

function decodeJsonSegment(
  segment: string,
  label: string
): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(decodeBase64Url(segment, label));
  } catch (error) {
    if (error instanceof ClaimError) throw error;
    throw new ClaimError(
      "invalid_format",
      `Token ${label} is not valid UTF-8.`
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ClaimError("invalid_format", `Token ${label} is not valid JSON.`);
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClaimError(
      "invalid_format",
      `Token ${label} must be a JSON object.`
    );
  }
  return value as Record<string, unknown>;
}

/** Strict base64url: URL-safe alphabet only, no padding, canonical length. */
function decodeBase64Url(segment: string, label: string): Uint8Array {
  if (
    segment.length === 0 ||
    !BASE64URL_PATTERN.test(segment) ||
    segment.length % 4 === 1
  ) {
    throw new ClaimError(
      "invalid_format",
      `Token ${label} is not valid base64url.`
    );
  }

  const base64 =
    segment.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (segment.length % 4)) % 4);

  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new ClaimError(
      "invalid_format",
      `Token ${label} is not valid base64url.`
    );
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  // Reject non-canonical encodings that `atob` would otherwise accept.
  if (encodeBase64Url(bytes) !== segment) {
    throw new ClaimError(
      "invalid_format",
      `Token ${label} is not valid base64url.`
    );
  }
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
