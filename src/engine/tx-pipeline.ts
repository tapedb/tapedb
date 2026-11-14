/**
 * Write-path transaction pipeline.
 *
 * Validation and authorization run before the transaction opens. Everything
 * else — deduplication, sequence allocation, log append, state advance and op
 * application — runs inside one `transactionSync`, so an error at any point
 * rolls back the log, the high-water mark and every row mutation together.
 */

import type { RoleClaim } from "../claims";
import { applyOps } from "./tx-apply";
import { expandBulkOps } from "./tx-bulk";
import { opsHash, stableStringify } from "./tx-hash";
import { assertRowPermissions, authorizeOps } from "./tx-permissions";
import type { SqlExecutor } from "./tx-sql";
import { TxError, type TxResult } from "./tx-types";
import { validateEnvelope } from "./tx-validate";
import { retryWindowMs } from "./durability/retention";

const FALLBACK_SCHEMA_VERSION = "0001_baseline";

type TxLogRow = {
  seq: number;
  ops_hash: string;
};

type TxStateRow = {
  high_water_seq: number;
};

type TxLogMaxRow = {
  max_seq: number | null;
};

type EngineMetaRow = {
  value: string;
};

export function runTransaction(
  sql: SqlExecutor,
  workspaceId: string,
  claim: RoleClaim,
  envelope: unknown
): TxResult {
  if (claim.workspaceId !== workspaceId) {
    throw new TxError(
      "permission_denied",
      "Role claim does not belong to this workspace."
    );
  }

  const tx = validateEnvelope(envelope);
  authorizeOps(claim, tx.ops);

  // The hash is of what the client sent, so a retry of the same request is
  // recognised. What gets logged may differ: a bulk write logs the rows it
  // resolved.
  const hash = opsHash(tx.rawOps);

  return sql.transactionSync(() => {
    if (tx.clientTxId !== undefined) {
      const prior = sql.one<TxLogRow>(
        `SELECT seq, ops_hash FROM "_tx_receipts" WHERE id = ?`,
        tx.clientTxId
      );

      if (prior !== undefined) {
        if (prior.ops_hash === hash) {
          return { txId: tx.txId, seq: prior.seq, applied: 0 };
        }
        throw new TxError(
          "conflict",
          `clientTxId "${tx.clientTxId}" was already used with different ops.`,
          { txId: tx.txId }
        );
      }
      // A receipt is kept for the retry window (half the history retention),
      // through log pruning, snapshots and recovery. Inside it an unknown key
      // is a write that was never applied. A retry first issued before the
      // window may have lost its receipt; applying it could apply it twice.
      if (tx.issuedAt !== undefined && tx.issuedAt <= Date.now() - retryWindowMs()) {
        throw new TxError(
          "retry_expired",
          `clientTxId "${tx.clientTxId}" was issued more than ${Math.round(retryWindowMs() / 86_400_000)} days ago; its receipt may be gone, so it is not applied. Send the write again as a new transaction if it still applies.`,
          { txId: tx.txId }
        );
      }
    }

    // Bulk writes become one op per matching row, here, so everything below
    // this point sees ordinary ops: the row rules judge each row, the log
    // records which rows were written, and a replay writes those same rows.
    const expanded = expandBulkOps(sql, claim, tx.txId, tx.rawOps, tx.ops);
    const matched = {
      ...(Object.keys(expanded.matched).length > 0 ? { matched: expanded.matched } : {}),
      ...(Object.keys(expanded.more).length > 0 ? { more: expanded.more } : {}),
    };

    if (expanded.ops.length === 0) {
      // A no-op is still a completed request: preserve its idempotency key so
      // retrying later cannot suddenly match newly-created rows.
      const state = sql.one<TxStateRow>(`SELECT high_water_seq FROM "_tx_state" WHERE "id" = 1`);
      const seq = tx.clientTxId === undefined ? (state?.high_water_seq ?? 0) : appendLogEntry(sql, {
        clientTxId: tx.clientTxId, ops: "[]", opsHash: hash,
        userId: claim.sub, role: claim.role, at: Date.now(),
      });
      return { txId: tx.txId, seq, applied: 0, ...matched };
    }

    // Row rules read the stored row, so they belong inside the transaction,
    // after the idempotency check (a replay of an applied tx must not re-judge)
    // and before the sequence is allocated (a denial burns nothing).
    assertRowPermissions(sql, claim, expanded.ops);

    const now = Date.now();
    const seq = appendLogEntry(sql, {
      clientTxId: tx.clientTxId ?? null,
      ops: stableStringify(expanded.rawOps),
      opsHash: hash,
      userId: claim.sub,
      role: claim.role,
      at: now,
    });

    const applied = applyOps({ sql, seq, now, txId: tx.txId }, expanded.ops);

    return { txId: tx.txId, seq, applied, ...matched };
  });
}

export interface LogEntry {
  clientTxId: string | null;
  /** Canonical JSON of the ops, exactly as replay will read them. */
  ops: string;
  opsHash: string;
  userId: string | null;
  role: number | null;
  at: number;
}

/**
 * Allocates the next sequence and appends one `_tx_log` row. Must run inside
 * the caller's transaction, so the row, the high-water mark and whatever the
 * caller applies commit or roll back together.
 */
export function appendLogEntry(sql: SqlExecutor, entry: LogEntry): number {
  const state = sql.one<TxStateRow>(
    `SELECT high_water_seq FROM "_tx_state" WHERE "id" = 1`
  );
  const logMax = sql.one<TxLogMaxRow>(
    `SELECT MAX(seq) AS max_seq FROM "_tx_log"`
  );

  // Never hand out a sequence that already exists in the log. Recovery or a
  // partial restore can leave `_tx_state` behind `_tx_log`; repairing here
  // keeps the invariant even if that state was written by an older build.
  const previousSeq = Math.max(
    state?.high_water_seq ?? 0,
    logMax?.max_seq ?? 0
  );

  if (state === undefined) {
    sql.exec(
      `INSERT INTO "_tx_state" ("id", high_water_seq) VALUES (1, ?)`,
      previousSeq
    );
  }

  const seq = previousSeq + 1;

  sql.exec(
    `INSERT INTO "_tx_log"
      (seq, client_tx_id, ops, ops_hash, user_id, role, at, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    seq,
    entry.clientTxId,
    entry.ops,
    entry.opsHash,
    entry.userId,
    entry.role,
    entry.at,
    readSchemaVersion(sql)
  );

  if (entry.clientTxId !== null) {
    sql.exec(`INSERT INTO "_tx_receipts" (id, seq, ops_hash, at) VALUES (?, ?, ?, ?)`, entry.clientTxId, seq, entry.opsHash, entry.at);
  }
  sql.exec(`UPDATE "_tx_state" SET high_water_seq = ? WHERE "id" = 1`, seq);
  return seq;
}

function readSchemaVersion(sql: SqlExecutor): string {
  const row = sql.one<EngineMetaRow>(
    `SELECT value FROM "_engine_meta" WHERE "key" = 'schema_version'`
  );
  return row?.value && row.value.length > 0
    ? row.value
    : FALLBACK_SCHEMA_VERSION;
}
