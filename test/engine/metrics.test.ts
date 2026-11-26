import { describe, expect, test } from "bun:test";

import { METRIC_BUCKETS_MS, WorkspaceMetrics } from "../../src/engine/metrics";

/** A clock a test drives by hand, so a duration is exact rather than observed. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

describe("WorkspaceMetrics counters", () => {
  test("a snapshot names every counter, including the untouched ones", () => {
    const metrics = new WorkspaceMetrics();
    metrics.count("transactions.committed");

    const snapshot = metrics.snapshot();
    expect(snapshot.counters["transactions.committed"]).toBe(1);
    // A dashboard should not have to guess whether a missing key means zero.
    expect(snapshot.counters["transactions.refused"]).toBe(0);
    expect(snapshot.counters["recovery.failures"]).toBe(0);
  });

  test("counts add, and a non-positive step changes nothing", () => {
    const metrics = new WorkspaceMetrics();
    metrics.count("transactions.rows", 3);
    metrics.count("transactions.rows", 4);
    metrics.count("transactions.rows", 0);
    metrics.count("transactions.rows", -5);

    expect(metrics.snapshot().counters["transactions.rows"]).toBe(7);
  });

  test("the window is reported, and declared as resetting", () => {
    const clock = fakeClock();
    const metrics = new WorkspaceMetrics(clock.now);
    clock.advance(250);

    const snapshot = metrics.snapshot();
    expect(snapshot.since).toBe(1_000);
    expect(snapshot.uptimeMs).toBe(250);
    // The flag is the only honest way to read the counters: an evicted object
    // starts again from zero.
    expect(snapshot.restartsCounters).toBe(true);
  });
});

describe("WorkspaceMetrics latency", () => {
  test("exact statistics are exact", () => {
    const metrics = new WorkspaceMetrics();
    for (const ms of [1, 2, 3, 94]) metrics.observe("query", ms);

    const timer = metrics.snapshot().latency.timers.query;
    expect(timer.count).toBe(4);
    expect(timer.sumMs).toBe(100);
    expect(timer.maxMs).toBe(94);
    expect(timer.meanMs).toBe(25);
  });

  test("a sample lands in the first bucket it does not exceed", () => {
    const metrics = new WorkspaceMetrics();
    // 0.5 is the first bound, so it belongs to bucket 0, not bucket 1.
    metrics.observe("query", 0.5);
    metrics.observe("query", 0.6);

    const timer = metrics.snapshot().latency.timers.query;
    expect(timer.buckets[0]).toBe(1);
    expect(timer.buckets[1]).toBe(1);
  });

  test("a sample past the last bound lands in the overflow bucket", () => {
    const metrics = new WorkspaceMetrics();
    const beyond = METRIC_BUCKETS_MS[METRIC_BUCKETS_MS.length - 1] + 1;
    metrics.observe("recovery", beyond);

    const timer = metrics.snapshot().latency.timers.recovery;
    expect(timer.buckets).toHaveLength(METRIC_BUCKETS_MS.length + 1);
    expect(timer.buckets[METRIC_BUCKETS_MS.length]).toBe(1);
    // The estimate is capped at the last bound, but the exact maximum is kept:
    // without it an outlier would be invisible.
    expect(timer.p99Ms).toBe(METRIC_BUCKETS_MS[METRIC_BUCKETS_MS.length - 1]);
    expect(timer.maxMs).toBe(beyond);
  });

  test("quantiles are the bucket bound the rank falls in", () => {
    const metrics = new WorkspaceMetrics();
    // 95 samples at 1ms and 5 at 4000ms: the median is fast, the tail is not.
    for (let i = 0; i < 95; i += 1) metrics.observe("transaction", 1);
    for (let i = 0; i < 5; i += 1) metrics.observe("transaction", 4_000);

    const timer = metrics.snapshot().latency.timers.transaction;
    expect(timer.p50Ms).toBe(1);
    // Rank 95 of 100 is still a fast sample, so p95 reads fast; the five slow
    // ones are ranks 96 to 100 and only p99 reaches them. That is the whole
    // point of carrying a quantile rather than a mean, whose 200ms here would
    // describe no request that was actually served.
    expect(timer.p95Ms).toBe(1);
    expect(timer.p99Ms).toBe(5_000);
    expect(timer.maxMs).toBe(4_000);
    expect(timer.meanMs).toBe(200.95);
  });

  test("an untouched timer reports nulls, not zeroes", () => {
    const timer = new WorkspaceMetrics().snapshot().latency.timers.flush;
    expect(timer.count).toBe(0);
    // Zero would read as "instant"; null reads as "never measured".
    expect(timer.meanMs).toBeNull();
    expect(timer.p50Ms).toBeNull();
    expect(timer.p99Ms).toBeNull();
  });

  test("a snapshot says its quantiles are estimates and publishes the bounds", () => {
    const snapshot = new WorkspaceMetrics().snapshot();
    expect(snapshot.latency.estimated).toBe(true);
    expect(snapshot.latency.bucketsMs).toEqual(METRIC_BUCKETS_MS);
  });

  test("a nonsense sample is ignored rather than recorded", () => {
    const metrics = new WorkspaceMetrics();
    metrics.observe("query", -1);
    metrics.observe("query", Number.NaN);
    metrics.observe("query", Number.POSITIVE_INFINITY);

    expect(metrics.snapshot().latency.timers.query.count).toBe(0);
  });

  test("buckets in a snapshot are a copy, so a reader cannot edit the instrument", () => {
    const metrics = new WorkspaceMetrics();
    metrics.observe("query", 1);

    const first = metrics.snapshot().latency.timers.query;
    // 1ms sits in bucket 1: the bounds are upper bounds, and bucket 0 holds
    // only what is at or under 0.5ms.
    expect(first.buckets[1]).toBe(1);
    first.buckets[1] = 999;

    expect(metrics.snapshot().latency.timers.query.buckets[1]).toBe(1);
  });
});

describe("WorkspaceMetrics timing helpers", () => {
  test("time records a duration and passes the value through", async () => {
    const clock = fakeClock();
    const metrics = new WorkspaceMetrics(clock.now);

    const result = await metrics.time("flush", async () => {
      clock.advance(42);
      return "done";
    });

    expect(result).toBe("done");
    expect(metrics.snapshot().latency.timers.flush.maxMs).toBe(42);
  });

  test("a body that throws is still recorded", async () => {
    const clock = fakeClock();
    const metrics = new WorkspaceMetrics(clock.now);

    await expect(
      metrics.time("flush", async () => {
        clock.advance(7);
        throw new Error("r2 unavailable");
      })
    ).rejects.toThrow("r2 unavailable");

    // The failures are the samples worth having: a path that recorded only its
    // successes would report a healthy flush while nothing reached R2.
    expect(metrics.snapshot().latency.timers.flush.count).toBe(1);
    expect(metrics.snapshot().latency.timers.flush.maxMs).toBe(7);
  });

  test("timeSync does the same for a synchronous body", () => {
    const clock = fakeClock();
    const metrics = new WorkspaceMetrics(clock.now);

    expect(metrics.timeSync("sql", () => { clock.advance(3); return 11; })).toBe(11);
    expect(() => metrics.timeSync("sql", () => { clock.advance(5); throw new Error("bad sql"); })).toThrow("bad sql");

    const timer = metrics.snapshot().latency.timers.sql;
    expect(timer.count).toBe(2);
    expect(timer.sumMs).toBe(8);
  });
});

describe("WorkspaceMetrics cost", () => {
  test("memory per timer is fixed, whatever the traffic", () => {
    const metrics = new WorkspaceMetrics();
    for (let i = 0; i < 50_000; i += 1) metrics.observe("query", i % 7_000);

    const timer = metrics.snapshot().latency.timers.query;
    // The point of buckets over samples: 50,000 observations are still one
    // array of a fixed length, so a busy workspace cannot grow this without
    // bound.
    expect(timer.buckets).toHaveLength(METRIC_BUCKETS_MS.length + 1);
    expect(timer.count).toBe(50_000);
    expect(timer.buckets.reduce((total, count) => total + count, 0)).toBe(50_000);
  });
});
