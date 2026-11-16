/**
 * Write-path transaction pipeline.
 *
 * Validation and authorization run before the transaction opens. Everything
 * else — deduplication, sequence allocation, log append, state advance and op
 * application — runs inside one `transactionSync`, so an error at any point
 * rolls back the log, the high-water mark and every row mutation together.
 */

import { auditEnabled } from "./audit";
import type { RoleClaim } from "../claims";
import { applyOps } from "./tx-apply";
import { bulkChunk, isBulk, releaseStaged, stageBulkOps, stagedIds } from "./tx-bulk";
import { LogWriter, writeLogOps } from "./tx-log";
import { opsHash, stableStringify } from "./tx-hash";
import { assertRowPermissions, authorizeOps } from "./tx-permissions";
import type { SqlExecutor } from "./tx-sql";
import { TxError, type TxResult } from "./tx-types";
import { validateEnvelope } from "./tx-validate";

const FALLBACK_SCHEMA_VERSION = "0001_baseline";

type TxLogRow = {
  seq: number;
  ops_hash: string | null;
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
        if (prior.ops_hash === null || prior.ops_hash === hash) {
          return { txId: tx.txId, seq: prior.seq, applied: 0 };
        }
        throw new TxError(
          "conflict",
          `clientTxId "${tx.clientTxId}" was already used with different ops.`,
          { txId: tx.txId }
        );
      }
      // Receipts no longer expire. An older engine or snapshot may already
      // have discarded some: keep that fixed boundary, never a moving window.
      const since = receiptsSince(sql);
      if (since > 0 && tx.issuedAt !== undefined && tx.issuedAt <= since) {
        throw new TxError(
          "retry_expired",
          `clientTxId "${tx.clientTxId}" was issued before this workspace can recognise a retry because an earlier engine or snapshot did not retain every receipt, so it is not applied: it may already have been. Send the write again as a new transaction if it still applies.`,
          { txId: tx.txId }
        );
      }
    }

    if (!tx.ops.some(isBulk)) {
      // Row rules read the stored row, so they belong inside the transaction,
      // after the idempotency check (a replay of an applied tx must not
      // re-judge) and before the sequence is allocated (a denial burns nothing).
      const now = Date.now();
      const seq = appendLogEntry(sql, { clientTxId: tx.clientTxId ?? null, ops: "[]", opsHash: hash, at: now, userId: claim.sub, role: claim.role });
      // In parts when it is larger than a row holds (see tx-log.ts).
      writeLogOps(sql, seq, tx.rawOps);
      const applied = applyOps({ sql, seq, now, txId: tx.txId, beforeOp: op => assertRowPermissions(sql, claim, [op]) }, tx.ops);
      return { txId: tx.txId, seq, applied };
    }

    // A bulk write: its filter is resolved once, against the database before
    // any op here applies, and the rows are staged. Then every row's rules
    // run, then the ops apply in order, a chunk of rows at a time, so the
    // whole write is one atomic transaction however many rows it touches and
    // no step holds more than a chunk in memory.
    const staged = stageBulkOps(sql, claim, tx.ops);
    try {
      const matched = { matched: staged.matched };
      const chunks = (index: number) => {
        const op = tx.ops[index];
        const key = staged.keys.get(index)!;
        return (function* () {
          for (const ids of stagedIds(sql, key)) yield bulkChunk(tx.txId, op as never, tx.rawOps[index], ids);
        })();
      };

      const nothing = tx.ops.every((op, index) => isBulk(op) && staged.matched[index] === 0);
      if (nothing) {
        // A no-op is still a completed request: preserve its idempotency key so
        // retrying later cannot suddenly match newly-created rows.
        const state = sql.one<TxStateRow>(`SELECT high_water_seq FROM "_tx_state" WHERE "id" = 1`);
        const seq = tx.clientTxId === undefined ? (state?.high_water_seq ?? 0) : appendLogEntry(sql, {
          clientTxId: tx.clientTxId, ops: "[]", opsHash: hash, at: Date.now(), userId: claim.sub, role: claim.role,
        });
        return { txId: tx.txId, seq, applied: 0, ...matched };
      }

      const now = Date.now();
      const seq = appendLogEntry(sql, { clientTxId: tx.clientTxId ?? null, ops: "[]", opsHash: hash, at: now, userId: claim.sub, role: claim.role });
      const log = new LogWriter(sql, seq);
      const context = { sql, seq, now, txId: tx.txId, beforeOp: (op: typeof tx.ops[number]) => assertRowPermissions(sql, claim, [op]) };
      let applied = 0;
      for (const [index, op] of tx.ops.entries()) {
        if (!isBulk(op)) {
          log.push(tx.rawOps[index]);
          applied += applyOps(context, [op]);
          continue;
        }
        for (const chunk of chunks(index)) {
          log.push(chunk.logged);
          applied += applyOps(context, chunk.ops);
        }
      }
      log.close();
      return { txId: tx.txId, seq, applied, ...matched };
    } finally {
      releaseStaged(sql, staged);
    }
  });
}

export interface LogEntry {
  clientTxId: string | null;
  /** Canonical JSON of the ops, exactly as replay will read them. */
  ops: string;
  opsHash: string;
  at: number;
  /** The writer, recorded only with `defineTapeDB({ audit: true })`. */
  userId?: string | null;
  role?: number | null;
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
    // Who wrote what is recorded only when the deployment asks for an audit
    // (audit.ts): otherwise it would be personal data without a purpose.
    auditEnabled() ? entry.userId ?? null : null,
    auditEnabled() ? entry.role ?? null : null,
    entry.at,
    readSchemaVersion(sql)
  );

  if (entry.clientTxId !== null) {
    sql.exec(`INSERT INTO "_tx_receipts" (id, seq, ops_hash, at) VALUES (?, ?, ?, ?)`, entry.clientTxId, seq, entry.opsHash, entry.at);
  }
  sql.exec(`UPDATE "_tx_state" SET high_water_seq = ? WHERE "id" = 1`, seq);
  return seq;
}

/**
 * Receipts are complete only from this time: set when a workspace was
 * upgraded or restored from state that did not retain every receipt.
 * 0 when complete.
 */
function receiptsSince(sql: SqlExecutor): number {
  const row = sql.one<{ value: string }>(`SELECT value FROM "_engine_meta" WHERE "key" = 'receipts_since'`);
  return row === undefined ? 0 : Number(row.value);
}

function readSchemaVersion(sql: SqlExecutor): string {
  const row = sql.one<EngineMetaRow>(
    `SELECT value FROM "_engine_meta" WHERE "key" = 'schema_version'`
  );
  return row?.value && row.value.length > 0
    ? row.value
    : FALLBACK_SCHEMA_VERSION;
}
