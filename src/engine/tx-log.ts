/**
 * The transaction log's storage for transactions of any size.
 *
 * A transaction is one `_tx_log` row. Its ops are usually small enough to sit
 * in that row; a bulk write that touches many rows is not, and a Durable
 * Object row holds at most 8 MB. So a log entry's ops are a list of parts:
 * part 0 in `_tx_log.ops`, the rest in `_tx_log_parts`, each a JSON array of
 * ops of at most `LOG_PART_BYTES`. Every reader goes through `logParts`, one
 * part at a time, so no step holds more than one part in memory.
 *
 * Bulk writes log compactly: one `patchIds` / `deleteIds` op per chunk of
 * rows, carrying the ids and the values once, instead of one op per row.
 * `expandLogOps` turns them back into ordinary ops right before they are
 * validated, a chunk at a time. Clients cannot send these kinds: they exist
 * only in the log.
 */

import { stableStringify } from "./tx-hash";
import type { SqlExecutor, SqlValue } from "./tx-sql";

/**
 * The most a stored part holds. Well under the 8 MB row limit, and small
 * enough that recovery applies one part (a few thousand rows) well inside a
 * Durable Object's 30 s of CPU, pausing between parts.
 */
export const LOG_PART_BYTES = 256 * 1024;
let logPartBytes = LOG_PART_BYTES;

/** Tests only: a smaller part size, so a multi-part entry needs few rows. */
export function setLogPartBytesForTests(bytes: number | null): void {
  logPartBytes = bytes ?? LOG_PART_BYTES;
}

/** Rows per compact bulk op in the log. */
export const LOG_IDS_PER_OP = 1000;

interface PartRow extends Record<string, SqlValue> {
  ops: string;
}

/**
 * Collects a transaction's ops into parts as they are produced, so a bulk
 * write never builds its whole op list in memory.
 */
export class LogWriter {
  private readonly parts: string[] = [];
  private current: string[] = [];
  private size = 2;
  private stored = 0;

  constructor(
    private readonly sql: SqlExecutor,
    private readonly seq: number,
    private readonly partBytes: number = logPartBytes
  ) {}

  push(op: unknown): void {
    const text = stableStringify(op);
    if (this.current.length > 0 && this.size + text.length + 1 > this.partBytes) this.cut();
    this.current.push(text);
    this.size += text.length + 1;
  }

  private cut(): void {
    const json = `[${this.current.join(",")}]`;
    if (this.parts.length === 0 && this.stored === 0) {
      // Part 0 waits for `close`, which writes it into the log row.
      this.parts.push(json);
    } else {
      this.stored += 1;
      this.sql.exec(`INSERT INTO "_tx_log_parts" (seq, part, ops) VALUES (?, ?, ?)`, this.seq, this.stored, json);
    }
    this.current = [];
    this.size = 2;
  }

  /** Writes part 0 into the log row. Returns how many parts the entry has. */
  close(): number {
    if (this.current.length > 0 || (this.parts.length === 0 && this.stored === 0)) this.cut();
    this.sql.exec(`UPDATE "_tx_log" SET ops = ? WHERE seq = ?`, this.parts[0] ?? "[]", this.seq);
    return 1 + this.stored;
  }
}

/** Writes a whole op list (already in memory) as a log entry's parts. */
export function writeLogOps(sql: SqlExecutor, seq: number, ops: readonly unknown[]): void {
  const writer = new LogWriter(sql, seq);
  for (const op of ops) writer.push(op);
  writer.close();
}

/** How many continuation parts a log entry has beyond part 0. */
export function extraParts(sql: SqlExecutor, seq: number): number {
  return sql.one<{ n: number }>(`SELECT COUNT(*) AS n FROM "_tx_log_parts" WHERE seq = ?`, seq)?.n ?? 0;
}

/** A log entry's ops, one part at a time: part 0 (given), then the stored ones. */
export function* logParts(sql: SqlExecutor, seq: number, first: string): Generator<unknown[]> {
  yield parseArray(first);
  let part = 0;
  for (;;) {
    const row = sql.one<PartRow>(`SELECT ops FROM "_tx_log_parts" WHERE seq = ? AND part > ? ORDER BY part LIMIT 1`, seq, part);
    if (row === undefined) return;
    part += 1;
    yield parseArray(row.ops);
  }
}

/** Removes continuation parts whose log row is gone. */
export function deleteOrphanParts(sql: SqlExecutor): void {
  sql.exec(`DELETE FROM "_tx_log_parts" WHERE seq NOT IN (SELECT seq FROM "_tx_log")`);
}

function parseArray(text: string): unknown[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("A log part is not a JSON array.");
  return parsed;
}

/** One compact bulk op per chunk of ids. */
export function compactBulkOp(
  kind: "patchMany" | "deleteMany",
  namespace: string,
  ids: readonly string[],
  values: Record<string, unknown>
): Record<string, unknown> {
  return kind === "deleteMany"
    ? { op: "deleteIds", namespace, ids: [...ids] }
    : { op: "patchIds", namespace, ids: [...ids], values };
}

/** Ordinary ops for a list that may hold compact bulk ops. */
export function expandLogOps(ops: readonly unknown[]): unknown[] {
  if (!ops.some(isCompact)) return [...ops];
  const out: unknown[] = [];
  for (const op of ops) {
    if (!isCompact(op)) {
      out.push(op);
      continue;
    }
    for (const id of op.ids) {
      out.push(
        op.op === "deleteIds"
          ? { op: "delete", namespace: op.namespace, id }
          : { op: "patch", namespace: op.namespace, id, values: op.values ?? {} }
      );
    }
  }
  return out;
}

function isCompact(
  op: unknown
): op is { op: "patchIds" | "deleteIds"; namespace: string; ids: string[]; values?: Record<string, unknown> } {
  return (
    typeof op === "object" &&
    op !== null &&
    ((op as { op?: unknown }).op === "patchIds" || (op as { op?: unknown }).op === "deleteIds") &&
    Array.isArray((op as { ids?: unknown }).ids)
  );
}
