/**
 * The operator's side of vector search: retry the queue, rebuild one workspace's
 * index from the database, and read the index state of individual rows.
 *
 * A rebuild is a workspace-scoped, crash-resumable job kept in the workspace's
 * own SQLite, not a process: the Durable Object can be evicted between batches
 * and the job continues from its cursor on the next wake. One job per workspace,
 * so concurrent requests converge on the same id (OPS-01). While it runs, search
 * for that workspace answers `vector_search_unavailable`, because a half-built
 * index would rank on a state the database no longer has.
 *
 * A rebuild deliberately forgets what the provider accepted: that record is what
 * makes the queue skip an unchanged row, and a rebuild exists because the index
 * cannot be trusted. Orphaned entries the workspace still remembers (an accepted
 * digest whose row is gone) are enqueued as deletes first, so they cannot come
 * back through a stale index.
 */

import type { SqlExecutor, SqlRow } from "../tx-sql";
import type { ConfiguredVectorize } from "./definition";
import { vectorRowDigest } from "./digest";
import {
  VECTOR_DEAD_LETTER_ATTEMPTS,
  VECTOR_QUEUE_TABLE,
  VECTOR_STATE_TABLE,
} from "./queue";

/** The single rebuild job a workspace can have at a time. */
export const VECTOR_REBUILD_TABLE = "_vector_rebuild";
/** Rows turned into intents per rebuild pass, the same bound the queue uses. */
export const VECTOR_REBUILD_BATCH = 500;

export type VectorRebuildPhase = "prepare" | "enqueue" | "verify";

export interface VectorRebuildState {
  jobId: string;
  model: string;
  phase: VectorRebuildPhase;
  /** Last row id enqueued in the `enqueue` phase; empty at its start. */
  cursor: string;
  /** Rows this job has enqueued, across restarts. */
  enqueued: number;
  startedAt: number;
  updatedAt: number;
}

interface RebuildRow extends SqlRow {
  job_id: string;
  model: string;
  phase: string;
  cursor: string;
  enqueued: number;
  started_at: number;
  updated_at: number;
}

/** Creates the job table; a deployment without `vectorize` never calls this. */
export function installVectorRebuild(sql: SqlExecutor): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS "${VECTOR_REBUILD_TABLE}" (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    job_id TEXT NOT NULL,
    model TEXT NOT NULL,
    phase TEXT NOT NULL,
    cursor TEXT NOT NULL DEFAULT '',
    enqueued INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

/** The active job, or null. */
export function readVectorRebuild(sql: SqlExecutor): VectorRebuildState | null {
  let row: RebuildRow | undefined;
  try {
    row = sql.one<RebuildRow>(
      `SELECT job_id, model, phase, cursor, enqueued, started_at, updated_at
         FROM "${VECTOR_REBUILD_TABLE}" WHERE id = 1`
    );
  } catch {
    // Configured but not installed yet.
    return null;
  }
  if (row === undefined) return null;
  return {
    jobId: row.job_id,
    model: row.model,
    phase: row.phase as VectorRebuildPhase,
    cursor: row.cursor,
    enqueued: Number(row.enqueued),
    startedAt: Number(row.started_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Starts a rebuild, or returns the one already running. The id is the
 * convergence point: two operators asking at once get one job and one answer.
 */
export function startVectorRebuild(
  sql: SqlExecutor,
  config: ConfiguredVectorize,
  now: number,
  jobId: string
): { state: VectorRebuildState; started: boolean } {
  const active = readVectorRebuild(sql);
  if (active !== null) return { state: active, started: false };
  sql.exec(
    `INSERT INTO "${VECTOR_REBUILD_TABLE}" (id, job_id, model, phase, cursor, enqueued, started_at, updated_at)
     VALUES (1, ?, ?, 'prepare', '', 0, ?, ?)`,
    jobId,
    config.model,
    now,
    now
  );
  return {
    state: {
      jobId,
      model: config.model,
      phase: "prepare",
      cursor: "",
      enqueued: 0,
      startedAt: now,
      updatedAt: now,
    },
    started: true,
  };
}

/**
 * One bounded pass: prepare, then enqueue a batch, then verify the queue is
 * empty. Returns the state afterwards; null means the job finished.
 */
export function advanceVectorRebuild(
  sql: SqlExecutor,
  config: ConfiguredVectorize,
  now: number,
  limit: number = VECTOR_REBUILD_BATCH
): VectorRebuildState | null {
  const state = readVectorRebuild(sql);
  if (state === null) return null;
  if (state.model !== config.model) {
    // The schema's indexed model changed under a running job: the old job's
    // cursor means nothing here, and finishing it would publish the wrong rows.
    sql.exec(`DELETE FROM "${VECTOR_REBUILD_TABLE}" WHERE id = 1`);
    return null;
  }

  if (state.phase === "prepare") {
    // Forget what the provider accepted, so every row is sent again, and turn
    // entries this workspace remembers for rows that no longer exist into
    // deletes. Both in one transaction: the queue and the state must agree.
    sql.transactionSync(() => {
      sql.exec(
        `INSERT OR IGNORE INTO "${VECTOR_QUEUE_TABLE}"
           (id, model, row_id, kind, seq, materialised_seq, created_at, next_attempt_at, attempts)
         SELECT lower(hex(randomblob(16))), ?, state.row_id, 'delete', 1, 0, ?, ?, 0
           FROM "${VECTOR_STATE_TABLE}" AS state
          WHERE state.model = ?
            AND NOT EXISTS (SELECT 1 FROM "${config.table}" AS r WHERE r.id = state.row_id)`,
        config.model,
        now,
        now,
        config.model
      );
      sql.exec(`DELETE FROM "${VECTOR_STATE_TABLE}" WHERE model = ?`, config.model);
      sql.exec(
        `UPDATE "${VECTOR_REBUILD_TABLE}" SET phase = 'enqueue', cursor = '', updated_at = ? WHERE id = 1`,
        now
      );
    });
    // Continue into the first batch in the same pass: a caller that started the
    // job learns how much it enqueued, and a small workspace can finish here.
    return advanceVectorRebuild(sql, config, now, limit);
  }

  if (state.phase === "enqueue") {
    const rows = sql.all<{ id: string }>(
      `SELECT id FROM "${config.table}" WHERE id > ? ORDER BY id LIMIT ?`,
      state.cursor,
      limit
    );
    if (rows.length === 0) {
      sql.exec(`UPDATE "${VECTOR_REBUILD_TABLE}" SET phase = 'verify', updated_at = ? WHERE id = 1`, now);
      return readVectorRebuild(sql);
    }
    const last = String(rows.at(-1)!.id);
    sql.transactionSync(() => {
      for (const row of rows) {
        const rowId = String(row.id);
        // OR IGNORE then update: a row already queued keeps its single intent,
        // moved forward so the materialiser recomputes it from current state.
        sql.exec(
          `INSERT OR IGNORE INTO "${VECTOR_QUEUE_TABLE}"
             (id, model, row_id, kind, seq, materialised_seq, created_at, next_attempt_at, attempts)
           VALUES (lower(hex(randomblob(16))), ?, ?, 'upsert', 1, 0, ?, ?, 0)`,
          config.model,
          rowId,
          now,
          now
        );
        sql.exec(
          `UPDATE "${VECTOR_QUEUE_TABLE}"
              SET materialised_seq = 0, attempts = 0, next_attempt_at = ?, last_error = NULL
            WHERE model = ? AND row_id = ?`,
          now,
          config.model,
          rowId
        );
      }
      sql.exec(
        `UPDATE "${VECTOR_REBUILD_TABLE}" SET cursor = ?, enqueued = enqueued + ?, updated_at = ? WHERE id = 1`,
        last,
        rows.length,
        now
      );
    });
    if (rows.length < limit) {
      sql.exec(`UPDATE "${VECTOR_REBUILD_TABLE}" SET phase = 'verify', updated_at = ? WHERE id = 1`, now);
    }
    return readVectorRebuild(sql);
  }

  // verify: the job is done when nothing it enqueued is still queued.
  const pending = sql.one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM "${VECTOR_QUEUE_TABLE}" WHERE model = ?`,
    config.model
  );
  if (Number(pending?.total ?? 0) > 0) {
    return state;
  }
  sql.exec(`DELETE FROM "${VECTOR_REBUILD_TABLE}" WHERE id = 1`);
  return null;
}

/**
 * Requeues every intent whose last attempt failed, without changing what the
 * provider is expected to hold: the materialiser recomputes each row from the
 * database, so a retry after a fix sends the current state, not a stale payload.
 */
export function retryVectorWork(sql: SqlExecutor, model: string, now: number): number {
  const before = sql.one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM "${VECTOR_QUEUE_TABLE}" WHERE model = ?`,
    model
  );
  sql.exec(
    `UPDATE "${VECTOR_QUEUE_TABLE}"
        SET attempts = 0, next_attempt_at = ?, last_error = NULL, materialised_seq = 0
      WHERE model = ?`,
    now,
    model
  );
  return Number(before?.total ?? 0);
}

/** What the index holds for one row, as an operator reads it. */
export type VectorRowState = "unindexed" | "pending" | "indexed" | "failed";

/**
 * The state of rows this caller was already authorized to read. The caller
 * passes only ids a normal read returned, so a hidden or missing row never
 * reaches here and cannot be distinguished from one that does not exist.
 */
export async function vectorRowStates(
  sql: SqlExecutor,
  config: ConfiguredVectorize,
  rowIds: readonly string[]
): Promise<Map<string, VectorRowState>> {
  const states = new Map<string, VectorRowState>();
  if (rowIds.length === 0) return states;
  const placeholders = rowIds.map(() => "?").join(", ");
  const select = `SELECT "id" AS id, "${config.column}" AS vector${config.filters
    .map((filter) => `, "${filter.column}" AS "${filter.attribute}"`)
    .join("")} FROM "${config.table}" WHERE id IN (${placeholders})`;
  const stored = sql.all<SqlRow>(select, ...rowIds);
  const accepted = sql.all<{ row_id: string; digest: string }>(
    `SELECT row_id, digest FROM "${VECTOR_STATE_TABLE}" WHERE model = ? AND row_id IN (${placeholders})`,
    config.model,
    ...rowIds
  );
  const queued = sql.all<{ row_id: string; attempts: number; last_error: string | null }>(
    `SELECT row_id, attempts, last_error FROM "${VECTOR_QUEUE_TABLE}" WHERE model = ? AND row_id IN (${placeholders})`,
    config.model,
    ...rowIds
  );
  const acceptedBy = new Map(accepted.map((row) => [String(row.row_id), String(row.digest)]));
  const queuedBy = new Map(queued.map((row) => [String(row.row_id), row]));

  for (const row of stored) {
    const rowId = String(row.id);
    const vector = row.vector;
    if (typeof vector !== "string" || vector.length === 0) {
      states.set(rowId, "unindexed");
      continue;
    }
    const filters: Record<string, string | number | boolean> = {};
    for (const filter of config.filters) {
      const value = row[filter.attribute];
      if (value === null || value === undefined) continue;
      filters[filter.attribute] =
        filter.type === "boolean" ? Number(value) === 1 : (value as string | number);
    }
    const digest = await vectorRowDigest({
      model: config.model,
      rowId,
      vector,
      dimensions: config.dimensions,
      filters,
    });
    if (acceptedBy.get(rowId) === digest) {
      states.set(rowId, "indexed");
      continue;
    }
    const intent = queuedBy.get(rowId);
    if (intent !== undefined && Number(intent.attempts) >= VECTOR_DEAD_LETTER_ATTEMPTS) {
      states.set(rowId, "failed");
      continue;
    }
    states.set(rowId, intent === undefined ? "unindexed" : "pending");
  }
  return states;
}
