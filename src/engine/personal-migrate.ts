import { NAMESPACES, toSnakeCase } from "./registry";
import { isPersonalCiphertext, type PersonalRuntime } from "./personal";
import type { SqlExecutor, SqlRow, SqlValue } from "./tx-sql";
import { appendLogEntry } from "./tx-pipeline";
import type { DeploymentConfig } from "./config";
import { opsHash } from "./tx-hash";
import { LogWriter } from "./tx-log";

/** Encrypt existing values in bounded, restartable transactions before reads. */
export async function migratePersonal(sql: SqlExecutor, personal: PersonalRuntime, transaction: <T>(fn: () => Promise<T>) => Promise<T>, deadline: number, config: DeploymentConfig): Promise<boolean> {
  const signature = JSON.stringify(Object.values(NAMESPACES).map(model => [model.table, Object.entries(model.attributes).filter(([, field]) => field.personal).map(([field, definition]) => [field, definition.personal])]));
  const stateKey = "personal_migration";
  const stored = sql.one<{ value: string }>(`SELECT value FROM "_engine_meta" WHERE "key" = ?`, stateKey);
  let state = stored ? JSON.parse(stored.value) as { signature: string; table: number; after: string } : { signature, table: 0, after: "" };
  if (state.signature !== signature) state = { signature, table: 0, after: "" };
  const models = Object.values(NAMESPACES);
  while (state.table < models.length) {
    if (Date.now() >= deadline) return false;
    const model = models[state.table];
    const fields = Object.entries(model.attributes).filter(([, definition]) => definition.personal);
    await transaction(async () => {
      const rows = fields.length ? sql.all<SqlRow>(`SELECT * FROM "${model.table}" WHERE id > ? ORDER BY id LIMIT 100`, state.after) : [];
      let log: LogWriter | undefined;
      const version = sql.one<{ value: string }>(`SELECT value FROM "_engine_meta" WHERE "key" = 'schema_version'`)?.value ?? null;
      for (const row of rows) {
        const values: Record<string, SqlValue> = {};
        for (const [field, definition] of fields) {
          const column = toSnakeCase(field), value = row[column];
          if (value === null || isPersonalCiphertext(value)) continue;
          const subject = definition.personal!.subject === "self" ? row.id : row[toSnakeCase(definition.personal!.subject)];
          if (typeof subject !== "string") throw new Error(`Personal field ${model.apiName}.${field} needs a string subject.`);
          values[column] = await personal.seal(model, String(row.id), field, value, subject, version);
        }
        if (Object.keys(values).length) {
          if (!log) {
            const seq = appendLogEntry(sql, { clientTxId: null, ops: "[]", opsHash: opsHash([]), at: Date.now() }, config);
            log = new LogWriter(sql, seq, config.logPartBytes); log.push({ op: "state:begin" });
          }
          sql.exec(`UPDATE "${model.table}" SET ${Object.keys(values).map(column => `"${column}" = ?`).join(", ")} WHERE id = ?`, ...Object.values(values), row.id);
          log.push({ op: "state:row", table: model.table, row: { ...row, ...values }, created: false });
        }
        state.after = String(row.id);
      }
      if (log) { log.push({ op: "state:end" }); log.close(); }
      if (rows.length < 100) { state.table++; state.after = ""; }
      sql.exec(`INSERT OR REPLACE INTO "_engine_meta" ("key", value) VALUES (?, ?)`, stateKey, JSON.stringify(state));
      sql.exec(`DELETE FROM "_personal_changes"`);
    });
    personal.clearPlaintext();
  }
  return true;
}
