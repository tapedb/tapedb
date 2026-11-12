import { logSegmentKey, MANIFEST_VERSION } from "../r2-keys";
import { buildLogSegment } from "./log-segment";
import {
  commitManifest,
  manifestCreatedAt,
  readEngineVersion,
} from "./manifest";
import type { SqlExecutor, SqlValue } from "./sql";
import type { FlushOptions, FlushResult, FlushState } from "./types";
import { DurabilityError } from "./types";

export const FLUSH_BACKOFF_BASE_MS = 30_000;
export const FLUSH_BACKOFF_MAX_MS = 60 * 60 * 1000;
export const MAX_FLUSH_ERROR_LENGTH = 500;

interface FlushStateRow extends Record<string, SqlValue> {
  last_seq: number;
  attempts: number;
  next_attempt_at: number | null;
  last_error: string | null;
  last_flush_at: number | null;
  last_segment_from: number | null;
  updated_at: number;
}

interface PendingRow extends Record<string, SqlValue> {
  present: number;
}

function ensureFlushStateRow(sql: SqlExecutor): void {
  sql.exec(
    `INSERT OR IGNORE INTO "_flush_state"
       (id, last_seq, attempts, next_attempt_at, last_error, last_flush_at,
        last_segment_from, updated_at)
     VALUES (1, 0, 0, NULL, NULL, NULL, NULL, 0)`
  );
}

/** Reads `_flush_state` and whether `_tx_log` has rows after `lastSeq`. */
export function readFlushState(sql: SqlExecutor): FlushState {
  ensureFlushStateRow(sql);

  const row = sql
    .exec<FlushStateRow>(
      `SELECT last_seq, attempts, next_attempt_at, last_error, last_flush_at,
              last_segment_from, updated_at
         FROM "_flush_state"
        WHERE id = 1`
    )
    .toArray()[0];

  const lastSeq = row?.last_seq ?? 0;
  const pending =
    sql
      .exec<PendingRow>(
        `SELECT 1 AS present FROM "_tx_log" WHERE seq > ? ORDER BY seq LIMIT 1`,
        lastSeq
      )
      .toArray().length > 0;

  return {
    lastSeq,
    attempts: row?.attempts ?? 0,
    nextAttemptAt: row?.next_attempt_at ?? null,
    lastError: row?.last_error ?? null,
    lastFlushAt: row?.last_flush_at ?? null,
    lastSegmentFrom: row?.last_segment_from ?? null,
    updatedAt: row?.updated_at ?? 0,
    hasPending: pending,
  };
}

/** True when there is work and the backoff window has elapsed. */
export function shouldFlush(state: FlushState, now: number): boolean {
  return (
    state.hasPending &&
    (state.nextAttemptAt === null || now >= state.nextAttemptAt)
  );
}

/** Exponential backoff: 30s, 60s, 120s … capped at one hour. */
export function nextBackoffDelay(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  return Math.min(FLUSH_BACKOFF_MAX_MS, FLUSH_BACKOFF_BASE_MS * 2 ** exponent);
}

function truncateError(message: string): string {
  return message.length > MAX_FLUSH_ERROR_LENGTH
    ? message.slice(0, MAX_FLUSH_ERROR_LENGTH)
    : message;
}

function recordFlushFailure(
  sql: SqlExecutor,
  state: FlushState,
  now: number,
  message: string
): void {
  const attempts = state.attempts + 1;
  const nextAttemptAt = now + nextBackoffDelay(attempts);
  sql.exec(
    `UPDATE "_flush_state"
        SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = 1`,
    attempts,
    nextAttemptAt,
    truncateError(message),
    now
  );
}

/**
 * Flushes pending `_tx_log` rows to R2.
 *
 * Ordering matters for recovery: the segment is uploaded first, then the
 * manifest is advanced, and only then is `_flush_state.last_seq` moved. If R2
 * or the manifest write fails, `last_seq` is untouched so the next attempt
 * re-uploads the same (idempotent) segment.
 */
export async function flushPending(
  bucket: R2Bucket,
  sql: SqlExecutor,
  workspaceId: string,
  now: number,
  options: FlushOptions = {}
): Promise<FlushResult> {
  const state = readFlushState(sql);

  if (!state.hasPending) {
    return { flushed: false };
  }

  const segment = buildLogSegment(
    sql,
    state.lastSeq,
    options.maxRows,
    options.maxBytes
  );

  if (!segment) {
    return { flushed: false };
  }

  const key = logSegmentKey(workspaceId, segment.fromSeq, segment.toSeq);

  try {
    const written = await bucket.put(key, segment.ndjson, {
      httpMetadata: { contentType: "application/x-ndjson; charset=utf-8" },
    });

    if (!written) {
      throw new DurabilityError(
        "r2_write_failed",
        `R2 did not acknowledge ${key}.`
      );
    }

    await commitManifest(bucket, workspaceId, (current) => ({
      version: MANIFEST_VERSION,
      workspaceId,
      baseSeq: current?.baseSeq ?? 0,
      logSeq: Math.max(current?.logSeq ?? 0, segment.toSeq),
      createdAt: current?.createdAt ?? manifestCreatedAt(now),
      engineVersion: readEngineVersion(sql),
      tables: current?.tables ?? [],
      totalRows: current?.totalRows ?? 0,
      totalBytes: current?.totalBytes ?? 0,
    }));

    sql.exec(
      `UPDATE "_flush_state"
          SET last_seq = ?, attempts = 0, next_attempt_at = NULL,
              last_error = NULL, last_flush_at = ?, last_segment_from = ?,
              updated_at = ?
        WHERE id = 1`,
      segment.toSeq,
      now,
      segment.fromSeq,
      now
    );

    return {
      flushed: true,
      fromSeq: segment.fromSeq,
      toSeq: segment.toSeq,
      rows: segment.rows,
      key,
    };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    recordFlushFailure(sql, state, now, error.message);

    return {
      flushed: false,
      error: error.message,
      code: cause instanceof DurabilityError ? cause.code : "r2_write_failed",
    };
  }
}
