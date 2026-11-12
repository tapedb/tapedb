import type { SqlExecutor, SqlValue } from "./sql";
import type { LogSegment } from "./types";

/**
 * One `_tx_log` row as stored by the transaction pipeline. `ops` stays a JSON
 * string in SQLite and is parsed back into the wire shape for the segment.
 */
interface TxLogRow extends Record<string, SqlValue> {
  seq: number;
  client_tx_id: string | null;
  ops: string;
  user_id: string | null;
  role: number | null;
  at: number;
  schema_version: string;
}

export const DEFAULT_MAX_SEGMENT_ROWS = 5000;
export const DEFAULT_MAX_SEGMENT_BYTES = 1024 * 1024;

const textEncoder = new TextEncoder();

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function parseOps(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // The pipeline writes valid JSON; keep a malformed row readable rather than
    // failing the whole flush.
    return raw;
  }
}

/**
 * Reads transactions after `afterSeq` in sequence order and renders one NDJSON
 * line per transaction.
 *
 * The returned segment never splits a transaction line: a single line larger
 * than `maxBytes` is still included on its own. Returns null when there is
 * nothing to flush.
 */
export function buildLogSegment(
  sql: SqlExecutor,
  afterSeq: number,
  maxRows: number = DEFAULT_MAX_SEGMENT_ROWS,
  maxBytes: number = DEFAULT_MAX_SEGMENT_BYTES
): LogSegment | null {
  assertPositiveInteger(maxRows, "maxRows");
  assertPositiveInteger(maxBytes, "maxBytes");
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    throw new Error("afterSeq must be a non-negative integer.");
  }

  const rows = sql
    .exec<TxLogRow>(
      `SELECT seq, client_tx_id, ops, user_id, role, at, schema_version
         FROM "_tx_log"
        WHERE seq > ?
        ORDER BY seq
        LIMIT ?`,
      afterSeq,
      maxRows
    )
    .toArray();

  const lines: string[] = [];
  let bytes = 0;

  for (const row of rows) {
    if (lines.length >= maxRows) break;

    const entry = {
      seq: row.seq,
      ...(row.client_tx_id === null ? {} : { clientTxId: row.client_tx_id }),
      ops: parseOps(row.ops),
      userId: row.user_id,
      role: row.role,
      at: row.at,
      schemaVersion: row.schema_version,
    };
    const line = `${JSON.stringify(entry)}\n`;
    const lineBytes = textEncoder.encode(line).byteLength;

    if (lines.length > 0 && bytes + lineBytes > maxBytes) break;

    lines.push(line);
    bytes += lineBytes;
  }

  if (lines.length === 0) return null;

  return {
    fromSeq: rows[0].seq,
    toSeq: rows[lines.length - 1].seq,
    rows: lines.length,
    ndjson: lines.join(""),
  };
}
