import { defaultDeploymentConfig, type DeploymentConfig } from "../config";
import { flushPending, readFlushState, shouldFlush } from "./flusher";
import { historyPruneAt, pruneHistory, shouldSnapshot, snapshotWorkspace } from "./snapshot";
import type { SqlExecutor } from "./sql";
import type { DurabilityOptions, DurabilityTickResult } from "./types";

/** Segments one pass writes at most, and the time it spends writing them. */
const MAX_SEGMENTS_PER_TICK = 1000;
const FLUSH_BUDGET_MS = 20_000;

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
  // The deployment this pass belongs to: what a segment line records and
  // whether `_tx_audit` is snapshotted. Absent means unconfigured.
  const config: DeploymentConfig = options.config ?? defaultDeploymentConfig();
  // Drain the backlog, a segment at a time, rather than one segment per pass:
  // a segment holds about 1 MB, and a workspace writing faster than that per
  // alarm delay would otherwise fall further behind R2 with every write.
  const started = Date.now();
  let flushResult: Awaited<ReturnType<typeof flushPending>> | { flushed: false } = { flushed: false };
  let flushedAny = false;
  for (let segments = 0; segments < MAX_SEGMENTS_PER_TICK; segments += 1) {
    const flushState = readFlushState(sql);
    if (!shouldFlush(flushState, now)) break;
    flushResult = await flushPending(bucket, sql, workspaceId, now, options.flush, config);
    if (!flushResult.flushed) break;
    flushedAny = true;
    if (Date.now() - started > FLUSH_BUDGET_MS) break;
  }

  const snapshot = shouldSnapshot(sql, now)
    ? await snapshotWorkspace(bucket, sql, workspaceId, now, options.snapshot, config)
    : null;

  // History older than the retention allows, whether or not anything changed.
  const pruneAt = historyPruneAt(sql);
  const history = pruneAt !== null && pruneAt <= now ? await pruneHistory(bucket, sql, workspaceId, now) : null;

  const flushError = "error" in flushResult && typeof flushResult.error === "string" ? flushResult.error : undefined;
  return { flushed: flushedAny, ...(flushError ? { flushError } : {}), snapshot, history };
}
