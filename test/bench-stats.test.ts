/**
 * The benchmarks' statistics.
 *
 * A wrong quantile in a benchmark does not fail anything: it prints a
 * plausible number and gets recorded in BENCHMARKS.md. So the arithmetic is
 * checked here against answers worked out by hand.
 */

import { describe, expect, test } from "bun:test";

import { quantile, round, summarize } from "../scripts/bench-stats";

describe("quantile", () => {
  test("is the sample at the nearest rank, never an interpolation", () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    // rank = ceil(0.5 * 10) = 5, so the fifth sample.
    expect(quantile(samples, 0.5)).toBe(5);
    expect(quantile(samples, 0.95)).toBe(10);
    expect(quantile(samples, 0.99)).toBe(10);
    // An interpolated p50 of this set would be 5.5, which is not a
    // measurement anything made.
    expect(samples).toContain(quantile(samples, 0.5));
  });

  test("p99 of 100 samples is the 99th, not the 100th", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);

    expect(quantile(samples, 0.99)).toBe(99);
    expect(quantile(samples, 1)).toBe(100);
  });

  test("one sample is every quantile", () => {
    expect(quantile([7], 0.5)).toBe(7);
    expect(quantile([7], 0.99)).toBe(7);
  });

  test("no samples is zero rather than undefined", () => {
    expect(quantile([], 0.5)).toBe(0);
  });

  test("a quantile at or below zero is the first sample, not an index of -1", () => {
    expect(quantile([3, 4, 5], 0)).toBe(3);
  });
});

describe("summarize", () => {
  test("reports exact statistics for a known set", () => {
    const summary = summarize([4, 1, 3, 2]);

    expect(summary.count).toBe(4);
    expect(summary.sumMs).toBe(10);
    expect(summary.meanMs).toBe(2.5);
    expect(summary.maxMs).toBe(4);
    // rank = ceil(0.5 * 4) = 2, so the second of [1,2,3,4].
    expect(summary.p50Ms).toBe(2);
  });

  test("sorts its own input, so a caller's order cannot change the answer", () => {
    const ascending = summarize([1, 2, 3, 100]);
    const descending = summarize([100, 3, 2, 1]);

    expect(descending).toEqual(ascending);
  });

  test("does not mutate the caller's array", () => {
    const samples = [3, 1, 2];
    summarize(samples);

    expect(samples).toEqual([3, 1, 2]);
  });

  test("a tail shows in p99 while the mean hides it", () => {
    const samples = [...Array.from({ length: 99 }, () => 1), 1000];
    const summary = summarize(samples);

    // The mean says 11ms, which describes nothing that happened; p99 says 1ms
    // and the maximum says 1000ms, which together describe the set.
    expect(summary.meanMs).toBe(10.99);
    expect(summary.p99Ms).toBe(1);
    expect(summary.maxMs).toBe(1000);
  });

  test("an empty set reports zeroes rather than NaN", () => {
    const summary = summarize([]);

    expect(summary.count).toBe(0);
    expect(summary.meanMs).toBe(0);
    expect(Number.isNaN(summary.meanMs)).toBe(false);
  });
});

describe("round", () => {
  test("keeps three decimals, so a float sum does not claim more precision", () => {
    expect(round(0.1 + 0.2)).toBe(0.3);
    expect(round(1.23456)).toBe(1.235);
    expect(round(10)).toBe(10);
  });
});
