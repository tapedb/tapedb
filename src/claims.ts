/**
 * Shared role-claim contract between the Worker (JWT verification) and the
 * workspace engine (permission checks).
 * consumes this shape.
 */

export const WORKSPACE_ROLE_LEVELS = {
  GUEST: 0,
  USER: 1,
  MEMBER: 2,
  EDITOR: 3,
  MODERATOR: 4,
  ADMIN: 5,
  OWNER: 6,
  FOUNDER: 7,
  DEVELOPER: 8,
} as const;

export type WorkspaceRole =
  (typeof WORKSPACE_ROLE_LEVELS)[keyof typeof WORKSPACE_ROLE_LEVELS];

export interface RoleClaim {
  /** Platform user id. */
  sub: string;
  /** Platform workspace id (the DO name). */
  workspaceId: string;
  /** Numeric workspace role level. */
  role: WorkspaceRole;
  /** Expiry, seconds since epoch. */
  exp: number;
  /** Issued at, seconds since epoch. */
  iat: number;
  iss?: string;
  aud?: string;
}

/** True for a whole role level from GUEST (0) to DEVELOPER (8). */
export function isRoleLevel(value: unknown): value is WorkspaceRole {
  return typeof value === "number" && Number.isInteger(value) && value >= WORKSPACE_ROLE_LEVELS.GUEST && value <= WORKSPACE_ROLE_LEVELS.DEVELOPER;
}

export function hasRoleLevel(
  role: WorkspaceRole,
  minimum: WorkspaceRole
): boolean {
  return role >= minimum;
}

export function hasRole(claim: RoleClaim, minimum: WorkspaceRole): boolean {
  return hasRoleLevel(claim.role, minimum);
}

/**
 * Shortest accepted `TAPEDB_CLAIM_SECRET`, in bytes. HS256 keys need at
 * least the hash's 256 bits (RFC 7518, section 3.2); a shorter secret can be
 * found offline from any one claim, and then claims can be forged.
 */
export const MIN_CLAIM_SECRET_BYTES = 32;

/** Why `secret` cannot sign or verify claims, or null when it can. */
export function claimSecretProblem(secret: string | undefined): string | null {
  if (!secret) return "TAPEDB_CLAIM_SECRET is not configured.";
  if (new TextEncoder().encode(secret).length < MIN_CLAIM_SECRET_BYTES) {
    return `TAPEDB_CLAIM_SECRET must be at least ${MIN_CLAIM_SECRET_BYTES} bytes; generate one with \`openssl rand -base64 32\`.`;
  }
  return null;
}
