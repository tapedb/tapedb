import { useLegacyFixture } from "../../fixtures/registry";
useLegacyFixture();

import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";

import { durabilityTick } from "../../../src/engine/durability";
import { configureRetention, DAY_MS, DEFAULT_HISTORY_RETENTION_MS } from "../../../src/engine/durability/retention";
import {
  historyPruneAt,
  pruneHistory,
  readSnapshotState,
  shouldSnapshot,
  snapshotDueAt,
  snapshotWorkspace,
} from "../../../src/engine/durability/snapshot";
import {
  FakeR2Bucket,
  insertFolder,
  insertTxLog,
  openTestDb,
  setFlushSeq,
  setHighWater,
  TEST_WORKSPACE,
} from "../../fixtures/test-support";
import type { SqlExecutor } from "../../../src/engine/durability/sql";

const R = DEFAULT_HISTORY_RETENTION_MS;
const ws = (rest: string) => `ws/${TEST_WORKSPACE}/${rest}`;

/** Every R2 object's text, snapshots gunzipped. */
function everyCopy(bucket: FakeR2Bucket): string {
  return [...bucket.objects.entries()]
    .map(([key, stored]) => (key.endsWith(".gz") ? gunzipSync(Buffer.from(stored.body)).toString() : new TextDecoder().decode(stored.body)))
    .join("\n");
}

function localLog(sql: SqlExecutor): string {
  return sql
    .exec<{ ops: string; user_id: string | null }>(`SELECT ops, user_id FROM "_tx_log"`)
    .toArray()
    .map((row) => `${row.ops} ${row.user_id}`)
    .join("\n");
}

describe("history retention", () => {
  test("a value deleted at T is gone from R2 and the local log by T + retention", async () => {
    const { sql } = openTestDb();
    const bucket = new FakeR2Bucket();
    let seq = 0;
    const write = (now: number, ops: unknown[], userId: string | null = null) => {
      seq += 1;
      insertTxLog(sql, { seq, ops, at: now, userId });
      setHighWater(sql, seq);
    };
    const tick = async (now: number) => {
      bucket.clock = now;
      await durabilityTick(bucket, sql, TEST_WORKSPACE, now);
    };

    // A quiet workspace: a handful of writes, far under the 1000-seq snapshot lag.
    let now = 10 * DAY_MS;
    insertFolder(sql, "secret", "alice@example.com");
    write(now, [{ op: "insert", namespace: "folders", id: "secret", values: { name: "alice@example.com" } }], "user-alice");
    insertFolder(sql, "other", "kept");
    write(now, [{ op: "insert", namespace: "folders", id: "other", values: { name: "kept" } }]);
    for (let day = 0; day < 3; day += 1) await tick((now += DAY_MS));
    expect(everyCopy(bucket)).toContain("alice@example.com");

    // Deleted at T.
    const deletedAt = (now += DAY_MS / 2);
    sql.exec(`DELETE FROM "folders" WHERE id = 'secret'`);
    write(deletedAt, [{ op: "delete", namespace: "folders", id: "secret" }]);

    // The durability alarm runs at least daily while history is due.
    while (now < deletedAt + R) await tick((now += DAY_MS));

    expect(everyCopy(bucket)).not.toContain("alice@example.com");
    expect(everyCopy(bucket)).not.toContain("user-alice");
    expect(localLog(sql)).not.toContain("alice@example.com");
    expect(localLog(sql)).not.toContain("user-alice");
    // Recovery still has what it needs: the live row in the newest snapshot.
    expect(everyCopy(bucket)).toContain("kept");
  });

  test("a workspace with changes snapshots once its newest snapshot is half the retention old", async () => {
    const { sql } = openTestDb();
    insertFolder(sql, "a", "a");
    setHighWater(sql, 5);
    setFlushSeq(sql, 5);
    const bucket = new FakeR2Bucket();
    await snapshotWorkspace(bucket, sql, TEST_WORKSPACE, 0);

    expect(snapshotDueAt(sql)).toBeNull();
    setHighWater(sql, 6);
    expect(snapshotDueAt(sql)).toBe(R / 2);
    expect(shouldSnapshot(sql, R / 2 - 1)).toBe(false);
    expect(shouldSnapshot(sql, R / 2)).toBe(true);
  });

  test("keeps a superseded snapshot and the log it covers through the grace day", async () => {
    const { sql } = openTestDb();
    insertFolder(sql, "a", "a");
    setHighWater(sql, 10);
    setFlushSeq(sql, 10);
    const bucket = new FakeR2Bucket();
    bucket.seed(ws("snapshots/5/folders/0.ndjson.gz"), "old", 0);
    bucket.seed(ws("log/1-5.ndjson"), "old", 0);
    bucket.seed(ws("log/6-10.ndjson"), "old", 0);
    bucket.seed(ws("log/11-12.ndjson"), "after", 0);

    const snapshotAt = R; // everything seeded is already past R/2
    bucket.clock = snapshotAt;
    await snapshotWorkspace(bucket, sql, TEST_WORKSPACE, snapshotAt, { retention: 5, retainLogSequences: 1000 });
    expect(historyPruneAt(sql)).toBe(snapshotAt + DAY_MS);

    const early = await pruneHistory(bucket, sql, TEST_WORKSPACE, snapshotAt + DAY_MS - 1);
    expect(early.objects).toBe(0);
    expect(bucket.objects.has(ws("snapshots/5/folders/0.ndjson.gz"))).toBe(true);

    const due = await pruneHistory(bucket, sql, TEST_WORKSPACE, snapshotAt + DAY_MS);
    expect(due.objects).toBe(3);
    expect(bucket.objects.has(ws("snapshots/5/folders/0.ndjson.gz"))).toBe(false);
    expect(bucket.objects.has(ws("log/1-5.ndjson"))).toBe(false);
    expect(bucket.objects.has(ws("log/6-10.ndjson"))).toBe(false);
    // What recovery needs: the newest snapshot and the log after it.
    expect(bucket.objects.has(ws("snapshots/10/folders/0.ndjson.gz"))).toBe(true);
    expect(bucket.objects.has(ws("log/11-12.ndjson"))).toBe(true);
    expect(due.nextAt).toBeNull();
    expect(historyPruneAt(sql)).toBeNull();
  });

  test("schedules the next prune for the oldest remaining history", async () => {
    const { sql } = openTestDb();
    insertFolder(sql, "a", "a");
    for (let seq = 1; seq <= 4; seq += 1) insertTxLog(sql, { seq, ops: [], at: seq * DAY_MS });
    setHighWater(sql, 4);
    setFlushSeq(sql, 4);
    const bucket = new FakeR2Bucket();
    await snapshotWorkspace(bucket, sql, TEST_WORKSPACE, 5 * DAY_MS, { retainLogSequences: 1000 });
    bucket.seed(ws("log/1-4.ndjson"), "covered", 3 * DAY_MS);

    const now = 2 * DAY_MS + R / 2;
    const result = await pruneHistory(bucket, sql, TEST_WORKSPACE, now);
    // Rows at day 1 and 2 are past R/2; day 3 is the oldest left.
    expect(result.localRows).toBe(2);
    expect(result.nextAt).toBe(3 * DAY_MS + R / 2);
    expect(bucket.objects.has(ws("log/1-4.ndjson"))).toBe(true);
  });

  test("an upgraded or recovered workspace with a snapshot but no prune record is due", async () => {
    const { sql } = openTestDb();
    insertFolder(sql, "a", "a");
    setHighWater(sql, 1);
    setFlushSeq(sql, 1);
    await snapshotWorkspace(new FakeR2Bucket(), sql, TEST_WORKSPACE, 0);
    sql.exec(`DELETE FROM "_engine_meta" WHERE "key" = 'history_prune_at'`);
    expect(historyPruneAt(sql)).toBe(Number.NEGATIVE_INFINITY);
    expect(readSnapshotState(sql).status).toBe("completed");
  });

  test("removes old hashes while retaining receipts and schedules only remaining hashes", async () => {
    const { sql } = openTestDb();
    insertFolder(sql, "a", "a");
    setHighWater(sql, 1);
    setFlushSeq(sql, 1);
    await snapshotWorkspace(new FakeR2Bucket(), sql, TEST_WORKSPACE, 0);
    sql.exec(`INSERT INTO "_tx_receipts" (id, seq, ops_hash, at) VALUES ('old', 1, 'h', ?), ('new', 1, 'h', ?)`, DAY_MS, 5 * DAY_MS);

    const result = await pruneHistory(new FakeR2Bucket(), sql, TEST_WORKSPACE, DAY_MS + R / 2);
    expect(result.receipts).toBe(1);
    expect(sql.exec(`SELECT id, seq, ops_hash, at FROM "_tx_receipts" ORDER BY at`).toArray()).toEqual([
      { id: "old", seq: 1, ops_hash: null, at: DAY_MS },
      { id: "new", seq: 1, ops_hash: "h", at: 5 * DAY_MS },
    ]);
    expect(result.nextAt).toBe(5 * DAY_MS + R / 2);
    const again = await pruneHistory(new FakeR2Bucket(), sql, TEST_WORKSPACE, 400 * DAY_MS);
    expect(again.receipts).toBe(1);
    expect(again.nextAt).toBeNull();
    expect(sql.exec(`SELECT COUNT(*) AS n FROM "_tx_receipts" WHERE ops_hash IS NULL`).toArray()).toEqual([{ n: 2 }]);
    expect((await pruneHistory(new FakeR2Bucket(), sql, TEST_WORKSPACE, 401 * DAY_MS)).receipts).toBe(0);
  });

  test("refuses a retention under two days", () => {
    expect(() => configureRetention({ days: 1 })).toThrow("at least 2");
    configureRetention({ days: 7 });
    configureRetention(undefined);
  });
});
