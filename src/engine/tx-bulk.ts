/**
 * Bulk writes, resolved to the rows they touch.
 *
 * `patchMany` and `deleteMany` arrive as a filter. The filter is evaluated
 * once, inside the transaction, and the op is replaced by one ordinary op per
 * matching row — which is also what goes into the log. Logging the filter
 * instead would mean re-running it during a replay, against a database that
 * has moved on, and changing a different set of rows than the first time.
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

/**
 * How many rows one bulk op writes per transaction. A transaction is applied
 * and logged in one go, and one Durable Object request has bounded time, so a
 * filter matching more is written in batches: the result carries a cursor
 * (the last id written) and the next transaction resumes after it. The model
 * client sends the batches until the filter is exhausted.
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

export interface ExpandedTransaction {
  /** Wire-shaped ops, as they go into the log and as a replay will read them. */
  rawOps: unknown[];
  ops: ValidatedOp[];
  /** Rows matched, keyed by the op's index in the original envelope. */
  matched: Record<number, number>;
  /** For a bulk op with rows left: the `after` that resumes it. */
  more: Record<number, string>;
}

/**
 * Replaces every bulk op with the ops it resolves to. Returns the transaction
 * unchanged when it holds none, so the ordinary path costs nothing.
 */
export function expandBulkOps(
  sql: SqlExecutor,
  claim: RoleClaim,
  txId: string,
  rawOps: readonly unknown[],
  ops: readonly ValidatedOp[]
): ExpandedTransaction {
  if (!ops.some(isBulk)) {
    return { rawOps: [...rawOps], ops: [...ops], matched: {}, more: {} };
  }

  const expandedRaw: unknown[] = [];
  const matched: Record<number, number> = {};
  const more: Record<number, string> = {};

  for (const [index, op] of ops.entries()) {
    if (!isBulk(op)) {
      expandedRaw.push(rawOps[index]);
      continue;
    }

    const namespace = findNamespace(op.namespace);
    if (!namespace) {
      throw new TxError("unknown_namespace", `Unknown namespace "${op.namespace}".`);
    }

    const batch = resolveIds(sql, claim, op);
    const ids = batch.ids;
    matched[index] = ids.length;
    if (batch.more && ids.length > 0) more[index] = ids[ids.length - 1];

    // The client's own values, not the column-keyed ones: a replay validates
    // these again, so they must be what a client would have sent.
    const values = (rawOps[index] as { values?: Record<string, unknown> }).values ?? {};
    for (const id of ids) {
      expandedRaw.push(
        op.kind === "deleteMany"
          ? { op: "delete", namespace: op.namespace, id }
          : { op: "patch", namespace: op.namespace, id, values }
      );
    }
  }

  // Nothing matched, so there is nothing to write; the caller skips the
  // transaction rather than logging an entry with no ops.
  if (expandedRaw.length === 0) return { rawOps: [], ops: [], matched, more };

  // Re-validating the expansion is what guarantees the log holds ops a replay
  // can read, rather than something shaped like them.
  const expanded = validateEnvelope({ txId, ops: expandedRaw });
  return { rawOps: expandedRaw, ops: expanded.ops, matched, more };
}
