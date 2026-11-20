import type { RoleClaim } from "../claims";
import { NAMESPACES, findNamespace } from "./registry";
import type { SqlExecutor, SqlRow } from "./tx-sql";
import { validateEnvelope, isLinkOp } from "./tx-validate";
import { authorizeOps, assertRowPermissions } from "./tx-permissions";
import { appendLogEntry } from "./tx-pipeline";
import type { DeploymentConfig } from "./config";
import { applyOps } from "./tx-apply";
import { stageBulkOps, isBulk, bulkChunk, stagedIds, releaseStaged } from "./tx-bulk";
import { LogWriter } from "./tx-log";
import { TxError, type TxResult } from "./tx-types";
import type { PersonalRuntime } from "./personal";

/** Capture SQL side effects too: cascades and foreign-key nulling. */
export function installPersonalCapture(sql: SqlExecutor): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS "_personal_changes" (table_name TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (table_name, id)) WITHOUT ROWID`);
  for (const model of Object.values(NAMESPACES)) for (const action of ["INSERT", "UPDATE", "DELETE"]) {
    const row = action === "DELETE" ? "OLD" : "NEW";
    sql.exec(`CREATE TRIGGER IF NOT EXISTS "_personal_capture_${model.table}_${action}" AFTER ${action} ON "${model.table}"
      BEGIN INSERT OR REPLACE INTO "_personal_changes" (table_name, id) VALUES ('${model.table}', ${row}.id); END`);
  }
}

/** The caller wraps this async pipeline in storage.transaction(). */
export async function runPersonalTransaction(sql: SqlExecutor, personal: PersonalRuntime, workspace: string, claim: RoleClaim, envelope: unknown, config: DeploymentConfig): Promise<TxResult> {
  if (claim.workspaceId !== workspace) throw new TxError("permission_denied", "The claim belongs to another workspace.");
  const tx = validateEnvelope(envelope); authorizeOps(claim, tx.ops);
  // Keyed: the raw ops carry plaintext personal values.
  const hash = await personal.receiptHash(tx.rawOps);
  if (tx.clientTxId !== undefined) {
    const prior = sql.one<{ seq: number; ops_hash: string | null }>(`SELECT seq, ops_hash FROM "_tx_receipts" WHERE id = ?`, tx.clientTxId);
    if (prior) {
      if (prior.ops_hash === null || prior.ops_hash === hash) return { txId: tx.txId, seq: prior.seq, applied: 0 };
      throw new TxError("conflict", "The transaction id was already used with different ops.");
    }
    const floor = Number(sql.one<{ value: string }>(`SELECT value FROM "_engine_meta" WHERE "key" = 'receipts_since'`)?.value ?? 0);
    if (floor > 0 && tx.issuedAt !== undefined && tx.issuedAt <= floor) throw new TxError("retry_expired", "This write predates the workspace's retained receipts.");
  }
  const viewSql = personal.sql(sql);
  const staged = await personal.read(() => sql.transactionSync(() => stageBulkOps(viewSql, claim, tx.ops)));
  const chunks = (index: number) => (function* () {
    for (const ids of stagedIds(sql, staged.keys.get(index)!)) yield bulkChunk(tx.txId, tx.ops[index] as never, tx.rawOps[index], ids);
  })();
  try {
    const nothing = tx.ops.every((op, index) => isBulk(op) && staged.matched[index] === 0);
    if (nothing && tx.clientTxId === undefined) return { txId: tx.txId, seq: sql.one<{ seq: number }>(`SELECT high_water_seq AS seq FROM "_tx_state" WHERE id = 1`)?.seq ?? 0, applied: 0, matched: staged.matched };
    const now = Date.now();
    const seq = appendLogEntry(sql, { clientTxId: tx.clientTxId ?? null, ops: "[]", opsHash: hash, at: now, userId: claim.sub, role: claim.role }, config);
    sql.exec(`DELETE FROM "_personal_changes"`);
    // Rows this transaction creates, by table and id: their whole-row entry is
    // an insert. The row cannot say so afterwards — an insert stamps
    // `created_at` and `updated_at` with the same `now`, so a patch in that
    // same millisecond leaves them equal and the entry would read as an insert.
    const created = new Set<string>();
    let applied = 0;
    for (const [index, op] of tx.ops.entries()) {
      const batches = isBulk(op) ? chunks(index) : [{ ops: [op] }];
      for (const batch of batches) for (let item of batch.ops) {
        await personal.read(() => assertRowPermissions(viewSql, claim, [item]));
        if ("values" in item && "id" in item) {
          const model = findNamespace(item.namespace)!;
          const inserting = !sql.one(`SELECT id FROM "${model.table}" WHERE id = ?`, item.id);
          // A missing row is only created by an insert or an upsert; a patch
          // throws. Record it before `prepare` so the whole-row entry below
          // knows the row was not there before this write.
          if (inserting && item.kind !== "patch") created.add(`${model.table}:${item.id}`);
          const incoming = item.kind === "upsert" && inserting && item.createValues !== undefined ? item.createValues : item.values;
          const values = await personal.prepare(sql, model, item.id, incoming, inserting);
          item = { ...item, values, ...(item.kind === "upsert" && inserting ? { createValues: values } : {}) };
        }
        if (isLinkOp(item)) {
          const model = findNamespace(item.childNamespace)!;
          const current = sql.one<SqlRow>(`SELECT * FROM "${model.table}" WHERE id = ?`, item.childId);
          if (current && (item.kind === "link" || current[item.foreignKeyColumn] === item.parentId)) {
            const values = await personal.prepare(sql, model, item.childId, { [item.foreignKeyColumn]: item.kind === "link" ? item.parentId : null }, false);
            applied += applyOps({ sql, seq, now, txId: tx.txId }, [item]);
            const fields = Object.keys(values).filter(column => column !== item.foreignKeyColumn);
            if (fields.length) sql.exec(`UPDATE "${model.table}" SET ${fields.map(column => `"${column}" = ?`).join(", ")} WHERE id = ?`, ...fields.map(column => values[column]), item.childId);
            continue;
          }
        }
        applied += applyOps({ sql, seq, now, txId: tx.txId }, [item]);
      }
    }
    const log = new LogWriter(sql, seq, config.logPartBytes); log.push({ op: "state:begin" });
    let afterTable = "", afterId = "";
    for (;;) {
      const changed = sql.all<{ table_name: string; id: string }>(`SELECT table_name, id FROM "_personal_changes" WHERE table_name > ? OR (table_name = ? AND id > ?) ORDER BY table_name, id LIMIT 100`, afterTable, afterTable, afterId);
      if (!changed.length) break;
      for (const change of changed) {
        const row = sql.one<SqlRow>(`SELECT * FROM "${change.table_name}" WHERE id = ?`, change.id);
        log.push(row
          ? { op: "state:row", table: change.table_name, row, created: created.has(`${change.table_name}:${change.id}`) }
          : { op: "state:delete", table: change.table_name, id: change.id });
        afterTable = change.table_name; afterId = change.id;
      }
    }
    log.push({ op: "state:end" }); log.close();
    sql.exec(`DELETE FROM "_personal_changes"`);
    return { txId: tx.txId, seq, applied, ...(tx.ops.some(isBulk) ? { matched: staged.matched } : {}) };
  } finally { releaseStaged(sql, staged); }
}
