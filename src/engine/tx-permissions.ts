/**
 * Permissions.
 *
 * Two kinds of decision, one place:
 *
 *   - a **role level** (the default: view=MEMBER, write=EDITOR, delete=MODERATOR)
 *   - a **row rule**: a predicate that sees the caller and the row
 *
 * Row rules exist because role levels cannot express "only the author may edit
 * this". They run inside the transaction, next to the write they gate, so the
 * row they judge is the row being changed.
 *
 * `view` accepts two rule forms. A function rule is evaluated per fetched row,
 * so it can express anything but cannot use an index: the executor scans to
 * fill a page, bounded by a cap. A `where` rule returns a query filter for the
 * caller, which is compiled into the SQL of every level that reads the
 * namespace, so it uses indexes and never short-fills a page.
 */

import { hasRole, WORKSPACE_ROLE_LEVELS, type RoleClaim, type WorkspaceRole } from "../claims";
import { assertDecisionShape, isViewWhereRule } from "./permission-shape";
import type { QueryWhere } from "./query-types";
import { findNamespace, toSnakeCase } from "./registry";
import type { SqlExecutor, SqlRow } from "./tx-sql";
import { TxError } from "./tx-types";
import { isLinkOp, type ValidatedOp } from "./tx-validate";

export type PermissionAction = "view" | "create" | "update" | "delete";

/** The caller, as far as a rule is concerned. */
export interface PermissionAuth {
  sub: string;
  role: WorkspaceRole;
  workspaceId: string;
}

/**
 * What a rule receives.
 *
 * `data` is the stored row for update, delete and link operations, with API
 * attribute names. `next` is the incoming values for create and update.
 */
export interface PermissionContext {
  auth: PermissionAuth;
  data?: Record<string, unknown>;
  next?: Record<string, unknown>;
  /**
   * API attribute names this op writes. Lets a rule gate one field: "only the
   * owner may change `price`" is
   * `changed.includes("price") ? data.ownerId === auth.sub : true`.
   */
  changed?: string[];
}

/** A rule returns true to allow. Throw or return false to deny. */
export type PermissionRule = (context: PermissionContext) => boolean;

/**
 * A `view` rule SQL can evaluate: the rows the caller may see, as a `where`
 * filter. An array is OR of its branches, so "mine or public" is
 * `[{ ownerId: auth.sub }, { isPublic: true }]`. An empty array hides
 * everything. Only valid for `view`.
 */
export interface ViewWhereRule {
  where: (auth: PermissionAuth) => QueryWhere | readonly QueryWhere[];
}

export type PermissionDecision = WorkspaceRole | PermissionRule | ViewWhereRule;

export type PermissionOverrides = Record<
  string,
  Partial<Record<PermissionAction, PermissionDecision>>
>;

export interface PermissionConfig {
  overrides?: PermissionOverrides;
}

export { assertDecisionShape, isViewWhereRule };

function isRule(decision: PermissionDecision): boolean {
  return typeof decision === "function" || isViewWhereRule(decision);
}

const DEFAULT_PERMISSIONS: Record<PermissionAction, WorkspaceRole> = {
  view: WORKSPACE_ROLE_LEVELS.MEMBER,
  create: WORKSPACE_ROLE_LEVELS.EDITOR,
  update: WORKSPACE_ROLE_LEVELS.EDITOR,
  delete: WORKSPACE_ROLE_LEVELS.MODERATOR,
};

/** Explicit per-namespace overrides supplied by the deployment's schema. */
const NAMESPACE_OVERRIDES: PermissionOverrides = {};

/** Installs the deployment's permission overrides. Called once per instance. */
export function configurePermissions(config: PermissionConfig = {}): void {
  for (const key of Object.keys(NAMESPACE_OVERRIDES)) {
    delete NAMESPACE_OVERRIDES[key];
  }
  for (const [namespace, actions] of Object.entries(config.overrides ?? {})) {
    for (const [action, decision] of Object.entries(actions ?? {})) {
      assertDecisionShape(namespace, action, decision);
    }
    NAMESPACE_OVERRIDES[namespace] = actions;
  }
}

function authOf(claim: RoleClaim): PermissionAuth {
  return { sub: claim.sub, role: claim.role, workspaceId: claim.workspaceId };
}

/**
 * The caller's `where` view filter for a namespace, as OR branches.
 *
 * `null` means the namespace has no where rule. A rule that throws returns no
 * branches, which hides every row: a broken rule must never widen access. The
 * shape is validated by the compiler, so a malformed filter is an error, not a
 * silent pass.
 */
export function viewWhereBranches(
  claim: RoleClaim,
  namespace: string
): readonly QueryWhere[] | null {
  const decision = decisionFor(namespace, "view");
  if (!isViewWhereRule(decision)) return null;

  let result: QueryWhere | readonly QueryWhere[];
  try {
    result = decision.where(authOf(claim));
  } catch {
    return [];
  }
  return Array.isArray(result) ? result : [result as QueryWhere];
}

function decisionFor(
  namespace: string,
  action: PermissionAction
): PermissionDecision {
  return NAMESPACE_OVERRIDES[namespace]?.[action] ?? DEFAULT_PERMISSIONS[action];
}

/**
 * True when the namespace's `view` decision is a function rule, which runs
 * after fetch. A count over such a namespace would include rows the rule
 * hides, so the executor refuses one.
 */
export function hasFunctionViewRule(namespace: string): boolean {
  return typeof decisionFor(namespace, "view") === "function";
}

/**
 * Evaluates a `view` rule against one row.
 *
 * Read rules cannot be pushed into SQL: they are arbitrary predicates. The
 * query executor calls this per fetched row, so a page can come back smaller
 * than the limit.
 */
export function allowRowView(
  claim: RoleClaim,
  namespace: string,
  data: Record<string, unknown>
): boolean {
  const decision = decisionFor(namespace, "view");
  // Level decisions were checked up front; where rules already ran in SQL.
  if (typeof decision !== "function") return true;

  try {
    return (
      decision({
        auth: {
          sub: claim.sub,
          role: claim.role,
          workspaceId: claim.workspaceId,
        },
        data,
      }) === true
    );
  } catch {
    // Fail closed: a broken read rule hides the row rather than exposing it.
    return false;
  }
}

/** Minimum role for a level decision. Throws when the namespace uses a rule. */
export function minimumRole(
  namespace: string,
  action: PermissionAction
): WorkspaceRole {
  if (!findNamespace(namespace)) {
    throw new TxError("permission_denied", `Unknown namespace "${namespace}".`);
  }

  const decision = decisionFor(namespace, action);
  if (isRule(decision)) {
    throw new TxError(
      "permission_denied",
      `"${namespace}.${action}" is a row rule, not a role level.`
    );
  }
  return decision as WorkspaceRole;
}

/**
 * Level check. A namespace whose action is a row rule is skipped here: the
 * rule is evaluated against the row inside the transaction instead.
 */
export function assertPermission(
  claim: RoleClaim,
  namespace: string,
  action: PermissionAction
): void {
  if (!findNamespace(namespace)) {
    throw new TxError("permission_denied", `Unknown namespace "${namespace}".`);
  }

  const decision = decisionFor(namespace, action);
  if (isRule(decision)) return;

  if (!hasRole(claim, decision as WorkspaceRole)) {
    throw new TxError(
      "permission_denied",
      `Role ${claim.role} is not allowed to ${action} "${namespace}".`
    );
  }
}

export function assertOpPermission(claim: RoleClaim, op: ValidatedOp): void {
  if (isLinkOp(op)) {
    assertPermission(claim, op.childNamespace, "update");
    return;
  }

  switch (op.kind) {
    case "insert":
      assertPermission(claim, op.namespace, "create");
      return;
    case "patch":
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

interface RowTarget {
  namespace: string;
  action: PermissionAction;
  id: string;
  values?: Record<string, unknown>;
}

/**
 * Which action an op represents.
 *
 * `update` is an upsert in this engine, so the action depends on whether the
 * row exists: an insert is a `create` and must satisfy the create rule, not
 * the update rule. Deciding from the op kind alone would let a create skip the
 * create rule entirely.
 */
function targetOf(op: ValidatedOp, rowExists: boolean): RowTarget {
  if (isLinkOp(op)) {
    // A link writes the child's foreign key, so the child's update rule decides.
    return { namespace: op.childNamespace, action: "update", id: op.childId };
  }
  if (op.kind === "delete") {
    return { namespace: op.namespace, action: "delete", id: op.id };
  }
  // insert and patch name their action outright; the apply step refuses an
  // insert over an existing row and a patch of a missing one.
  const action =
    op.kind === "insert"
      ? "create"
      : op.kind === "patch"
        ? "update"
        : rowExists
          ? "update"
          : "create";
  return {
    namespace: op.namespace,
    action,
    id: op.id,
    values: op.values,
  };
}

/** Stored row with API attribute names, or undefined when it does not exist. */
function readRow(
  sql: SqlExecutor,
  namespace: string,
  id: string
): Record<string, unknown> | undefined {
  const definition = findNamespace(namespace);
  if (!definition) return undefined;

  const row = sql.one<SqlRow>(
    `SELECT * FROM "${definition.table}" WHERE "id" = ?`,
    id
  );
  if (row === undefined) return undefined;

  const output: Record<string, unknown> = { id };
  for (const attribute of Object.keys(definition.attributes)) {
    const column = toSnakeCase(attribute);
    if (column in row) output[attribute] = row[column];
  }
  return output;
}

/** Incoming values arrive keyed by column; rules see API attribute names. */
function valuesToApi(
  namespace: string,
  values: Record<string, unknown>
): Record<string, unknown> {
  const definition = findNamespace(namespace);
  if (!definition) return values;

  const byColumn = new Map<string, string>();
  for (const attribute of Object.keys(definition.attributes)) {
    byColumn.set(toSnakeCase(attribute), attribute);
  }

  const output: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(values)) {
    output[byColumn.get(column) ?? column] = value;
  }
  return output;
}

/**
 * Evaluates row rules for every op. Must run inside the transaction so the row
 * a rule reads is the row the write will change.
 *
 * A rule that throws denies: a broken rule must never widen access.
 */
export function assertRowPermissions(
  sql: SqlExecutor,
  claim: RoleClaim,
  ops: ValidatedOp[]
): void {
  for (const op of ops) {
    const id = isLinkOp(op) ? op.childId : op.id;
    const namespace = isLinkOp(op) ? op.childNamespace : op.namespace;
    const data = readRow(sql, namespace, id);
    const target = targetOf(op, data !== undefined);

    const decision = decisionFor(target.namespace, target.action);
    if (typeof decision !== "function") continue;

    const context: PermissionContext = {
      auth: {
        sub: claim.sub,
        role: claim.role,
        workspaceId: claim.workspaceId,
      },
      data,
      next:
        target.values === undefined
          ? undefined
          : valuesToApi(target.namespace, target.values),
      changed:
        target.values === undefined
          ? undefined
          : Object.keys(valuesToApi(target.namespace, target.values)),
    };

    let allowed = false;
    try {
      allowed = decision(context) === true;
    } catch {
      allowed = false;
    }

    if (!allowed) {
      throw new TxError(
        "permission_denied",
        `Row rule denied ${target.action} on "${target.namespace}".`
      );
    }
  }
}

/** Exposed for tests and for future query-side authorization. */
export const PERMISSION_MATRIX = {
  defaults: DEFAULT_PERMISSIONS,
  overrides: NAMESPACE_OVERRIDES,
} as const;
