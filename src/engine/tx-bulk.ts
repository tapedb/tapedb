/**
 * Bulk writes, resolved to the rows they touch.
 *
 * `patchMany` and `deleteMany` arrive as a filter. The filter is evaluated
 * once, inside the transaction and before any op is applied, and its rows are
 * staged; the transaction then checks, applies and logs them a chunk at a
 * time, so one transaction writes any number of rows atomically. The log
 * records the rows, not the filter: re-running the filter during a replay,
 * against a database that has moved on, would change a different set.
 *
 * The rows are resolved through the query executor with the caller's claim,
 * so a bulk write touches exactly the rows that caller could have read and
 * patched one by one: `read` rules narrow the set, and the row rules for
 * `update` and `delete` still run per row afterwards.
 */

import type { RoleClaim } from "../claims";
import { compileQuery } from "./query-compile";
import { executeCompiledQueryWithPageInfo, viewAccess } from "./query-execute";
import { findNamespace } from "./registry";
import type { SqlExecutor } from "./tx-sql";
import { TxError } from "./tx-types";
import { validateEnvelope, type ValidatedBulkOp, type ValidatedOp } from "./tx-validate";
import { ensureScratch, SCRATCH_TABLE } from "./query-stages";
import { compactBulkOp, expandLogOps, LOG_IDS_PER_OP } from "./tx-log";

/**
 * How many matching ids are resolved per query while staging a bulk op. A
 * bulk write is one transaction however many rows it matches; this only
 * bounds how many ids are in memory at once.
 */
export const BULK_BATCH_ROWS = 1000;

function isBulk(op: ValidatedOp): op is ValidatedBulkOp {
  return op.kind === "patchMany" || op.kind === "deleteMany";
}

/**
 * The next batch of ids a bulk op's filter matches, for this caller, in id
 * order after `op.after`, and whether more match beyond it.
 *
 * Resuming by id rather than re-running the filter from the start is what
 * makes batching terminate: a patch that leaves rows matching would
 * otherwise match the same rows again.
 */
function resolveIds(
  sql: SqlExecutor,
  claim: RoleClaim,
  op: ValidatedBulkOp
): { ids: string[]; more: boolean } {
  const where =
    op.after === undefined ? op.where : { $and: [op.where, { id: { $gt: op.after } }] };
  const compiled = compileQuery(
    { [op.namespace]: { $: { where, order: { id: "asc" }, limit: BULK_BATCH_ROWS, select: ["id"] } } },
    viewAccess(claim)
  );
  const { data, pageInfo } = executeCompiledQueryWithPageInfo(sql, compiled, claim);
  return {
    ids: (data[op.namespace] ?? []).map((row) => (row as { id: string }).id),
    more: pageInfo[op.namespace]?.hasMore === true,
  };
}

export interface StagedBulk {
  /** Scratch key holding each bulk op's ids, keyed by the op's index. */
  keys: Map<number, string>;
  /** Rows matched, keyed by the op's index in the envelope. */
  matched: Record<number, number>;
}

/**
 * Resolves every bulk op's filter once, against the database as it is before
 * any op in the transaction is applied, and stages the matching ids in the
 * scratch table. The rows are found in id-ordered chunks through the query
 * executor, so the caller's read rules apply and no chunk holds more than
 * `BULK_BATCH_ROWS` ids in memory, however many rows match.
 */
export function stageBulkOps(sql: SqlExecutor, claim: RoleClaim, ops: readonly ValidatedOp[]): StagedBulk {
  const keys = new Map<number, string>();
  const matched: Record<number, number> = {};
  if (!ops.some(isBulk)) return { keys, matched };
  ensureScratch(sql);

  for (const [index, op] of ops.entries()) {
    if (!isBulk(op)) continue;
    if (!findNamespace(op.namespace)) {
      throw new TxError("unknown_namespace", `Unknown namespace "${op.namespace}".`);
    }
    const key = globalThis.crypto.randomUUID();
    keys.set(index, key);
    let count = 0;
    let after = op.after;
    for (;;) {
      const batch = resolveIds(sql, claim, after === undefined ? op : { ...op, after });
      if (batch.ids.length > 0) {
        sql.exec(
          `INSERT OR IGNORE INTO "${SCRATCH_TABLE}" ("k", "id") SELECT ?, value FROM json_each(?)`,
          key,
          JSON.stringify(batch.ids)
        );
        count += batch.ids.length;
        after = batch.ids[batch.ids.length - 1];
      }
      if (!batch.more || batch.ids.length === 0) break;
    }
    matched[index] = count;
  }
  return { keys, matched };
}

/** A staged bulk op's ids, in id order, a chunk at a time. */
export function* stagedIds(sql: SqlExecutor, key: string): Generator<string[]> {
  let after = "";
  for (;;) {
    const rows = sql.all<{ id: string }>(
      `SELECT "id" FROM "${SCRATCH_TABLE}" WHERE "k" = ? AND "id" > ? ORDER BY "id" LIMIT ?`,
      key,
      after,
      LOG_IDS_PER_OP
    );
    if (rows.length === 0) return;
    yield rows.map((row) => row.id);
    if (rows.length < LOG_IDS_PER_OP) return;
    after = rows[rows.length - 1].id;
  }
}

/** Removes the staged ids. */
export function releaseStaged(sql: SqlExecutor, staged: StagedBulk): void {
  if (staged.keys.size === 0) return;
  sql.exec(`DELETE FROM "${SCRATCH_TABLE}" WHERE "k" IN (SELECT value FROM json_each(?))`, JSON.stringify([...staged.keys.values()]));
}

/**
 * One chunk of a bulk op as the log stores it (ids and values once) and as
 * validated per-row ops. The values are the client's own, not the
 * column-keyed ones: a replay validates them again, so they must be what a
 * client would have sent.
 */
export function bulkChunk(
  txId: string,
  op: ValidatedBulkOp,
  rawOp: unknown,
  ids: readonly string[]
): { logged: Record<string, unknown>; ops: ValidatedOp[] } {
  const values = (rawOp as { values?: Record<string, unknown> }).values ?? {};
  const logged = compactBulkOp(op.kind, op.namespace, ids, values);
  return { logged, ops: validateEnvelope({ txId, ops: expandLogOps([logged]) }).ops };
}

export { isBulk };
