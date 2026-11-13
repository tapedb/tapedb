import { useLegacyFixture } from "../../fixtures/registry";
useLegacyFixture();

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";

import { manifestKey } from "../../../src/engine/r2-keys";
import { namespaceTables } from "../../fixtures/registry";
import {
  readSnapshotState,
  shouldSnapshot,
  SNAPSHOT_SEQ_THRESHOLD,
  snapshotWorkspace,
} from "../../../src/engine/durability/snapshot";
import {
  FakeR2Bucket,
  insertFolder,
  openTestDb,
  setFlushSeq,
  setHighWater,
  TEST_WORKSPACE,
} from "../../fixtures/test-support";

async function readManifest(bucket: FakeR2Bucket) {
  const object = (await bucket.get(manifestKey(TEST_WORKSPACE))) as {
    text(): Promise<string>;
  } | null;
  expect(object).not.toBeNull();
  return JSON.parse(await object!.text());
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

describe("snapshotWorkspace", () => {
  test("chunks rows, gzips NDJSON and records checksums", async () => {
    const { sql } = openTestDb();
    for (const id of ["a", "b", "c", "d", "e"]) {
      insertFolder(sql, id, `Folder ${id}`);
    }
    setHighWater(sql, 5);
    setFlushSeq(sql, 5);

    const bucket = new FakeR2Bucket();
    const now = 2_000_000;
    const result = await snapshotWorkspace(bucket, sql, TEST_WORKSPACE, now, {
      chunkRows: 2,
    });

    expect(result.snapshotted).toBe(true);
    expect(result.baseSeq).toBe(5);
    expect(result.logSeq).toBe(5);
    expect(result.rows).toBe(5);
    expect(result.chunks).toBe(3);
    expect(result.manifestKey).toBe(manifestKey(TEST_WORKSPACE));

    const keys = [0, 1, 2].map(
      (index) => `ws/${TEST_WORKSPACE}/snapshots/5/folders/${index}.ndjson.gz`
    );
    for (const key of keys) expect(bucket.objects.has(key)).toBe(true);

    const lines = keys.flatMap((key) => {
      const raw = gunzipSync(Buffer.from(bucket.bodyOf(key)!)).toString("utf8");
      return raw
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
    });
    expect(lines.map((row) => row.id)).toEqual(["a", "b", "c", "d", "e"]);

    const manifest = await readManifest(bucket);
    expect(manifest.version).toBe(2);
    expect(manifest.baseSeq).toBe(5);
    expect(manifest.logSeq).toBe(5);
    expect(
      manifest.tables.map((table: { name: string }) => table.name)
    ).toEqual([...namespaceTables(), "_files", "_tx_receipts"]);
    expect(manifest.totalRows).toBe(5);

    const folderTable = manifest.tables.find(
      (table: { name: string }) => table.name === "folders"
    );
    expect(
      folderTable.chunks.map((chunk: { rows: number }) => chunk.rows)
    ).toEqual([2, 2, 1]);

    let expectedTotalBytes = 0;
    folderTable.chunks.forEach(
      (
        chunk: { key: string; bytes: number; sha256: string },
        index: number
      ) => {
        const body = bucket.bodyOf(chunk.key)!;
        expect(chunk.key).toBe(keys[index]);
        expect(chunk.bytes).toBe(body.byteLength);
        expect(chunk.sha256).toBe(hash(body));
        expectedTotalBytes += body.byteLength;
      }
    );
    expect(manifest.totalBytes).toBe(expectedTotalBytes);

    const state = readSnapshotState(sql);
    expect(state).toMatchObject({
      baseSeq: 5,
      status: "completed",
      completedAt: now,
      manifestKey: manifestKey(TEST_WORKSPACE),
    });
  });

  test("marks completed only after the manifest is durable", async () => {
    const { sql } = openTestDb();
    insertFolder(sql, "a", "Folder a");
    setHighWater(sql, 1);
    setFlushSeq(sql, 1);

    const bucket = new FakeR2Bucket();
    let statusWhenManifestWritten: string | undefined;

    bucket.beforePut = (key) => {
      if (!key.endsWith("/manifest.json")) return;
      const row = sql
        .exec<{
          status: string;
        }>(`SELECT status FROM "_snapshot_state" WHERE id = 1`)
        .toArray()[0];
      statusWhenManifestWritten = row?.status;
    };

    const result = await snapshotWorkspace(bucket, sql, TEST_WORKSPACE, 10);
    expect(result.snapshotted).toBe(true);
    expect(statusWhenManifestWritten).toBe("running");
    expect(readSnapshotState(sql).status).toBe("completed");
  });

  test("sets status failed and keeps manifest_key unset when a write fails", async () => {
    const { sql } = openTestDb();
    insertFolder(sql, "a", "Folder a");
    setHighWater(sql, 3);
    setFlushSeq(sql, 3);

    const bucket = new FakeR2Bucket();
    bucket.failPuts = true;

    const result = await snapshotWorkspace(bucket, sql, TEST_WORKSPACE, 10);
    expect(result.snapshotted).toBe(false);
    expect(result.error).toContain("R2 write failed");

    const state = readSnapshotState(sql);
    expect(state.status).toBe("failed");
    expect(state.completedAt).toBeNull();
    expect(state.manifestKey).toBeNull();
  });

  test("prunes covered log segments and keeps the last two snapshot prefixes", async () => {
    const { sql } = openTestDb();
    insertFolder(sql, "a", "Folder a");
    setHighWater(sql, 20);
    setFlushSeq(sql, 20);

    const bucket = new FakeR2Bucket();
    const logs: Array<[number, number]> = [
      [1, 5],
      [6, 10],
      [11, 15],
      [16, 20],
      [21, 25],
    ];
    for (const [from, to] of logs) {
      bucket.seed(`ws/${TEST_WORKSPACE}/log/${from}-${to}.ndjson`, "old");
    }
    for (const seq of [5, 10, 15]) {
      bucket.seed(
        `ws/${TEST_WORKSPACE}/snapshots/${seq}/folders/0.ndjson.gz`,
        "old"
      );
    }

    // Horizon 0 isolates the pruning contract from the idempotency retention
    // policy, which the next test covers.
    const result = await snapshotWorkspace(bucket, sql, TEST_WORKSPACE, 30, {
      retainLogSequences: 0,
    });
    expect(result.snapshotted).toBe(true);

    for (const [from, to] of logs) {
      const key = `ws/${TEST_WORKSPACE}/log/${from}-${to}.ndjson`;
      expect(bucket.objects.has(key)).toBe(to > 20);
    }

    expect(
      bucket.objects.has(
        `ws/${TEST_WORKSPACE}/snapshots/20/folders/0.ndjson.gz`
      )
    ).toBe(true);
    expect(
      bucket.objects.has(
        `ws/${TEST_WORKSPACE}/snapshots/15/folders/0.ndjson.gz`
      )
    ).toBe(true);
    for (const seq of [5, 10]) {
      expect(
        bucket.objects.has(
          `ws/${TEST_WORKSPACE}/snapshots/${seq}/folders/0.ndjson.gz`
        )
      ).toBe(false);
    }
  });

  test("retains covered segments inside the idempotency horizon", async () => {
    const { sql } = openTestDb();
    insertFolder(sql, "a", "Folder a");
    setHighWater(sql, 20);
    setFlushSeq(sql, 20);

    const bucket = new FakeR2Bucket();
    const logs: Array<[number, number]> = [
      [1, 5],
      [6, 10],
      [11, 15],
      [16, 20],
    ];
    for (const [from, to] of logs) {
      bucket.seed(`ws/${TEST_WORKSPACE}/log/${from}-${to}.ndjson`, "old");
    }

    // Base 20 with a horizon of 10 keeps everything after seq 10: a snapshot
    // stores rows, not idempotency keys, so those segments are the only copy of
    // the keys for a retry that crosses the snapshot.
    await snapshotWorkspace(bucket, sql, TEST_WORKSPACE, 30, {
      retainLogSequences: 10,
    });

    for (const [from, to] of logs) {
      const key = `ws/${TEST_WORKSPACE}/log/${from}-${to}.ndjson`;
      expect(bucket.objects.has(key)).toBe(to > 10);
    }
  });

  test("does not fail the snapshot when pruning fails", async () => {
    const { sql } = openTestDb();
    insertFolder(sql, "a", "Folder a");
    setHighWater(sql, 4);
    setFlushSeq(sql, 4);

    const bucket = new FakeR2Bucket();
    bucket.failDeletes = true;
    bucket.seed(`ws/${TEST_WORKSPACE}/log/1-2.ndjson`, "old");
    bucket.seed(`ws/${TEST_WORKSPACE}/snapshots/1/folders/0.ndjson.gz`, "old");
    bucket.seed(`ws/${TEST_WORKSPACE}/snapshots/2/folders/0.ndjson.gz`, "old");

    const result = await snapshotWorkspace(bucket, sql, TEST_WORKSPACE, 10, {
      retainLogSequences: 0,
    });
    expect(result.snapshotted).toBe(true);
    expect(result.warnings?.length).toBe(2);
    expect(readSnapshotState(sql).status).toBe("completed");
  });
});

describe("shouldSnapshot", () => {
  test("requires transactions", () => {
    const { sql } = openTestDb();
    expect(shouldSnapshot(sql, 0)).toBe(false);
  });

  test("is true when there is no completed snapshot and work exists", () => {
    const { sql } = openTestDb();
    setHighWater(sql, 1);
    expect(shouldSnapshot(sql, 0)).toBe(true);
  });

  test("uses the sequence threshold once a baseline exists", () => {
    const { sql } = openTestDb();
    sql.exec(
      `INSERT INTO "_snapshot_state" (id, base_seq, status)
       VALUES (1, 0, 'completed')`
    );

    setHighWater(sql, SNAPSHOT_SEQ_THRESHOLD - 1);
    expect(shouldSnapshot(sql, 0)).toBe(false);

    setHighWater(sql, SNAPSHOT_SEQ_THRESHOLD);
    expect(shouldSnapshot(sql, 0)).toBe(true);

    sql.exec(
      `UPDATE "_snapshot_state" SET base_seq = ? WHERE id = 1`,
      SNAPSHOT_SEQ_THRESHOLD
    );
    setHighWater(sql, SNAPSHOT_SEQ_THRESHOLD * 2 - 1);
    expect(shouldSnapshot(sql, 0)).toBe(false);
  });

  test("retries after a failed snapshot", () => {
    const { sql } = openTestDb();
    setHighWater(sql, 2);
    sql.exec(
      `INSERT INTO "_snapshot_state" (id, base_seq, status)
       VALUES (1, 0, 'failed')`
    );
    expect(shouldSnapshot(sql, 0)).toBe(true);
  });
});
