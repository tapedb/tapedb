/**
 * Workspace diagnostics: what an administrator reads to tell whether a
 * workspace is healthy (`GET /engine/workspaces/:id/diagnostics`,
 * `db.$diagnostics()`).
 *
 * Two kinds of number live here, and the answer keeps them apart:
 *
 * - **Counters and latencies** are kept in this object's memory only. They
 *   cost a few additions per operation, are never written to SQLite, and
 *   start again from zero when Cloudflare evicts or restarts the object.
 *   `since` says when they started.
 * - **State** (log size, flush lag, snapshot age, outbox counts) is read from
 *   the engine's own tables when the diagnostics are asked for, so it is true
 *   after a restart too.
 *
 * Latencies are fixed-bucket histograms: memory per histogram is constant
 * whatever the traffic, and the percentiles read from them are estimates (the
 * upper bound of the bucket the rank falls in), marked as such.
 *
 * Nothing here holds a row, a value, a subject, a claim or a query parameter:
 * only counts, durations and error codes.
 *
 * Clock: workerd advances `Date.now()` only at I/O, so a duration measured
 * around synchronous SQL reads 0 there. A duration in these histograms is the
 * time between I/O boundaries; CPU-only work shows up in Workers Logs'
 * `cpuTimeMs`, not here.
 */

/** Upper bounds of the latency buckets, in milliseconds; the last bucket is open. */
export const LATENCY_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000] as const;

/** The span the recent rates cover. */
export const RATE_WINDOW_MS = 5 * 60_000;
const RATE_SLOTS = 10;
const RATE_SLOT_MS = RATE_WINDOW_MS / RATE_SLOTS;

/** Thresholds the health verdict applies. */
export const HEALTH_THRESHOLDS = {
  /** Oldest write not yet in R2: past this, durability is falling behind. */
  flushLagMs: 5 * 60_000,
  /** Writes not yet in R2: past this, durability is falling behind. */
  unflushedTransactions: 10_000,
  /** Estimated p95 transaction latency past this is abnormal. */
  transactionP95Ms: 1_000,
  /** Estimated p95 live-update latency past this is abnormal. */
  subscriptionP95Ms: 2_500,
  /** A snapshot this long past its due time (half the retention after the last) is overdue. */
  snapshotGraceMs: 86_400_000,
} as const;

export interface LatencySummary {
  count: number;
  /** Mean of the measured durations, ms. */
  meanMs: number | null;
  /** Largest measured duration, ms. */
  maxMs: number | null;
  /** Estimated from the buckets: the upper bound of the bucket the rank falls in. */
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  /** Per-bucket counts, keyed by upper bound ("+Inf" for the open bucket). */
  buckets: Record<string, number>;
}

/** A fixed-bucket latency histogram. */
export class LatencyHistogram {
  private readonly counts = new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0);
  private total = 0;
  private sum = 0;
  private max = 0;

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    let index = LATENCY_BUCKETS_MS.findIndex((bound) => ms <= bound);
    if (index === -1) index = LATENCY_BUCKETS_MS.length;
    this.counts[index] += 1;
    this.total += 1;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  }

  /** The estimated value at quantile `q` (0..1), or null with no samples. */
  quantile(q: number): number | null {
    if (this.total === 0) return null;
    const rank = Math.max(1, Math.ceil(q * this.total));
    let seen = 0;
    for (let index = 0; index < this.counts.length; index += 1) {
      seen += this.counts[index];
      if (seen >= rank) {
        // The open bucket's bound is the largest value seen.
        return index < LATENCY_BUCKETS_MS.length ? Math.min(LATENCY_BUCKETS_MS[index], this.max) : this.max;
      }
    }
    return this.max;
  }

  summary(): LatencySummary {
    const buckets: Record<string, number> = {};
    LATENCY_BUCKETS_MS.forEach((bound, index) => {
      buckets[String(bound)] = this.counts[index];
    });
    buckets["+Inf"] = this.counts[LATENCY_BUCKETS_MS.length];
    return {
      count: this.total,
      meanMs: this.total === 0 ? null : round(this.sum / this.total),
      maxMs: this.total === 0 ? null : round(this.max),
      p50Ms: this.quantile(0.5),
      p95Ms: this.quantile(0.95),
      p99Ms: this.quantile(0.99),
      buckets,
    };
  }
}

/** Events per slot over the last `RATE_WINDOW_MS`, in a fixed ring. */
export class RateWindow {
  private readonly slots = new Array<number>(RATE_SLOTS).fill(0);
  private readonly slotStart = new Array<number>(RATE_SLOTS).fill(-1);

  constructor(private readonly now: () => number) {}

  add(n = 1): void {
    const at = this.now();
    const slotTime = Math.floor(at / RATE_SLOT_MS);
    const index = slotTime % RATE_SLOTS;
    if (this.slotStart[index] !== slotTime) {
      this.slotStart[index] = slotTime;
      this.slots[index] = 0;
    }
    this.slots[index] += n;
  }

  /** Events per second over the window (or since `since`, if more recent). */
  perSecond(since: number): number {
    const at = this.now();
    const current = Math.floor(at / RATE_SLOT_MS);
    let total = 0;
    for (let index = 0; index < RATE_SLOTS; index += 1) {
      if (this.slotStart[index] > current - RATE_SLOTS) total += this.slots[index];
    }
    const span = Math.max(1_000, Math.min(RATE_WINDOW_MS, at - since));
    return round(total / (span / 1_000));
  }
}

/** Transaction refusals, by engine error code. A bounded set: codes come from `TxErrorCode`. */
type CodeCounts = Record<string, number>;
const MAX_CODES = 64;

function countCode(counts: CodeCounts, code: string): void {
  if (code in counts || Object.keys(counts).length < MAX_CODES) counts[code] = (counts[code] ?? 0) + 1;
  else counts.other = (counts.other ?? 0) + 1;
}

/** The kinds of read the room serves. */
export type ReadKind = "query" | "sql" | "search";

/**
 * The room's in-memory metrics. One per room instance; nothing is persisted.
 */
export class WorkspaceMetrics {
  readonly since: number;
  private readonly transactionRate: RateWindow;
  private readonly readRate: RateWindow;

  private transactions = { committed: 0, unchanged: 0, rejected: 0, failed: 0, rejectedByCode: {} as CodeCounts };
  private reads = { query: 0, sql: 0, search: 0, rejected: 0, failed: 0, rejectedByCode: {} as CodeCounts };
  private realtime = { subscribes: 0, liveReruns: 0, sharedReruns: 0, updatesSent: 0, presenceMessages: 0, topicMessages: 0 };
  private durability = { ticks: 0, flushFailures: 0, tickFailures: 0, lastTickAt: null as number | null, lastTickError: null as string | null };
  private recovery = { steps: 0, completed: 0, failures: 0, consecutiveFailures: 0, lastError: null as string | null, lastErrorAt: null as number | null, lastCompletedMs: null as number | null, startedAt: null as number | null };
  private webhooks = { passes: 0, failures: 0, lastError: null as string | null };

  private readonly latency = {
    transaction: new LatencyHistogram(),
    read: new LatencyHistogram(),
    subscriptionUpdate: new LatencyHistogram(),
    durabilityTick: new LatencyHistogram(),
    recoveryStep: new LatencyHistogram(),
  };

  constructor(private readonly now: () => number = Date.now) {
    this.since = now();
    this.transactionRate = new RateWindow(now);
    this.readRate = new RateWindow(now);
  }

  /** A `/transact` that committed (applied rows) or was a replay / no-op. */
  transactionDone(ms: number, applied: number): void {
    if (applied > 0) this.transactions.committed += 1;
    else this.transactions.unchanged += 1;
    this.transactionRate.add();
    this.latency.transaction.record(ms);
  }

  /** A `/transact` the engine refused with a code (validation, rules, conflicts, limits). */
  transactionRejected(code: string): void {
    this.transactions.rejected += 1;
    countCode(this.transactions.rejectedByCode, code);
  }

  /** A `/transact` that threw something other than an engine refusal. */
  transactionFailed(): void {
    this.transactions.failed += 1;
  }

  readDone(kind: ReadKind, ms: number): void {
    this.reads[kind] += 1;
    this.readRate.add();
    this.latency.read.record(ms);
  }

  readRejected(code: string): void {
    this.reads.rejected += 1;
    countCode(this.reads.rejectedByCode, code);
  }

  readFailed(): void {
    this.reads.failed += 1;
  }

  subscribed(): void {
    this.realtime.subscribes += 1;
  }

  /**
   * One live-update pass: `latencyMs` from the first write it covers to the
   * last update sent, `reruns` queries actually run, `shared` answers reused.
   */
  liveFlush(latencyMs: number, reruns: number, shared: number, sent: number): void {
    this.realtime.liveReruns += reruns;
    this.realtime.sharedReruns += shared;
    this.realtime.updatesSent += sent;
    if (sent > 0) this.latency.subscriptionUpdate.record(latencyMs);
  }

  presenceMessage(): void {
    this.realtime.presenceMessages += 1;
  }

  topicMessage(): void {
    this.realtime.topicMessages += 1;
  }

  durabilityTick(ms: number, flushError: string | null): void {
    this.durability.ticks += 1;
    this.durability.lastTickAt = this.now();
    this.durability.lastTickError = flushError;
    if (flushError !== null) this.durability.flushFailures += 1;
    this.latency.durabilityTick.record(ms);
  }

  durabilityTickFailed(error: string): void {
    this.durability.tickFailures += 1;
    this.durability.lastTickAt = this.now();
    this.durability.lastTickError = error;
  }

  recoveryStep(ms: number, finished: boolean): void {
    if (this.recovery.startedAt === null) this.recovery.startedAt = this.now() - ms;
    this.recovery.steps += 1;
    this.recovery.consecutiveFailures = 0;
    this.latency.recoveryStep.record(ms);
    if (finished) {
      this.recovery.completed += 1;
      this.recovery.lastCompletedMs = this.now() - this.recovery.startedAt;
      this.recovery.startedAt = null;
    }
  }

  recoveryFailed(error: string): void {
    this.recovery.failures += 1;
    this.recovery.consecutiveFailures += 1;
    this.recovery.lastError = error;
    this.recovery.lastErrorAt = this.now();
  }

  webhookPass(error: string | null): void {
    this.webhooks.passes += 1;
    if (error !== null) {
      this.webhooks.failures += 1;
      this.webhooks.lastError = error;
    }
  }

  /** The measured part of the diagnostics. */
  snapshot(): MeasuredDiagnostics {
    return {
      since: this.since,
      uptimeMs: this.now() - this.since,
      rates: {
        windowMs: RATE_WINDOW_MS,
        transactionsPerSecond: this.transactionRate.perSecond(this.since),
        readsPerSecond: this.readRate.perSecond(this.since),
      },
      transactions: { ...this.transactions, rejectedByCode: { ...this.transactions.rejectedByCode } },
      reads: { ...this.reads, rejectedByCode: { ...this.reads.rejectedByCode } },
      realtime: { ...this.realtime },
      durability: { ...this.durability },
      recovery: {
        steps: this.recovery.steps,
        completed: this.recovery.completed,
        failures: this.recovery.failures,
        consecutiveFailures: this.recovery.consecutiveFailures,
        lastError: this.recovery.lastError,
        lastErrorAt: this.recovery.lastErrorAt,
        lastDurationMs: this.recovery.lastCompletedMs,
      },
      webhookDelivery: { ...this.webhooks },
      latency: {
        transaction: this.latency.transaction.summary(),
        read: this.latency.read.summary(),
        subscriptionUpdate: this.latency.subscriptionUpdate.summary(),
        durabilityTick: this.latency.durabilityTick.summary(),
        recoveryStep: this.latency.recoveryStep.summary(),
      },
    };
  }
}

export interface MeasuredDiagnostics {
  since: number;
  uptimeMs: number;
  rates: { windowMs: number; transactionsPerSecond: number; readsPerSecond: number };
  transactions: { committed: number; unchanged: number; rejected: number; failed: number; rejectedByCode: CodeCounts };
  reads: { query: number; sql: number; search: number; rejected: number; failed: number; rejectedByCode: CodeCounts };
  realtime: { subscribes: number; liveReruns: number; sharedReruns: number; updatesSent: number; presenceMessages: number; topicMessages: number };
  durability: { ticks: number; flushFailures: number; tickFailures: number; lastTickAt: number | null; lastTickError: string | null };
  recovery: {
    steps: number;
    completed: number;
    failures: number;
    consecutiveFailures: number;
    lastError: string | null;
    lastErrorAt: number | null;
    lastDurationMs: number | null;
  };
  webhookDelivery: { passes: number; failures: number; lastError: string | null };
  latency: Record<"transaction" | "read" | "subscriptionUpdate" | "durabilityTick" | "recoveryStep", LatencySummary>;
}

/** What the engine's tables say, read when the diagnostics are asked for. */
export interface StoredDiagnostics {
  storage: {
    /** SQLite's own size for this object, bytes; null where the runtime does not report it. */
    databaseBytes: number | null;
    txLogRows: number;
    files: number;
  };
  durability: {
    seq: number;
    flushedSeq: number;
    unflushedTransactions: number;
    /** Commit time of the oldest write not yet in R2, ms since epoch. */
    oldestUnflushedAt: number | null;
    lastFlushAt: number | null;
    lastFlushError: string | null;
    flushAttempts: number;
    nextFlushAttemptAt: number | null;
    snapshotSeq: number;
    snapshotStatus: string;
    snapshotCompletedAt: number | null;
    /** When the next snapshot is due (half the retention after the last), or null with nothing new to snapshot. */
    snapshotDueAt: number | null;
  };
  recovery: { status: string | null; recovering: boolean };
  connections: { sockets: number; subscriptions: number; topics: number; presenceTargets: number };
  webhooks: { pending: number; delivered: number; dead: number } | null;
  migrations: { applied: number; latest: string | null };
}

export type HealthStatus = "ok" | "degraded" | "failing";

export interface HealthReason {
  code: string;
  status: Exclude<HealthStatus, "ok">;
  message: string;
}

export interface WorkspaceDiagnostics {
  workspaceId: string;
  at: number;
  health: { status: HealthStatus; reasons: HealthReason[] };
  measured: MeasuredDiagnostics;
  stored: StoredDiagnostics;
}

/**
 * The health verdict: `failing` when the workspace cannot serve or cannot
 * reach R2, `degraded` when something is falling behind or failing in a way
 * the workspace survives.
 */
export function assessHealth(measured: MeasuredDiagnostics, stored: StoredDiagnostics, now: number): { status: HealthStatus; reasons: HealthReason[] } {
  const reasons: HealthReason[] = [];
  const add = (code: string, status: HealthReason["status"], message: string) => reasons.push({ code, status, message });
  const d = stored.durability;

  if (stored.recovery.recovering) {
    add(
      measured.recovery.consecutiveFailures > 0 ? "recovery_failing" : "recovering",
      measured.recovery.consecutiveFailures > 0 ? "failing" : "degraded",
      measured.recovery.consecutiveFailures > 0
        ? `The restore from R2 failed ${measured.recovery.consecutiveFailures} time(s) in a row; requests answer 503 until it completes.`
        : "The workspace is restoring from R2; requests answer 503 until it completes."
    );
  }
  if (d.lastFlushError !== null) {
    add("flush_failing", "failing", `The last flush to R2 failed after ${d.flushAttempts} attempt(s); writes since seq ${d.flushedSeq} are only in this object.`);
  }
  if (d.oldestUnflushedAt !== null && now - d.oldestUnflushedAt > HEALTH_THRESHOLDS.flushLagMs) {
    add("flush_lagging", "degraded", `The oldest write not yet in R2 is ${Math.round((now - d.oldestUnflushedAt) / 1000)} s old.`);
  } else if (d.unflushedTransactions > HEALTH_THRESHOLDS.unflushedTransactions) {
    add("flush_lagging", "degraded", `${d.unflushedTransactions} writes are not yet in R2.`);
  }
  // A workspace never snapshotted has a due time of zero (the next pass takes
  // one); only a schedule that a completed snapshot set can be overdue.
  if (d.snapshotCompletedAt !== null && d.snapshotDueAt !== null && now > d.snapshotDueAt + HEALTH_THRESHOLDS.snapshotGraceMs) {
    add("snapshot_overdue", "degraded", "The newest snapshot is older than its schedule (half the retention) plus a day.");
  }
  if (stored.webhooks !== null && stored.webhooks.dead > 0) {
    add("webhooks_dead_lettered", "degraded", `${stored.webhooks.dead} webhook event(s) are dead-lettered.`);
  }
  const txP95 = measured.latency.transaction.p95Ms;
  if (txP95 !== null && measured.latency.transaction.count >= 20 && txP95 > HEALTH_THRESHOLDS.transactionP95Ms) {
    add("write_latency_high", "degraded", `Estimated p95 transaction latency is ${txP95} ms.`);
  }
  const liveP95 = measured.latency.subscriptionUpdate.p95Ms;
  if (liveP95 !== null && measured.latency.subscriptionUpdate.count >= 20 && liveP95 > HEALTH_THRESHOLDS.subscriptionP95Ms) {
    add("live_updates_slow", "degraded", `Estimated p95 live-update latency is ${liveP95} ms.`);
  }

  const status: HealthStatus = reasons.some((reason) => reason.status === "failing")
    ? "failing"
    : reasons.length > 0
      ? "degraded"
      : "ok";
  return { status, reasons };
}

/** Error text as it may leave the object: one line, bounded. */
export function diagnosticError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").slice(0, 300);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
