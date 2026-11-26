/**
 * Workspace instrumentation.
 *
 * One of these lives in each workspace's Durable Object, in memory. Nothing
 * here writes to SQLite or to R2: a metric that cost a transaction would make
 * the thing it measures slower, and the log is the application's, not ours.
 *
 * What that costs is honesty about the window. A Durable Object is evicted
 * when it goes idle and restarts cold, so every counter here is "since this
 * object started", not "since the workspace existed". `since` and `uptimeMs`
 * in the snapshot say which window the caller is looking at, and
 * `restartsCounters` says plainly that the numbers reset. Anything that must
 * survive a restart is read from SQLite at snapshot time instead
 * (`gauges` in the route), where it is already durable.
 *
 * Latency is kept as fixed-bucket histograms rather than raw samples, so the
 * memory a workspace spends on instrumentation is a constant: a counter and a
 * bucket array per timer, whatever the traffic. Quantiles read off buckets are
 * estimates, and the snapshot marks them as such — the bucket bounds are
 * published so a reader can see how coarse an estimate is. `sumMs` and `maxMs`
 * are exact.
 */

/** Counter names. A closed union, so a typo is a type error, not a lost metric. */
export type CounterName =
  // Writes. `refused` covers every rejection (permissions, validation,
  // conflicts are counted separately because they mean something different).
  | "transactions.committed"
  | "transactions.refused"
  | "transactions.conflicts"
  | "transactions.deduped"
  | "transactions.rows"
  // Reads.
  | "queries.served"
  | "queries.refused"
  | "sql.served"
  | "sql.refused"
  // Sockets and live queries.
  | "sockets.accepted"
  | "sockets.closed"
  | "subscriptions.opened"
  | "subscriptions.closed"
  | "subscriptions.updates"
  | "presence.updates"
  | "broadcast.messages"
  // Durability. Failures are counted apart from attempts so a rate is visible
  // without subtracting.
  | "durability.flushes"
  | "durability.flushFailures"
  | "durability.snapshots"
  | "durability.snapshotFailures"
  | "recovery.runs"
  | "recovery.failures";

/** Timer names: what we measure the duration of. */
export type TimerName =
  | "query"
  | "transaction"
  | "sql"
  | "subscriptionUpdate"
  | "flush"
  | "snapshot"
  | "recovery";

const COUNTER_NAMES: readonly CounterName[] = [
  "transactions.committed",
  "transactions.refused",
  "transactions.conflicts",
  "transactions.deduped",
  "transactions.rows",
  "queries.served",
  "queries.refused",
  "sql.served",
  "sql.refused",
  "sockets.accepted",
  "sockets.closed",
  "subscriptions.opened",
  "subscriptions.closed",
  "subscriptions.updates",
  "presence.updates",
  "broadcast.messages",
  "durability.flushes",
  "durability.flushFailures",
  "durability.snapshots",
  "durability.snapshotFailures",
  "recovery.runs",
  "recovery.failures",
];

const TIMER_NAMES: readonly TimerName[] = [
  "query",
  "transaction",
  "sql",
  "subscriptionUpdate",
  "flush",
  "snapshot",
  "recovery",
];

/**
 * Bucket upper bounds in milliseconds. The last bucket is everything above the
 * final bound, so a slow outlier lands somewhere rather than being dropped.
 *
 * The spread is sub-millisecond to half a minute because these timers measure
 * very different things with one scale: a query against a warm Durable Object
 * is tens of microseconds, while a cold-start recovery that rebuilds a
 * workspace from R2 is seconds.
 */
export const METRIC_BUCKETS_MS: readonly number[] = [
  0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
];

/** One timer's distribution. `sumMs` and `maxMs` are exact; quantiles are not. */
export interface TimerSnapshot {
  count: number;
  sumMs: number;
  maxMs: number;
  /** Mean of the recorded samples, exact. Null when nothing was recorded. */
  meanMs: number | null;
  /**
   * Read off the buckets, so each is the upper bound of the bucket the
   * quantile falls in, not the sample. Null when nothing was recorded.
   */
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  /** Counts per bucket, aligned with `METRIC_BUCKETS_MS` plus a final overflow. */
  buckets: number[];
}

export interface MetricsSnapshot {
  /** When this object started counting: epoch milliseconds. */
  since: number;
  uptimeMs: number;
  /**
   * Always true. A Durable Object restarts cold after eviction, so these
   * counters describe one object's lifetime, not the workspace's history.
   */
  restartsCounters: true;
  counters: Record<CounterName, number>;
  /** Quantiles in here are estimated from buckets; `bucketsMs` says how coarsely. */
  latency: {
    estimated: true;
    bucketsMs: readonly number[];
    timers: Record<TimerName, TimerSnapshot>;
  };
}

function quantile(buckets: readonly number[], count: number, q: number): number | null {
  if (count === 0) return null;
  // The rank of the sample we want, counting from 1.
  const target = Math.ceil(q * count);
  let seen = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    seen += buckets[i];
    if (seen >= target) {
      // The last bucket has no upper bound; report the highest bound we know
      // and let `maxMs` carry the real figure.
      return METRIC_BUCKETS_MS[i] ?? METRIC_BUCKETS_MS[METRIC_BUCKETS_MS.length - 1];
    }
  }
  return METRIC_BUCKETS_MS[METRIC_BUCKETS_MS.length - 1];
}

interface Timer {
  count: number;
  sumMs: number;
  maxMs: number;
  buckets: number[];
}

function emptyTimer(): Timer {
  return { count: 0, sumMs: 0, maxMs: 0, buckets: new Array(METRIC_BUCKETS_MS.length + 1).fill(0) };
}

/**
 * Counters and latency histograms for one workspace, in memory.
 *
 * Every method is O(1) against a fixed number of buckets and allocates
 * nothing, so instrumenting a path costs an integer add and a short scan.
 */
export class WorkspaceMetrics {
  private readonly counters = new Map<CounterName, number>();
  private readonly timers = new Map<TimerName, Timer>();
  private readonly startedAt: number;
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
    this.startedAt = clock();
  }

  /** Adds to a counter. `by` may be any non-negative integer (rows, bytes, 1). */
  count(name: CounterName, by = 1): void {
    if (by <= 0) return;
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  /** Records one duration in milliseconds. A negative or non-finite sample is ignored. */
  observe(name: TimerName, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    let timer = this.timers.get(name);
    if (!timer) {
      timer = emptyTimer();
      this.timers.set(name, timer);
    }
    timer.count += 1;
    timer.sumMs += ms;
    if (ms > timer.maxMs) timer.maxMs = ms;
    let index = METRIC_BUCKETS_MS.length;
    for (let i = 0; i < METRIC_BUCKETS_MS.length; i += 1) {
      if (ms <= METRIC_BUCKETS_MS[i]) {
        index = i;
        break;
      }
    }
    timer.buckets[index] += 1;
  }

  /**
   * Times `fn` and records it under `name`, whether it returns or throws: a
   * path that only records its successes hides exactly the latency worth
   * seeing. The result is passed through untouched.
   */
  async time<T>(name: TimerName, fn: () => Promise<T>): Promise<T> {
    const started = this.clock();
    try {
      return await fn();
    } finally {
      this.observe(name, this.clock() - started);
    }
  }

  /** The same, for a synchronous body. */
  timeSync<T>(name: TimerName, fn: () => T): T {
    const started = this.clock();
    try {
      return fn();
    } finally {
      this.observe(name, this.clock() - started);
    }
  }

  snapshot(): MetricsSnapshot {
    const counters = {} as Record<CounterName, number>;
    for (const name of COUNTER_NAMES) counters[name] = this.counters.get(name) ?? 0;

    const timers = {} as Record<TimerName, TimerSnapshot>;
    for (const name of TIMER_NAMES) {
      const timer = this.timers.get(name);
      if (!timer) {
        timers[name] = {
          count: 0, sumMs: 0, maxMs: 0, meanMs: null,
          p50Ms: null, p95Ms: null, p99Ms: null,
          buckets: new Array(METRIC_BUCKETS_MS.length + 1).fill(0),
        };
        continue;
      }
      timers[name] = {
        count: timer.count,
        // Round the accumulated sum: a float sum of many small samples
        // otherwise reports a precision it does not have.
        sumMs: Math.round(timer.sumMs * 1000) / 1000,
        maxMs: timer.maxMs,
        meanMs: Math.round((timer.sumMs / timer.count) * 1000) / 1000,
        p50Ms: quantile(timer.buckets, timer.count, 0.5),
        p95Ms: quantile(timer.buckets, timer.count, 0.95),
        p99Ms: quantile(timer.buckets, timer.count, 0.99),
        buckets: [...timer.buckets],
      };
    }

    return {
      since: this.startedAt,
      uptimeMs: Math.max(0, this.clock() - this.startedAt),
      restartsCounters: true,
      counters,
      latency: { estimated: true, bucketsMs: METRIC_BUCKETS_MS, timers },
    };
  }
}
