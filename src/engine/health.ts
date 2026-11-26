/**
 * The verdict `GET /metrics` leads with: is this workspace healthy, and if
 * not, why. It reads only numbers the answer already carries (gauges from
 * SQLite and the socket list, timers and counters from memory), so it costs
 * nothing extra and can be recomputed from the answer by a reader.
 *
 * `failing`: the workspace cannot serve, or cannot reach R2.
 * `degraded`: something is behind or slow, and the workspace still serves.
 */

import type { TimerSnapshot } from "./metrics";

/** Thresholds the verdict applies; published so a reader can see the rules. */
export const HEALTH_THRESHOLDS = {
  /** The oldest write not yet in R2, past this, is lagging (the alarm runs 30 s after a write). */
  pendingAgeMs: 5 * 60_000,
  /** Writes not yet in R2, past this, are lagging whatever their age. */
  pendingSeq: 10_000,
  /** A snapshot this long past its due time is overdue. */
  snapshotGraceMs: 86_400_000,
  /** Estimated p95 transaction latency past this is abnormal. */
  transactionP95Ms: 1_000,
  /** Estimated p95 live-update latency past this is abnormal. */
  subscriptionUpdateP95Ms: 2_500,
  /** Fewer samples than this say nothing about a percentile. */
  minSamples: 20,
} as const;

export type HealthStatus = "ok" | "degraded" | "failing";

export type HealthReasonCode =
  | "recovering"
  | "recovery_failing"
  | "flush_failing"
  | "flush_lagging"
  | "snapshot_overdue"
  | "webhooks_dead_lettered"
  | "write_latency_high"
  | "live_updates_slow";

export interface HealthReason {
  code: HealthReasonCode;
  status: Exclude<HealthStatus, "ok">;
  message: string;
}

export interface WorkspaceHealth {
  status: HealthStatus;
  reasons: HealthReason[];
}

export interface HealthInput {
  now: number;
  recovering: boolean;
  /** Restores R2 refused to answer, since this object started. */
  recoveryFailures: number;
  durability: {
    flushedSeq: number;
    pendingSeq: number;
    /** Commit time of the oldest write not yet in R2; null when none is waiting. */
    oldestPendingAt: number | null;
    flushAttempts: number;
    lastFlushError: string | null;
    /** When the next snapshot is due; null when there is nothing new to snapshot. */
    snapshotDueAt: number | null;
    /** Null for a workspace never snapshotted: its due time is zero and the next pass takes one. */
    snapshotCompletedAt: number | null;
  };
  webhooksDead: number | null;
  transaction: TimerSnapshot;
  subscriptionUpdate: TimerSnapshot;
}

export function assessHealth(input: HealthInput): WorkspaceHealth {
  const reasons: HealthReason[] = [];
  const add = (code: HealthReasonCode, status: HealthReason["status"], message: string) => reasons.push({ code, status, message });
  const d = input.durability;
  const t = HEALTH_THRESHOLDS;

  if (input.recovering) {
    if (input.recoveryFailures > 0) {
      add("recovery_failing", "failing", `A restore from R2 is in progress and R2 has refused it ${input.recoveryFailures} time(s); requests answer 503 until it completes.`);
    } else {
      add("recovering", "degraded", "A restore from R2 is in progress; requests answer 503 until it completes.");
    }
  }
  if (d.lastFlushError !== null) {
    add("flush_failing", "failing", `The last flush to R2 failed (${d.flushAttempts} attempt(s)); writes after seq ${d.flushedSeq} exist only in this object.`);
  }
  const pendingAge = d.oldestPendingAt === null ? 0 : input.now - d.oldestPendingAt;
  if (pendingAge > t.pendingAgeMs) {
    add("flush_lagging", "degraded", `The oldest write not yet in R2 is ${Math.round(pendingAge / 1000)} s old.`);
  } else if (d.pendingSeq > t.pendingSeq) {
    add("flush_lagging", "degraded", `${d.pendingSeq} writes are not yet in R2.`);
  }
  if (d.snapshotCompletedAt !== null && d.snapshotDueAt !== null && input.now > d.snapshotDueAt + t.snapshotGraceMs) {
    add("snapshot_overdue", "degraded", "The newest snapshot is more than a day past its due time (half the retention after the last).");
  }
  if (input.webhooksDead !== null && input.webhooksDead > 0) {
    add("webhooks_dead_lettered", "degraded", `${input.webhooksDead} webhook event(s) are dead-lettered.`);
  }
  if (input.transaction.count >= t.minSamples && (input.transaction.p95Ms ?? 0) > t.transactionP95Ms) {
    add("write_latency_high", "degraded", `Estimated p95 transaction latency is ${input.transaction.p95Ms} ms.`);
  }
  if (input.subscriptionUpdate.count >= t.minSamples && (input.subscriptionUpdate.p95Ms ?? 0) > t.subscriptionUpdateP95Ms) {
    add("live_updates_slow", "degraded", `Estimated p95 live-update latency is ${input.subscriptionUpdate.p95Ms} ms.`);
  }

  const status: HealthStatus = reasons.some((reason) => reason.status === "failing") ? "failing" : reasons.length > 0 ? "degraded" : "ok";
  return { status, reasons };
}
