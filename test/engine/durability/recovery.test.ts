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

  for (const table of [...namespaceTables(), "$files"]) {
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
    expect(manifest.tables.map((table) => table.name)).toEqual(
      namespaceTables()
    );

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
      tables: namespaceTables().length,
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
