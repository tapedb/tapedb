import type { RoleClaim } from "../claims";
import { NAMESPACES } from "./registry";
import { filesPrefix } from "./r2-keys";
import { validateEnvelope } from "./tx-validate";
import { appendLogEntry } from "./tx-pipeline";
import { LogWriter } from "./tx-log";
import { opsHash, stableStringify } from "./tx-hash";
import { applyFileOps, type FilePutOp } from "./file-index";
import { TxError } from "./tx-types";
import type { SqlExecutor, SqlRow } from "./tx-sql";

export function assertEmpty(sql: SqlExecutor): void {
  if ((sql.one<{ seq: number }>(`SELECT high_water_seq AS seq FROM "_tx_state" WHERE id = 1`)?.seq ?? 0) > 0 ||
    sql.one<{ n: number }>(`SELECT COUNT(*) AS n FROM "_tx_log"`)!.n > 0 ||
    sql.one<{ n: number }>(`SELECT COUNT(*) AS n FROM "_files"`)!.n > 0 ||
    Object.values(NAMESPACES).some(model => sql.one<{ n: number }>(`SELECT COUNT(*) AS n FROM "${model.table}"`)!.n > 0))
    throw new TxError("conflict", "Import requires an empty workspace without history.");
}

/** A checked stream is staged in SQLite, then applied and logged atomically. */
export async function importWorkspace(sql: SqlExecutor, request: Request, claim: RoleClaim, workspaceId: string): Promise<number> {
  assertEmpty(sql);
  sql.exec(`CREATE TABLE IF NOT EXISTS "_tapedb_import" (n INTEGER PRIMARY KEY, data TEXT NOT NULL)`);
  sql.exec(`DELETE FROM "_tapedb_import"`);
  let n = 0, rows = 0, header: Record<string, unknown> | null = null, end: Record<string, unknown> | null = null;
  const stage = (text: string) => {
    if (!text.trim()) return;
    const value = JSON.parse(text) as Record<string, unknown>;
    if (end) throw new Error("The export has data after its end line.");
    if (!header) {
      if (value.type !== "header" || value.format !== "tapedb-export" || value.version !== 1 || value.workspaceId !== workspaceId ||
        !Array.isArray(value.skipped) || value.skipped.length) throw new Error("Import requires a complete export of this workspace.");
      header = value; return;
    }
    if (value.type === "end") { end = value; return; }
    if (value.type !== "row" && value.type !== "file") throw new Error("Unexpected export line.");
    if (value.type === "row") rows++;
    sql.exec(`INSERT INTO "_tapedb_import" (n, data) VALUES (?, ?)`, ++n, text);
  };
  try {
    if (!request.body) throw new Error("Import needs an NDJSON body.");
    const reader = request.body.pipeThrough(new TextDecoderStream()).getReader();
    let tail = "";
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        tail += value;
        for (let at = tail.indexOf("\n"); at >= 0; at = tail.indexOf("\n")) { stage(tail.slice(0, at)); tail = tail.slice(at + 1); }
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    if (tail.trim()) stage(tail);
    const finish = end as Record<string, unknown> | null;
    const start = header as Record<string, unknown> | null;
    if (!start || !finish || finish.consistent !== true || finish.rows !== rows || finish.startSeq !== start.seq || finish.seq !== start.seq)
      throw new Error("The export is incomplete or inconsistent.");
    return sql.transactionSync(() => {
      assertEmpty(sql);
      if (!Number.isSafeInteger(start.seq) || (start.seq as number) < 0) throw new Error("Invalid export sequence.");
      sql.exec(`UPDATE "_tx_state" SET high_water_seq = ? WHERE id = 1`, start.seq as number);
      sql.exec("PRAGMA defer_foreign_keys = ON");
      const seq = appendLogEntry(sql, { clientTxId: null, ops: "[]", opsHash: opsHash([]), at: Date.now() });
      const log = new LogWriter(sql, seq);
      log.push({ op: "import:begin" });
      for (let at = 0;;) {
        const batch = sql.all<{ n: number; data: string }>(`SELECT n, data FROM "_tapedb_import" WHERE n > ? ORDER BY n LIMIT 100`, at);
        if (!batch.length) break;
        for (const staged of batch) {
          at = staged.n;
          const line = JSON.parse(staged.data);
          const now = Date.now();
          if (line.type === "file") {
            const file = line.file;
            if (!file || typeof file.path !== "string" || typeof file.id !== "string" || typeof file.r2Key !== "string" || !file.r2Key.startsWith(filesPrefix(workspaceId)) || !Number.isSafeInteger(file.size) || file.size < 0)
              throw new Error("Invalid file index entry.");
            const op: FilePutOp = { op: "file:put", id: file.id, path: file.path, key: file.r2Key, size: file.size, contentType: file.contentType ?? null, uploadedBy: file.uploadedBy ?? null, createdAt: file.createdAt, updatedAt: file.updatedAt };
            log.push(op);
            applyFileOps(sql, [op], file.createdAt ?? now);
            sql.exec(`UPDATE "_files" SET updated_at = ? WHERE id = ?`, file.updatedAt ?? now, file.id);
            continue;
          }
          const namespace = NAMESPACES[line.model];
          if (!namespace || !line.data || typeof line.data.id !== "string") throw new Error("Invalid exported model row.");
          const { id, createdAt, updatedAt, updatedSeq, ...values } = line.data;
          const parsed = validateEnvelope({ txId: "import", ops: [{ op: "insert", namespace: line.model, id, values }] }).ops[0];
          if (parsed.kind !== "insert") throw new Error("Invalid import operation.");
          const row: SqlRow = { id, ...parsed.values, created_at: createdAt ? new Date(createdAt).getTime() : now,
            updated_at: updatedAt ? new Date(updatedAt).getTime() : now, updated_seq: updatedSeq ?? 0 };
          if (!Number.isFinite(row.created_at) || !Number.isFinite(row.updated_at)) throw new Error("Invalid row timestamp.");
          const op = { op: "import:row", table: namespace.table, row };
          log.push(op);
          const columns = Object.keys(row);
          sql.exec(`INSERT INTO "${namespace.table}" (${columns.map(column => '"' + column + '"').join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...columns.map(column => row[column]));
        }
      }
      log.push({ op: "import:end" });
      log.close();
      sql.exec(`INSERT OR REPLACE INTO "_engine_meta" ("key", value) VALUES ('receipts_since', ?)`, String(Date.now()));
      return rows;
    });
  } finally { sql.exec(`DROP TABLE IF EXISTS "_tapedb_import"`); }
}
