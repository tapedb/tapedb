/**
 * The benchmarks' statistics, apart from the benchmarks so they can be tested.
 *
 * `scripts/bench.ts` runs its scenarios on import, so nothing there is
 * importable from a test. These two functions are the part that could silently
 * lie — a wrong quantile reads as a result, not as a bug — so they live here
 * and `test/bench-stats.test.ts` checks them against hand-worked answers.
 *
 * Quantiles here are **exact**, from kept samples. The engine's own
 * `GET /metrics` reports bucket estimates instead, on purpose: it must keep
 * constant memory in a long-lived Durable Object, while a benchmark runs once
 * and can afford to hold every sample.
 */

export interface Summary {
  count: number;
  sumMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

/**
 * The sample at rank `ceil(q * n)`, counting from 1 — the nearest-rank
 * definition, with no interpolation between samples. A quantile of a set of
 * measurements should be one of the measurements: an interpolated 103.5 ms
 * names a request that never happened.
 *
 * `samples` must already be sorted ascending.
 */
export function quantile(samples: readonly number[], q: number): number {
  if (samples.length === 0) return 0;
  const rank = Math.ceil(q * samples.length) - 1;
  return samples[Math.min(Math.max(rank, 0), samples.length - 1)];
}

/** Rounds to three decimals, so a float sum does not report precision it lacks. */
export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Summarises durations in milliseconds. Does not mutate the input. */
export function summarize(samples: readonly number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    sumMs: round(sum),
    meanMs: sorted.length === 0 ? 0 : round(sum / sorted.length),
    p50Ms: round(quantile(sorted, 0.5)),
    p95Ms: round(quantile(sorted, 0.95)),
    p99Ms: round(quantile(sorted, 0.99)),
    maxMs: round(sorted.at(-1) ?? 0),
  };
}
