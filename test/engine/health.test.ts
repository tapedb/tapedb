/** The health verdict `GET /metrics` leads with (src/engine/health.ts). */

import { describe, expect, test } from "bun:test";

import { assessHealth, type HealthInput } from "../../src/engine/health";
import type { TimerSnapshot } from "../../src/engine/metrics";

const timer = (count = 0, p95Ms: number | null = null): TimerSnapshot => ({
  count,
  sumMs: 0,
  maxMs: p95Ms ?? 0,
  meanMs: null,
  p50Ms: p95Ms,
  p95Ms,
  p99Ms: p95Ms,
  buckets: [],
});

function input(overrides: Partial<HealthInput> = {}, durability: Partial<HealthInput["durability"]> = {}): HealthInput {
  return {
    now: 10 * 86_400_000,
    recovering: false,
    recoveryFailures: 0,
    webhooksDead: null,
    transaction: timer(),
    subscriptionUpdate: timer(),
    ...overrides,
    durability: {
      flushedSeq: 10,
      pendingSeq: 0,
      oldestPendingAt: null,
      flushAttempts: 0,
      lastFlushError: null,
      snapshotDueAt: null,
      snapshotCompletedAt: null,
      ...durability,
    },
  };
}

const codes = (health: ReturnType<typeof assessHealth>) => health.reasons.map((reason) => reason.code);

describe("assessHealth", () => {
  test("a flushed, quiet workspace is ok", () => {
    expect(assessHealth(input())).toEqual({ status: "ok", reasons: [] });
  });

  test("a failing flush is failing", () => {
    const health = assessHealth(input({}, { lastFlushError: "R2 500", flushAttempts: 3, pendingSeq: 4 }));
    expect(health.status).toBe("failing");
    expect(codes(health)).toEqual(["flush_failing"]);
  });

  test("writes waiting under the alarm delay are normal; past five minutes they are lagging", () => {
    const now = input().now;
    expect(assessHealth(input({}, { pendingSeq: 50, oldestPendingAt: now - 30_000 })).status).toBe("ok");
    expect(codes(assessHealth(input({}, { pendingSeq: 50, oldestPendingAt: now - 6 * 60_000 })))).toEqual(["flush_lagging"]);
    expect(codes(assessHealth(input({}, { pendingSeq: 20_000, oldestPendingAt: now - 1_000 })))).toEqual(["flush_lagging"]);
  });

  test("a snapshot past its due time and a day is overdue; one never taken is not", () => {
    const now = input().now;
    expect(codes(assessHealth(input({}, { snapshotCompletedAt: 0, snapshotDueAt: now - 2 * 86_400_000 })))).toEqual(["snapshot_overdue"]);
    expect(assessHealth(input({}, { snapshotCompletedAt: null, snapshotDueAt: 0 })).status).toBe("ok");
  });

  test("a restore is degraded; one R2 keeps refusing is failing", () => {
    expect(codes(assessHealth(input({ recovering: true })))).toEqual(["recovering"]);
    const failing = assessHealth(input({ recovering: true, recoveryFailures: 2 }));
    expect(failing).toMatchObject({ status: "failing", reasons: [{ code: "recovery_failing" }] });
  });

  test("dead-lettered webhooks are degraded", () => {
    expect(codes(assessHealth(input({ webhooksDead: 0 })))).toEqual([]);
    expect(codes(assessHealth(input({ webhooksDead: 2 })))).toEqual(["webhooks_dead_lettered"]);
  });

  test("slow writes and live updates count only with enough samples", () => {
    expect(assessHealth(input({ transaction: timer(19, 5_000) })).status).toBe("ok");
    expect(codes(assessHealth(input({ transaction: timer(20, 2_500) })))).toEqual(["write_latency_high"]);
    expect(codes(assessHealth(input({ subscriptionUpdate: timer(50, 5_000) })))).toEqual(["live_updates_slow"]);
  });

  test("failing outranks degraded, and every reason is listed", () => {
    const health = assessHealth(input({ webhooksDead: 1 }, { lastFlushError: "down", flushAttempts: 1 }));
    expect(health.status).toBe("failing");
    expect(codes(health).sort()).toEqual(["flush_failing", "webhooks_dead_lettered"]);
  });
});
