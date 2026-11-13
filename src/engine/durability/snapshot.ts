import {
  MANIFEST_VERSION,
  manifestKey,
  workspacePrefix,
  type ManifestChunk,
  type ManifestTable,
} from "../r2-keys";
import { deleteR2Keys, listAllR2 } from "../r2-list";
import { ENGINE_TABLES, namespaceTables } from "../registry";
import { readFlushState } from "./flusher";
import {
  commitManifest,
  manifestCreatedAt,
  readEngineVersion,
  utf8Bytes,
} from "./manifest";
import type { SqlExecutor, SqlValue } from "./sql";
import type {
  SnapshotOptions,
  SnapshotResult,
  SnapshotState,
  SnapshotStatus,
} from "./types";

export const SNAPSHOT_SEQ_THRESHOLD = 1000;
export const DEFAULT_SNAPSHOT_CHUNK_ROWS = 500;
export const DEFAULT_SNAPSHOT_CHUNK_BYTES = 1024 * 1024;
export const DEFAULT_SNAPSHOT_RETENTION = 2;

const SAFE_TABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type SqlRow = Record<string, SqlValue>;

interface HighWaterRow extends Record<string, SqlValue> {
  high_water_seq: number;
}

interface SnapshotStateRow extends Record<string, SqlValue> {
  base_seq: number;
  status: string;
  started_at: number | null;
  completed_at: number | null;
  manifest_key: string | null;
}

interface TableChunkAccumulator {
  chunks: ManifestChunk[];
  rows: number;
  bytes: number;
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function readSchemaVersion(sql: SqlExecutor): string | undefined {
  const row = sql
    .exec<{ value: string }>(`SELECT value FROM "_engine_meta" WHERE "key" = 'schema_version'`)
    .toArray()[0];
  return row?.value;
}

export function readHighWater(sql: SqlExecutor): number {
  const row = sql
    .exec<HighWaterRow>(`SELECT high_water_seq FROM "_tx_state" WHERE id = 1`)
    .toArray()[0];
  return row?.high_water_seq ?? 0;
}

export function readSnapshotState(sql: SqlExecutor): SnapshotState {
  const row = sql
    .exec<SnapshotStateRow>(
      `SELECT base_seq, status, started_at, completed_at, manifest_key
         FROM "_snapshot_state"
        WHERE id = 1`
    )
    .toArray()[0];

  return {
    baseSeq: row?.base_seq ?? 0,
    status: (row?.status as SnapshotStatus | undefined) ?? "idle",
    startedAt: row?.started_at ?? null,
    completedAt: row?.completed_at ?? null,
    manifestKey: row?.manifest_key ?? null,
  };
}

function ensureSnapshotStateRow(sql: SqlExecutor): void {
  sql.exec(
    `INSERT OR IGNORE INTO "_snapshot_state" (id, base_seq, status)
     VALUES (1, 0, 'idle')`
  );
}

function markSnapshotRunning(sql: SqlExecutor, now: number): void {
  ensureSnapshotStateRow(sql);
  sql.exec(
    `UPDATE "_snapshot_state"
        SET status = 'running', started_at = ?, completed_at = NULL,
            manifest_key = NULL
      WHERE id = 1`,
    now
  );
}

function markSnapshotCompleted(
  sql: SqlExecutor,
  workspaceId: string,
  baseSeq: number,
  now: number
): void {
  sql.exec(
    `UPDATE "_snapshot_state"
        SET base_seq = ?, status = 'completed', completed_at = ?, manifest_key = ?
      WHERE id = 1`,
    baseSeq,
    now,
    manifestKey(workspaceId)
  );
}

function markSnapshotFailed(sql: SqlExecutor): void {
  ensureSnapshotStateRow(sql);
  sql.exec(
    `UPDATE "_snapshot_state"
        SET status = 'failed', completed_at = NULL, manifest_key = NULL
      WHERE id = 1`
  );
}

/** True when a snapshot is due, based on sequence lag or a missing baseline. */
export function shouldSnapshot(sql: SqlExecutor, _now: number): boolean {
  const highWater = readHighWater(sql);
  if (highWater <= 0) return false;

  const state = readSnapshotState(sql);
  if (highWater - state.baseSeq >= SNAPSHOT_SEQ_THRESHOLD) return true;

  return state.status !== "completed";
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  // See recovery.ts: lib.dom and workers-types both declare these globals.
  const stream = new Response(bytes as unknown as BodyInit).body;
  if (!stream) {
    throw new Error("Failed to create a compression stream.");
  }
  const compressed = stream.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function snapshotTable(
  bucket: R2Bucket,
  sql: SqlExecutor,
  workspaceId: string,
  baseSeq: number,
  table: string,
  chunkRows: number,
  chunkBytes: number
): Promise<TableChunkAccumulator> {
  if (!SAFE_TABLE.test(table)) {
    throw new Error(`Unsafe table name in registry: ${table}`);
  }

  const prefix = `${workspacePrefix(workspaceId)}/snapshots/${baseSeq}/${table}`;
  const chunks: ManifestChunk[] = [];
  let totalRows = 0;
  let totalBytes = 0;

  let lines: string[] = [];
  let lineBytes = 0;
  let chunkIndex = 0;

  const flushChunk = async (): Promise<void> => {
    if (lines.length === 0) return;

    const key = `${prefix}/${chunkIndex}.ndjson.gz`;
    const raw = new TextEncoder().encode(lines.join(""));
    const compressed = await gzipBytes(raw);
    const written = await bucket.put(key, compressed, {
      httpMetadata: { contentType: "application/gzip" },
    });
    if (!written) {
      throw new Error(`R2 did not acknowledge snapshot chunk ${key}.`);
    }

    chunks.push({
      key,
      rows: lines.length,
      bytes: compressed.byteLength,
      sha256: await sha256Hex(compressed),
    });
    totalRows += lines.length;
    totalBytes += compressed.byteLength;
    chunkIndex += 1;
    lines = [];
    lineBytes = 0;
  };

  let lastId: string | null = null;
  for (;;) {
    const rows: SqlRow[] =
      lastId === null
        ? sql
            .exec<SqlRow>(
              `SELECT * FROM "${table}" ORDER BY id LIMIT ?`,
              chunkRows
            )
            .toArray()
        : sql
            .exec<SqlRow>(
              `SELECT * FROM "${table}" WHERE id > ? ORDER BY id LIMIT ?`,
              lastId,
              chunkRows
            )
            .toArray();

    if (rows.length === 0) break;

    for (const row of rows) {
      const line = `${JSON.stringify(row)}\n`;
      const bytes = utf8Bytes(line);

      if (
        lines.length > 0 &&
        (lines.length >= chunkRows || lineBytes + bytes > chunkBytes)
      ) {
        await flushChunk();
      }

      lines.push(line);
      lineBytes += bytes;

      if (lines.length >= chunkRows) {
        await flushChunk();
      }
    }

    lastId = String(rows[rows.length - 1].id);
    if (rows.length < chunkRows) break;
  }

  await flushChunk();

  return { chunks, rows: totalRows, bytes: totalBytes };
}

const LOG_SEGMENT_NAME = /^(\d+)-(\d+)\.ndjson$/;

/**
 * How far below the snapshot base a log segment is kept.
 *
 * A snapshot stores rows, not idempotency keys, so a segment folded into a
 * snapshot is still the only durable record of the `clientTxId` values it
 * carried. Deleting it the moment the snapshot lands is what made a retried
 * write apply twice after an eviction. Keeping roughly two snapshots' worth of
 * covered segments bounds the retry window explicitly instead of pretending it
 * is unlimited: R2 holds a few small objects, and the guarantee matches what a
 * client outbox can realistically replay.
 */
export const DEDUPE_HORIZON_SEQ = 2 * SNAPSHOT_SEQ_THRESHOLD;

/**
 * Deletes log segments wholly covered by `baseSeq`, keeping those inside the
 * idempotency horizon so cold-start recovery can still rebuild `_tx_log`.
 */
export async function pruneCoveredLogSegments(
  bucket: R2Bucket,
  workspaceId: string,
  baseSeq: number,
  options: { dedupeHorizonSeq?: number } = {}
): Promise<number> {
  const prefix = `${workspacePrefix(workspaceId)}/log/`;
  const objects = await listAllR2(bucket, prefix);
  const keys: string[] = [];
  const horizon = options.dedupeHorizonSeq ?? DEDUPE_HORIZON_SEQ;
  const retainFrom = baseSeq - horizon;

  for (const object of objects) {
    const match = LOG_SEGMENT_NAME.exec(object.key.slice(prefix.length));
    if (!match) continue;
    // A segment that overlaps the horizon stays: its lines below the snapshot
    // base are the only remaining copy of their idempotency keys.
    if (Number(match[2]) <= retainFrom) keys.push(object.key);
  }

  await deleteR2Keys(bucket, keys);
  return keys.length;
}

const SNAPSHOT_OBJECT = /^(\d+)\//;

/**
 * Keeps the newest `retention` snapshot prefixes (including the one just
 * written) and deletes older prefix contents.
 */
export async function pruneOldSnapshots(
  bucket: R2Bucket,
  workspaceId: string,
  currentBaseSeq: number,
  retention: number = DEFAULT_SNAPSHOT_RETENTION
): Promise<number> {
  const prefix = `${workspacePrefix(workspaceId)}/snapshots/`;
  const objects = await listAllR2(bucket, prefix);

  const sequences = new Set<number>([currentBaseSeq]);
  const byObject: Array<{ key: string; seq: number | null }> = [];

  for (const object of objects) {
    const match = SNAPSHOT_OBJECT.exec(object.key.slice(prefix.length));
    const seq = match ? Number(match[1]) : null;
    if (seq !== null) sequences.add(seq);
    byObject.push({ key: object.key, seq });
  }

  const keep = new Set(
    [...sequences].sort((a, b) => b - a).slice(0, Math.max(1, retention))
  );
  const keys = byObject
    .filter((entry) => entry.seq !== null && !keep.has(entry.seq))
    .map((entry) => entry.key);

  await deleteR2Keys(bucket, keys);
  return keys.length;
}

async function pruneSafely(
  bucket: R2Bucket,
  workspaceId: string,
  baseSeq: number,
  retention: number,
  dedupeHorizonSeq?: number
): Promise<string[]> {
  const warnings: string[] = [];

  try {
    await pruneCoveredLogSegments(bucket, workspaceId, baseSeq, {
      dedupeHorizonSeq,
    });
  } catch (cause) {
    warnings.push(
      `log prune failed: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }

  try {
    await pruneOldSnapshots(bucket, workspaceId, baseSeq, retention);
  } catch (cause) {
    warnings.push(
      `snapshot prune failed: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }

  return warnings;
}

/**
 * Writes a full chunked snapshot of every entity table and then commits the v2
 * manifest. `_snapshot_state` only becomes `completed` after the manifest PUT
 * succeeds; pruning runs afterwards and never fails the snapshot.
 */
export async function snapshotWorkspace(
  bucket: R2Bucket,
  sql: SqlExecutor,
  workspaceId: string,
  now: number,
  options: SnapshotOptions = {}
): Promise<SnapshotResult> {
  const chunkRows = assertPositiveInteger(
    options.chunkRows ?? DEFAULT_SNAPSHOT_CHUNK_ROWS,
    "chunkRows"
  );
  const chunkBytes = assertPositiveInteger(
    options.chunkBytes ?? DEFAULT_SNAPSHOT_CHUNK_BYTES,
    "chunkBytes"
  );
  const retention = assertPositiveInteger(
    options.retention ?? DEFAULT_SNAPSHOT_RETENTION,
    "retention"
  );

  const baseSeq = readHighWater(sql);
  const flushState = readFlushState(sql);

  markSnapshotRunning(sql, now);

  try {
    const tables: ManifestTable[] = [];
    let totalRows = 0;
    let totalBytes = 0;
    let totalChunks = 0;

    // The file index is part of the workspace's state like any table: without
    // it a restore keeps only files written after the snapshot.
    for (const table of [...namespaceTables(), ENGINE_TABLES.files]) {
      const snapshot = await snapshotTable(
        bucket,
        sql,
        workspaceId,
        baseSeq,
        table,
        chunkRows,
        chunkBytes
      );
      tables.push({ name: table, chunks: snapshot.chunks });
      totalRows += snapshot.rows;
      totalBytes += snapshot.bytes;
      totalChunks += snapshot.chunks.length;
    }

    const logSeq = Math.max(baseSeq, flushState.lastSeq);

    const { manifest } = await commitManifest(
      bucket,
      workspaceId,
      (current) => ({
        version: MANIFEST_VERSION,
        workspaceId,
        baseSeq,
        logSeq: Math.max(logSeq, current?.logSeq ?? 0),
        createdAt: current?.createdAt ?? manifestCreatedAt(now),
        engineVersion: readEngineVersion(sql),
        schemaVersion: readSchemaVersion(sql),
        tables,
        totalRows,
        totalBytes,
      })
    );

    markSnapshotCompleted(sql, workspaceId, baseSeq, now);

    const warnings = await pruneSafely(
      bucket,
      workspaceId,
      baseSeq,
      retention,
      options.dedupeHorizonSeq
    );

    return {
      snapshotted: true,
      baseSeq,
      logSeq: manifest.logSeq,
      manifestKey: manifestKey(workspaceId),
      tables: tables.length,
      chunks: totalChunks,
      rows: totalRows,
      bytes: totalBytes,
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  } catch (cause) {
    markSnapshotFailed(sql);
    return {
      snapshotted: false,
      baseSeq,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
