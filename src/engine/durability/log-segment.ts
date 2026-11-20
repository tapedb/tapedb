import { defaultDeploymentConfig, type DeploymentConfig } from "../config";
import type { SqlExecutor, SqlValue } from "./sql";
import type { LogSegment } from "./types";

/**
 * One `_tx_log` row as stored by the transaction pipeline. `ops` stays a JSON
 * string in SQLite and is parsed back into the wire shape for the segment.
 */
interface TxLogRow extends Record<string, SqlValue> {
  ops_hash: string;
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

/** How many continuation parts a log entry has beyond part 0. */
function extraParts(sql: SqlExecutor, seq: number): number {
  const row = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "_tx_log_parts" WHERE seq = ?`, seq).toArray()[0];
  return row?.n ?? 0;
}

/** The stored continuation parts of a log entry, as JSON text, in order. */
export function* storedParts(sql: SqlExecutor, seq: number): Generator<string> {
  let part = 0;
  for (;;) {
    const row = sql
      .exec<{ part: number; ops: string }>(
        `SELECT part, ops FROM "_tx_log_parts" WHERE seq = ? AND part > ? ORDER BY part LIMIT 1`,
        seq,
        part
      )
      .toArray()[0];
    if (row === undefined) return;
    part = row.part;
    yield row.ops;
  }
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
  maxBytes: number = DEFAULT_MAX_SEGMENT_BYTES,
  /** The deployment being flushed; its audit flag decides what a line carries. */
  config: DeploymentConfig = defaultDeploymentConfig()
): LogSegment | null {
  assertPositiveInteger(maxRows, "maxRows");
  assertPositiveInteger(maxBytes, "maxBytes");
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    throw new Error("afterSeq must be a non-negative integer.");
  }

  const rows = sql
    .exec<TxLogRow>(
      `SELECT seq, client_tx_id, ops, ops_hash, user_id, role, at, schema_version
         FROM "_tx_log"
        WHERE seq > ?
        ORDER BY seq
        LIMIT ?`,
      afterSeq,
      maxRows
    )
    .toArray();

  const lines: string[] = [];
  const refs: Array<{ seq: number; first: string }> = [];
  let bytes = 0;

  for (const row of rows) {
    if (lines.length >= maxRows) break;

    const parts = extraParts(sql, row.seq);
    const entry = {
      seq: row.seq,
      ...(row.client_tx_id === null ? {} : { clientTxId: row.client_tx_id }),
      // An entry in parts keeps its ops in their own object, written part by
      // part, so neither the segment nor a later replay holds them at once.
      ...(parts > 0 ? { ops: [], opsParts: parts + 1 } : { ops: parseOps(row.ops) }),
      // The hash of what the client sent, which is not always the hash of the
      // ops stored beside it: a bulk write logs the rows it resolved. Carried
      // so a retry after a restore is still recognised.
      opsHash: row.ops_hash,
      // Present only when the deployment records an audit.
      ...(config.audit && row.user_id !== null ? { userId: row.user_id } : {}),
      ...(config.audit && row.role !== null ? { role: row.role } : {}),
      at: row.at,
      schemaVersion: row.schema_version,
    };
    const line = `${JSON.stringify(entry)}\n`;
    const lineBytes = textEncoder.encode(line).byteLength;

    if (lines.length > 0 && bytes + lineBytes > maxBytes) break;

    lines.push(line);
    if (parts > 0) refs.push({ seq: row.seq, first: row.ops });
    bytes += lineBytes;
  }

  if (lines.length === 0) return null;

  return {
    fromSeq: rows[0].seq,
    toSeq: rows[lines.length - 1].seq,
    rows: lines.length,
    ndjson: lines.join(""),
    refs,
  };
}
