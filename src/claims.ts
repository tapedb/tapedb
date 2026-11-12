/**
 * Shared role-claim contract between the Worker (JWT verification) and the
 * workspace engine (permission checks). KAN-390 owns verification; KAN-391
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

export function hasRoleLevel(
  role: WorkspaceRole,
  minimum: WorkspaceRole
): boolean {
  return role >= minimum;
}

export function hasRole(claim: RoleClaim, minimum: WorkspaceRole): boolean {
  return hasRoleLevel(claim.role, minimum);
}
