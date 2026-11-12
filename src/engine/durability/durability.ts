import { flushPending, readFlushState, shouldFlush } from "./flusher";
import { shouldSnapshot, snapshotWorkspace } from "./snapshot";
import type { SqlExecutor } from "./sql";
import type { DurabilityOptions, DurabilityTickResult } from "./types";

/**
 * One durability pass: flush pending log rows first, then take a snapshot when
 * the sequence lag (or a missing baseline) makes one due.
 *
 * This module deliberately does not schedule alarms; the caller owns the
 * Durable Object alarm lifecycle.
 */
export async function durabilityTick(
  bucket: R2Bucket,
  sql: SqlExecutor,
  workspaceId: string,
  now: number,
  options: DurabilityOptions = {}
): Promise<DurabilityTickResult> {
  const flushState = readFlushState(sql);
  const flushResult = shouldFlush(flushState, now)
    ? await flushPending(bucket, sql, workspaceId, now, options.flush)
    : { flushed: false };

  const snapshot = shouldSnapshot(sql, now)
    ? await snapshotWorkspace(bucket, sql, workspaceId, now, options.snapshot)
    : null;

  return { flushed: flushResult.flushed, snapshot };
}
