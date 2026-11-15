/**
 * Reads the role claim the Worker attaches after verifying the client JWT.
 *
 * The client-supplied `x-tapedb-claims` header is replaced before forwarding, so this
 * header is trusted. Nothing here reads a client header directly, verifies a
 * signature, or logs token material. A missing, malformed, expired or
 * wrong-workspace claim is a permission failure.
 */

import {
  WORKSPACE_ROLE_LEVELS,
  type RoleClaim,
  type WorkspaceRole,
} from "../claims";
import { TRUSTED_CLAIM_HEADER } from "../verify";
import { TxError } from "./tx-types";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function readTrustedRoleClaim(
  request: Request,
  workspaceId: string
): RoleClaim {
  const claim = readTrustedRoleClaimAnyWorkspace(request);
  if (claim.workspaceId !== workspaceId) {
    throw denied("Verified role claim is for a different workspace.");
  }
  return claim;
}

/**
 * Reads the verified claim without comparing it to a workspace id.
 *
 * For Durable Objects addressed by something other than a workspace (the app
 * registry), the workspace check is the caller's job: the binding is what
 * decides which workspace the claim must match.
 */
export function readTrustedRoleClaimAnyWorkspace(request: Request): RoleClaim {
  const header = request.headers.get(TRUSTED_CLAIM_HEADER);
  if (header === null || header.length === 0) {
    throw denied("Missing verified role claim.");
  }

  const payload = decodeClaim(header);
  if (payload === null) {
    throw denied("Verified role claim is malformed.");
  }

  const sub = payload.sub;
  if (typeof sub !== "string" || sub.trim().length === 0) {
    throw denied("Verified role claim has no subject.");
  }

  const claimedWorkspace = payload.workspaceId;
  if (typeof claimedWorkspace !== "string" || claimedWorkspace.length === 0) {
    throw denied("Verified role claim has no workspace.");
  }

  const role = payload.role;
  if (
    typeof role !== "number" ||
    !Number.isInteger(role) ||
    role < WORKSPACE_ROLE_LEVELS.GUEST ||
    role > WORKSPACE_ROLE_LEVELS.DEVELOPER
  ) {
    throw denied("Verified role claim has an invalid role.");
  }

  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isInteger(exp)) {
    throw denied("Verified role claim has no expiry.");
  }
  if (exp <= Math.floor(Date.now() / 1000)) {
    throw denied("Verified role claim has expired.");
  }

  const iat = payload.iat;
  const claim: RoleClaim = {
    sub,
    workspaceId: claimedWorkspace,
    role: role as WorkspaceRole,
    exp,
    // The Worker does not forward `iat`; 0 keeps the shape stable.
    iat: typeof iat === "number" && Number.isInteger(iat) ? iat : 0,
  };

  return claim;
}

function decodeClaim(header: string): Record<string, unknown> | null {
  if (!BASE64URL_PATTERN.test(header) || header.length % 4 === 1) {
    return null;
  }

  const base64 =
    header.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (header.length % 4)) % 4);

  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  // Reject non-canonical encodings that atob accepts.
  if (encodeBase64Url(bytes) !== header) return null;

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes
    );
  } catch {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
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

function denied(message: string): TxError {
  return new TxError("permission_denied", message);
}
