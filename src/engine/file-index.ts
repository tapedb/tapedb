/**
 * The `_files` index, written through the transaction log.
 *
 * Bytes live in R2 and never enter the log. Their metadata rows do: a row that
 * changes outside the log exists only in the Durable Object's SQLite and in
 * the next snapshot, so a restore from R2 loses every upload since that
 * snapshot and resurrects every delete. Logging the change as an engine op
 * gives it a sequence, a segment, and a replay like any other write.
 *
 * File ops are engine-only. `validateEnvelope` refuses them, so a client
 * cannot forge one through `/transact`; only the room's `/files` route and
 * recovery apply them.
 */

import { ENGINE_TABLES } from "./registry";
import { opsHash, stableStringify } from "./tx-hash";
import { appendLogEntry } from "./tx-pipeline";
import type { SqlExecutor } from "./tx-sql";

export interface FilePutOp {
  op: "file:put";
  /** Row id, carried so a replay inserts the same id the original did. */
  id: string;
  path: string;
  key: string;
  size: number;
  contentType: string | null;
  /** The uploader's claim subject. */
  uploadedBy?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface FileForgetOp {
  op: "file:forget";
  path: string;
}

export type FileOp = FilePutOp | FileForgetOp;

export interface FileRecord {
  path: string;
  key: string;
  size: number;
  contentType: string | null;
  uploadedBy?: string | null;
}

/** True when a logged op list is a file-index entry rather than a client tx. */
export function isFileOpList(ops: readonly unknown[]): ops is FileOp[] {
  return (
    ops.length > 0 &&
    ops.every(
      (op) =>
        typeof op === "object" &&
        op !== null &&
        ((op as { op?: unknown }).op === "file:put" ||
          (op as { op?: unknown }).op === "file:forget")
    )
  );
}

/**
 * Applies file ops. Both are last-writer-wins on `path`, so applying them in
 * sequence order is enough for a replay to converge: no `updated_seq` guard is
 * needed, and replaying a line twice is harmless.
 *
 * Returns the number of rows changed.
 */
export function applyFileOps(
  sql: SqlExecutor,
  ops: readonly FileOp[],
  at: number
): number {
  let changed = 0;
  for (const op of ops) {
    if (op.op === "file:put") {
      changed += sql.exec(
        `INSERT INTO "${ENGINE_TABLES.files}"
           ("id", "path", "r2_key", "size", "content_type", "uploaded_by", "created_at", "updated_at")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT("path") DO UPDATE SET
           "r2_key" = excluded."r2_key",
           "size" = excluded."size",
           "content_type" = excluded."content_type",
           "uploaded_by" = excluded."uploaded_by",
           "updated_at" = excluded."updated_at"`,
        op.id,
        op.path,
        op.key,
        op.size,
        op.contentType,
        op.uploadedBy ?? null,
        op.createdAt ?? at,
        op.updatedAt ?? at
      );
    } else {
      changed += sql.exec(
        `DELETE FROM "${ENGINE_TABLES.files}" WHERE "path" = ?`,
        op.path
      );
    }
  }
  return changed;
}

/** Logs and applies file ops in one transaction. Returns rows changed. */
function commitFileOps(
  sql: SqlExecutor,
  ops: FileOp[],
  actor: { sub: string | null; role: number | null }
): number {
  return sql.transactionSync(() => {
    const at = Date.now();
    appendLogEntry(sql, {
      clientTxId: null,
      ops: stableStringify(ops),
      opsHash: opsHash(ops),
      at,
    });
    return applyFileOps(sql, ops, at);
  });
}

export function recordFileEntry(
  sql: SqlExecutor,
  record: FileRecord,
  actor: { sub: string | null; role: number | null } = { sub: null, role: null }
): void {
  commitFileOps(
    sql,
    [
      {
        op: "file:put",
        id: crypto.randomUUID(),
        path: record.path,
        key: record.key,
        size: record.size,
        contentType: record.contentType,
        ...(record.uploadedBy ? { uploadedBy: record.uploadedBy } : {}),
      },
    ],
    actor
  );
}

/**
 * Forgets a path. A path that is not indexed burns no sequence: there is
 * nothing for a replay to undo.
 */
export function forgetFileEntry(
  sql: SqlExecutor,
  path: string,
  actor: { sub: string | null; role: number | null } = { sub: null, role: null }
): number {
  const present = sql.one(
    `SELECT 1 AS "present" FROM "${ENGINE_TABLES.files}" WHERE "path" = ?`,
    path
  );
  if (present === undefined) return 0;
  return commitFileOps(sql, [{ op: "file:forget", path }], actor);
}
