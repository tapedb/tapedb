import { useLegacyFixture } from "../../fixtures/registry";
useLegacyFixture();

import { describe, expect, test } from "bun:test";

import { durabilityTick } from "../../../src/engine/durability";
import { readFlushState } from "../../../src/engine/durability/flusher";
import { readSnapshotState } from "../../../src/engine/durability/snapshot";
import {
  FakeR2Bucket,
  insertFolder,
  insertTxLog,
  openTestDb,
  setFlushSeq,
  setHighWater,
  TEST_WORKSPACE,
} from "../../fixtures/test-support";

describe("durabilityTick", () => {
  test("flushes before taking a due snapshot", async () => {
    const { sql } = openTestDb();
    insertFolder(sql, "a", "Folder a");
    insertTxLog(sql, { seq: 1000, ops: [] });
    setHighWater(sql, 1000);

    const bucket = new FakeR2Bucket();
    const order: string[] = [];
    bucket.beforePut = (key) => {
      order.push(key);
    };

    const result = await durabilityTick(bucket, sql, TEST_WORKSPACE, 5000);

    expect(result.flushed).toBe(true);
    expect(result.snapshot?.snapshotted).toBe(true);

    const logIndex = order.findIndex((key) => key.includes("/log/"));
    const snapshotChunkIndex = order.findIndex((key) =>
      key.includes("/snapshots/")
    );
    const manifestIndices = order
      .map((key, index) => (key.endsWith("/manifest.json") ? index : -1))
      .filter((index) => index >= 0);

    expect(logIndex).toBe(0);
    expect(manifestIndices.length).toBe(2);
    expect(manifestIndices[0]).toBeGreaterThan(logIndex);
    expect(snapshotChunkIndex).toBeGreaterThan(manifestIndices[0]);
    expect(manifestIndices[1]).toBeGreaterThan(snapshotChunkIndex);

    expect(readFlushState(sql).lastSeq).toBe(1000);
    expect(readSnapshotState(sql)).toMatchObject({
      baseSeq: 1000,
      status: "completed",
    });
  });

  test("one pass drains a backlog larger than a segment, instead of one segment per pass", async () => {
    const { sql } = openTestDb();
    // Each entry is ~200 KB, so a 1 MB segment holds about five of them.
    const big = Array.from({ length: 1500 }, (_, index) => ({ op: "update", namespace: "folders", id: `f${index}`, values: { name: "x".repeat(120) } }));
    for (let seq = 1; seq <= 40; seq += 1) insertTxLog(sql, { seq, ops: big });
    setHighWater(sql, 40);

    const bucket = new FakeR2Bucket();
    const result = await durabilityTick(bucket, sql, TEST_WORKSPACE, 5000);

    expect(result.flushed).toBe(true);
    expect(readFlushState(sql).lastSeq).toBe(40);
    const segments = [...bucket.objects.keys()].filter((key) => /\/log\/\d+-\d+\.ndjson$/.test(key));
    expect(segments.length).toBeGreaterThan(1);
  });

  test("does not retry a failed flush before next_attempt_at", async () => {
    const { sql } = openTestDb();
    insertTxLog(sql, { seq: 1, ops: [] });

    const bucket = new FakeR2Bucket();
    bucket.failPuts = true;

    const now = 1000;
    const first = await durabilityTick(bucket, sql, TEST_WORKSPACE, now);
    expect(first.flushed).toBe(false);
    expect(first.snapshot).toBeNull();
    expect(readFlushState(sql).attempts).toBe(1);

    bucket.failPuts = false;
    const second = await durabilityTick(bucket, sql, TEST_WORKSPACE, now + 1);
    expect(second.flushed).toBe(false);
    expect(readFlushState(sql).attempts).toBe(1);
    expect(bucket.puts).toHaveLength(0);

    const third = await durabilityTick(
      bucket,
      sql,
      TEST_WORKSPACE,
      now + 30_000
    );
    expect(third.flushed).toBe(true);
    expect(readFlushState(sql).lastSeq).toBe(1);
  });

  test("skips the snapshot when nothing is due", async () => {
    const { sql } = openTestDb();
    insertTxLog(sql, { seq: 10, ops: [] });
    setHighWater(sql, 10);
    setFlushSeq(sql, 10);
    sql.exec(
      `INSERT INTO "_snapshot_state" (id, base_seq, status)
       VALUES (1, 10, 'completed')`
    );

    const bucket = new FakeR2Bucket();
    const result = await durabilityTick(bucket, sql, TEST_WORKSPACE, 1000);

    expect(result.flushed).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(bucket.objects.size).toBe(0);
  });
});
