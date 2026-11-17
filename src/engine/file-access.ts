import { PersonalPending } from "./personal";
/**
 * Per-file access rules: who may read, write and delete each file.
 *
 * Installed from the schema's `files` rules by `defineTapeDB`, in the Worker
 * and in every Durable Object. Without rules the defaults are role levels
 * (read: member, write and delete: editor), checked by the Worker alone, as
 * before. With any rule the workspace's Durable Object decides every byte
 * route and filters the file list, because only it holds the index (who
 * uploaded what) and the rows a file can be attached to.
 *
 * A rule is one of:
 * - a role level;
 * - a check over the caller and the file (and, for a write, the file it
 *   replaces);
 * - attachment to a row: the file follows the row's own rules. Reading it
 *   needs the row to be readable by the caller, writing or deleting it needs
 *   the caller to be allowed to update the row. A path that names no row, or
 *   a row that does not exist, denies.
 *
 * Every rule fails closed: one that throws denies.
 */

import { hasRole, WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../claims";
import { executeQuery } from "./query-execute";
import { findNamespace } from "./registry";
import { allowStoredRow } from "./tx-permissions";
import type { SqlExecutor } from "./tx-sql";

export type FileAction = "read" | "write" | "delete";

/** A file as rules see it. */
export interface FileInfo {
  path: string;
  /** Bytes; null for a write whose size is not known yet. */
  size: number | null;
  contentType: string | null;
  /** The uploader's claim subject. */
  uploadedBy: string;
}

export interface FileCheckContext {
  auth: { sub: string; role: number; workspaceId: string };
  /** For read and delete, the stored file; for write, the incoming one. */
  file: FileInfo;
  /** For write, the stored file it would replace, if any. */
  existing?: FileInfo;
}

export type FileRule =
  | { readonly decision: "role"; readonly level: number }
  | { readonly decision: "check"; readonly test: (context: FileCheckContext) => boolean }
  | {
      readonly decision: "attachedTo";
      readonly model: string;
      readonly locate: (path: string) => string | null | undefined;
    };

export interface FileRules {
  read?: FileRule;
  write?: FileRule;
  delete?: FileRule;
}

const DEFAULTS: Record<FileAction, FileRule> = {
  read: { decision: "role", level: WORKSPACE_ROLE_LEVELS.MEMBER },
  write: { decision: "role", level: WORKSPACE_ROLE_LEVELS.EDITOR },
  delete: { decision: "role", level: WORKSPACE_ROLE_LEVELS.EDITOR },
};

let rules: FileRules = {};

export function configureFileAccess(next: FileRules | undefined): void {
  for (const [action, rule] of Object.entries(next ?? {})) {
    if (!["read", "write", "delete"].includes(action)) {
      throw new Error(`files.${action} is not a file action; use read, write or delete.`);
    }
    if (rule === undefined) continue;
    if (rule.decision === "role") {
      if (!Number.isInteger(rule.level)) throw new Error(`files.${action}: role() needs a role level.`);
    } else if (rule.decision === "check") {
      if (typeof rule.test !== "function") throw new Error(`files.${action}: fileCheck() needs a function.`);
    } else if (rule.decision === "attachedTo") {
      if (typeof rule.locate !== "function") throw new Error(`files.${action}: attachedTo() needs a function from path to row id.`);
    } else {
      throw new Error(`files.${action}: use role(), fileCheck() or attachedTo().`);
    }
  }
  rules = { ...(next ?? {}) };
}

/** True when the schema sets any file rule; the defaults need no Durable Object. */
export function fileRulesConfigured(): boolean {
  return Object.values(rules).some((rule) => rule !== undefined);
}

function ruleFor(action: FileAction): FileRule {
  return rules[action] ?? DEFAULTS[action];
}

/** The role a role-only rule needs, or null when the rule looks at the file. */
export function fileRoleFloor(action: FileAction): number | null {
  const rule = ruleFor(action);
  return rule.decision === "role" ? rule.level : null;
}

function authOf(claim: RoleClaim) {
  return { sub: claim.sub, role: claim.role, workspaceId: claim.workspaceId };
}

function locate(rule: Extract<FileRule, { decision: "attachedTo" }>, path: string): string | null {
  try {
    const id = rule.locate(path);
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Ids among `ids` the caller can read in `model`, under its read rules. */
function readableRows(sql: SqlExecutor, claim: RoleClaim, model: string, ids: string[]): Set<string> {
  const visible = new Set<string>();
  if (!findNamespace(model)) return visible;
  for (let start = 0; start < ids.length; start += 1000) {
    const chunk = ids.slice(start, start + 1000);
    try {
      const result = executeQuery(sql, claim, { query: { [model]: { $: { where: { id: { $in: chunk } } } } } });
      for (const row of result[model] ?? []) {
        const id = (row as { id?: unknown }).id;
        if (typeof id === "string") visible.add(id);
      }
    } catch (error) {
      if (error instanceof PersonalPending) throw error;
      // A read the caller may not make at all shows nothing.
    }
  }
  return visible;
}

/**
 * Whether the caller may take `action` on `file`. For a write, `file` is the
 * incoming file and `existing` the stored one it would replace.
 */
export function authorizeFile(
  sql: SqlExecutor,
  claim: RoleClaim,
  action: FileAction,
  file: FileInfo,
  existing?: FileInfo
): boolean {
  const rule = ruleFor(action);
  switch (rule.decision) {
    case "role":
      return hasRole(claim, rule.level as never);
    case "check":
      try {
        return rule.test({ auth: authOf(claim), file, ...(existing ? { existing } : {}) }) === true;
      } catch {
        return false;
      }
    case "attachedTo": {
      const id = locate(rule, file.path);
      if (id === null) return false;
      return action === "read"
        ? readableRows(sql, claim, rule.model, [id]).has(id)
        : allowStoredRow(sql, claim, rule.model, id, "update");
    }
  }
}

/** The files the caller may read, in order. Attached rows are read in chunks. */
export function readableFiles<T extends FileInfo>(sql: SqlExecutor, claim: RoleClaim, files: T[]): T[] {
  const rule = ruleFor("read");
  if (rule.decision !== "attachedTo") {
    return files.filter((file) => authorizeFile(sql, claim, "read", file));
  }
  const ids = files.map((file) => locate(rule, file.path));
  const visible = readableRows(
    sql,
    claim,
    rule.model,
    [...new Set(ids.filter((id): id is string => id !== null))]
  );
  return files.filter((_, index) => ids[index] !== null && visible.has(ids[index]!));
}

/** How each file action is decided, for tooling: a role level, a check in code, or the rules of a model's rows. */
export function describeFileAccess(): Record<FileAction, { rule: "role"; role: number } | { rule: "check" } | { rule: "attachedTo"; model: string }> {
  const describe = (action: FileAction) => {
    const rule = rules[action] ?? DEFAULTS[action];
    if (rule.decision === "role") return { rule: "role" as const, role: rule.level };
    if (rule.decision === "attachedTo") return { rule: "attachedTo" as const, model: rule.model };
    return { rule: "check" as const };
  };
  return { read: describe("read"), write: describe("write"), delete: describe("delete") };
}
