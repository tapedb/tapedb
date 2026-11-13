/**
 * Applies validated ops to workspace SQLite.
 *
 * Table and column names come only from the registry and are quoted. Every
 * value is parameterised. Each mutation advances `updated_seq` to the current
 * transaction sequence and refreshes `updated_at`; inserts also set
 * `created_at`.
 */

import {
  findNamespace,
  toSnakeCase,
  type NamespaceDefinition,
} from "./registry";
import type { SqlExecutor, SqlValue } from "./tx-sql";
import { TxError } from "./tx-types";
import {
  isLinkOp,
  requiredColumns,
  type ValidatedLinkOp,
  type ValidatedOp,
  type ValidatedValuesOp,
} from "./tx-validate";

export interface ApplyContext {
  sql: SqlExecutor;
  seq: number;
  now: number;
  txId?: string;
  /**
   * Recovery replay. An op that succeeded once is re-applied against a
   * database that may already hold its effect, so insert behaves as an upsert
   * and a patch of a missing row is a no-op instead of an error.
   */
  replay?: boolean;
}

interface ErrorContext {
  txId?: string;
  opIndex?: number;
}

export function applyOps(context: ApplyContext, ops: ValidatedOp[]): number {
  let applied = 0;

  for (const [opIndex, op] of ops.entries()) {
    try {
      applied += applyOp(context, op);
    } catch (error) {
      throw toTxError(error, { txId: context.txId, opIndex });
    }
  }

  return applied;
}

function applyOp(context: ApplyContext, op: ValidatedOp): number {
  if (isLinkOp(op)) {
    return applyLink(context, op);
  }

  const namespace = findNamespace(op.namespace);
  if (!namespace) {
    throw new TxError(
      "unknown_namespace",
      `Unknown namespace "${op.namespace}".`
    );
  }

  switch (op.kind) {
    case "insert":
    case "patch":
    case "upsert":
    case "update":
    case "merge":
      return applyValues(context, op, namespace);
    case "patchMany":
    case "deleteMany":
      // expandBulkOps replaces these before anything is applied.
      throw new TxError(
        "invalid_op",
        `"${op.kind}" reached the apply step; it should have been resolved to rows first.`
      );
    case "delete": {
      const table = quoteIdentifier(namespace.table);
      const changes = context.sql.exec(
        `DELETE FROM ${table} WHERE "id" = ?`,
        op.id
      );
      return changes > 0 ? 1 : 0;
    }
  }
}

function applyValues(
  context: ApplyContext,
  op: ValidatedValuesOp,
  namespace: NamespaceDefinition
): number {
  const table = quoteIdentifier(namespace.table);
  const existing = context.sql.one(
    `SELECT 1 AS "present" FROM ${table} WHERE "id" = ? LIMIT 1`,
    op.id
  );

  if (existing === undefined) {
    if (op.kind === "patch") {
      if (context.replay) return 0;
      throw new TxError(
        "not_found",
        `No "${namespace.apiName}" row with id "${op.id}" to update.`
      );
    }
    return insertRow(
      context,
      op.kind === "upsert" && op.createValues !== undefined
        ? { ...op, values: op.createValues }
        : op,
      namespace,
      table
    );
  }

  if (op.kind === "insert" && !context.replay) {
    throw new TxError(
      "unique_violation",
      `A "${namespace.apiName}" row with id "${op.id}" already exists.`
    );
  }

  const columns = Object.keys(op.values);
  const assignments = columns.map((column) => `${quoteIdentifier(column)} = ?`);
  assignments.push(`"updated_at" = ?`, `"updated_seq" = ?`);

  const params: SqlValue[] = columns.map((column) => op.values[column]);
  params.push(context.now, context.seq, op.id);

  const changes = context.sql.exec(
    `UPDATE ${table} SET ${assignments.join(", ")} WHERE "id" = ?`,
    ...params
  );

  return changes > 0 ? 1 : 0;
}

function insertRow(
  context: ApplyContext,
  op: ValidatedValuesOp,
  namespace: NamespaceDefinition,
  table: string
): number {
  // A replayed insert was valid when it was written; a field made required
  // since then is filled by its column default instead.
  for (const column of context.replay ? [] : requiredColumns(namespace)) {
    if (!(column in op.values)) {
      throw new TxError(
        "invalid_op",
        `Insert into "${namespace.apiName}" requires attribute "${column}".`
      );
    }
  }

  const valueColumns = Object.keys(op.values);
  const columns = [
    "id",
    ...valueColumns,
    "created_at",
    "updated_at",
    "updated_seq",
  ];
  const placeholders = columns.map(() => "?").join(", ");
  const params: SqlValue[] = [
    op.id,
    ...valueColumns.map((column) => op.values[column]),
    context.now,
    context.now,
    context.seq,
  ];

  context.sql.exec(
    `INSERT INTO ${table} (${columns
      .map(quoteIdentifier)
      .join(", ")}) VALUES (${placeholders})`,
    ...params
  );

  return 1;
}

function applyLink(context: ApplyContext, op: ValidatedLinkOp): number {
  const childNamespace = findNamespace(op.childNamespace);
  if (!childNamespace) {
    throw new TxError(
      "unknown_namespace",
      `Unknown namespace "${op.childNamespace}".`
    );
  }

  const foreignKey = childNamespace.attributes[op.foreignKeyAttribute];
  if (!foreignKey) {
    throw new TxError(
      "unknown_link",
      `Link "${op.link}" has no foreign key attribute on "${op.childNamespace}".`
    );
  }

  if (op.kind === "unlink" && !foreignKey.optional) {
    throw new TxError(
      "foreign_key_violation",
      `Cannot unlink "${op.link}": "${op.childNamespace}.${op.foreignKeyAttribute}" is NOT NULL.`
    );
  }

  const table = quoteIdentifier(childNamespace.table);
  const child = context.sql.one(
    `SELECT 1 AS "present" FROM ${table} WHERE "id" = ? LIMIT 1`,
    op.childId
  );
  if (child === undefined) {
    throw new TxError(
      "not_found",
      `Cannot ${op.kind} "${op.link}": child row "${op.childId}" does not exist.`
    );
  }

  const foreignKeyColumn = quoteIdentifier(
    op.foreignKeyColumn || toSnakeCase(op.foreignKeyAttribute)
  );

  if (op.kind === "unlink") {
    // An unlink is a no-op unless the child currently points at this parent.
    // Nulling unconditionally would detach a child another client has already
    // moved to a different parent.
    const current = context.sql.one(
      `SELECT ${foreignKeyColumn} AS "fk" FROM ${table} WHERE "id" = ?`,
      op.childId
    );
    if (current === undefined) {
      throw new TxError(
        "not_found",
        `Cannot unlink "${op.link}": child row "${op.childId}" does not exist.`
      );
    }
    if (current.fk !== op.parentId) return 0;
  }

  const value: SqlValue = op.kind === "link" ? op.parentId : null;
  const changes = context.sql.exec(
    `UPDATE ${table} SET ${foreignKeyColumn} = ?, "updated_at" = ?, "updated_seq" = ? WHERE "id" = ?`,
    value,
    context.now,
    context.seq,
    op.childId
  );

  if (changes === 0) {
    throw new TxError(
      "not_found",
      `Cannot ${op.kind} "${op.link}": child row "${op.childId}" does not exist.`
    );
  }

  return 1;
}

/** Maps SQLite constraint failures onto the transaction error vocabulary. */
export function toTxError(error: unknown, context: ErrorContext = {}): TxError {
  if (error instanceof TxError) {
    const txId = error.txId ?? context.txId;
    const opIndex = error.opIndex ?? context.opIndex;
    return new TxError(error.code, error.message, {
      ...(txId === undefined ? {} : { txId }),
      ...(opIndex === undefined ? {} : { opIndex }),
    });
  }

  const message = error instanceof Error ? error.message : String(error);

  if (/UNIQUE constraint failed/i.test(message)) {
    return new TxError("unique_violation", message, context);
  }
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    return new TxError("foreign_key_violation", message, context);
  }
  if (/NOT NULL constraint failed|CHECK constraint failed/i.test(message)) {
    return new TxError("invalid_value", message, context);
  }

  return new TxError("storage_error", message, context);
}

/**
 * Registry identifiers are trusted, but quoting still validates the shape so a
 * future registry mistake cannot inject SQL.
 */
export function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new TxError(
      "storage_error",
      `Invalid SQL identifier "${identifier}".`
    );
  }
  return `"${identifier}"`;
}
