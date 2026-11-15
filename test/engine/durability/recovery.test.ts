import { useLegacyFixture } from "../../fixtures/registry";
useLegacyFixture();

import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../../../src/claims";
import { logOpsKey, manifestKey, readManifest } from "../../../src/engine/r2-keys";
import { setLogPartBytesForTests } from "../../../src/engine/tx-log";
import { namespaceTables } from "../../fixtures/registry";
import { appendLogEntry, runTransaction } from "../../../src/engine/tx-pipeline";
import { LogWriter } from "../../../src/engine/tx-log";
import { configureAudit, rowHistory, syncAuditCapture } from "../../../src/engine/audit";
import type { SqlRow as TxRow, SqlExecutor as TxSql } from "../../../src/engine/tx-sql";
import type { TxEnvelope } from "../../../src/engine/tx-types";
import { flushPending } from "../../../src/engine/durability/flusher";
import {
  recoverWorkspace,
  type RecoveryResult,
  type RecoverySqlExecutor,
} from "../../../src/engine/durability/recovery";
import { pruneHistory, pruneCoveredLogSegments, snapshotWorkspace, trimLocalLog } from "../../../src/engine/durability/snapshot";
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
      "_files", "_tx_receipts",
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
      tables: namespaceTables().length + 2, // models, file index, and transaction receipts
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

  test("a large entry is restored a part per step, and no step repeats finished lines or parts", async () => {
    setLogPartBytesForTests(20_000);
    try {
      const source = createSource();
      seedWorkspace(source);
      const bucket = new FakeR2Bucket();
      await publish(source, bucket, NOW);
      run(source, {
        txId: "many",
        ops: Array.from({ length: 3000 }, (_, index) => ({
          op: "update",
          namespace: "folders",
          id: `bulk-${String(index).padStart(5, "0")}`,
          values: { name: `F${index}` },
        })),
      });
      // Two large entries in the same segment.
      for (const [txId, color] of [["green", "green"], ["blue", "blue"]]) {
        run(source, { txId, ops: [{ op: "patchMany", namespace: "folders", where: { name: { $ne: "keep" } }, values: { color } }] } as TxEnvelope, WORKSPACE_ROLE_LEVELS.MODERATOR);
      }
      await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW + 10);
      const parts = Number(scalar(source.db, `SELECT COUNT(*) FROM "_tx_log_parts"`));
      expect(parts).toBeGreaterThan(4);

      // Every call stops at the first chance: one unit per call.
      const target = createSource();
      const executor = recoveryExecutor(target.db, target.sql);
      let calls = 0;
      let sawPartial = false;
      for (;;) {
        calls += 1;
        expect(calls).toBeLessThan(200);
        const result = await recoverWorkspace(bucket as unknown as R2Bucket, executor, TEST_WORKSPACE, { now: NOW + 20, shouldPause: () => true });
        if (result.recovered) break;
        const green = Number(scalar(target.db, `SELECT COUNT(*) FROM "folders" WHERE "color" = 'green'`));
        if (green > 0 && green < 3000) sawPartial = true;
      }
      // The first entry was stopped between its parts at least once.
      expect(sawPartial).toBe(true);
      // Units: snapshot chunks, segments, parts. Repeating finished lines or
      // parts would take more calls (or never finish).
      const chunks = (await manifestOf(bucket)).tables.reduce((sum, table) => sum + table.chunks.length, 0);
      const segments = [...bucket.objects.keys()].filter((key) => /\/log\/\d+-\d+\.ndjson$/.test(key)).length;
      const entries = Number(scalar(source.db, `SELECT COUNT(DISTINCT seq) FROM "_tx_log_parts"`));
      expect(calls).toBeLessThanOrEqual(chunks + segments + entries + parts + 2);
      expect(entityRows(target.db)).toEqual(entityRows(source.db));
    } finally {
      setLogPartBytesForTests(null);
    }
  });

  test("each entry stored in parts is its own unit, also below the snapshot", async () => {
    setLogPartBytesForTests(20_000);
    try {
      const source = createSource();
      seedWorkspace(source);
      for (let entry = 0; entry < 4; entry += 1) {
        run(source, {
          txId: `parted-${entry}`,
          ops: Array.from({ length: 400 }, (_, index) => ({
            op: "update",
            namespace: "folders",
            id: `parted-${entry}-${index}`,
            values: { name: `F${index}` },
          })),
        });
      }
      const bucket = new FakeR2Bucket();
      // The entries are folded into the snapshot: restoring only records them.
      await publish(source, bucket, NOW);
      const entries = Number(scalar(source.db, `SELECT COUNT(DISTINCT seq) FROM "_tx_log_parts"`));
      expect(entries).toBe(4);

      const target = createSource();
      const executor = recoveryExecutor(target.db, target.sql);
      const units: string[] = [];
      let stoppedBetween = false;
      for (let calls = 0; ; calls += 1) {
        expect(calls).toBeLessThan(200);
        const result = await recoverWorkspace(bucket as unknown as R2Bucket, executor, TEST_WORKSPACE, {
          now: NOW + 20,
          shouldPause: () => true,
          onUnit: (unit) => units.push(unit),
        });
        if (result.recovered) break;
        const recorded = Number(scalar(target.db, `SELECT COUNT(DISTINCT seq) FROM "_tx_log_parts"`));
        if (recorded > 0 && recorded < entries) stoppedBetween = true;
      }
      expect(stoppedBetween).toBe(true);
      expect(units.filter((unit) => /^entry \d+$/.test(unit)).length).toBeGreaterThanOrEqual(entries - 1);
      expect(entityRows(target.db)).toEqual(entityRows(source.db));
    } finally {
      setLogPartBytesForTests(null);
    }
  });

  test("entries that write whole rows share one foreign-key switch and check, and none below the base", async () => {
    const source = createSource();
    seedWorkspace(source);
    // Whole-row entries, as personal-field writes and imports log them.
    const rowEntry = (index: number) => {
      const row = { id: `whole-${index}`, name: `W${index}`, created_at: 1, updated_at: 1 };
      return source.db.transaction(() => {
        const seq = appendLogEntry(txExecutor(source.db), {
          clientTxId: `whole-${index}`,
          ops: JSON.stringify([{ op: "state:begin" }, { op: "state:row", table: "folders", row: { ...row, updated_seq: 0 } }, { op: "state:end" }]),
          opsHash: `hash-${index}`,
          at: NOW,
        });
        source.db.query(`INSERT INTO "folders" (id, name, created_at, updated_at, updated_seq) VALUES (?, ?, 1, 1, ?)`).run(row.id, row.name, seq);
        // The logged row carries the seq it was written at.
        source.db.query(`UPDATE "_tx_log" SET ops = replace(ops, '"updated_seq":0', '"updated_seq":' || seq) WHERE seq = ?`).run(seq);
        return seq;
      })();
    };
    for (let index = 0; index < 20; index += 1) rowEntry(index);
    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW); // these 20 are below the base
    for (let index = 20; index < 50; index += 1) rowEntry(index);
    await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW + 10);

    const target = createSource();
    const base = recoveryExecutor(target.db, target.sql);
    let switches = 0;
    let checks = 0;
    const counting: RecoverySqlExecutor = {
      ...base,
      exec(query, ...bindings) {
        if (/PRAGMA foreign_keys = OFF/.test(query)) switches += 1;
        if (/PRAGMA foreign_key_check/.test(query)) checks += 1;
        return base.exec(query, ...bindings);
      },
    };
    const result = await recoverWorkspace(bucket as unknown as R2Bucket, counting, TEST_WORKSPACE, { now: NOW + 20 });
    expect(result.recovered).toBe(true);
    expect(entityRows(target.db)).toEqual(entityRows(source.db));
    expect(Number(scalar(target.db, `SELECT COUNT(*) FROM "_tx_log" WHERE client_tx_id LIKE 'whole-%'`))).toBe(50);
    // One run of 30 above the base: one switch for it (plus the snapshot
    // restore's own), not one per entry.
    expect(switches).toBeLessThanOrEqual(2);
    expect(checks).toBeLessThanOrEqual(3);
  });

  test("a whole-row entry in parts is applied a part per step too, checked once at its end", async () => {
    const source = createSource();
    seedWorkspace(source);
    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);
    // One entry of 300 whole rows, written as personal-field writes are, in parts.
    source.db.transaction(() => {
      const sql = txExecutor(source.db);
      const seq = appendLogEntry(sql, { clientTxId: "whole-entry", ops: "[]", opsHash: "hash-whole", at: NOW });
      const log = new LogWriter(sql, seq, 4_000);
      log.push({ op: "state:begin" });
      for (let index = 0; index < 300; index += 1) {
        const row = { id: `whole-${index}`, name: `W${index}`, created_at: 1, updated_at: 1, updated_seq: seq };
        source.db.query(`INSERT INTO "folders" (id, name, created_at, updated_at, updated_seq) VALUES (?, ?, 1, 1, ?)`).run(row.id, row.name, seq);
        log.push({ op: "state:row", table: "folders", row });
      }
      log.push({ op: "state:end" });
      log.close();
    })();
    await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW + 10);
    const parts = 1 + Number(scalar(source.db, `SELECT COUNT(*) FROM "_tx_log_parts"`));
    expect(parts).toBeGreaterThan(5);

    const target = createSource();
    const base = recoveryExecutor(target.db, target.sql);
    let checks = 0;
    const counting: RecoverySqlExecutor = {
      ...base,
      exec(query, ...bindings) {
        if (/PRAGMA foreign_key_check/.test(query)) checks += 1;
        return base.exec(query, ...bindings);
      },
    };
    let stoppedInside = false;
    for (let calls = 0; ; calls += 1) {
      expect(calls).toBeLessThan(200);
      const result = await recoverWorkspace(bucket as unknown as R2Bucket, counting, TEST_WORKSPACE, { now: NOW + 20, shouldPause: () => true });
      if (result.recovered) break;
      const restored = Number(scalar(target.db, `SELECT COUNT(*) FROM "folders" WHERE id LIKE 'whole-%'`));
      if (restored > 0 && restored < 300) stoppedInside = true;
      // Foreign keys are on whenever a step has stopped.
      expect(target.db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    }
    expect(stoppedInside).toBe(true);
    expect(checks).toBeLessThanOrEqual(2); // the snapshot's, and this entry's
    expect(entityRows(target.db)).toEqual(entityRows(source.db));
  });

  test("replays a bulk write stored in parts, a part at a time", async () => {
    setLogPartBytesForTests(20_000);
    try {
      const source = createSource();
      seedWorkspace(source);
      const bucket = new FakeR2Bucket();
      await publish(source, bucket, NOW);

      run(source, {
        txId: "many",
        ops: Array.from({ length: 3000 }, (_, index) => ({
          op: "update",
          namespace: "folders",
          id: `bulk-${String(index).padStart(5, "0")}`,
          values: { name: `F${index}` },
        })),
      });
      const bulk = run(
        source,
        { txId: "bulk", clientTxId: "bulk-1", ops: [{ op: "patchMany", namespace: "folders", where: { name: { $ne: "keep" } }, values: { color: "green" } }] } as TxEnvelope,
        WORKSPACE_ROLE_LEVELS.MODERATOR
      );
      expect(Number(scalar(source.db, `SELECT COUNT(*) FROM "folders" WHERE "color" = 'green'`))).toBeGreaterThanOrEqual(3000);
      expect(scalar(source.db, `SELECT COUNT(*) FROM "_tx_log_parts" WHERE seq = ${bulk.seq}`)).toBeGreaterThan(0);

      await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW + 10);
      const opsKey = logOpsKey(TEST_WORKSPACE, bulk.seq);
      expect(bucket.objects.has(opsKey)).toBe(true);
      expect(bucket.multipartUploads).toBeGreaterThan(0);

      const target = createSource();
      await recoverWorkspace(bucket as unknown as R2Bucket, recoveryExecutor(target.db, target.sql), TEST_WORKSPACE, { now: NOW + 20 });
      expect(entityRows(target.db)).toEqual(entityRows(source.db));
      expect(scalar(target.db, `SELECT COUNT(*) FROM "folders" WHERE "color" = 'green'`)).toBe(
        scalar(source.db, `SELECT COUNT(*) FROM "folders" WHERE "color" = 'green'`)
      );
      // The local log holds the same parts, so a re-flush from here is faithful.
      for (const query of [`SELECT ops FROM "_tx_log" WHERE seq = ${bulk.seq}`, `SELECT GROUP_CONCAT(ops, '|') FROM (SELECT ops FROM "_tx_log_parts" WHERE seq = ${bulk.seq} ORDER BY part)`]) {
        expect(scalar(target.db, query)).toBe(scalar(source.db, query));
      }
      // The retry is still recognised.
      expect(run(target, { txId: "again", clientTxId: "bulk-1", ops: [{ op: "patchMany", namespace: "folders", where: { name: { $ne: "keep" } }, values: { color: "green" } }] } as TxEnvelope, WORKSPACE_ROLE_LEVELS.MODERATOR)).toMatchObject({ applied: 0 });

      // A snapshot past it lets pruning remove the ops object with its segment.
      await snapshotWorkspace(bucket, source.sql, TEST_WORKSPACE, NOW + 30);
      await pruneCoveredLogSegments(bucket as unknown as R2Bucket, TEST_WORKSPACE, bulk.seq + 10, { retainLogSequences: 0 });
      expect(bucket.objects.has(opsKey)).toBe(false);
    } finally {
      setLogPartBytesForTests(null);
    }
  });

  test("uploads a log over 25 MB in equal parts, measured in bytes", async () => {
    // R2 refuses a multipart upload whose parts (but the last) differ in size.
    // Multibyte text makes string length and byte length disagree.
    const source = createSource();
    seedWorkspace(source);
    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);

    const name = "é".repeat(15_000) + "x".repeat(7_777);
    const big = run(source, {
      txId: "big",
      ops: Array.from({ length: 800 }, (_, index) => ({
        op: "update",
        namespace: "folders",
        id: `big-${String(index).padStart(4, "0")}`,
        values: { name: `${index}${name}` },
      })),
    });
    const flushed = await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW + 10);
    expect(flushed.error).toBeUndefined();
    expect(bucket.objects.has(logOpsKey(TEST_WORKSPACE, big.seq))).toBe(true);
    expect((bucket.objects.get(logOpsKey(TEST_WORKSPACE, big.seq)) as { body: Uint8Array }).body.byteLength).toBeGreaterThan(25 * 1024 * 1024);
    expect(bucket.multipartUploads).toBeGreaterThan(0);

    const target = createSource();
    await recoverWorkspace(bucket as unknown as R2Bucket, recoveryExecutor(target.db, target.sql), TEST_WORKSPACE, { now: NOW + 20 });
    expect(entityRows(target.db)).toEqual(entityRows(source.db));
    // Writes, uploads and replays over 25 MB: about 3 s here, 7 s on the CI
    // builder, past bun's 5 s default.
  }, 60_000);

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

  test("rows a failed run left behind are not served: the next run starts over", async () => {
    const source = createSource();
    seedWorkspace(source);
    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);
    const manifest = await manifestOf(bucket);
    const folders = manifest.tables.find((table) => table.name === "folders")!;
    const good = new Uint8Array(bucket.objects.get(folders.chunks[0].key)!.body);
    await corruptChunk(bucket, folders.chunks[0].key);

    const target = createSource();
    const executor = recoveryExecutor(target.db, target.sql);
    await expectFailure(recoverWorkspace(bucket as unknown as R2Bucket, executor, TEST_WORKSPACE, { now: NOW + 5 }), /checksum/i);
    // A failed run whose cleanup did not finish: some restored rows remain.
    target.db.exec(`INSERT INTO "folders" (id, name, created_at, updated_at, updated_seq) VALUES ('left-behind', 'X', 1, 1, 1)`);

    bucket.objects.get(folders.chunks[0].key)!.body = good;
    const second = await recoverWorkspace(bucket as unknown as R2Bucket, executor, TEST_WORKSPACE, { now: NOW + 6 });
    expect(second.recovered).toBe(true);
    expect(entityRows(target.db)).toEqual(entityRows(source.db));
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
  function files(db: Database): Array<{ path: string; r2_key: string; size: number; uploaded_by?: string | null }> {
    return db
      .query(`SELECT "path", "r2_key", "size", "uploaded_by" FROM "_files" ORDER BY "path"`)
      .all() as Array<{ path: string; r2_key: string; size: number; uploaded_by?: string | null }>;
  }

  test("uploads and deletes after the snapshot survive a cold start", async () => {
    const source = createSource();
    seedWorkspace(source);
    const sql = txExecutor(source.db);

    recordFileEntry(sql, { path: "kept.png", key: "k/kept", size: 10, contentType: "image/png", uploadedBy: "alice" });
    recordFileEntry(sql, { path: "doomed.png", key: "k/doomed", size: 20, contentType: null });

    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW); // snapshot holds kept + doomed

    // After the snapshot: one new upload, one overwrite, one delete.
    recordFileEntry(sql, { path: "late.pdf", key: "k/late", size: 30, contentType: "application/pdf", uploadedBy: "bob" });
    recordFileEntry(sql, { path: "kept.png", key: "k/kept-v2", size: 11, contentType: "image/png", uploadedBy: "carol" });
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
      { path: "kept.png", r2_key: "k/kept-v2", size: 11, uploaded_by: "carol" },
      { path: "late.pdf", r2_key: "k/late", size: 30, uploaded_by: "bob" },
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

describe("transaction receipts through a restore", () => {
  const ops = [
    { op: "update", namespace: "folders", id: "f-retry", values: { name: "Once" } },
  ];

  /** Seq 1 seed, seq 2 the client's write, both folded into a snapshot at base 2. */
  async function restored(): Promise<Source> {
    const source = createSource();
    seedWorkspace(source);
    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);

    run(source, { txId: "w1", clientTxId: "client-r", ops } as TxEnvelope);
    await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW + 10);
    await snapshotWorkspace(bucket, source.sql, TEST_WORKSPACE, NOW + 20);

    const target = createSource();
    await recoverWorkspace(
      bucket as unknown as R2Bucket,
      recoveryExecutor(target.db, target.sql),
      TEST_WORKSPACE,
      { now: NOW + 30 }
    );
    return target;
  }

  test("a restore keeps every receipt, so a retry of a write in the snapshot is answered, not applied", async () => {
    const target = await restored();
    const retry = run(target, { txId: "w2", clientTxId: "client-r", ops } as TxEnvelope);
    expect(retry).toMatchObject({ seq: 2, applied: 0 });
  });

  test("a snapshot from before receipts still restores, and says what it could not carry", async () => {
    const source = createSource();
    seedWorkspace(source);
    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);
    run(source, { txId: "w1", clientTxId: "client-r", ops } as TxEnvelope);
    await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW + 10);
    await snapshotWorkspace(bucket, source.sql, TEST_WORKSPACE, NOW + 20);
    const key = manifestKey(TEST_WORKSPACE);
    const manifest = JSON.parse(new TextDecoder().decode(bucket.bodyOf(key)!));
    manifest.dedupeFloorSeq = 0;
    manifest.tables = manifest.tables.filter((table: { name: string }) => table.name !== "_tx_receipts");
    bucket.seed(key, JSON.stringify(manifest));
    // And the log that would have carried client-r's receipt has been pruned.
    for (const logKey of [...bucket.objects.keys()].filter((k) => k.includes("/log/"))) bucket.objects.delete(logKey);

    const target = createSource();
    const restoredAt = Date.now();
    // A floor an older engine wrote is cleared, not obeyed.
    target.db.exec(`INSERT OR REPLACE INTO "_engine_meta" ("key", value) VALUES ('dedupe_floor_seq', '9')`);
    const result = await recoverWorkspace(
      bucket as unknown as R2Bucket,
      recoveryExecutor(target.db, target.sql),
      TEST_WORKSPACE,
      { now: restoredAt, force: true }
    );
    expect(result).toMatchObject({ recovered: true, baseSeq: 2 });
    expect((result as { warnings?: string[] }).warnings?.[0]).toMatch(/refused as retry_expired/);
    expect(scalar(target.db, `SELECT COUNT(*) FROM "_engine_meta" WHERE "key" = 'dedupe_floor_seq'`)).toBe(0);

    // client-r is in the snapshot but its receipt is not: a retry issued
    // before the restore is refused, not applied twice.
    expect(() => run(target, { txId: "w1-retry", clientTxId: "client-r", issuedAt: restoredAt - 60_000, ops } as TxEnvelope)).toThrow(/issued before/);
    expect(scalar(target.db, `SELECT COUNT(*) FROM "_tx_log"`)).toBe(0);

    // New writes are deduped as always.
    const fresh = [{ op: "update", namespace: "folders", id: "f-new", values: { name: "New" } }];
    expect(run(target, { txId: "n1", clientTxId: "client-new", issuedAt: restoredAt + 1, ops: fresh } as TxEnvelope)).toMatchObject({ seq: 3, applied: 1 });
    expect(run(target, { txId: "n2", clientTxId: "client-new", issuedAt: restoredAt + 1, ops: fresh } as TxEnvelope)).toMatchObject({ seq: 3, applied: 0 });
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

describe("the local log is bounded", () => {
  const write = (source: Source, n: number) =>
    run(source, {
      txId: `t${n}`,
      clientTxId: `c${n}`,
      ops: [{ op: "update", namespace: "folders", id: `f${n}`, values: { name: `F${n}` } }],
    } as TxEnvelope);

  test("trimming replay rows keeps durable transaction receipts", async () => {
    const source = createSource();
    seedWorkspace(source); // seq 1
    for (let n = 2; n <= 10; n += 1) write(source, n);
    const bucket = new FakeR2Bucket();
    await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW);
    await snapshotWorkspace(bucket, source.sql, TEST_WORKSPACE, NOW, { retainLogSequences: 3 });

    // base 10, horizon 3: rows 1..7 go, 8..10 stay.
    expect(scalar(source.db, `SELECT GROUP_CONCAT(seq) FROM (SELECT seq FROM "_tx_log" ORDER BY seq)`)).toBe("8,9,10");
    expect(scalar(source.db, `SELECT COUNT(*) FROM "_tx_receipts"`)).toBe(9);
    expect(run(source, { txId: "r", clientTxId: "c4", ops: [{ op: "update", namespace: "folders", id: "f4", values: { name: "F4" } }] } as TxEnvelope)).toMatchObject({seq: 4, applied: 0});
    // ...one above it is still deduped, and new writes continue the sequence.
    expect(run(source, { txId: "r2", clientTxId: "c9", ops: [{ op: "update", namespace: "folders", id: "f9", values: { name: "F9" } }] } as TxEnvelope)).toMatchObject({ seq: 9, applied: 0 });
    expect(write(source, 11).seq).toBe(11);
  });

  test("never trims a row that has not reached R2", () => {
    const source = createSource();
    seedWorkspace(source);
    for (let n = 2; n <= 10; n += 1) write(source, n);
    source.db.exec(`UPDATE "_flush_state" SET last_seq = 4 WHERE id = 1`);

    // A snapshot base of 10 alone would allow cutting to 7; flushed is 4.
    trimLocalLog(source.sql, 10, { retainLogSequences: 3 });
    expect(scalar(source.db, `SELECT MIN(seq) FROM "_tx_log"`)).toBe(2);
    expect(scalar(source.db, `SELECT COUNT(*) FROM "_tx_log"`)).toBe(9);
  });
});

describe("bulk writes through a restore", () => {
  test("replay changes the rows the original changed, not the ones the filter matches now", async () => {
    const source = createSource();
    seedWorkspace(source);
    const sql = txExecutor(source.db);
    void sql;

    // Snapshot first, so everything below is rebuilt by replaying the log
    // rather than restored from the snapshot.
    const snapshotBucket = new FakeR2Bucket();
    await flushPending(snapshotBucket, source.sql, TEST_WORKSPACE, NOW);
    await snapshotWorkspace(snapshotBucket, source.sql, TEST_WORKSPACE, NOW);

    // Three folders named "Batch", bulk-renamed, then a fourth added with the
    // old name afterwards. Re-running the filter during a replay would catch
    // the fourth as well; replaying the resolved rows cannot.
    run(source, {
      txId: "mk",
      ops: ["p1", "p2", "p3"].map((id) => ({ op: "insert", namespace: "folders", id, values: { name: "Batch" } })),
    } as unknown as TxEnvelope);
    run(source, {
      txId: "bulk",
      ops: [{ op: "patchMany", namespace: "folders", where: { name: "Batch" }, values: { name: "Renamed" } }],
    } as unknown as TxEnvelope);
    run(source, {
      txId: "after",
      ops: [{ op: "insert", namespace: "folders", id: "p4", values: { name: "Batch" } }],
    } as unknown as TxEnvelope);

    const bucket = snapshotBucket;
    await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW + 5);
    const target = createSource();
    await recoverWorkspace(bucket as unknown as R2Bucket, recoveryExecutor(target.db, target.sql), TEST_WORKSPACE, {
      now: NOW + 10,
    });

    expect(entityRows(target.db)).toEqual(entityRows(source.db));
    expect(
      target.db.query(`SELECT "id" FROM "folders" WHERE "name" = 'Batch' ORDER BY "id"`).all()
    ).toEqual([{ id: "p4" }]);
  });

  test("a retry of a bulk write is still deduped after a restore", async () => {
    const source = createSource();
    seedWorkspace(source);
    run(source, {
      txId: "mk",
      ops: [{ op: "insert", namespace: "folders", id: "q1", values: { name: "Batch" } }],
    } as unknown as TxEnvelope);

    const envelope = {
      txId: "bulk",
      clientTxId: "client-bulk",
      ops: [{ op: "patchMany", namespace: "folders", where: { name: "Batch" }, values: { name: "Renamed" } }],
    } as unknown as TxEnvelope;
    run(source, envelope);

    const bucket = new FakeR2Bucket();
    await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW);

    const target = createSource();
    await recoverWorkspace(bucket as unknown as R2Bucket, recoveryExecutor(target.db, target.sql), TEST_WORKSPACE, {
      now: NOW + 10,
    });

    // The log holds the resolved rows, whose hash is not the hash of what the
    // client sent; the segment carries the client's hash so this still matches.
    const retry = run(target, { ...envelope, txId: "retry" });
    expect(retry).toMatchObject({ applied: 0 });
  });
});


describe("durable transaction receipts", () => {
  test("a 400-day retry stays deduplicated with a null hash through pruning and two restores", async () => {
    const day = 86_400_000;
    const start = Date.now();
    const bucket = new FakeR2Bucket();
    let source = createSource();
    const tx = { txId: "original", clientTxId: "permanent", issuedAt: start, ops: [
      { op: "update", namespace: "folders", id: "permanent-folder", values: { name: "Original" } },
    ] } as TxEnvelope;
    expect(run(source, tx)).toMatchObject({ seq: 1, applied: 1 });
    source.db.exec(`UPDATE "_tx_log" SET at = ?`, start);
    source.db.exec(`UPDATE "_tx_receipts" SET at = ?`, start);
    run(source, { txId: "later", ops: [{ op: "update", namespace: "folders", id: "permanent-folder", values: { name: "Latest" } }] } as TxEnvelope);
    bucket.clock = start;
    await flushPending(bucket, source.sql, TEST_WORKSPACE, start);
    await snapshotWorkspace(bucket, source.sql, TEST_WORKSPACE, start, { retainLogSequences: 0 });
    await pruneHistory(bucket, source.sql, TEST_WORKSPACE, start + 16 * day);
    expect(source.db.query(`SELECT id, seq, ops_hash, at FROM "_tx_receipts"`).all()).toEqual([
      { id: "permanent", seq: 1, ops_hash: null, at: start },
    ]);
    for (let generation = 0; generation < 2; generation++) {
      const now = start + (400 + generation) * day;
      bucket.clock = now;
      await snapshotWorkspace(bucket, source.sql, TEST_WORKSPACE, now, { retainLogSequences: 0 });
      const target = createSource();
      expect(await recoverWorkspace(bucket as unknown as R2Bucket, recoveryExecutor(target.db, target.sql), TEST_WORKSPACE, { now })).toMatchObject({ recovered: true });
      expect(target.db.query(`SELECT ops_hash FROM "_tx_receipts" WHERE id = 'permanent'`).get()).toEqual({ ops_hash: null });
      expect(run(target, { ...tx, txId: "retry" })).toMatchObject({ seq: 1, applied: 0 });
      expect(scalar(target.db, `SELECT name FROM folders WHERE id = 'permanent-folder'`)).toBe("Latest");
      source = target;
    }
  });

  test("old log-only recovery drops aged hashes without losing retry keys", async () => {
    const start = Date.now();
    const source = createSource(), bucket = new FakeR2Bucket();
    const tx = { txId: "original", clientTxId: "log-only", issuedAt: start, ops: [
      { op: "update", namespace: "folders", id: "log-only-folder", values: { name: "Once" } },
    ] } as TxEnvelope;
    run(source, tx);
    source.db.exec(`UPDATE "_tx_log" SET at = ?`, start);
    await flushPending(bucket, source.sql, TEST_WORKSPACE, start);
    const target = createSource();
    expect(await recoverWorkspace(bucket as unknown as R2Bucket, recoveryExecutor(target.db, target.sql), TEST_WORKSPACE, { now: start + 400 * 86_400_000 })).toMatchObject({ recovered: true });
    expect(target.db.query(`SELECT ops_hash FROM "_tx_receipts" WHERE id = 'log-only'`).get()).toEqual({ ops_hash: null });
    expect(run(target, tx)).toMatchObject({ seq: 1, applied: 0 });
  });

  test("a legacy receipt boundary survives snapshots, intervening flushes and repeated recovery", async () => {
    const now = Date.now();
    let source = createSource();
    const bucket = new FakeR2Bucket();
    seedWorkspace(source);
    await publish(source, bucket, now);
    const key = manifestKey(TEST_WORKSPACE);
    const legacy = JSON.parse(new TextDecoder().decode(bucket.bodyOf(key)!));
    delete legacy.receiptFloor;
    bucket.seed(key, JSON.stringify(legacy));
    for (let generation = 0; generation < 2; generation++) {
      const target = createSource();
      expect(await recoverWorkspace(bucket as unknown as R2Bucket, recoveryExecutor(target.db, target.sql), TEST_WORKSPACE, { now: now + generation })).toMatchObject({ recovered: true });
      const tx = { txId: "unknown", clientTxId: "lost-key", issuedAt: now - 1, ops: [
        { op: "update", namespace: "folders", id: "f1", values: { name: "Duplicate" } },
      ] } as TxEnvelope;
      expect(() => run(target, tx)).toThrow(/issued before/);
      await snapshotWorkspace(bucket, target.sql, TEST_WORKSPACE, now + generation + 10);
      run(target, { ...tx, txId: "new", clientTxId: "new-" + generation, issuedAt: now + 100 } as TxEnvelope);
      await flushPending(bucket, target.sql, TEST_WORKSPACE, now + generation + 20);
      expect((await readManifest(bucket as unknown as R2Bucket, TEST_WORKSPACE))!.manifest.receiptFloor).toBe(now);
      source = target;
    }
  });

  test("retries survive complete log pruning, two recoveries and changed-op conflicts", async () => {
    let source = createSource();
    const bucket = new FakeR2Bucket();
    const first = { txId: "first", clientTxId: "receipt-first", ops: [
      { op: "update", namespace: "folders", id: "receipt-folder", values: { name: "Original" } },
    ] } as TxEnvelope;
    expect(run(source, first)).toMatchObject({seq:1,applied:1});
    for (let n=0;n<30;n++) run(source, {txId:`later-${n}`,clientTxId:`later-${n}`,ops:[
      {op:"update",namespace:"folders",id:"receipt-folder",values:{name:`Latest ${n}`}},
    ]} as TxEnvelope);
    await flushPending(bucket,source.sql,TEST_WORKSPACE,NOW);
    await snapshotWorkspace(bucket,source.sql,TEST_WORKSPACE,NOW,{retainLogSequences:0,chunkRows:3});
    expect(scalar(source.db,`SELECT COUNT(*) FROM "_tx_log"`)).toBe(0);
    expect([...bucket.objects.keys()].some(key=>key.includes('/log/'))).toBe(false);
    const receiptTimes = source.db.query(`SELECT id, at FROM "_tx_receipts" ORDER BY id`).all();
    expect((receiptTimes as Array<{ at: number }>).every((row) => row.at > 0)).toBe(true);
    for(let generation=0;generation<2;generation++) {
      const target=createSource();
      await recoverWorkspace(bucket as unknown as R2Bucket,recoveryExecutor(target.db,target.sql),TEST_WORKSPACE,{now:NOW+generation+1});
      expect(run(target,{...first,txId:"retry"} as TxEnvelope)).toMatchObject({seq:1,applied:0});
      expect(scalar(target.db,`SELECT name FROM folders WHERE id='receipt-folder'`)).toBe("Latest 29");
      expect(()=>run(target,{...first,ops:[{op:"update",namespace:"folders",id:"receipt-folder",values:{name:"Changed"}}]} as TxEnvelope)).toThrow(/different ops/);
      expect(scalar(target.db,`SELECT COUNT(*) FROM "_tx_receipts"`)).toBe(31);
      // Each receipt keeps the time its write was applied, so its retry window does not restart.
      expect(target.db.query(`SELECT id, at FROM "_tx_receipts" ORDER BY id`).all()).toEqual(receiptTimes);
      await snapshotWorkspace(bucket,target.sql,TEST_WORKSPACE,NOW+generation+100,{retainLogSequences:0});
      source=target;
    }
  });

  test("a no-match bulk retry stays a no-op after a restore even if new rows match", async()=>{
    const source=createSource(),bucket=new FakeR2Bucket();
    const request={txId:"empty",clientTxId:"empty-once",ops:[{op:"patchMany",namespace:"folders",where:{name:"Later"},values:{name:"Must not apply"}}]} as unknown as TxEnvelope;
    expect(run(source,request).applied).toBe(0);
    run(source,{txId:"insert",ops:[{op:"update",namespace:"folders",id:"new-match",values:{name:"Later"}}]} as TxEnvelope);
    await flushPending(bucket,source.sql,TEST_WORKSPACE,NOW);
    const target=createSource();
    await recoverWorkspace(bucket as unknown as R2Bucket,recoveryExecutor(target.db,target.sql),TEST_WORKSPACE,{now:NOW+1});
    expect(run(target,request).applied).toBe(0);
    expect(scalar(target.db,`SELECT name FROM folders WHERE id='new-match'`)).toBe("Later");
  });

  test("a checkpoint remains coherent while writes arrive during chunk uploads",async()=>{
    const source=createSource(),bucket=new FakeR2Bucket();
    run(source,{txId:"before",clientTxId:"before",ops:[
      {op:"update",namespace:"folders",id:"a",values:{name:"Before"}},
      {op:"update",namespace:"folders",id:"b",values:{name:"Delete later"}},
    ]} as TxEnvelope);
    await flushPending(bucket,source.sql,TEST_WORKSPACE,NOW);
    const put=bucket.put.bind(bucket);let interrupted=false;
    bucket.put=async(...args:Parameters<typeof bucket.put>)=>{
      if(!interrupted&&args[0].includes('/snapshots/')) {
        interrupted=true;
        run(source,{txId:"during",clientTxId:"during",ops:[
          {op:"update",namespace:"folders",id:"a",values:{name:"After"}},
          {op:"delete",namespace:"folders",id:"b"},
          {op:"update",namespace:"folders",id:"c",values:{name:"Created during upload"}},
        ]} as TxEnvelope, WORKSPACE_ROLE_LEVELS.OWNER);
        await flushPending(bucket,source.sql,TEST_WORKSPACE,NOW+1);
      }
      return put(...args);
    };
    expect(await snapshotWorkspace(bucket,source.sql,TEST_WORKSPACE,NOW+2,{chunkRows:1})).toMatchObject({snapshotted:true});
    const target=createSource();
    await recoverWorkspace(bucket as unknown as R2Bucket,recoveryExecutor(target.db,target.sql),TEST_WORKSPACE,{now:NOW+3});
    expect(entityRows(target.db)).toEqual(entityRows(source.db));
    expect(scalar(target.db,`SELECT COUNT(*) FROM "_tx_receipts"`)).toBe(2);
    // One restored from the snapshot, one replayed from the log: both keep their time.
    expect(target.db.query(`SELECT id, at FROM "_tx_receipts" ORDER BY id`).all()).toEqual(source.db.query(`SELECT id, at FROM "_tx_receipts" ORDER BY id`).all());
    expect(source.db.query(`SELECT name FROM sqlite_master WHERE name LIKE '_tapedb_snapshot_%'`).all()).toEqual([]);
  });
});

describe("the writer's identity", () => {
  test("is not written to R2 log lines, and not restored from older ones", async () => {
    const source = createSource();
    seedWorkspace(source);
    // A row from before the writer's identity stopped being recorded.
    source.db.exec(`UPDATE "_tx_log" SET user_id = 'alice@example.com', role = 3`);
    run(source, { txId: "next", ops: [{ op: "update", namespace: "folders", id: "f9", values: { name: "F9" } }] } as TxEnvelope);
    const bucket = new FakeR2Bucket();
    await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW);
    const segments = [...bucket.objects.entries()].filter(([key]) => key.includes("/log/"));
    expect(segments.length).toBeGreaterThan(0);
    for (const [, stored] of segments) {
      const lines = new TextDecoder().decode(stored.body).trim().split("\n").map((line) => JSON.parse(line));
      for (const line of lines) {
        expect(line).not.toHaveProperty("userId");
        expect(line).not.toHaveProperty("role");
      }
    }

    // A segment written by an older engine still carries it.
    const [key, stored] = segments[0];
    const old = new TextDecoder().decode(stored.body).trim().split("\n")
      .map((line) => JSON.stringify({ ...JSON.parse(line), userId: "alice@example.com", role: 3 })).join("\n") + "\n";
    bucket.seed(key, old);
    const target = createSource();
    await recoverWorkspace(bucket as unknown as R2Bucket, recoveryExecutor(target.db, target.sql), TEST_WORKSPACE, { now: NOW + 1 });
    const restored = target.db.query(`SELECT user_id, role FROM "_tx_log"`).all() as Array<{ user_id: string | null; role: number | null }>;
    expect(restored.length).toBeGreaterThan(0);
    expect(restored.every((row) => row.user_id === null && row.role === null)).toBe(true);
  });
});

describe("with audit on", () => {
  function auditSource(): Source {
    const source = createSource();
    syncAuditCapture(txExecutor(source.db));
    return source;
  }
  function history(db: Database, table: string, id: string) {
    return rowHistory(txExecutor(db), table, id).map(({ sub, role, action }) => ({ sub, role, action }));
  }

  test("records who changed each row, carries it in R2, and recovery restores it", async () => {
    configureAudit(true);
    try {
      const source = auditSource();
      run(source, { txId: "a", ops: [{ op: "update", namespace: "folders", id: "f1", values: { name: "One" } }] } as TxEnvelope);
      run(source, { txId: "b", ops: [{ op: "merge", namespace: "folders", id: "f1", values: { name: "Uno" } }] } as TxEnvelope, WORKSPACE_ROLE_LEVELS.ADMIN);
      expect(history(source.db, "folders", "f1")).toEqual([
        { sub: "user-1", role: WORKSPACE_ROLE_LEVELS.EDITOR, action: "insert" },
        { sub: "user-1", role: WORKSPACE_ROLE_LEVELS.ADMIN, action: "update" },
      ]);
      const logged = source.db.query(`SELECT user_id, role FROM "_tx_log" ORDER BY seq`).all();
      expect(logged).toEqual([
        { user_id: "user-1", role: WORKSPACE_ROLE_LEVELS.EDITOR },
        { user_id: "user-1", role: WORKSPACE_ROLE_LEVELS.ADMIN },
      ]);

      const bucket = new FakeR2Bucket();
      await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW);
      const lines = [...bucket.objects.entries()].filter(([key]) => key.includes("/log/"))
        .flatMap(([, stored]) => new TextDecoder().decode(stored.body).trim().split("\n").map((line) => JSON.parse(line)));
      expect(lines.map((line) => [line.userId, line.role])).toEqual([
        ["user-1", WORKSPACE_ROLE_LEVELS.EDITOR],
        ["user-1", WORKSPACE_ROLE_LEVELS.ADMIN],
      ]);

      // Replayed from the log alone.
      const fromLog = auditSource();
      await recoverWorkspace(bucket as unknown as R2Bucket, recoveryExecutor(fromLog.db, fromLog.sql), TEST_WORKSPACE, { now: NOW + 1 });
      expect(fromLog.db.query(`SELECT user_id, role FROM "_tx_log" ORDER BY seq`).all()).toEqual(logged);
      expect(history(fromLog.db, "folders", "f1")).toEqual(history(source.db, "folders", "f1"));

      // Restored from a snapshot, then one more change replayed on top.
      expect(await snapshotWorkspace(bucket, source.sql, TEST_WORKSPACE, NOW + 2)).toMatchObject({ snapshotted: true });
      run(source, { txId: "c", ops: [{ op: "delete", namespace: "folders", id: "f1" }] } as TxEnvelope, WORKSPACE_ROLE_LEVELS.OWNER);
      await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW + 3);
      const fromSnapshot = auditSource();
      await recoverWorkspace(bucket as unknown as R2Bucket, recoveryExecutor(fromSnapshot.db, fromSnapshot.sql), TEST_WORKSPACE, { now: NOW + 4 });
      expect(history(fromSnapshot.db, "folders", "f1")).toEqual([
        { sub: "user-1", role: WORKSPACE_ROLE_LEVELS.EDITOR, action: "insert" },
        { sub: "user-1", role: WORKSPACE_ROLE_LEVELS.ADMIN, action: "update" },
        { sub: "user-1", role: WORKSPACE_ROLE_LEVELS.OWNER, action: "delete" },
      ]);
    } finally {
      configureAudit(false);
    }
  });

  test("the history leaves with the rest of the log after the retention", async () => {
    configureAudit(true);
    try {
      const source = auditSource();
      run(source, { txId: "a", ops: [{ op: "update", namespace: "folders", id: "f1", values: { name: "One" } }] } as TxEnvelope);
      const bucket = new FakeR2Bucket();
      await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW);
      await snapshotWorkspace(bucket, source.sql, TEST_WORKSPACE, NOW);
      expect(scalar(source.db, `SELECT COUNT(*) FROM "_tx_audit"`)).toBe(1);
      await pruneHistory(bucket as unknown as R2Bucket, source.sql, TEST_WORKSPACE, Date.now() + 400 * 86_400_000);
      expect(scalar(source.db, `SELECT COUNT(*) FROM "_tx_log"`)).toBe(0);
      expect(scalar(source.db, `SELECT COUNT(*) FROM "_tx_audit"`)).toBe(0);
    } finally {
      configureAudit(false);
    }
  });

  test("turning it off stops recording", () => {
    configureAudit(true);
    const source = auditSource();
    configureAudit(false);
    syncAuditCapture(txExecutor(source.db));
    run(source, { txId: "a", ops: [{ op: "update", namespace: "folders", id: "f1", values: { name: "One" } }] } as TxEnvelope);
    expect(scalar(source.db, `SELECT COUNT(*) FROM "_tx_audit"`)).toBe(0);
    expect(source.db.query(`SELECT user_id, role FROM "_tx_log"`).all()).toEqual([{ user_id: null, role: null }]);
  });
});

describe("a recovery cut off part way", () => {
  /** A bucket whose reads stop answering after `budget` of them: a reset mid-recovery. */
  function hangAfter(bucket: FakeR2Bucket, budget: number): R2Bucket {
    let reads = 0;
    return new Proxy(bucket as unknown as R2Bucket, {
      get(target, property, receiver) {
        if (property === "get") {
          return (...args: unknown[]) =>
            ++reads > budget ? new Promise(() => {}) : (target.get as (...a: unknown[]) => unknown).apply(target, args);
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** A workspace with a snapshot and several log segments after it. */
  async function durableWorkspace() {
    const source = createSource();
    seedWorkspace(source);
    const bucket = new FakeR2Bucket();
    await publish(source, bucket, NOW);
    for (let index = 0; index < 4; index += 1) {
      run(source, {
        txId: `after-${index}`,
        ops: [{ op: "update", namespace: "folders", id: `late-${index}`, values: { name: `Late ${index}` } }],
      });
      await flushPending(bucket, source.sql, TEST_WORKSPACE, NOW + 10 + index);
    }
    return { source, bucket };
  }

  const highWater = (db: Database) => scalar(db, `SELECT high_water_seq FROM "_tx_state"`);

  /** A bucket whose `get` fails (throws) on the reads numbered in `failing`. */
  function failOn(bucket: FakeR2Bucket, failing: Set<number>, counted: { reads: number; started: number[] }): R2Bucket {
    return new Proxy(bucket as unknown as R2Bucket, {
      get(target, property, receiver) {
        if (property === "get") {
          return async (...args: unknown[]) => {
            counted.reads += 1;
            if (failing.has(counted.reads)) throw new Error("R2 get failed.");
            return (target.get as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  test("an R2 read that fails keeps the progress, and the next call resumes from it", async () => {
    const { source, bucket } = await durableWorkspace();
    const counted = { reads: 0, started: [] as number[] };
    const reference = createSource();
    await recoverWorkspace(failOn(bucket, new Set(), counted) as R2Bucket, recoveryExecutor(reference.db, reference.sql), TEST_WORKSPACE, { now: NOW + 100 });
    const total = counted.reads;
    expect(total).toBeGreaterThan(4);

    // Fail the last read: everything before it was applied and must stay.
    const target = createSource();
    const executor = recoveryExecutor(target.db, target.sql);
    const flaky = { reads: 0, started: [] as number[] };
    const failed = await recoverWorkspace(failOn(bucket, new Set([total]), flaky), executor, TEST_WORKSPACE, { now: NOW + 100 });
    expect(failed).toMatchObject({ recovered: false, reason: "unavailable" });
    expect(scalar(target.db, `SELECT value FROM "_engine_meta" WHERE "key" = 'recovery_status'`)).toBe("running");
    expect(Object.values(entityRows(target.db)).flat().length).toBeGreaterThan(0);

    // The retry reads only what is left.
    const retry = { reads: 0, started: [] as number[] };
    const resumed = await recoverWorkspace(failOn(bucket, new Set(), retry), executor, TEST_WORKSPACE, { now: NOW + 200 });
    expect(resumed.recovered).toBe(true);
    expect(retry.reads).toBeLessThan(total);
    expect(entityRows(target.db)).toEqual(entityRows(source.db));
    expect(highWater(target.db)).toBe(highWater(source.db));
  });

  test("is resumed, not served as a finished workspace", async () => {
    // Without progress kept, the next boot saw restored rows, called the
    // workspace populated, and served it partly restored at seq 0.
    const { source, bucket } = await durableWorkspace();
    for (const budget of [1, 2, 3, 4, 5, 6]) {
      const target = createSource();
      const executor = recoveryExecutor(target.db, target.sql);
      void recoverWorkspace(hangAfter(bucket, budget), executor, TEST_WORKSPACE, { now: NOW + 100 });
      await Bun.sleep(5);

      const resumed = await recoverWorkspace(bucket as unknown as R2Bucket, executor, TEST_WORKSPACE, { now: NOW + 200 });
      expect(resumed.recovered).toBe(true);
      expect(entityRows(target.db)).toEqual(entityRows(source.db));
      expect(highWater(target.db)).toBe(highWater(source.db));
    }
  });

  test("continues in budgeted steps to the same result", async () => {
    const { source, bucket } = await durableWorkspace();
    const target = createSource();
    const executor = recoveryExecutor(target.db, target.sql);
    let attempts = 0;
    for (;;) {
      attempts += 1;
      let steps = 0;
      const result = await recoverWorkspace(bucket as unknown as R2Bucket, executor, TEST_WORKSPACE, {
        now: NOW + 100,
        shouldPause: () => ++steps > 1,
      });
      if (result.recovered) break;
      expect(result).toEqual({ recovered: false, reason: "paused" });
      // Partly restored is not populated: the next call carries on.
      expect(attempts).toBeLessThan(200);
    }
    expect(attempts).toBeGreaterThan(3);
    expect(entityRows(target.db)).toEqual(entityRows(source.db));
    expect(highWater(target.db)).toBe(highWater(source.db));
    expect(scalar(target.db, `SELECT COUNT(*) FROM "_engine_meta" WHERE "key" LIKE 'recovery_%' AND "key" IN ('recovery_manifest','recovery_phase','recovery_chunks_done','recovery_segments_done')`)).toBe(0);
  });

  test("started by a version that kept no progress, starts over", async () => {
    const { source, bucket } = await durableWorkspace();
    const target = createSource();
    const executor = recoveryExecutor(target.db, target.sql);
    void recoverWorkspace(hangAfter(bucket, 3), executor, TEST_WORKSPACE, { now: NOW + 100 });
    await Bun.sleep(5);
    target.db.exec(`DELETE FROM "_engine_meta" WHERE "key" IN ('recovery_manifest','recovery_phase','recovery_chunks_done','recovery_segments_done')`);

    expect((await recoverWorkspace(bucket as unknown as R2Bucket, executor, TEST_WORKSPACE, { now: NOW + 200 })).recovered).toBe(true);
    expect(entityRows(target.db)).toEqual(entityRows(source.db));
    expect(highWater(target.db)).toBe(highWater(source.db));
  });
});
