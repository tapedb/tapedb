/**
 * Workspace transaction permissions.
 *
 * Defaults: view=MEMBER, create/update=EDITOR, delete=MODERATOR. A deployment
 * may widen or narrow any namespace per action with `configurePermissions()`;
 * only namespaces with a deliberate exception need an entry.
 */

import {
  hasRole,
  WORKSPACE_ROLE_LEVELS,
  type RoleClaim,
  type WorkspaceRole,
} from "../claims";
import { findNamespace } from "./registry";
import { TxError } from "./tx-types";
import { isLinkOp, type ValidatedOp } from "./tx-validate";

export type PermissionAction = "view" | "create" | "update" | "delete";

const DEFAULT_PERMISSIONS: Record<PermissionAction, WorkspaceRole> = {
  view: WORKSPACE_ROLE_LEVELS.MEMBER,
  create: WORKSPACE_ROLE_LEVELS.EDITOR,
  update: WORKSPACE_ROLE_LEVELS.EDITOR,
  delete: WORKSPACE_ROLE_LEVELS.MODERATOR,
};

/** Explicit per-namespace overrides supplied by the deployment's schema. */
const NAMESPACE_OVERRIDES: Record<
  string,
  Partial<Record<PermissionAction, WorkspaceRole>>
> = {};

export interface PermissionConfig {
  overrides?: Record<
    string,
    Partial<Record<PermissionAction, WorkspaceRole>>
  >;
}

/** Installs the deployment's permission overrides. Called once per instance. */
export function configurePermissions(config: PermissionConfig = {}): void {
  for (const key of Object.keys(NAMESPACE_OVERRIDES)) {
    delete NAMESPACE_OVERRIDES[key];
  }
  for (const [namespace, actions] of Object.entries(config.overrides ?? {})) {
    NAMESPACE_OVERRIDES[namespace] = actions;
  }
}

/** Minimum role for an action on a namespace. */
export function minimumRole(
  namespace: string,
  action: PermissionAction
): WorkspaceRole {
  if (!findNamespace(namespace)) {
    throw new TxError("permission_denied", `Unknown namespace "${namespace}".`);
  }

  const override = NAMESPACE_OVERRIDES[namespace]?.[action];
  if (override !== undefined) return override;
  return DEFAULT_PERMISSIONS[action];
}

export function assertPermission(
  claim: RoleClaim,
  namespace: string,
  action: PermissionAction
): void {
  const minimum = minimumRole(namespace, action);
  if (!hasRole(claim, minimum)) {
    throw new TxError(
      "permission_denied",
      `Role ${claim.role} is not allowed to ${action} "${namespace}".`
    );
  }
}

/**
 * Authorizes one validated op.
 *
 * `link`/`unlink` write the child's foreign key, so they require `update` on
 * the FK-owning child namespace rather than on the source namespace.
 */
export function assertOpPermission(claim: RoleClaim, op: ValidatedOp): void {
  if (isLinkOp(op)) {
    assertPermission(claim, op.childNamespace, "update");
    return;
  }

  switch (op.kind) {
    case "update":
    case "merge":
      assertPermission(claim, op.namespace, "update");
      return;
    case "delete":
      assertPermission(claim, op.namespace, "delete");
      return;
  }
}

export function authorizeOps(claim: RoleClaim, ops: ValidatedOp[]): void {
  for (const op of ops) assertOpPermission(claim, op);
}

/** Exposed for tests and for future query-side authorization. */
export const PERMISSION_MATRIX = {
  defaults: DEFAULT_PERMISSIONS,
  overrides: NAMESPACE_OVERRIDES,
} as const;
