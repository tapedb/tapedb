import { flushPending, readFlushState, shouldFlush } from "./flusher";
import { historyPruneAt, pruneHistory, shouldSnapshot, snapshotWorkspace } from "./snapshot";
import type { SqlExecutor } from "./sql";
import type { DurabilityOptions, DurabilityTickResult } from "./types";

/**
 * One durability pass: flush pending log rows first, take a snapshot when one
 * is due, then delete history past the retention.
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

  // History older than the retention allows, whether or not anything changed.
  const pruneAt = historyPruneAt(sql);
  const history = pruneAt !== null && pruneAt <= now ? await pruneHistory(bucket, sql, workspaceId, now) : null;

  return { flushed: flushResult.flushed, snapshot, history };
}
