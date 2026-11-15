/**
 * Cold-start recovery: rebuild a workspace Durable Object's SQLite from R2.
 *
 * The manifest names a chunked snapshot plus the highest flushed log sequence.
 * Recovery restores every entity table from that snapshot and then replays log
 * segments after the snapshot base. Replays never touch `_tx_log` or advance
 * `_tx_state` as they go; engine bookkeeping is written once, after the replay
 * finishes, so a crash mid-recovery cannot make the workspace look caught up.
 *
 * Every op is idempotent: an op is skipped when its target row already carries
 * `updated_seq >= line.seq`. A second recovery over the same R2 contents is
 * therefore safe.
 */

import { auditEnabled } from "../audit";
import { applyFileOps, isFileOpList } from "../file-index";
import {
  changesAfter,
  evolveColumn,
  evolveField,
  evolveModel,
  evolveTable,
  type SchemaChange,
} from "../schema-evolution";
import {
  logOpsKey,
  manifestKey,
  readManifest,
  workspacePrefix,
  type ManifestTable,
  type WorkspaceManifest,
} from "../r2-keys";
import { listAllR2 } from "../r2-list";
import {
  ENGINE_TABLES,
  findNamespace,
  LINKS,
  NAMESPACES,
  namespaceTables,
  registryGeneration,
  toSnakeCase,
} from "../registry";
import { applyOps, quoteIdentifier } from "../tx-apply";
import { opsHash, stableStringify } from "../tx-hash";
import { expandLogOps } from "../tx-log";
import type {
  SqlExecutor as TxSqlExecutor,
  SqlRow as TxSqlRow,
} from "../tx-sql";
import { acceptsValue, isBulkOp, isLinkOp, validateEnvelope, type ValidatedOp } from "../tx-validate";
import { sha256Hex } from "./snapshot";
import { readReceiptFloor } from "./manifest";
import { historyAgeLimit, historyRetentionMs } from "./retention";
import type { SqlCursor, SqlExecutor, SqlValue } from "./sql";

/** Durability SQL plus the transaction primitive the restore/replay needs. */
export interface RecoverySqlExecutor extends SqlExecutor {
  settle?(): Promise<void>;
  transactionSync<T>(fn: () => T): T;
}

export interface RecoverWorkspaceOptions {
  /**
   * Restore even when entity tables already contain rows. Existing rows are
   * left in place; snapshot rows replace rows with the same id.
   */
  force?: boolean;
  /** Clock override for deterministic tests; defaults to `Date.now()`. */
  now?: number;
  /**
   * Epoch ms after which recovery stops at the next chunk or segment, keeps
   * its progress, and returns `{ recovered: false, reason: "paused" }`. The
   * next call resumes. A Durable Object resets if its boot runs past 30 s,
   * so the room recovers in budgeted steps.
   */
  deadline?: number;
  /** Test hook: checked where `deadline` is; true pauses. */
  shouldPause?: () => boolean;
}

/** Thrown between steps when the time budget is spent; never escapes. */
class RecoveryPaused extends Error {}

/** R2 could not be read. Nothing was applied from the failed read. */
class R2Unavailable extends Error {}

/**
 * The bucket as recovery reads it: a failed get, list or whole-object read
 * becomes `R2Unavailable`, which keeps the progress made so far instead of
 * starting over. Streamed bodies are not wrapped: a parted entry applies
 * while it streams, so a failure there is not safe to resume from.
 */
function resumableReads(bucket: R2Bucket): R2Bucket {
  const guard = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      throw new R2Unavailable(messageOf(error));
    }
  };
  const wrapObject = (object: R2ObjectBody | null): R2ObjectBody | null =>
    object === null
      ? null
      : (new Proxy(object, {
          get(target, key) {
            if (key === "arrayBuffer" || key === "text" || key === "json") {
              const read = Reflect.get(target, key, target) as () => Promise<unknown>;
              return () => guard(() => read.call(target));
            }
            // Native getters (body, etag) need the object itself as `this`.
            const value = Reflect.get(target, key, target) as unknown;
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          },
        }) as R2ObjectBody);
  return new Proxy(bucket, {
    get(target, key) {
      if (key === "get") {
        return (...args: Parameters<R2Bucket["get"]>) =>
          guard(() => target.get(...args)).then((object) => wrapObject(object as R2ObjectBody | null));
      }
      if (key === "list") return (...args: Parameters<R2Bucket["list"]>) => guard(() => target.list(...args));
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export type RecoveryResult =
  | { recovered: false; reason: "no_manifest" | "already_populated" | "paused" }
  /** R2 could not be read; progress is kept and a later call resumes. */
  | { recovered: false; reason: "unavailable"; error: string }
  | {
      recovered: true;
      baseSeq: number;
      logSeq: number;
      /** Number of manifest tables restored (including empty ones). */
      tables: number;
      /** Snapshot rows inserted. */
      rows: number;
      /** Log transactions with at least one op applied. */
      replayed: number;
      /** Set when the restore could not carry everything forward. */
      warnings?: string[];
    };

interface PragmaColumn extends Record<string, SqlValue> {
  name: string;
}

interface UpdatedSeqRow extends Record<string, SqlValue> {
  updated_seq: number;
}

interface LogLine {
  /** The client's ops hash, when the segment carries one. */
  opsHash?: string;
  seq: number;
  at: number;
  ops: unknown[];
  /** The idempotency key. Present when the client supplied one. */
  clientTxId?: string;
  schemaVersion?: string;
  /** Present when the entry's ops are in their own object, in this many parts. */
  opsParts?: number;
  /** The writer, when the deployment records an audit. */
  userId?: string;
  role?: number;
}

interface LogSegmentRef {
  key: string;
  fromSeq: number;
  toSeq: number;
}

interface TargetRow {
  table: string;
  id: string;
}

type RestorableRow = Record<string, SqlValue>;

/**
 * Dependency-safe restore order, derived from the deployment registry.
 *
 * Parents come before children so the restore also works when
 * `PRAGMA foreign_keys` cannot be turned off (for example when recovery runs
 * inside an outer transaction). Computed rather than hardcoded, so a schema
 * change cannot silently reorder a restore.
 */
export function restoreOrder(): string[] {
  let remaining = Object.values(NAMESPACES);
  const emitted: string[] = [];
  const done = new Set<string>();

  while (remaining.length > 0) {
    const ready = remaining.filter((namespace) =>
      Object.values(namespace.attributes).every((attribute) => {
        const referenced = attribute.references?.table;
        if (!referenced || referenced === namespace.table) return true;
        if (!remaining.some((other) => other.table === referenced)) return true;
        return done.has(referenced);
      })
    );

    // A cycle cannot be ordered; emit the remainder rather than loop forever.
    const batch = ready.length > 0 ? ready : remaining;
    for (const namespace of batch) {
      emitted.push(namespace.table);
      done.add(namespace.table);
    }

    // Drop what was emitted. Without this the loop never terminates: `ready` is
    // derived from `remaining`, and re-selecting the same tables grows
    // `emitted` until the array overflows.
    remaining = remaining.filter((namespace) => !done.has(namespace.table));
  }

  emitted.push(ENGINE_TABLES.files, ENGINE_TABLES.txReceipts, ENGINE_TABLES.txAudit);
  return emitted;
}

/** Tables whose rows reference another row in the same chunk. */
function selfReferential(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const namespace of Object.values(NAMESPACES)) {
    for (const [name, attribute] of Object.entries(namespace.attributes)) {
      if (attribute.references?.table === namespace.table) {
        map[namespace.table] = toSnakeCase(name);
      }
    }
  }
  return map;
}

const LOG_SEGMENT_NAME = /^(\d+)-(\d+)\.ndjson$/;
const MAX_ERROR_LENGTH = 2000;

/**
 * Tables recovery may touch. Computed lazily and rebuilt when the registry is
 * configured, which happens after this module loads: a module-level snapshot
 * would be fixed to the empty pre-configuration state and reject every
 * namespace.
 */
let allowedTableCache: { generation: number; tables: Set<string> } | null = null;

export function allowedTables(): Set<string> {
  const generation = registryGeneration();
  if (allowedTableCache === null || allowedTableCache.generation !== generation) {
    allowedTableCache = {
      generation,
      tables: new Set<string>([...namespaceTables(), ENGINE_TABLES.files, ENGINE_TABLES.txReceipts, ENGINE_TABLES.txAudit]),
    };
  }
  return allowedTableCache.tables;
}

const textDecoder = new TextDecoder();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Engine tables include `$files`, which `quoteIdentifier` intentionally
 * rejects. Callers only pass names from `allowedTables()`, so quoting here is
 * a guard rail rather than an input sanitizer.
 */
function quoteTable(table: string): string {
  if (!allowedTables().has(table)) {
    throw new Error(`Unknown table "${table}".`);
  }
  return `"${table}"`;
}

function truncate(message: string): string {
  return message.length > MAX_ERROR_LENGTH
    ? message.slice(0, MAX_ERROR_LENGTH)
    : message;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setMeta(sql: RecoverySqlExecutor, key: string, value: string): void {
  sql.exec(
    `INSERT OR REPLACE INTO "_engine_meta" ("key", value) VALUES (?, ?)`,
    key,
    value
  );
}

function getMeta(sql: RecoverySqlExecutor, key: string): string | undefined {
  try {
    const row = sql.exec<{ value: string }>(`SELECT value FROM "_engine_meta" WHERE "key" = ?`, key).toArray()[0];
    return row?.value;
  } catch {
    return undefined;
  }
}

const PROGRESS_KEYS = ["recovery_manifest", "recovery_phase", "recovery_chunks_done", "recovery_segments_done"];

function deleteMeta(sql: RecoverySqlExecutor, key: string): void {
  sql.exec(`DELETE FROM "_engine_meta" WHERE "key" = ?`, key);
}

function markRunning(sql: RecoverySqlExecutor, now: number): void {
  setMeta(sql, "recovery_status", "running");
  setMeta(sql, "recovery_started_at", String(now));
  deleteMeta(sql, "recovery_error");
  deleteMeta(sql, "recovery_completed_at");
  deleteMeta(sql, "recovery_failed_at");
}

function markFailed(
  sql: RecoverySqlExecutor,
  now: number,
  error: unknown
): void {
  setMeta(sql, "recovery_status", "failed");
  for (const key of PROGRESS_KEYS) deleteMeta(sql, key);
  setMeta(sql, "recovery_error", truncate(messageOf(error)));
  setMeta(sql, "recovery_failed_at", String(now));
  deleteMeta(sql, "recovery_completed_at");
}

function markComplete(
  sql: RecoverySqlExecutor,
  manifest: WorkspaceManifest,
  now: number
): void {
  setMeta(sql, "recovery_status", "complete");
  for (const key of PROGRESS_KEYS) deleteMeta(sql, key);
  setMeta(sql, "recovery_completed_at", String(now));
  setMeta(sql, "recovery_base_seq", String(manifest.baseSeq));
  setMeta(sql, "recovery_log_seq", String(manifest.logSeq));
  deleteMeta(sql, "recovery_error");
  deleteMeta(sql, "recovery_failed_at");
}

/** True when any entity table contains at least one row. */
function hasEntityRows(sql: RecoverySqlExecutor): boolean {
  for (const table of restoreOrder()) {
    const rows = sql
      .exec(`SELECT 1 AS "present" FROM ${quoteTable(table)} LIMIT 1`)
      .toArray();
    if (rows.length > 0) return true;
  }
  return false;
}

/**
 * True when this Durable Object has ever committed a transaction, even if
 * every row has since been deleted.
 *
 * `hasEntityRows` alone cannot tell a freshly-wiped DO from a workspace that
 * legitimately emptied itself: deletes are hard deletes, so a workspace whose
 * last row was removed looks identical to one that lost its SQLite. The
 * high-water mark survives both cases, and only the wipe resets it.
 */
function hasWriteHistory(sql: RecoverySqlExecutor): boolean {
  try {
    const row = sql
      .exec<{
        high_water_seq: number;
      }>(`SELECT high_water_seq FROM "_tx_state" WHERE "id" = 1`)
      .toArray()[0];
    return (row?.high_water_seq ?? 0) > 0;
  } catch {
    // Migrations have not run yet, so there is no local history to protect.
    return false;
  }
}

/**
 * Drops the rows a failed restore managed to insert.
 *
 * `recoverWorkspace` only runs when the entity tables were empty, so everything
 * in these tables at this point came from the failed attempt. Removing it stops
 * the next boot from treating a partial restore as real local state and
 * returning `already_populated` forever.
 */
function clearRestoredRows(sql: RecoverySqlExecutor): void {
  // Children first: attachment foreign keys deliberately restrict task deletion.
  for (const table of [...restoreOrder()].reverse()) {
    sql.exec(`DELETE FROM ${quoteTable(table)}`);
  }
}

function orderedTables(manifest: WorkspaceManifest): ManifestTable[] {
  const byName = new Map(manifest.tables.map((table) => [table.name, table]));
  const ordered: ManifestTable[] = [];

  for (const name of restoreOrder()) {
    const table = byName.get(name);
    if (table) {
      ordered.push(table);
      byName.delete(name);
    }
  }

  // Table names are validated against the registry before this point, so
  // anything left over cannot be restored with this schema.
  if (byName.size > 0) {
    throw new Error(
      `Manifest contains unknown table(s): ${[...byName.keys()].join(", ")}.`
    );
  }

  return ordered;
}

function validateManifestTables(manifest: WorkspaceManifest): void {
  const snapshotPrefix = `${workspacePrefix(
    manifest.workspaceId
  )}/snapshots/${manifest.baseSeq}/`;

  const changes = changesAfter(manifest.schemaVersion);
  for (const table of manifest.tables) {
    const current = evolveTable(table.name, changes);
    if (current !== null && !allowedTables().has(current)) {
      throw new Error(`Manifest contains unknown table "${table.name}".`);
    }

    const tablePrefix = `${snapshotPrefix}${table.name}/`;
    for (const chunk of table.chunks) {
      if (!chunk.key.startsWith(tablePrefix)) {
        throw new Error(
          `Snapshot chunk ${chunk.key} is outside the manifest's table prefix.`
        );
      }
    }
  }
}

function readColumns(sql: RecoverySqlExecutor, table: string): Set<string> {
  const columns = sql
    .exec<PragmaColumn>(`PRAGMA table_info(${quoteTable(table)})`)
    .toArray()
    .map((row) => row.name);

  if (columns.length === 0) {
    throw new Error(
      `Table "${table}" has no columns; workspace migrations have not run.`
    );
  }

  return new Set(columns);
}

async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  // `lib.dom` and workers-types both declare Response/BodyInit, and their
  // intersection rejects Uint8Array<ArrayBufferLike>. Same bytes either way.
  const stream = new Response(bytes as unknown as BodyInit).body;
  if (!stream) {
    throw new Error("Failed to create a decompression stream.");
  }
  const decompressed = stream.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(decompressed).arrayBuffer());
}

function parseNdjson(text: string, source: string): RestorableRow[] {
  const rows: RestorableRow[] = [];

  for (const [index, line] of text.split("\n").entries()) {
    if (line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Invalid NDJSON in ${source} at line ${index + 1}.`);
    }

    if (!isPlainRecord(parsed)) {
      throw new Error(
        `Snapshot row in ${source} at line ${index + 1} is not an object.`
      );
    }

    rows.push(parsed as RestorableRow);
  }

  return rows;
}

/**
 * Puts parents before children so self-referential foreign keys hold even when
 * `PRAGMA foreign_keys = OFF` is unavailable. Rows in a cycle are appended in
 * their original order and left for `PRAGMA foreign_key_check` to reject.
 */
function orderParentsFirst(
  rows: RestorableRow[],
  parentColumn: string
): RestorableRow[] {
  const knownIds = new Set(rows.map((row) => String(row.id)));
  const emitted = new Set<string>();
  const pending = [...rows];
  const ordered: RestorableRow[] = [];

  while (pending.length > 0) {
    let progressed = false;

    for (let index = 0; index < pending.length;) {
      const row = pending[index];
      const parent = row[parentColumn];
      const parentReady =
        parent === null ||
        parent === undefined ||
        !knownIds.has(String(parent)) ||
        emitted.has(String(parent));

      if (parentReady) {
        ordered.push(row);
        emitted.add(String(row.id));
        pending.splice(index, 1);
        progressed = true;
      } else {
        index += 1;
      }
    }

    if (!progressed) {
      ordered.push(...pending);
      break;
    }
  }

  return ordered;
}

/** Snapshot rows from an older schema, with dropped columns removed and renamed ones moved. */
function evolveRows(
  rows: RestorableRow[],
  table: string,
  changes: SchemaChange[]
): RestorableRow[] {
  if (changes.length === 0) return rows;
  return rows.map((row) => {
    const out: RestorableRow = {};
    for (const [column, value] of Object.entries(row)) {
      const current = evolveColumn(table, column, changes);
      if (current !== null) out[current] = value;
    }
    return out;
  });
}

/**
 * Log ops from an older schema, read through the changes made since. A model
 * or link a migration dropped drops the op; a dropped field drops the value;
 * renames are followed; a retyped value that no longer fits is dropped.
 */
function evolveOps(ops: unknown[], changes: SchemaChange[]): unknown[] {
  if (changes.length === 0) return ops;
  const out: unknown[] = [];
  for (const raw of ops) {
    if (!isPlainRecord(raw) || typeof raw.namespace !== "string") {
      out.push(raw);
      continue;
    }
    const namespace = evolveModel(raw.namespace, changes);
    if (namespace === null) continue;
    const op: Record<string, unknown> = { ...raw, namespace };

    if (raw.op === "link" || raw.op === "unlink") {
      if (typeof raw.link === "string" && !(raw.link in LINKS)) {
        // Model-API link names are "<model>.<field>"; follow their renames.
        const [model, field] = raw.link.split(".");
        const evolved = field === undefined ? null : evolveField(model, field, changes);
        const owner = evolveModel(model, changes);
        if (evolved === null || owner === null) continue;
        op.link = `${owner}.${evolved.field}`;
      }
      out.push(op);
      continue;
    }

    for (const key of ["values", "create"] as const) {
      const values = raw[key];
      if (!isPlainRecord(values)) continue;
      const projected: Record<string, unknown> = {};
      for (const [attribute, value] of Object.entries(values)) {
        const evolved = evolveField(raw.namespace, attribute, changes);
        if (evolved === null) continue;
        if (evolved.retyped && !acceptsValue(namespace, evolved.field, value)) continue;
        projected[evolved.field] = value;
      }
      op[key] = projected;
    }
    out.push(op);
  }
  return out;
}

function insertChunk(
  sql: RecoverySqlExecutor,
  table: string,
  rows: RestorableRow[],
  allowedColumns: Set<string>
): number {
  if (rows.length === 0) return 0;

  const columns = Object.keys(rows[0]).sort();
  const columnSet = new Set(columns);

  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length !== columns.length) {
      throw new Error(
        `Snapshot rows for "${table}" have inconsistent column sets.`
      );
    }
    for (const key of keys) {
      if (!columnSet.has(key)) {
        throw new Error(
          `Snapshot rows for "${table}" have inconsistent column sets.`
        );
      }
      if (!allowedColumns.has(key)) {
        throw new Error(
          `Snapshot row for "${table}" contains unknown column "${key}".`
        );
      }
    }
  }

  const statement = `INSERT OR REPLACE INTO ${quoteTable(table)} (${columns
    .map(quoteIdentifier)
    .join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;

  for (const row of rows) {
    sql.exec(statement, ...columns.map((column) => row[column]));
  }

  return rows.length;
}

async function restoreTable(
  bucket: R2Bucket,
  sql: RecoverySqlExecutor,
  table: ManifestTable & { sourceName?: string },
  allowedColumns: Set<string>,
  changes: SchemaChange[],
  progress: { index: number; done: number; pause: () => void }
): Promise<number> {
  let inserted = 0;

  for (const chunk of table.chunks) {
    // Chunks committed by an earlier, interrupted attempt stay committed.
    const index = progress.index;
    progress.index += 1;
    if (index < progress.done) continue;
    progress.pause();
    const object = await bucket.get(chunk.key);
    if (!object) {
      throw new Error(`Snapshot chunk ${chunk.key} is missing from R2.`);
    }

    const compressed = new Uint8Array(await object.arrayBuffer());

    if (compressed.byteLength !== chunk.bytes) {
      throw new Error(
        `Snapshot chunk ${chunk.key} is ${compressed.byteLength} bytes; manifest says ${chunk.bytes}.`
      );
    }

    const digest = await sha256Hex(compressed);
    if (digest.toLowerCase() !== chunk.sha256.toLowerCase()) {
      throw new Error(
        `Snapshot chunk ${chunk.key} failed checksum verification.`
      );
    }

    const rows = evolveRows(
      parseNdjson(textDecoder.decode(await gunzipBytes(compressed)), chunk.key),
      table.sourceName ?? table.name,
      changes
    );

    if (rows.length !== chunk.rows) {
      throw new Error(
        `Snapshot chunk ${chunk.key} has ${rows.length} rows; manifest says ${chunk.rows}.`
      );
    }

    const parentColumn = selfReferential()[table.name];
    const ordered =
      parentColumn === undefined ? rows : orderParentsFirst(rows, parentColumn);

    // The chunk and its checkpoint commit together.
    inserted += sql.transactionSync(() => {
      const count = insertChunk(sql, table.name, ordered, allowedColumns);
      setMeta(sql, "recovery_chunks_done", String(index + 1));
      return count;
    });
  }

  return inserted;
}

async function restoreSnapshot(
  bucket: R2Bucket,
  sql: RecoverySqlExecutor,
  manifest: WorkspaceManifest,
  pause: () => void
): Promise<{ tables: number; rows: number }> {
  const changes = changesAfter(manifest.schemaVersion);
  const tables = orderedTables(manifest);
  let rows = 0;
  const progress = { index: 0, done: Number(getMeta(sql, "recovery_chunks_done") ?? 0), pause };

  for (const table of tables) {
    const columns = readColumns(sql, table.name);
    rows += await restoreTable(bucket, sql, table, columns, changes, progress);
  }

  return { tables: tables.length, rows };
}

function foreignKeyCheck(sql: RecoverySqlExecutor): void {
  const violations = sql
    .exec<Record<string, SqlValue>>(`PRAGMA foreign_key_check`)
    .toArray();

  if (violations.length === 0) return;

  const sample = violations
    .slice(0, 5)
    .map(
      (row) =>
        `${String(row.table)}#${String(row.rowid)} -> ${String(row.parent)}`
    )
    .join(", ");

  throw new Error(
    `Foreign key check failed after restore (${violations.length} violation(s): ${sample}).`
  );
}

async function listLogSegments(
  bucket: R2Bucket,
  workspaceId: string
): Promise<LogSegmentRef[]> {
  const prefix = `${workspacePrefix(workspaceId)}/log/`;
  const objects = await listAllR2(bucket, prefix);
  const segments: LogSegmentRef[] = [];

  for (const object of objects) {
    const match = LOG_SEGMENT_NAME.exec(object.key.slice(prefix.length));
    if (!match) continue;

    const fromSeq = Number(match[1]);
    const toSeq = Number(match[2]);

    if (
      !Number.isSafeInteger(fromSeq) ||
      !Number.isSafeInteger(toSeq) ||
      toSeq < fromSeq
    ) {
      throw new Error(`Invalid log segment name "${object.key}".`);
    }

    segments.push({ key: object.key, fromSeq, toSeq });
  }

  return segments.sort((a, b) => a.fromSeq - b.fromSeq || a.toSeq - b.toSeq);
}

function parseLogLines(text: string, source: string): LogLine[] {
  const lines: LogLine[] = [];

  for (const [index, line] of text.split("\n").entries()) {
    if (line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Invalid NDJSON in ${source} at line ${index + 1}.`);
    }

    if (!isPlainRecord(parsed)) {
      throw new Error(
        `Log line in ${source} at line ${index + 1} is not an object.`
      );
    }

    const seq = parsed.seq;
    const at = parsed.at;
    const ops = parsed.ops;

    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
      throw new Error(
        `Log line in ${source} at line ${index + 1} has an invalid seq.`
      );
    }
    if (typeof at !== "number" || !Number.isFinite(at)) {
      throw new Error(
        `Log line in ${source} at line ${index + 1} has an invalid timestamp.`
      );
    }
    const opsParts = parsed.opsParts;
    const inParts = typeof opsParts === "number" && Number.isSafeInteger(opsParts) && opsParts > 0;
    if (!Array.isArray(ops) || (ops.length === 0 && !inParts && !(typeof parsed.clientTxId === "string" && parsed.clientTxId.length > 0 && typeof parsed.opsHash === "string" && parsed.opsHash.length > 0))) {
      throw new Error(`Log line in ${source} at line ${index + 1} has no ops.`);
    }

    // The segment carries the idempotency key too, so recovery rebuilds
    // `_tx_log` instead of forgetting every transaction it restored. The
    // writer's identity is restored only when the deployment records an
    // audit (recordReplayedLine).
    const clientTxId = parsed.clientTxId;
    const opsHashValue = parsed.opsHash;
    const schemaVersion = parsed.schemaVersion;

    lines.push({
      seq,
      at,
      ops,
      ...(typeof clientTxId === "string" && clientTxId.length > 0
        ? { clientTxId }
        : {}),
      ...(typeof opsHashValue === "string" && opsHashValue.length > 0
        ? { opsHash: opsHashValue }
        : {}),
      schemaVersion:
        typeof schemaVersion === "string" ? schemaVersion : "unknown",
      ...(inParts ? { opsParts: opsParts as number } : {}),
      ...(typeof parsed.userId === "string" ? { userId: parsed.userId } : {}),
      ...(typeof parsed.role === "number" ? { role: parsed.role } : {}),
    });
  }

  return lines;
}

function targetFor(op: ValidatedOp): TargetRow {
  if (isBulkOp(op)) {
    // The log holds the rows a bulk write resolved, never the filter.
    throw new Error(`A log line holds an unresolved "${op.kind}".`);
  }
  if (isLinkOp(op)) {
    const child = findNamespace(op.childNamespace);
    if (!child) {
      throw new Error(`Unknown link child namespace "${op.childNamespace}".`);
    }
    return { table: child.table, id: op.childId };
  }

  const namespace = findNamespace(op.namespace);
  if (!namespace) {
    throw new Error(`Unknown namespace "${op.namespace}".`);
  }
  return { table: namespace.table, id: op.id };
}

function alreadyApplied(
  sql: RecoverySqlExecutor,
  target: TargetRow,
  seq: number,
  op: ValidatedOp
): boolean {
  const row = sql
    .exec<UpdatedSeqRow>(
      `SELECT "updated_seq" FROM ${quoteTable(target.table)} WHERE "id" = ? LIMIT 1`,
      target.id
    )
    .toArray()[0];

  if (row === undefined) {
    // A delete that finds nothing has nothing left to do. A missing target for
    // any other op means the transaction was not applied yet.
    return op.kind === "delete";
  }

  return Number(row.updated_seq) >= seq;
}

function toTxSql(sql: RecoverySqlExecutor): TxSqlExecutor {
  return {
    exec(query, ...params) {
      const cursor = sql.exec(query, ...params) as SqlCursor<
        Record<string, SqlValue>
      > & { rowsWritten?: number };
      return cursor.rowsWritten ?? 1;
    },
    all<T extends TxSqlRow = TxSqlRow>(
      query: string,
      ...params: SqlValue[]
    ): T[] {
      return sql.exec<T>(query, ...params).toArray();
    },
    one<T extends TxSqlRow = TxSqlRow>(
      query: string,
      ...params: SqlValue[]
    ): T | undefined {
      return sql.exec<T>(query, ...params).toArray()[0];
    },
    transactionSync(fn) {
      return sql.transactionSync(fn);
    },
  };
}

function replayLine(
  sql: RecoverySqlExecutor,
  txSql: TxSqlExecutor,
  line: LogLine
): boolean {
  // File-index entries are engine ops, not client transactions: they are
  // last-writer-wins on path, so applying them in order is the whole replay.
  if (isFileOpList(line.ops)) {
    recordReplayedLine(sql, line);
    applyFileOps(txSql, line.ops, line.at);
    return true;
  }

  if (line.ops.some(op => isPlainRecord(op) && (op.op === "import:row" || typeof op.op === "string" && op.op.startsWith("state:") || op.op === "import:begin" || op.op === "import:end"))) {
    recordReplayedLine(sql, line);
    for (const raw of line.ops as Array<{ op: string; table: string; row: RestorableRow; id?: string }>) {
      if (raw.op === "file:put" || raw.op === "file:forget") { applyFileOps(txSql, [raw as never], line.at); continue; }
      if (raw.op === "state:delete") {
        const changes = changesAfter(line.schemaVersion), table = evolveTable(raw.table, changes);
        if (typeof raw.id !== "string") throw new Error("Invalid state deletion.");
        if (table && namespaceTables().includes(table)) txSql.exec(`DELETE FROM "${table}" WHERE id = ? AND updated_seq <= ?`, raw.id, line.seq);
        continue;
      }
      if (raw.op !== "import:row" && raw.op !== "state:row") continue;
      const changes = changesAfter(line.schemaVersion);
      const table = evolveTable(raw.table, changes);
      if (table === null || !namespaceTables().includes(table)) continue;
      const row = evolveRows([raw.row], raw.table, changes)[0];
      const old = sql.exec<{ updated_seq: number }>(`SELECT updated_seq FROM "${table}" WHERE id = ?`, String(row.id)).toArray()[0];
      if (old && old.updated_seq >= line.seq) continue;
      const allowed = new Set(sql.exec<{ name: string }>(`PRAGMA table_info("${table}")`).toArray().map(column => column.name));
      insertChunk(sql, table, [row], allowed);
    }
    return true;
  }

  const ops = evolveOps(expandLogOps(line.ops), changesAfter(line.schemaVersion));
  // Receipts survive even when a migration removed every referenced model.
  if (ops.length === 0) {
    recordReplayedLine(sql, line);
    return false;
  }
  const tx = validateEnvelope({ txId: "recovery", ops });
  const touched = new Set<string>();
  let applied = false;

  // Rebuild the local log as we replay, so `clientTxId` dedupe survives the
  // cold start for as long as the segments are retained. Without this the
  // engine forgets every transaction it just restored, and a client retrying
  // across an eviction re-applies its write.
  recordReplayedLine(sql, line);

  for (const op of tx.ops) {
    const target = targetFor(op);
    const key = `${target.table}:${target.id}`;

    if (!touched.has(key) && alreadyApplied(sql, target, line.seq, op)) {
      continue;
    }

    applyOps(
      {
        sql: txSql,
        seq: line.seq,
        now: line.at,
        txId: "recovery",
        replay: true,
      },
      [op]
    );

    touched.add(key);
    applied = true;
  }

  return applied;
}

/**
 * Writes one replayed segment line back into `_tx_log`.
 *
 * `ops_hash` is recomputed rather than carried in the segment: the segment
 * stores the ops themselves, and the hash is a canonical function of them, so
 * recomputing keeps the idempotency check byte-identical to the original
 * insert.
 */
function recordReplayedLine(sql: RecoverySqlExecutor, line: LogLine): void {
  const ops = line.ops as readonly unknown[];
  if (line.clientTxId) {
    sql.exec(`INSERT OR IGNORE INTO "_tx_receipts" (id, seq, ops_hash, at) VALUES (?, ?, ?, ?)`,
      line.clientTxId, line.seq, line.opsHash ?? opsHash(ops), line.at);
  }

  sql.exec(
    `INSERT OR IGNORE INTO "_tx_log"
       (seq, client_tx_id, ops, ops_hash, user_id, role, at, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    line.seq,
    line.clientTxId ?? null,
    stableStringify(ops),
    // Older segments carry no hash, so it is recomputed from the ops; a bulk
    // write's stored ops are the rows it resolved, whose hash is not the
    // client's, which is why newer segments carry the original.
    line.opsHash ?? opsHash(ops),
    auditEnabled() && typeof line.userId === "string" ? line.userId : null,
    auditEnabled() && typeof line.role === "number" ? line.role : null,
    line.at,
    line.schemaVersion ?? "unknown"
  );
}

function startsImport(ops: unknown[]): boolean {
  return isPlainRecord(ops[0]) && (ops[0].op === "import:begin" || ops[0].op === "state:begin");
}
async function importForeignKeys(sql: RecoverySqlExecutor, enabled: boolean): Promise<void> {
  await sql.settle?.();
  sql.exec(`PRAGMA foreign_keys = ${enabled ? "ON" : "OFF"}`);
}

async function replayLogs(
  bucket: R2Bucket,
  sql: RecoverySqlExecutor,
  txSql: TxSqlExecutor,
  workspaceId: string,
  baseSeq: number,
  logSeq: number,
  snapshotHasFiles: boolean,
  pause: () => void
): Promise<{ replayed: number; maxSeq: number }> {
  const segments = await listLogSegments(bucket, workspaceId);
  let replayed = 0;
  let maxSeq = 0;
  const done = Number(getMeta(sql, "recovery_segments_done") ?? 0);

  // A segment that is present in R2 is durable even when the manifest write
  // that would have advanced `logSeq` lost the ETag race (crash between the
  // segment PUT and the manifest PUT). The manifest is a lower bound, not the
  // authority: replay everything the listed segments can cover.
  const durableToSeq = segments.reduce(
    (max, segment) => Math.max(max, segment.toSeq),
    logSeq
  );

  for (const [index, segment] of segments.entries()) {
    // Segments an interrupted attempt finished; replaying them again would
    // be harmless (rows carry their seq), only slower.
    if (index < done) continue;
    if (segment.fromSeq > durableToSeq) continue;
    pause();

    const object = await bucket.get(segment.key);
    if (!object) {
      // A segment the snapshot already covers may have been pruned once it
      // fell outside the idempotency horizon. Rows are safe in the snapshot;
      // its keys are simply outside the retry window we promise.
      if (segment.toSeq <= baseSeq) continue;
      throw new Error(`Log segment ${segment.key} is missing from R2.`);
    }

    const lines = parseLogLines(await object.text(), segment.key);

    let pending: LogLine[] = [];
    const applyPending = () => sql.transactionSync(() => {
      const batch = pending;
      pending = [];
      for (const line of batch) {
        // The snapshot already reflects everything at or below its base, so
        // those ops must not be applied again (a delete-then-insert history
        // would resurrect rows the snapshot correctly omits). Their
        // idempotency keys are another matter: the snapshot does not carry
        // them, so this line is the only copy left.
        if (line.seq <= baseSeq) {
          recordReplayedLine(sql, line);
          // Snapshots taken before the file index was snapshotted do not
          // hold it, so the segments are its only copy below the base. File
          // ops are last-writer-wins on path, so applying them is safe.
          if (!snapshotHasFiles && isFileOpList(line.ops)) {
            applyFileOps(txSql, line.ops, line.at);
          }
          continue;
        }

        maxSeq = Math.max(maxSeq, line.seq);
        if (line.ops.length === 0) recordReplayedLine(sql, line);
        else if (replayLine(sql, txSql, line)) replayed += 1;
      }
    });

    for (const line of lines) {
      if (line.opsParts === undefined && startsImport(line.ops)) {
        applyPending();
        await importForeignKeys(sql, false);
        try {
          sql.transactionSync(() => { if (line.seq > baseSeq) replayLine(sql, txSql, line); else recordReplayedLine(sql, line); });
          foreignKeyCheck(sql);
        } finally { await importForeignKeys(sql, true); }
        maxSeq = Math.max(maxSeq, line.seq); replayed++;
        continue;
      }
      if (line.opsParts === undefined) {
        pending.push(line);
        continue;
      }
      applyPending();
      if (await replayParts(bucket, sql, txSql, workspaceId, line, baseSeq)) replayed += 1;
      if (line.seq > baseSeq) maxSeq = Math.max(maxSeq, line.seq);
    }
    applyPending();
    setMeta(sql, "recovery_segments_done", String(index + 1));
  }

  return { replayed, maxSeq };
}

/**
 * Replays an entry whose ops are in their own object, a part at a time: each
 * part is read from the stream, recorded in the local log (part 0 in the log
 * row, the rest in `_tx_log_parts`) and, above the snapshot base, applied, in
 * its own transaction. Applying a row is idempotent, so a recovery cut off
 * between parts finishes them on the next attempt.
 */
async function replayParts(
  bucket: R2Bucket,
  sql: RecoverySqlExecutor,
  txSql: TxSqlExecutor,
  workspaceId: string,
  line: LogLine,
  baseSeq: number
): Promise<boolean> {
  const object = await bucket.get(logOpsKey(workspaceId, line.seq));
  if (!object) throw new Error(`The ops of log entry ${line.seq} are missing from R2.`);
  let part = 0;
  let applied = false;
  let importing = false;
  try {
  for await (const text of objectLines(object)) {
    const ops = JSON.parse(text) as unknown[];
    const current = part;
    if (part === 0 && startsImport(ops)) { importing = true; await importForeignKeys(sql, false); }
    sql.transactionSync(() => {
      if (current === 0) recordReplayedLine(sql, { ...line, ops });
      else sql.exec(`INSERT OR IGNORE INTO "_tx_log_parts" (seq, part, ops) VALUES (?, ?, ?)`, line.seq, current, text);
      if (line.seq > baseSeq && ops.length > 0 && replayLine(sql, txSql, { ...line, ops })) applied = true;
    });
    part += 1;
  }
  if (importing) foreignKeyCheck(sql);
  } finally { if (importing) await importForeignKeys(sql, true); }
  if (part !== line.opsParts) {
    throw new Error(`Log entry ${line.seq} has ${part} parts in R2; its segment says ${line.opsParts}.`);
  }
  return applied;
}

/** An object's lines, read from its body stream without holding it whole. */
async function* objectLines(object: R2ObjectBody): AsyncGenerator<string> {
  const reader = object.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += value;
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const lineText = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (lineText.length > 0) yield lineText;
      newline = buffered.indexOf("\n");
    }
  }
  if (buffered.length > 0) yield buffered;
}

function writeFinalState(
  sql: RecoverySqlExecutor,
  manifest: WorkspaceManifest,
  maxReplayedSeq: number,
  now: number
): void {
  const highWater = Math.max(manifest.logSeq, maxReplayedSeq);

  sql.exec(
    `INSERT OR IGNORE INTO "_tx_state" ("id", high_water_seq) VALUES (1, 0)`
  );
  sql.exec(
    `UPDATE "_tx_state" SET high_water_seq = ? WHERE "id" = 1`,
    highWater
  );

  sql.exec(
    `INSERT OR IGNORE INTO "_flush_state"
       (id, last_seq, attempts, updated_at)
     VALUES (1, 0, 0, ?)`,
    now
  );
  sql.exec(
    `UPDATE "_flush_state"
        SET last_seq = MAX(last_seq, ?), attempts = 0, next_attempt_at = NULL,
            last_error = NULL, updated_at = ?
      WHERE id = 1`,
    manifest.logSeq,
    now
  );

  sql.exec(
    `INSERT OR IGNORE INTO "_snapshot_state"
       (id, base_seq, status)
     VALUES (1, ?, 'completed')`,
    manifest.baseSeq
  );
  sql.exec(
    `UPDATE "_snapshot_state"
        SET base_seq = ?, status = 'completed', started_at = ?,
            completed_at = ?, manifest_key = ?
      WHERE id = 1`,
    manifest.baseSeq,
    now,
    now,
    manifestKey(manifest.workspaceId)
  );
}

/**
 * Rebuilds `workspaceId` from its R2 manifest, snapshot chunks and log
 * segments.
 *
 * Returns `{ recovered: false, reason }` when there is no manifest or when the
 * workspace already has entity rows and `force` is not set. On a restore or
 * replay failure the `_engine_meta` recovery marker is left as `failed` with
 * the error text and the error is rethrown, so the caller can fail the boot.
 */
export async function recoverWorkspace(
  bucket: R2Bucket,
  sql: RecoverySqlExecutor,
  workspaceId: string,
  options: RecoverWorkspaceOptions = {}
): Promise<RecoveryResult> {
  const now = options.now ?? Date.now();
  bucket = resumableReads(bucket);
  // Every call does at least one chunk or segment, so a slow first read can
  // never keep a recovery from moving forward.
  let started = false;
  const pause = () => {
    const first = !started;
    started = true;
    if (first) return;
    if (options.shouldPause?.() ?? (options.deadline !== undefined && Date.now() >= options.deadline)) {
      throw new RecoveryPaused();
    }
  };

  // A run that was cut off (a reset past the boot's 30 s, an eviction, a
  // crash) left "running" behind with its progress: resume it. Its rows are
  // partial, so they never count as a populated workspace. Neither do the
  // rows of a run that failed: the workspace never served them.
  const status = getMeta(sql, "recovery_status");
  const interrupted = status === "running" || status === "failed";
  const pinned = interrupted ? getMeta(sql, "recovery_manifest") : undefined;
  if (pinned !== undefined) {
    return runRecovery(bucket, sql, workspaceId, JSON.parse(pinned) as WorkspaceManifest, now, pause);
  }
  if (interrupted) {
    // Failed, or cut off by a version that kept no progress: start over.
    try {
      sql.exec("PRAGMA foreign_keys = OFF");
    } catch {
      // Children are deleted first either way.
    }
    clearRestoredRows(sql);
  }

  // A normal boot must not touch R2. Only a genuinely fresh DO is a recovery
  // candidate: no entity rows AND no local write history. A workspace that
  // deliberately emptied its tables still owns that state, and restoring it
  // would resurrect deleted rows and rewind `_tx_state`.
  if (!options.force && !interrupted && (hasEntityRows(sql) || hasWriteHistory(sql))) {
    return { recovered: false, reason: "already_populated" };
  }

  const stored = await readManifest(bucket, workspaceId);
  if (!stored) {
    return { recovered: false, reason: "no_manifest" };
  }

  if (stored.manifest.workspaceId !== workspaceId) {
    throw new Error(
      `Manifest for workspace ${stored.manifest.workspaceId} cannot restore ${workspaceId}.`
    );
  }
  // Chunk keys keep the table names of the schema the snapshot was taken
  // under, so they are checked first; the rows then restore into today's
  // tables. A table a later migration dropped is skipped.
  validateManifestTables(stored.manifest);
  const changes = changesAfter(stored.manifest.schemaVersion);
  const manifest: WorkspaceManifest = {
    ...stored.manifest,
    tables: stored.manifest.tables.flatMap((table) => {
      const current = evolveTable(table.name, changes);
      return current === null ? [] : [{ ...table, name: current, sourceName: table.name }];
    }),
  };

  // Drop any stale log rows before replaying. The replay rebuilds `_tx_log`
  // from the durable segments, so a row here belongs to a database that is
  // about to be replaced. The manifest is pinned, so every resumed step
  // restores the same snapshot.
  sql.transactionSync(() => {
    markRunning(sql, now);
    sql.exec(`DELETE FROM "_tx_log"`);
    sql.exec(`DELETE FROM "_tx_log_parts"`);
    sql.exec(`DELETE FROM "_tx_receipts"`);
    sql.exec(`DELETE FROM "_tx_audit"`);
    setMeta(sql, "recovery_manifest", JSON.stringify(manifest));
    setMeta(sql, "recovery_phase", "restore");
    setMeta(sql, "recovery_chunks_done", "0");
    setMeta(sql, "recovery_segments_done", "0");
  });
  return runRecovery(bucket, sql, workspaceId, manifest, now, pause);
}

/** Restore, then replay, from wherever an earlier attempt got to. */
async function runRecovery(
  bucket: R2Bucket,
  sql: RecoverySqlExecutor,
  workspaceId: string,
  manifest: WorkspaceManifest,
  now: number,
  pause: () => void
): Promise<RecoveryResult> {
  try {
    // Foreign keys are disabled for the restore so chunk order cannot break
    // self-references; `PRAGMA foreign_key_check` below is the safety net.
    // When the pragma cannot change (for example inside an outer transaction)
    // `RESTORE_ORDER` and `orderParentsFirst` keep the restore valid.
    try {
      sql.exec("PRAGMA foreign_keys = OFF");
    } catch {
      // Fall back to dependency ordering.
    }

    let restored: { tables: number; rows: number } = { tables: manifest.tables.length, rows: 0 };
    try {
      if (getMeta(sql, "recovery_phase") !== "replay") {
        restored = await restoreSnapshot(bucket, sql, manifest, pause);
        foreignKeyCheck(sql);
        setMeta(sql, "recovery_phase", "replay");
      }
    } finally {
      try {
        sql.exec("PRAGMA foreign_keys = ON");
      } catch {
        // The caller owns the connection; nothing else we can do here.
      }
    }

    const txSql = toTxSql(sql);
    const replay = await replayLogs(
      bucket,
      sql,
      txSql,
      workspaceId,
      manifest.baseSeq,
      manifest.logSeq,
      manifest.tables.some((table) => table.name === ENGINE_TABLES.files),
      pause
    );
    // Lines replayed by earlier attempts count too.
    const replayedTo = Number(
      sql.exec<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM "_tx_log" WHERE seq > ?`, manifest.baseSeq).toArray()[0]?.seq ?? 0
    );

    // Older snapshots may omit receipts or contain ones whose siblings were
    // expired. Carry their safety boundary through every later snapshot.
    const incomplete = manifest.baseSeq > 0 && (
      manifest.receiptFloor === undefined ||
      !manifest.tables.some((table) => table.name === ENGINE_TABLES.txReceipts)
    );
    const floor = Math.max(readReceiptFloor(sql), manifest.receiptFloor ?? 0, incomplete ? now : 0);

    // Bookkeeping and the success marker commit together so the workspace can
    // never look caught up while its sequence state is only half written.
    sql.transactionSync(() => {
      writeFinalState(sql, manifest, Math.max(replay.maxSeq, replayedTo), now);
      // Receipts without a stored timestamp take the restore time.
      sql.exec(`UPDATE "_tx_receipts" SET at = ? WHERE at = 0`, now);
      // Written by engines that tracked missing receipts; nothing reads it.
      sql.exec(`DELETE FROM "_engine_meta" WHERE "key" = 'dedupe_floor_seq'`);
      sql.exec(`UPDATE "_tx_receipts" SET ops_hash = NULL WHERE ops_hash IS NOT NULL AND at <= ?`, now - historyAgeLimit(historyRetentionMs()));
      sql.exec(`INSERT OR REPLACE INTO "_engine_meta" ("key", value) VALUES ('receipts_since', ?)`, String(floor));
      markComplete(sql, manifest, now);
    });

    if (incomplete) {
      console.warn("workspace_recovered_without_complete_receipts", { workspaceId, baseSeq: manifest.baseSeq });
    }

    return {
      recovered: true,
      baseSeq: manifest.baseSeq,
      logSeq: manifest.logSeq,
      tables: restored.tables,
      rows: restored.rows,
      replayed: replay.replayed,
      ...(incomplete
        ? {
            warnings: [
              `The snapshot does not guarantee complete transaction receipts: unknown retries first issued before this restore are refused as retry_expired.`,
            ],
          }
        : {}),
    };
  } catch (error) {
    if (error instanceof RecoveryPaused) {
      // Progress is committed; the next call resumes.
      return { recovered: false, reason: "paused" };
    }
    if (error instanceof R2Unavailable) {
      return { recovered: false, reason: "unavailable", error: error.message };
    }
    try {
      markFailed(sql, now, error);
    } catch {
      // Preserve the restore/replay error even if the marker cannot be written.
    }
    try {
      // Leave no half-restored dataset behind: without this the next boot sees
      // rows, reports `already_populated`, and serves a systematically
      // incomplete workspace forever.
      clearRestoredRows(sql);
    } catch {
      // Preserve the original failure; the retry will fail the same way.
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}
