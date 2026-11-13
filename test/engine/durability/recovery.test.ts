import { useNdexFixture } from "../../fixtures/registry";
useNdexFixture();

import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../../../src/claims";
import { manifestKey, readManifest } from "../../../src/engine/r2-keys";
import { namespaceTables } from "../../fixtures/registry";
import { runTransaction } from "../../../src/engine/tx-pipeline";
import type { SqlRow as TxRow, SqlExecutor as TxSql } from "../../../src/engine/tx-sql";
import type { TxEnvelope } from "../../../src/engine/tx-types";
import { flushPending } from "../../../src/engine/durability/flusher";
import {
  recoverWorkspace,
  type RecoveryResult,
  type RecoverySqlExecutor,
} from "../../../src/engine/durability/recovery";
import { snapshotWorkspace } from "../../../src/engine/durability/snapshot";
import { forgetFileEntry, recordFileEntry } from "../../../src/engine/file-index";
import type { SqlExecutor as DurabilitySql, SqlValue } from "../../../src/engine/durability/sql";
import { FakeR2Bucket, openTestDb, TEST_WORKSPACE } from "../../fixtures/test-support";

const NOW = 1_700_000_000_000;

interface Source {
  db: Database;
  sql: DurabilitySql;
}

function createSource(): Source {
  const { db, sql } = openTestDb();
  db.exec("PRAGMA foreign_keys = ON");
  return { db, sql };
}

function txExecutor(db: Database): TxSql {
  return {
    exec(query, ...params) {
      return db.prepare(query).run(...(params as never[])).changes;
    },
    all<T extends TxRow = TxRow>(query: string, ...params: SqlValue[]): T[] {
      return db.query(query).all(...(params as never[])) as T[];
    },
    one<T extends TxRow = TxRow>(
      query: string,
      ...params: SqlValue[]
    ): T | undefined {
      const row = db.query(query).get(...(params as never[]));
      return row === null ? undefined : (row as T);
    },
    transactionSync<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}

function recoveryExecutor(
  db: Database,
  sql: DurabilitySql
): RecoverySqlExecutor {
  return {
    exec<T extends Record<string, SqlValue>>(
      query: string,
      ...bindings: SqlValue[]
    ) {
      return sql.exec<T>(query, ...bindings);
    },
    transactionSync<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}

function claim(role: number = WORKSPACE_ROLE_LEVELS.EDITOR): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "user-1",
    workspaceId: TEST_WORKSPACE,
    role: role as RoleClaim["role"],
    exp: now + 60,
    iat: now,
  };
}

function run(
  source: Source,
  envelope: TxEnvelope,
  role: number = WORKSPACE_ROLE_LEVELS.EDITOR
) {
  return runTransaction(
    txExecutor(source.db),
    TEST_WORKSPACE,
    claim(role),
    envelope
  );
}

/** Seeds every namespace with one or two related rows in a single transaction. */
function seedWorkspace(source: Source): number {
  return run(source, {
    txId: "seed",
    ops: [
      {
        op: "update",
        namespace: "whiteboardElements",
        id: "whiteboard-shape-1",
        values: {
          boardId: "whiteboard-1",
          kind: "shape",
          z: 0,
          data: {
            x: 10,
            y: 20,
            width: 100,
            height: 60,
            shape: "rectangle",
            fill: "red",
          },
        },
      },
      {
        op: "update",
        namespace: "folders",
        id: "z-parent",
        values: { name: "Parent" },
      },
      {
        op: "update",
        namespace: "folders",
        id: "a-child",
        values: { name: "Child", parentId: "z-parent" },
      },
      {
        op: "update",
        namespace: "documents",
        id: "d1",
        values: { title: "Doc", content: "Body", folderId: "z-parent" },
      },
      {
        op: "update",
        namespace: "blocks",
        id: "z-block",
        values: {
          type: "paragraph",
          content: "Hello",
          order: 0,
          documentId: "d1",
        },
      },
      {
        op: "update",
        namespace: "blocks",
        id: "a-block",
        values: {
          type: "paragraph",
          content: "Nested",
          order: 1,
          documentId: "d1",
          parentId: "z-block",
        },
      },
      {
        op: "update",
        namespace: "versions",
        id: "v1",
        values: { snapshot: "snap", versionNumber: 1, documentId: "d1" },
      },
      {
        op: "update",
        namespace: "embeddings",
        id: "e1",
        values: { vector: [0.1, 0.2], model: "m", blockId: "z-block" },
      },
      {
        op: "update",
        namespace: "kanbanBoards",
        id: "board1",
        values: { name: "Board" },
      },
      {
        op: "update",
        namespace: "kanbanSprints",
        id: "sprint1",
        values: { name: "Sprint", order: 0, boardId: "board1" },
      },
      {
        op: "update",
        namespace: "kanbanColumns",
        id: "col1",
        values: { name: "Todo", order: 0, boardId: "board1" },
      },
      {
        op: "update",
        namespace: "kanbanTasks",
        id: "task1",
        values: {
          title: "Task",
          order: 0,
          columnId: "col1",
          sprintId: "sprint1",
          tags: ["a", "b"],
        },
      },
      {
        op: "update",
        namespace: "taskAssignees",
        id: "ta1",
        values: { taskId: "task1", userId: "user-2" },
      },
      {
        op: "update",
        namespace: "favorites",
        id: "fav1",
        values: { type: "document", targetId: "d1" },
      },
      {
        op: "update",
        namespace: "gitBranches",
        id: "gb1",
        values: {
          taskId: "task1",
          taskTitle: "Task",
          branchName: "feature",
          repositoryId: "repo",
          createdBy: "user-1",
          status: "open",
        },
      },
      {
        op: "update",
        namespace: "pullRequests",
        id: "pr1",
        values: {
          branchId: "gb1",
          taskId: "task1",
          prNumber: 1,
          prTitle: "PR",
          prUrl: "https://example.com/pr/1",
          status: "open",
          author: "user-1",
        },
      },
      {
        op: "update",
        namespace: "ciStatus",
        id: "ci1",
        values: {
          branchId: "gb1",
          workflowName: "ci",
          status: "success",
          runNumber: 1,
          runUrl: "https://example.com/ci/1",
          startedAt: NOW,
        },
      },
      {
        op: "update",
        namespace: "webcalSubscriptions",
        id: "sub1",
        values: { name: "Calendar", url: "https://example.com/cal.ics" },
      },
      {
        op: "update",
        namespace: "webcalEvents",
        id: "ev1",
        values: {
          uid: "uid-1",
          occurrenceKey: "occ-1",
          title: "Event",
          startAt: NOW,
          subscriptionId: "sub1",
        },
      },
      {
        op: "update",
        namespace: "canvasElements",
        id: "ce1",
        values: { documentId: "d1", data: { shape: "rect" } },
      },
      {
        op: "update",
        namespace: "moscowDiagrams",
        id: "md1",
        values: {
          workspaceId: TEST_WORKSPACE,
          documentId: "d1",
          payload: { text: "x" },
          createdBy: "user-1",
        },
      },
      {
        op: "update",
        namespace: "coverPageTemplates",
        id: "cpt1",
        values: {
          workspaceId: TEST_WORKSPACE,
          name: "Template",
          content: "Cover",
        },
      },
    ],
  }).seq;
}

async function publish(
  source: Source,
  bucket: FakeR2Bucket,
  now: number
): Promise<void> {
  const flushed = await flushPending(bucket, source.sql, TEST_WORKSPACE, now);
  expect(flushed.flushed).toBe(true);

  const snapshotted = await snapshotWorkspace(
    bucket,
    source.sql,
    TEST_WORKSPACE,
    now
  );
  expect(snapshotted.snapshotted).toBe(true);
}

function entityRows(db: Database): Record<string, Record<string, unknown>[]> {
  const result: Record<string, Record<string, unknown>[]> = {};

  for (const table of [...namespaceTables(), "_files"]) {
    result[table] = db
      .query(`SELECT * FROM "${table}" ORDER BY "id"`)
      .all() as Record<string, unknown>[];
  }

  return result;
}

function meta(db: Database, key: string): string | undefined {
  const row = db
    .query(`SELECT value FROM "_engine_meta" WHERE "key" = ?`)
    .get(key) as { value: string } | null;
  return row?.value;
}

function scalar(db: Database, query: string): unknown {
  const row = db.query(query).get() as Record<string, unknown> | null;
  return row === null ? undefined : Object.values(row)[0];
}

async function expectFailure(
  promise: Promise<unknown>,
  pattern: RegExp
): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const typed = error as Error;
    expect(typed.message).toMatch(pattern);
    return typed;
  }
  throw new Error("Expected recovery to reject.");
}

async function manifestOf(bucket: FakeR2Bucket) {
  const stored = await readManifest(
    bucket as unknown as R2Bucket,
    TEST_WORKSPACE
  );
  expect(stored).not.toBeNull();
  return stored!.manifest;
}

async function corruptChunk(bucket: FakeR2Bucket, key: string): Promise<void> {
  const body = bucket.bodyOf(key);
  expect(body).toBeDefined();
  const corrupted = body!.slice();
  corrupted[0] ^= 0xff;
  await bucket.put(key, corrupted);
}

/**
 * Rewrites a snapshot chunk's rows and keeps the manifest's size/checksum
 * consistent, so only the row contents are under test.
 */
async function rewriteChunk(
  bucket: FakeR2Bucket,
  manifest: Awaited<ReturnType<typeof manifestOf>>,
  tableName: string,
  mutate: (rows: Record<string, unknown>[]) => void
): Promise<void> {
  const table = manifest.tables.find((entry) => entry.name === tableName);
  const chunk = table?.chunks[0];
  if (!chunk) throw new Error(`No snapshot chunk for "${tableName}".`);

  const body = bucket.bodyOf(chunk.key);
  if (!body) throw new Error(`Missing snapshot chunk ${chunk.key}.`);

  const rows = gunzipSync(Buffer.from(body))
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  mutate(rows);

  const ndjson = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  const compressed = new Uint8Array(gzipSync(Buffer.from(ndjson)));

  await bucket.put(chunk.key, compressed);
  chunk.bytes = compressed.byteLength;
  chunk.sha256 = createHash("sha256").update(compressed).digest("hex");
  chunk.rows = rows.length;
  await bucket.put(manifestKey(TEST_WORKSPACE), JSON.stringify(manifest));
}

describe("recoverWorkspace", () => {
  test("restores a snapshot into a fresh database with FKs and updated_seq", async () => {
    const source = createSource();
    const seq = seedWorkspace(source);
    expect(seq).toBe(1);

    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);

    const manifest = await manifestOf(bucket);
    expect(manifest.baseSeq).toBe(1);
    expect(manifest.logSeq).toBe(1);
    expect(manifest.tables.map((table) => table.name)).toEqual([
      ...namespaceTables(),
      "_files",
    ]);

    const target = createSource();
    const result = (await recoverWorkspace(
      bucket as unknown as R2Bucket,
      recoveryExecutor(target.db, target.sql),
      TEST_WORKSPACE,
      { now: NOW + 1 }
    )) as Extract<RecoveryResult, { recovered: true }>;

    expect(result).toEqual({
      recovered: true,
      baseSeq: 1,
      logSeq: 1,
      tables: namespaceTables().length + 1, // the models plus the file index
      rows: 22,
      replayed: 0,
    });

    expect(entityRows(target.db)).toEqual(entityRows(source.db));

    // Self-referential rows made it in parent-first: the FK check passed and
    // both the parent and child exist.
    expect(
      scalar(
        target.db,
        `SELECT parent_id FROM "folders" WHERE "id" = 'a-child'`
      )
    ).toBe("z-parent");
    expect(
      scalar(target.db, `SELECT parent_id FROM "blocks" WHERE "id" = 'a-block'`)
    ).toBe("z-block");

    expect(meta(target.db, "recovery_status")).toBe("complete");
    expect(meta(target.db, "recovery_base_seq")).toBe("1");
    expect(meta(target.db, "recovery_log_seq")).toBe("1");
    expect(meta(target.db, "recovery_error")).toBeUndefined();
    expect(scalar(target.db, `SELECT high_water_seq FROM "_tx_state"`)).toBe(1);
    expect(scalar(target.db, `SELECT last_seq FROM "_flush_state"`)).toBe(1);
    expect(scalar(target.db, `SELECT base_seq FROM "_snapshot_state"`)).toBe(1);
    expect(scalar(target.db, `SELECT status FROM "_snapshot_state"`)).toBe(
      "completed"
    );
  });

  test("replays log segments written after the snapshot base", async () => {
    const source = createSource();
    seedWorkspace(source);

    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);

    run(source, {
      txId: "after-snapshot-1",
      ops: [
        {
          op: "merge",
          namespace: "folders",
          id: "a-child",
          values: { color: "blue" },
        },
        {
          op: "update",
          namespace: "documents",
          id: "d1",
          values: { title: "Doc v2" },
        },
        {
          op: "link",
          namespace: "folders",
          id: "a-child",
          link: "folderDocuments",
          targetId: "d1",
        },
      ],
    });
    run(
      source,
      {
        txId: "after-snapshot-2",
        ops: [
          {
            op: "update",
            namespace: "folders",
            id: "f-new",
            values: { name: "New" },
          },
          { op: "delete", namespace: "favorites", id: "fav1" },
          {
            op: "unlink",
            namespace: "documents",
            id: "d1",
            link: "folderDocuments",
            targetId: "a-child",
          },
        ],
      },
      WORKSPACE_ROLE_LEVELS.MODERATOR
    );

    const flushed = await flushPending(
      bucket,
      source.sql,
      TEST_WORKSPACE,
      NOW + 10
    );
    expect(flushed).toMatchObject({
      flushed: true,
      fromSeq: 2,
      toSeq: 3,
    });

    const manifest = await manifestOf(bucket);
    expect(manifest.baseSeq).toBe(1);
    expect(manifest.logSeq).toBe(3);

    const target = createSource();
    const result = (await recoverWorkspace(
      bucket as unknown as R2Bucket,
      recoveryExecutor(target.db, target.sql),
      TEST_WORKSPACE,
      { now: NOW + 20 }
    )) as Extract<RecoveryResult, { recovered: true }>;

    expect(result).toMatchObject({
      recovered: true,
      baseSeq: 1,
      logSeq: 3,
      replayed: 2,
    });

    expect(entityRows(target.db)).toEqual(entityRows(source.db));
    expect(
      scalar(target.db, `SELECT title FROM "documents" WHERE "id" = 'd1'`)
    ).toBe("Doc v2");
    expect(
      scalar(target.db, `SELECT name FROM "folders" WHERE "id" = 'f-new'`)
    ).toBe("New");
    expect(scalar(target.db, `SELECT COUNT(*) FROM "favorites"`)).toBe(0);

    expect(scalar(target.db, `SELECT high_water_seq FROM "_tx_state"`)).toBe(3);

    // The lines are written back into `_tx_log`, so idempotency keys survive
    // the cold start for as long as the segments are retained. Seq 2 and 3 are
    // replayed; seq 1 sits at the snapshot base and contributes only its key.
    expect(scalar(target.db, `SELECT COUNT(*) FROM "_tx_log"`)).toBe(3);
    expect(
      scalar(target.db, `SELECT GROUP_CONCAT(seq) FROM (SELECT seq FROM "_tx_log" ORDER BY seq)`)
    ).toBe("1,2,3");
    expect(scalar(target.db, `SELECT last_seq FROM "_flush_state"`)).toBe(3);
    expect(scalar(target.db, `SELECT base_seq FROM "_snapshot_state"`)).toBe(1);

    // Re-running the restore + replay over the same R2 contents converges on
    // the same rows.
    await recoverWorkspace(
      bucket as unknown as R2Bucket,
      recoveryExecutor(target.db, target.sql),
      TEST_WORKSPACE,
      { force: true, now: NOW + 30 }
    );
    expect(entityRows(target.db)).toEqual(entityRows(source.db));
  });

  test("keeps clientTxId dedupe across a cold start", async () => {
    const source = createSource();
    seedWorkspace(source);

    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);

    const ops = [
      {
        op: "update",
        namespace: "folders",
        id: "f-dedupe",
        values: { name: "Once" },
      },
    ];

    const first = run(source, { txId: "t1", clientTxId: "client-1", ops } as TxEnvelope);
    expect(first).toMatchObject({ applied: 1 });

    await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW + 10);

    // Cold start into an empty database: everything comes from R2.
    const target = createSource();
    await recoverWorkspace(
      bucket as unknown as R2Bucket,
      recoveryExecutor(target.db, target.sql),
      TEST_WORKSPACE,
      { now: NOW + 20 }
    );
    // Two keys: the seed at the snapshot base, and the transaction replayed
    // from the segment above it.
    expect(scalar(target.db, `SELECT COUNT(*) FROM "_tx_log"`)).toBe(2);

    // The client never saw the acknowledgement and retries after the eviction.
    const retry = run(target, {
      txId: "t2",
      clientTxId: "client-1",
      ops,
    } as TxEnvelope);
    expect(retry).toMatchObject({ applied: 0 });
    expect(scalar(target.db, `SELECT name FROM "folders" WHERE "id" = 'f-dedupe'`)).toBe(
      "Once"
    );

    // Reusing the key for different ops is still refused after recovery.
    expect(() =>
      run(target, {
        txId: "t3",
        clientTxId: "client-1",
        ops: [
          {
            op: "update",
            namespace: "folders",
            id: "f-dedupe",
            values: { name: "Changed" },
          },
        ],
      } as TxEnvelope)
    ).toThrow(/already used with different ops/);
  });

  test("keeps a key folded into a snapshot, using the retained segment", async () => {
    const source = createSource();
    seedWorkspace(source);

    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW); // baseline snapshot at seq 1

    const ops = [
      {
        op: "update",
        namespace: "folders",
        id: "f-folded",
        values: { name: "Folded" },
      },
    ];
    run(source, { txId: "s1", clientTxId: "client-snap", ops } as TxEnvelope);
    await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW + 10); // segment 2-2

    // A second snapshot folds seq 2 into the snapshot itself.
    await snapshotWorkspace(bucket, source.sql, TEST_WORKSPACE, NOW + 20);

    // The segment stays inside the idempotency horizon instead of being pruned.
    expect(
      [...bucket.objects.keys()].some((key) => key.endsWith("/log/2-2.ndjson"))
    ).toBe(true);

    const target = createSource();
    const result = (await recoverWorkspace(
      bucket as unknown as R2Bucket,
      recoveryExecutor(target.db, target.sql),
      TEST_WORKSPACE,
      { now: NOW + 30 }
    )) as Extract<RecoveryResult, { recovered: true }>;

    // Snapshot base moved past the transaction, so its rows came from the
    // snapshot and only its key came from the segment.
    expect(result.baseSeq).toBe(2);

    const retry = run(target, {
      txId: "s2",
      clientTxId: "client-snap",
      ops,
    } as TxEnvelope);
    expect(retry).toMatchObject({ applied: 0 });
  });

  test("is idempotent when recovery is repeated", async () => {
    const source = createSource();
    seedWorkspace(source);
    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);

    run(source, {
      txId: "after-snapshot",
      ops: [
        {
          op: "update",
          namespace: "folders",
          id: "f-new",
          values: { name: "New" },
        },
      ],
    });
    await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW + 10);

    const target = createSource();
    const sql = recoveryExecutor(target.db, target.sql);

    const first = (await recoverWorkspace(
      bucket as unknown as R2Bucket,
      sql,
      TEST_WORKSPACE,
      { now: NOW + 20 }
    )) as Extract<RecoveryResult, { recovered: true }>;
    expect(first.replayed).toBe(1);

    const afterFirst = entityRows(target.db);

    const skipped = await recoverWorkspace(
      bucket as unknown as R2Bucket,
      sql,
      TEST_WORKSPACE,
      { now: NOW + 21 }
    );
    expect(skipped).toEqual({
      recovered: false,
      reason: "already_populated",
    });
    expect(entityRows(target.db)).toEqual(afterFirst);

    const forced = (await recoverWorkspace(
      bucket as unknown as R2Bucket,
      sql,
      TEST_WORKSPACE,
      { force: true, now: NOW + 22 }
    )) as Extract<RecoveryResult, { recovered: true }>;
    expect(forced.recovered).toBe(true);
    expect(entityRows(target.db)).toEqual(afterFirst);
    expect(meta(target.db, "recovery_status")).toBe("complete");
  });

  test("fails closed on a checksum mismatch and records the failed marker", async () => {
    const source = createSource();
    seedWorkspace(source);
    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);

    const manifest = await manifestOf(bucket);
    const folders = manifest.tables.find((table) => table.name === "folders");
    expect(folders).toBeDefined();
    const chunk = folders!.chunks[0];
    await corruptChunk(bucket, chunk.key);

    const target = createSource();
    const error = await expectFailure(
      recoverWorkspace(
        bucket as unknown as R2Bucket,
        recoveryExecutor(target.db, target.sql),
        TEST_WORKSPACE,
        { now: NOW + 5 }
      ),
      /checksum/i
    );

    expect(error.message).toContain(chunk.key);
    expect(meta(target.db, "recovery_status")).toBe("failed");
    expect(meta(target.db, "recovery_error")).toContain("checksum");
    expect(meta(target.db, "recovery_completed_at")).toBeUndefined();

    // No partial boot: the caller can see the failure and retry; no success
    // marker was written.
    expect(meta(target.db, "recovery_base_seq")).toBeUndefined();
    expect(scalar(target.db, `SELECT COUNT(*) FROM "folders"`)).toBe(0);

    // The restore toggles foreign keys off and must turn them back on even
    // when it fails.
    const foreignKeys = target.db.query("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };
    expect(foreignKeys.foreign_keys).toBe(1);
  });

  test("a restore that fails after committing a chunk leaves no rows, so the next boot retries", async () => {
    const source = createSource();
    seedWorkspace(source);
    run(source, {
      txId: "attachment",
      ops: [
        {
          op: "update",
          namespace: "kanbanAttachments",
          id: "attachment1",
          values: {
            taskId: "task1",
            objectKey: "kanban/task1/attachment1",
            name: "photo.png",
            size: 8,
            contentType: "image/png",
          },
        },
      ],
    });
    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);

    const manifest = await manifestOf(bucket);
    // Corrupt a table restored after the first one, so at least one chunk is
    // committed before the restore fails.
    const later = manifest.tables.find((table) => table.name === "favorites");
    expect(later).toBeDefined();
    await corruptChunk(bucket, later!.chunks[0].key);

    const target = createSource();
    await expectFailure(
      recoverWorkspace(
        bucket as unknown as R2Bucket,
        recoveryExecutor(target.db, target.sql),
        TEST_WORKSPACE,
        { now: NOW + 5 }
      ),
      /checksum/i
    );

    // Nothing from the failed attempt may survive: a leftover row makes the
    // next boot report already_populated and serve an incomplete workspace.
    for (const table of namespaceTables()) {
      expect(scalar(target.db, `SELECT COUNT(*) FROM "${table}"`)).toBe(0);
    }

    // The retry must attempt the restore again rather than short-circuiting.
    const retry = await expectFailure(
      recoverWorkspace(
        bucket as unknown as R2Bucket,
        recoveryExecutor(target.db, target.sql),
        TEST_WORKSPACE,
        { now: NOW + 6 }
      ),
      /checksum/i
    );
    expect(retry.message).toContain(later!.chunks[0].key);
  });

  test("does not restore a workspace that legitimately emptied itself", async () => {
    const source = createSource();
    seedWorkspace(source);
    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);

    // Every row deleted through the pipeline: no entity rows are left, but the
    // workspace has committed transactions and must not be treated as wiped.
    for (const table of namespaceTables()) {
      source.sql.exec(`DELETE FROM "${table}"`);
    }
    const highWater = scalar(
      source.db,
      `SELECT high_water_seq FROM "_tx_state" WHERE "id" = 1`
    );
    expect(Number(highWater)).toBeGreaterThan(0);

    const result = await recoverWorkspace(
      bucket as unknown as R2Bucket,
      recoveryExecutor(source.db, source.sql),
      TEST_WORKSPACE,
      { now: NOW + 7 }
    );

    expect(result).toEqual({ recovered: false, reason: "already_populated" });
    expect(scalar(source.db, `SELECT COUNT(*) FROM "folders"`)).toBe(0);
    expect(
      scalar(source.db, `SELECT high_water_seq FROM "_tx_state" WHERE "id" = 1`)
    ).toBe(highWater);
  });

  test("replays a log segment that is durable in R2 when the manifest never advanced", async () => {
    const source = createSource();
    seedWorkspace(source);
    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);

    // Acknowledged delete that reaches R2 as a segment, whose manifest update
    // then loses the ETag race (crash between the segment PUT and the manifest
    // PUT). The segment is durable, so replay must not be bounded by the
    // manifest pointer alone.
    run(
      source,
      {
        txId: "delete-doc",
        ops: [{ op: "delete", namespace: "documents", id: "d1" }],
      },
      WORKSPACE_ROLE_LEVELS.MODERATOR
    );
    bucket.beforePut = (key: string) =>
      key.endsWith("/manifest.json") ? "conflict" : undefined;

    const flushed = await flushPending(
      bucket,
      source.sql,
      TEST_WORKSPACE,
      NOW + 1
    );
    expect(flushed.flushed).toBe(false);
    expect(
      [...bucket.objects.keys()].filter((key) => key.includes("/log/")).length
    ).toBeGreaterThan(0);

    const target = createSource();
    const result = (await recoverWorkspace(
      bucket as unknown as R2Bucket,
      recoveryExecutor(target.db, target.sql),
      TEST_WORKSPACE,
      { now: NOW + 2 }
    )) as Extract<RecoveryResult, { recovered: true }>;

    expect(result.recovered).toBe(true);
    expect(result.replayed).toBeGreaterThan(0);
    expect(
      scalar(target.db, `SELECT COUNT(*) FROM "documents" WHERE "id" = 'd1'`)
    ).toBe(0);
  });

  test("returns no_manifest without touching the database", async () => {
    const target = createSource();
    const result = await recoverWorkspace(
      new FakeR2Bucket() as unknown as R2Bucket,
      recoveryExecutor(target.db, target.sql),
      TEST_WORKSPACE,
      { now: NOW }
    );

    expect(result).toEqual({ recovered: false, reason: "no_manifest" });
    expect(meta(target.db, "recovery_status")).toBeUndefined();
    expect(scalar(target.db, `SELECT COUNT(*) FROM "folders"`)).toBe(0);
  });

  test("rejects a manifest table outside the registry", async () => {
    const source = createSource();
    seedWorkspace(source);
    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);

    const manifest = await manifestOf(bucket);
    const tampered = {
      ...manifest,
      tables: [
        ...manifest.tables,
        {
          name: "not_a_table",
          chunks: [],
        },
      ],
    };
    await bucket.put(manifestKey(TEST_WORKSPACE), JSON.stringify(tampered));

    const target = createSource();
    await expectFailure(
      recoverWorkspace(
        bucket as unknown as R2Bucket,
        recoveryExecutor(target.db, target.sql),
        TEST_WORKSPACE,
        { now: NOW }
      ),
      /unknown table/i
    );

    expect(scalar(target.db, `SELECT COUNT(*) FROM "folders"`)).toBe(0);
  });

  test("rejects a snapshot row with an unknown column", async () => {
    const source = createSource();
    seedWorkspace(source);
    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);

    const manifest = await manifestOf(bucket);
    await rewriteChunk(bucket, manifest, "folders", (rows) => {
      for (const row of rows) row.not_a_column = "x";
    });

    const target = createSource();
    await expectFailure(
      recoverWorkspace(
        bucket as unknown as R2Bucket,
        recoveryExecutor(target.db, target.sql),
        TEST_WORKSPACE,
        { now: NOW }
      ),
      /unknown column/i
    );

    expect(meta(target.db, "recovery_status")).toBe("failed");
    expect(scalar(target.db, `SELECT COUNT(*) FROM "folders"`)).toBe(0);
  });

  test("fails closed when the restored snapshot has a dangling foreign key", async () => {
    const source = createSource();
    seedWorkspace(source);
    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);

    const manifest = await manifestOf(bucket);
    await rewriteChunk(bucket, manifest, "documents", (rows) => {
      for (const row of rows) row.folder_id = "missing-folder";
    });

    const target = createSource();
    await expectFailure(
      recoverWorkspace(
        bucket as unknown as R2Bucket,
        recoveryExecutor(target.db, target.sql),
        TEST_WORKSPACE,
        { now: NOW }
      ),
      /foreign key check failed/i
    );

    expect(meta(target.db, "recovery_status")).toBe("failed");
  });
});

describe("file index across a restore", () => {
  function files(db: Database): Array<{ path: string; r2_key: string; size: number }> {
    return db
      .query(`SELECT "path", "r2_key", "size" FROM "_files" ORDER BY "path"`)
      .all() as Array<{ path: string; r2_key: string; size: number }>;
  }

  test("uploads and deletes after the snapshot survive a cold start", async () => {
    const source = createSource();
    seedWorkspace(source);
    const sql = txExecutor(source.db);

    recordFileEntry(sql, { path: "kept.png", key: "k/kept", size: 10, contentType: "image/png" });
    recordFileEntry(sql, { path: "doomed.png", key: "k/doomed", size: 20, contentType: null });

    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW); // snapshot holds kept + doomed

    // After the snapshot: one new upload, one overwrite, one delete.
    recordFileEntry(sql, { path: "late.pdf", key: "k/late", size: 30, contentType: "application/pdf" });
    recordFileEntry(sql, { path: "kept.png", key: "k/kept-v2", size: 11, contentType: "image/png" });
    expect(forgetFileEntry(sql, "doomed.png")).toBe(1);

    await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW + 10);

    const target = createSource();
    await recoverWorkspace(
      bucket as unknown as R2Bucket,
      recoveryExecutor(target.db, target.sql),
      TEST_WORKSPACE,
      { now: NOW + 20 }
    );

    expect(files(target.db)).toEqual([
      { path: "kept.png", r2_key: "k/kept-v2", size: 11 },
      { path: "late.pdf", r2_key: "k/late", size: 30 },
    ]);
    expect(files(target.db)).toEqual(files(source.db));

    // File entries take sequences, so a write after recovery cannot reuse one.
    const next = run(target, {
      txId: "after",
      ops: [{ op: "update", namespace: "folders", id: "f-after", values: { name: "After" } }],
    });
    expect(next.seq).toBe(Number(scalar(source.db, `SELECT MAX(seq) FROM "_tx_log"`)) + 1);
  });

  test("forgetting a path that is not indexed burns no sequence", () => {
    const source = createSource();
    seedWorkspace(source);
    const before = scalar(source.db, `SELECT high_water_seq FROM "_tx_state"`);
    expect(forgetFileEntry(txExecutor(source.db), "never.png")).toBe(0);
    expect(scalar(source.db, `SELECT high_water_seq FROM "_tx_state"`)).toBe(before);
  });

  test("a client cannot forge a file op through a transaction", () => {
    const source = createSource();
    expect(() =>
      run(source, {
        txId: "forged",
        ops: [{ op: "file:put", id: "x", path: "evil", key: "k", size: 1, contentType: null }],
      } as unknown as TxEnvelope)
    ).toThrow(/Op kind is not recognised/);
  });
});

describe("retries the restore cannot vouch for", () => {
  const ops = [
    { op: "update", namespace: "folders", id: "f-retry", values: { name: "Once" } },
  ];

  /**
   * Seq 1 seed, seq 2 the client's write, both folded into a snapshot at base
   * 2. Optionally prunes the segment that held seq 2's key, which is what
   * happens once it falls outside DEDUPE_HORIZON_SEQ.
   */
  async function restored(pruneKeySegment: boolean): Promise<Source> {
    const source = createSource();
    seedWorkspace(source);
    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);

    run(source, { txId: "w1", clientTxId: "client-r", ops } as TxEnvelope);
    await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW + 10);
    await snapshotWorkspace(bucket, source.sql, TEST_WORKSPACE, NOW + 20);

    if (pruneKeySegment) {
      for (const key of [...bucket.objects.keys()]) {
        if (key.includes("/log/")) bucket.objects.delete(key);
      }
    }

    const target = createSource();
    await recoverWorkspace(
      bucket as unknown as R2Bucket,
      recoveryExecutor(target.db, target.sql),
      TEST_WORKSPACE,
      { now: NOW + 30 }
    );
    return target;
  }

  test("a restore that kept every key records no floor and dedupes", async () => {
    const target = await restored(false);
    expect(scalar(target.db, `SELECT value FROM "_engine_meta" WHERE "key" = 'dedupe_floor_seq'`)).toBe("0");
    const retry = run(target, { txId: "w2", clientTxId: "client-r", basisSeq: 1, ops } as TxEnvelope);
    expect(retry).toMatchObject({ seq: 2, applied: 0 });
  });

  test("a retry from below the floor is refused, not applied twice", async () => {
    const target = await restored(true);
    expect(scalar(target.db, `SELECT value FROM "_engine_meta" WHERE "key" = 'dedupe_floor_seq'`)).toBe("2");

    // The client created the write after seeing seq 1. Its key is gone, so the
    // server cannot tell whether seq 2 was this write.
    expect(() =>
      run(target, { txId: "w2", clientTxId: "client-r", basisSeq: 1, ops } as TxEnvelope)
    ).toThrow(/may already be applied/);
    expect(scalar(target.db, `SELECT high_water_seq FROM "_tx_state"`)).toBe(2);

    // Negative control: without a basis the engine cannot know, and the retry
    // is applied a second time. This is what basisSeq prevents.
    const blind = run(target, { txId: "w3", clientTxId: "client-r", ops } as TxEnvelope);
    expect(blind).toMatchObject({ seq: 3, applied: 1 });
  });

  test("a retry whose basis is at or above the floor is answered normally", async () => {
    const target = await restored(true);

    // Created after the client saw seq 2: any earlier attempt would sit above
    // the floor, where every key is known, so an unknown key means unapplied.
    const fresh = [
      { op: "update", namespace: "folders", id: "f-new", values: { name: "New" } },
    ];
    const first = run(target, { txId: "n1", clientTxId: "client-new", basisSeq: 2, ops: fresh } as TxEnvelope);
    expect(first).toMatchObject({ seq: 3, applied: 1 });
    const again = run(target, { txId: "n2", clientTxId: "client-new", basisSeq: 2, ops: fresh } as TxEnvelope);
    expect(again).toMatchObject({ seq: 3, applied: 0 });
  });

  test("basisSeq is validated", () => {
    const source = createSource();
    expect(() =>
      run(source, { txId: "v1", clientTxId: "c", basisSeq: -1, ops } as TxEnvelope)
    ).toThrow(/basisSeq must be a non-negative integer/);
    expect(() =>
      run(source, { txId: "v2", basisSeq: 1, ops } as TxEnvelope)
    ).toThrow(/only meaningful with a clientTxId/);
  });
});

describe("strict ops through a restore", () => {
  test("insert and patch replay from segments, and a forced recovery converges", async () => {
    const source = createSource();
    seedWorkspace(source);
    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);

    run(source, { txId: "i1", ops: [{ op: "insert", namespace: "folders", id: "f-strict", values: { name: "Made" } }] } as unknown as TxEnvelope);
    run(source, { txId: "p1", ops: [{ op: "patch", namespace: "folders", id: "f-strict", values: { name: "Renamed" } }] } as unknown as TxEnvelope);
    await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW + 10);

    const target = createSource();
    const exec = recoveryExecutor(target.db, target.sql);
    await recoverWorkspace(bucket as unknown as R2Bucket, exec, TEST_WORKSPACE, { now: NOW + 20 });
    expect(scalar(target.db, `SELECT name FROM "folders" WHERE "id" = 'f-strict'`)).toBe("Renamed");

    // A forced re-run restores over the same rows and must land identically.
    await recoverWorkspace(bucket as unknown as R2Bucket, exec, TEST_WORKSPACE, { force: true, now: NOW + 30 });
    expect(scalar(target.db, `SELECT name FROM "folders" WHERE "id" = 'f-strict'`)).toBe("Renamed");
    expect(entityRows(target.db)).toEqual(entityRows(source.db));
  });
});

describe("the file index in snapshots", () => {
  async function uploadedBeforeSnapshot() {
    const source = createSource();
    seedWorkspace(source);
    recordFileEntry(txExecutor(source.db), { path: "old.png", key: "k/old", size: 5, contentType: null });
    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW); // the file entry is at or below the base
    return { source, bucket };
  }

  async function restoredPaths(bucket: FakeR2Bucket): Promise<unknown[]> {
    const target = createSource();
    await recoverWorkspace(bucket as unknown as R2Bucket, recoveryExecutor(target.db, target.sql), TEST_WORKSPACE, { now: NOW + 10 });
    return target.db.query(`SELECT "path" FROM "_files"`).all();
  }

  test("a file uploaded before the snapshot survives a restore", async () => {
    const { bucket } = await uploadedBeforeSnapshot();
    const manifest = JSON.parse(new TextDecoder().decode(bucket.bodyOf(manifestKey(TEST_WORKSPACE))!));
    expect(manifest.tables.map((table: { name: string }) => table.name)).toContain("_files");

    // Without the snapshot the segment would be the only copy; drop it.
    for (const key of [...bucket.objects.keys()]) if (key.includes("/log/")) bucket.objects.delete(key);
    expect(await restoredPaths(bucket)).toEqual([{ path: "old.png" }]);
  });

  test("an older snapshot without the index is filled from retained segments", async () => {
    const { bucket } = await uploadedBeforeSnapshot();
    // Rewrite the manifest the way an older engine wrote it: no _files table.
    const key = manifestKey(TEST_WORKSPACE);
    const manifest = JSON.parse(new TextDecoder().decode(bucket.bodyOf(key)!));
    manifest.tables = manifest.tables.filter((table: { name: string }) => table.name !== "_files");
    bucket.seed(key, JSON.stringify(manifest));

    expect(await restoredPaths(bucket)).toEqual([{ path: "old.png" }]);
  });
});
