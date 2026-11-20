/**
 * Opt-in write audit: who changed each row, and when.
 *
 * Off by default, because the writer's identity is personal data nothing in
 * the engine needs. With `defineTapeDB({ audit: true })`:
 *
 * - every transaction's log row carries the claim's subject and role, in the
 *   local log and in the log lines shipped to R2, and recovery restores them;
 * - a trigger on each model table records (table, row, seq, time, subject,
 *   role) in `_tx_audit` for every row a transaction changes, cascades
 *   included. It reads the writer from the transaction's own log row, which
 *   every write path appends before it touches data.
 *
 * `_tx_audit` is snapshotted and restored with the workspace, and pruned by
 * age with the rest of the history (`retention.days`), so the writer's
 * identity leaves every copy within the retention.
 */

import { namespaceTables } from "./registry";
import type { SqlExecutor } from "./tx-sql";

export const AUDIT_TABLE = "_tx_audit";

const triggerName = (table: string, action: string) => `_tapedb_audit_${table}_${action}`;

/**
 * Removes the capture triggers. Runs before schema migrations, so a
 * migration's own writes (a backfill, a table rebuild) are not attributed to
 * the last transaction's writer.
 */
export function dropAuditCapture(sql: SqlExecutor): void {
  for (const row of sql.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '\_tapedb\_audit\_%' ESCAPE '\\'`
  )) {
    sql.exec(`DROP TRIGGER IF EXISTS "${row.name}"`);
  }
}

/**
 * Creates the capture triggers when the deployment audits and drops them when
 * it does not, so turning audit off stops recording at the next boot.
 *
 * `on` is the deployment's own `audit` flag, passed in by its room: a second
 * deployment in the same process cannot turn this one's capture on or off.
 */
export function syncAuditCapture(sql: SqlExecutor, on: boolean): void {
  for (const table of namespaceTables()) {
    for (const action of ["INSERT", "UPDATE", "DELETE"] as const) {
      const name = triggerName(table, action);
      if (!on) {
        sql.exec(`DROP TRIGGER IF EXISTS "${name}"`);
        continue;
      }
      const row = action === "DELETE" ? "OLD" : "NEW";
      // Writes outside a logged transaction (a restore from a snapshot) find
      // no log row and record nothing.
      sql.exec(
        `CREATE TRIGGER IF NOT EXISTS "${name}" AFTER ${action} ON "${table}"
         WHEN EXISTS (SELECT 1 FROM "_tx_log")
         BEGIN
           INSERT OR REPLACE INTO "${AUDIT_TABLE}" (id, table_name, row_id, seq, at, user_id, role, action)
           SELECT '${table}' || char(31) || ${row}.id || char(31) || seq,
                  '${table}', ${row}.id, seq, at, user_id, role, '${action.toLowerCase()}'
             FROM "_tx_log" ORDER BY seq DESC LIMIT 1;
         END`
      );
    }
  }
}

export interface AuditEntry {
  seq: number;
  at: number;
  /** The writer's claim subject. */
  sub: string | null;
  role: number | null;
  action: "insert" | "update" | "delete";
}

/** Every recorded change to one row, oldest first. */
export function rowHistory(sql: SqlExecutor, table: string, id: string): AuditEntry[] {
  return sql
    .all<{ seq: number; at: number; user_id: string | null; role: number | null; action: string }>(
      `SELECT seq, at, user_id, role, action FROM "${AUDIT_TABLE}" WHERE table_name = ? AND row_id = ? ORDER BY seq`,
      table,
      id
    )
    .map((row) => ({
      seq: Number(row.seq),
      at: Number(row.at),
      sub: row.user_id,
      role: row.role === null ? null : Number(row.role),
      action: row.action as AuditEntry["action"],
    }));
}
