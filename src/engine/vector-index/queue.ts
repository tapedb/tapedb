/**
 * The index queue: what the index should hold, made durable inside the write.
 *
 * The shape is the webhook outbox's, deliberately — the same capture-inside-
 * the-transaction, drain-from-the-alarm mechanism the engine already runs, not
 * a second scheduler beside it:
 *
 * 1. **Capture.** One trigger per watched table and action appends the intent
 *    to `_vector_queue` in the write's own transaction, keyed by
 *    `(model, row_id)`, so ten writes to one row in one transaction leave one
 *    intent and a delete after an insert leaves a delete. A trigger only
 *    writes a row: nothing about the index can fail or slow the commit, and a
 *    rolled-back transaction leaves no intent.
 * 2. **Materialise.** `materialiseVectorIntents` reads each captured row,
 *    computes its digest, and turns it into either an upsert (the stored
 *    vector string plus the values of the filter attributes) or a delete — or
 *    drops it, when the digest equals the one the provider already accepted.
 *    This runs right after the commit that captured it and again at the start
 *    of every drain, so a process that died between the two loses nothing.
 * 3. **Drain.** `drainVectorQueue` submits due intents in platform-sized
 *    batches from the durability alarm, records the mutation ID the provider
 *    answered with, and on failure keeps the intent with an `attempts` count
 *    and a `next_attempt_at`, exactly as the log flusher does.
 *
 * Two properties this buys, and one it does not:
 *
 * - a commit is never blocked and never fails because of the index: the row is
 *   committed, the intent is committed with it, and the drain is a later event;
 * - an unchanged row is not re-sent, and a row whose only change is a filter
 *   value *is* re-sent, because the digest covers the filter values;
 * - it does **not** make a vector visible. Indexing is asynchronous at the
 *   provider and measured ~73–103 s behind an accepted upsert on a live index.
 *   `pending` is the normal state of a freshly written row, and the mutation ID
 *   is recorded for correlation — never compared as a watermark, which the
 *   provider does not promise to move forward.
 */

import { nextBackoffDelay } from "../durability/flusher";
import { decodeVector } from "../../model/vector";
import type { SqlExecutor, SqlRow, SqlValue } from "../tx-sql";
import { vectorRowDigest } from "./digest";
import type { VectorPurgeStatus } from "./purge-ledger";
import { vectorIdFor, vectorNamespaceFor } from "./identity";
import type { ConfiguredVectorize } from "./definition";
import type { VectorIndex, VectorRecord, VectorSubmissionGate } from "./types";

/** Intents waiting for the index, one row per (model, row). */
export const VECTOR_QUEUE_TABLE = "_vector_queue";
/** The digest the provider has accepted, per indexed row. */
export const VECTOR_STATE_TABLE = "_vector_state";

/**
 * The platform's documented ceiling for one Workers-binding upsert: 1,000
 * vectors (the HTTP API takes 5,000, and this engine uses the binding).
 */
export const VECTOR_UPSERT_BATCH = 1_000;
/**
 * IDs per delete. The limits page documents no delete batch ceiling for the
 * binding, so this uses the one figure it does document for a Workers-side
 * batch rather than assuming the HTTP API's 5,000 applies here.
 */
export const VECTOR_DELETE_BATCH = 1_000;
/** Captured rows turned into intents per pass; the rest wait for the next. */
export const VECTOR_MATERIALISE_LIMIT = 500;
/**
 * Metadata the provider stores with each vector is capped at 10 KiB, and an
 * indexed string is truncated at 64 bytes. A filter value is copied whole when
 * it fits and cut on a UTF-8 boundary when it does not: the search-time gate
 * re-applies the filter against SQLite, so a truncated value can only add a
 * candidate that is then rejected, never hide one.
 */
export const VECTOR_FILTER_MAX_BYTES = 64;
/**
 * Failed attempts after which an intent stops being retried and is reported as
 * dead-lettered. It is never dropped — the row and its intent stay in the
 * workspace, visible in `/status`, so an operator can fix the cause and clear
 * `attempts` — but a purge or a rebuild should not have to out-wait a queue
 * that has been failing for a day. Twelve attempts is roughly six hours of
 * capped backoff.
 */
export const VECTOR_DEAD_LETTER_ATTEMPTS = 12;

const TRIGGER_PREFIX = "_tapedb_vector_";
const MAX_ERROR_LENGTH = 500;
const SEP = "\u001f";

/** One intent. */
interface QueueRow extends SqlRow {
  id: string;
  model: string;
  row_id: string;
  kind: "upsert" | "delete";
  seq: number;
  materialised_seq: number;
  vector_id: string | null;
  digest: string | null;
  payload: string | null;
  created_at: number;
  next_attempt_at: number;
  attempts: number;
  last_error: string | null;
}

/** The stored intent for an upsert: the exact vector bytes and the filters. */
interface UpsertPayload {
  vector: string;
  filters: Record<string, string | number | boolean>;
}

/** What one drain pass did. */
export interface VectorDrainSummary {
  /** Vectors the provider accepted. */
  upserted: number;
  /** IDs the provider accepted a deletion for. */
  deleted: number;
  /** Intents that failed this pass and are waiting for their retry. */
  retried: number;
  /** Intents still queued, including those awaiting materialisation. */
  pending: number;
  /** When the next attempt is due, or null when nothing is queued. */
  nextAt: number | null;
  /** The mutation IDs this pass's submissions were accepted under. */
  mutations: string[];
  /**
   * The workspace is fenced: nothing was submitted, by this pass or by any
   * later one, and the intents stay where they are. An erasure owns what
   * happens next.
   */
  fenced: boolean;
  /** Intents that have failed too many times to keep retrying. */
  deadLettered: number;
}

/**
 * What the queue holds, for `GET /status`.
 *
 * The three work states are separate on purpose: `pending` is normal, `failing`
 * is a submission being retried, and `deadLettered` is work that stopped
 * retrying and needs someone. A room with a purge adds `fenced` and the
 * ledger's state (`VectorQueueStatus`), which is how a stuck erasure is visible.
 */
export interface VectorQueueCounts {
  /** Intents in the queue: work the provider has not accepted, in any state. */
  pending: number;
  /** Intents whose last attempt failed and are waiting for their retry. */
  failing: number;
  /** Intents that exhausted `VECTOR_DEAD_LETTER_ATTEMPTS` and are not retried. */
  deadLettered: number;
  /** Rows the provider has accepted a digest for. */
  indexed: number;
  /** The most recent mutation ID recorded, for correlation. */
  lastMutationId: string | null;
}

/** `VectorQueueCounts` plus what only the room knows: the fence and the purge. */
export interface VectorQueueStatus extends VectorQueueCounts {
  /** True while the workspace's erasure marker stands. */
  fenced: boolean;
  /** The purge's durable progress, or null when the workspace was never fenced. */
  purge: VectorPurgeStatus | null;
}

// ---- Tables and capture --------------------------------------------------------

const captureTriggerName = (table: string, action: string): string =>
  `${TRIGGER_PREFIX}${table}_${action.toLowerCase()}`;

function quote(value: string): string {
  return value.replaceAll("'", "''");
}

function createTables(sql: SqlExecutor): void {
  // `seq` is the transaction that last touched the row; `materialised_seq` is
  // the one whose desired state is in `kind`/`digest`/`payload`. A row whose
  // seq is ahead of that is waiting to be turned into an intent.
  sql.exec(`CREATE TABLE IF NOT EXISTS "${VECTOR_QUEUE_TABLE}" (
    id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    row_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'upsert',
    seq INTEGER NOT NULL,
    materialised_seq INTEGER NOT NULL DEFAULT 0,
    vector_id TEXT,
    digest TEXT,
    payload TEXT,
    created_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    UNIQUE(model, row_id)
  )`);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS "${VECTOR_QUEUE_TABLE}_due" ON "${VECTOR_QUEUE_TABLE}" (next_attempt_at, seq)`
  );
  // What the provider has accepted, per row: the digest, so a write that
  // changes nothing is not sent again, and the mutation ID it was accepted
  // under, so a later reconciliation can find its place.
  sql.exec(`CREATE TABLE IF NOT EXISTS "${VECTOR_STATE_TABLE}" (
    model TEXT NOT NULL,
    row_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    mutation_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (model, row_id)
  )`);
}

/**
 * One trigger: record that this row changed, inside the transaction now being
 * written. The sequence and time come from the transaction's own `_tx_log`
 * line, the same way `_tx_audit` and the webhook capture attribute a change.
 *
 * The insert is `OR IGNORE` and the update always runs, so a second change to
 * the same row in one transaction keeps its single intent and only moves it
 * forward. `digest` and `payload` are left alone here: whether the desired
 * state actually changed is decided in `materialiseVectorIntents`, where the
 * digest can be computed.
 */
function captureTrigger(config: ConfiguredVectorize, action: "INSERT" | "UPDATE" | "DELETE"): string {
  const row = action === "DELETE" ? "OLD" : "NEW";
  return `CREATE TRIGGER IF NOT EXISTS "${captureTriggerName(config.table, action)}" AFTER ${action} ON "${config.table}"
    WHEN EXISTS (SELECT 1 FROM "_tx_log")
    BEGIN
      INSERT OR IGNORE INTO "${VECTOR_QUEUE_TABLE}"
        (id, model, row_id, kind, seq, materialised_seq, created_at, next_attempt_at, attempts)
      SELECT lower(hex(randomblob(16))), '${quote(config.model)}', ${row}."id", 'upsert', seq, 0, at, at, 0
        FROM "_tx_log" ORDER BY seq DESC LIMIT 1;
      UPDATE "${VECTOR_QUEUE_TABLE}"
         SET seq = (SELECT seq FROM "_tx_log" ORDER BY seq DESC LIMIT 1),
             materialised_seq = 0
       WHERE model = '${quote(config.model)}' AND row_id = ${row}."id";
    END`;
}

/**
 * Creates the queue tables and the capture triggers the configuration needs.
 * Only the indexed model is watched, so a workspace pays for the rows one
 * field actually asked about, and a deployment without `vectorize` creates no
 * table at all.
 */
export function installVectorCapture(sql: SqlExecutor, config: ConfiguredVectorize): void {
  createTables(sql);
  for (const action of ["INSERT", "UPDATE", "DELETE"] as const) {
    sql.exec(captureTrigger(config, action));
  }
}

/**
 * Removes the capture triggers. Runs on boot before migrations, so a backfill
 * or a table rebuild is not reported as a write, and when vector search is
 * turned off so capture stops at the next boot.
 */
export function dropVectorCapture(sql: SqlExecutor): void {
  for (const row of sql.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '\\_tapedb\\_vector\\_%' ESCAPE '\\'`
  )) {
    sql.exec(`DROP TRIGGER IF EXISTS "${row.name}"`);
  }
}

// ---- Materialise ---------------------------------------------------------------

type Decision =
  | { kind: "drop"; row: QueueRow }
  | { kind: "delete"; row: QueueRow; vectorId: string }
  | { kind: "upsert"; row: QueueRow; vectorId: string; digest: string; payload: string };

/**
 * Turns captured rows into intents: computes each row's digest from what it now
 * holds, compares it with the digest the provider last accepted, and leaves an
 * upsert, a delete, or nothing.
 *
 * Runs on its own — after a commit, and again at the start of every drain —
 * because it is the only step that reads the row's final state. Writes the
 * decisions in one transaction and only for the sequence it read, so a write
 * that lands while this is awaiting a hash is not overwritten: its `seq` moved
 * on and it is materialised again.
 */
export async function materialiseVectorIntents(
  sql: SqlExecutor,
  config: ConfiguredVectorize,
  workspaceId: string,
  now: number,
  limit: number = VECTOR_MATERIALISE_LIMIT
): Promise<number> {
  const pending = sql.all<QueueRow>(
    `SELECT id, model, row_id, kind, seq, materialised_seq, vector_id, digest, payload,
            created_at, next_attempt_at, attempts, last_error
       FROM "${VECTOR_QUEUE_TABLE}"
      WHERE materialised_seq < seq
      ORDER BY seq, rowid
      LIMIT ?`,
    limit
  );
  if (pending.length === 0) return 0;

  const select = `SELECT "id" AS id, "${config.column}" AS vector${config.filters
    .map((filter) => `, "${filter.column}" AS "${filter.attribute}"`)
    .join("")} FROM "${config.table}" WHERE "id" = ?`;

  const decisions = await Promise.all(
    pending.map(async (row): Promise<Decision> => {
      const stored = sql.one<SqlRow>(select, row.row_id);
      const vectorId = await vectorIdFor({
        binding: config.binding,
        workspaceId,
        model: config.model,
        field: config.field,
        rowId: String(row.row_id),
      });

      // A row that is gone, or one whose vector was cleared, is absent from the
      // index. A delete is always queued: the provider accepts deleting an ID
      // it does not hold, and the alternative — trusting the state table to
      // know what reached the provider — cannot cover an upsert whose answer
      // was lost.
      const value: SqlValue | undefined = stored === undefined ? undefined : stored.vector;
      if (stored === undefined || value === null || value === undefined || value === "") {
        return { kind: "delete", row, vectorId };
      }

      const filters = filterValuesOf(config, stored);
      const digest = await vectorRowDigest({
        model: config.model,
        rowId: String(row.row_id),
        vector: String(value),
        dimensions: config.dimensions,
        filters,
      });

      const accepted = sql.one<{ digest: string }>(
        `SELECT digest FROM "${VECTOR_STATE_TABLE}" WHERE model = ? AND row_id = ?`,
        config.model,
        row.row_id
      );
      if (accepted?.digest === digest) {
        // The provider already holds exactly this state: the only work is to
        // forget the intent, so a write that changes nothing costs no call.
        return { kind: "drop", row };
      }

      return {
        kind: "upsert",
        row,
        vectorId,
        digest,
        payload: JSON.stringify({ vector: String(value), filters } satisfies UpsertPayload),
      };
    })
  );

  let changed = 0;
  sql.transactionSync(() => {
    for (const decision of decisions) {
      const { row } = decision;
      if (decision.kind === "drop") {
        sql.exec(
          `DELETE FROM "${VECTOR_QUEUE_TABLE}" WHERE id = ? AND seq = ?`,
          row.id,
          row.seq
        );
        continue;
      }
      if (decision.kind === "delete") {
        sql.exec(
          `UPDATE "${VECTOR_QUEUE_TABLE}"
              SET kind = 'delete', digest = NULL, payload = NULL, vector_id = ?,
                  materialised_seq = ?, attempts = 0, next_attempt_at = ?, last_error = NULL
            WHERE id = ? AND seq = ?`,
          decision.vectorId,
          row.seq,
          now,
          row.id,
          row.seq
        );
        changed += 1;
        continue;
      }
      sql.exec(
        `UPDATE "${VECTOR_QUEUE_TABLE}"
            SET kind = 'upsert', digest = ?, payload = ?, vector_id = ?,
                materialised_seq = ?, attempts = 0, next_attempt_at = ?, last_error = NULL
          WHERE id = ? AND seq = ?`,
        decision.digest,
        decision.payload,
        decision.vectorId,
        row.seq,
        now,
        row.id,
        row.seq
      );
      changed += 1;
    }
  });
  return changed;
}

/** The filter values of a stored row, in API names, typed as the attribute is. */
function filterValuesOf(
  config: ConfiguredVectorize,
  stored: SqlRow
): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (const filter of config.filters) {
    const value: SqlValue | undefined = stored[filter.attribute];
    if (value === null || value === undefined) continue;
    if (filter.type === "boolean") {
      // Stored as 0/1 by the write path, whatever the driver hands back.
      values[filter.attribute] = Number(value) === 1;
    } else if (filter.type === "number") {
      values[filter.attribute] = Number(value);
    } else {
      values[filter.attribute] = String(value);
    }
  }
  return values;
}

// ---- Drain ---------------------------------------------------------------------

/**
 * Submits due intents, in `seq` order, one batch per kind, and records what the
 * provider accepted.
 *
 * Upserts are sent before deletes, both oldest first, each capped at the
 * platform's batch size. A failed submission leaves every intent in its batch
 * with `attempts` incremented and `next_attempt_at` set from the same capped
 * exponential backoff the log flusher uses — the entry is never dropped, so an
 * outage costs latency and nothing else. After `VECTOR_DEAD_LETTER_ATTEMPTS` an
 * intent stops being retried and is counted as dead-lettered; it stays in the
 * table, because dropping it would silently lose the publish.
 *
 * The provider accepts asynchronously: a success here means "accepted", and the
 * vector may not be visible for a minute or two. Nothing in this function waits
 * for that, and no caller does either.
 *
 * **The fence.** When `gate` is given, every submission — upsert and delete —
 * goes through it, so a workspace whose erasure marker stands submits nothing,
 * including a retry recovered from `_vector_state` in a room that was evicted
 * and re-created. The gate also owns the ordering guarantee: a fence written
 * while a submission is in flight waits for that submission, and a submission
 * that begins after the fence sees it. Refused work is not a failure: the
 * intents keep their place and `summary.fenced` says why nothing was sent.
 */
export async function drainVectorQueue(
  sql: SqlExecutor,
  index: VectorIndex,
  config: ConfiguredVectorize,
  workspaceId: string,
  now: number,
  options: {
    upsertBatch?: number;
    deleteBatch?: number;
    /** Refuses a submission while an erasure fence stands. */
    gate?: VectorSubmissionGate;
    /** Attempts after which an intent stops being retried. */
    deadLetterAfter?: number;
  } = {}
): Promise<VectorDrainSummary> {
  const summary: VectorDrainSummary = {
    upserted: 0,
    deleted: 0,
    retried: 0,
    pending: 0,
    nextAt: null,
    mutations: [],
    fenced: false,
    deadLettered: 0,
  };
  const deadLetterAfter = Math.max(1, options.deadLetterAfter ?? VECTOR_DEAD_LETTER_ATTEMPTS);
  const namespace = await vectorNamespaceFor(config.binding, workspaceId);

  const upserts = sql.all<QueueRow>(
    `SELECT id, model, row_id, kind, seq, materialised_seq, vector_id, digest, payload,
            created_at, next_attempt_at, attempts, last_error
       FROM "${VECTOR_QUEUE_TABLE}"
      WHERE kind = 'upsert' AND materialised_seq >= seq AND next_attempt_at <= ?
        AND attempts < ?
      ORDER BY seq, rowid
      LIMIT ?`,
    now,
    deadLetterAfter,
    Math.max(1, options.upsertBatch ?? VECTOR_UPSERT_BATCH)
  );

  if (upserts.length > 0) {
    const accepted: QueueRow[] = [];
    const records: VectorRecord[] = [];
    for (const row of upserts) {
      const record = recordFor(row, config, namespace);
      if (record === null) {
        // A stored value this build cannot decode can only come from a restore
        // or a hand-edited row; it keeps retrying, and stays visible as failing.
        failIntents(sql, [row], now, "the stored value is not a vector this build reads");
        summary.retried += 1;
        continue;
      }
      accepted.push(row);
      records.push(record);
    }

    if (records.length > 0) {
      const submitted = await submitThrough(options.gate, () => index.upsert(records));
      if (!submitted.ok) {
        failIntents(sql, accepted, now, errorMessage(submitted.error));
        summary.retried += accepted.length;
      } else if (submitted.value === null) {
        // Fenced between the intent and its submission: submit nothing.
        summary.fenced = true;
      } else {
        acceptUpserts(sql, config, accepted, submitted.value.mutationId, now);
        summary.upserted += records.length;
        summary.mutations.push(submitted.value.mutationId);
      }
    }
  }

  const deletes = summary.fenced
    ? []
    : sql.all<QueueRow>(
        `SELECT id, model, row_id, kind, seq, materialised_seq, vector_id, digest, payload,
                created_at, next_attempt_at, attempts, last_error
           FROM "${VECTOR_QUEUE_TABLE}"
          WHERE kind = 'delete' AND materialised_seq >= seq AND next_attempt_at <= ?
            AND attempts < ?
          ORDER BY seq, rowid
          LIMIT ?`,
        now,
        deadLetterAfter,
        Math.max(1, options.deleteBatch ?? VECTOR_DELETE_BATCH)
      );

  if (deletes.length > 0) {
    const ids = deletes.map((row) => String(row.vector_id ?? ""));
    const submitted = await submitThrough(options.gate, () => index.deleteByIds(ids));
    if (!submitted.ok) {
      failIntents(sql, deletes, now, errorMessage(submitted.error));
      summary.retried += deletes.length;
    } else if (submitted.value === null) {
      summary.fenced = true;
    } else {
      acceptDeletes(sql, config, deletes, submitted.value.mutationId, now);
      summary.deleted += ids.length;
      summary.mutations.push(submitted.value.mutationId);
    }
  }

  const waiting = sql.one<{ total: number; next_at: number | null; dead: number }>(
    `SELECT COUNT(*) AS total, MIN(next_attempt_at) AS next_at,
            COALESCE(SUM(CASE WHEN attempts >= ? THEN 1 ELSE 0 END), 0) AS dead
       FROM "${VECTOR_QUEUE_TABLE}"`,
    deadLetterAfter
  );
  summary.pending = Number(waiting?.total ?? 0);
  summary.deadLettered = Number(waiting?.dead ?? 0);
  summary.nextAt = waiting?.next_at === null || waiting?.next_at === undefined ? null : Number(waiting.next_at);
  return summary;
}

/**
 * Runs one submission, through the fence when there is one. The three outcomes
 * are kept apart on purpose: an error means nothing was accepted and the
 * intents retry, `null` means the fence refused it and nothing was sent, and a
 * value is the provider's acceptance.
 */
async function submitThrough<T>(
  gate: VectorSubmissionGate | undefined,
  operation: () => Promise<T>
): Promise<{ ok: true; value: T | null } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: gate === undefined ? await operation() : await gate.submit(operation) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** The vector a queued upsert asks the index to hold, or null if unreadable. */
function recordFor(
  row: QueueRow,
  config: ConfiguredVectorize,
  namespace: string
): VectorRecord | null {
  try {
    const payload = JSON.parse(String(row.payload)) as UpsertPayload;
    if (typeof payload.vector !== "string" || row.vector_id === null || row.digest === null) return null;
    const values = decodeVector(payload.vector, config.dimensions);
    return {
      id: String(row.vector_id),
      values,
      namespace,
      metadata: {
        ...metadataFilters(payload.filters),
        // The version digest travels with the vector: a search compares it
        // against the row it just read, so a stale candidate is suppressed
        // without asking the provider anything. 64 ASCII characters, which is
        // exactly the 64-byte indexed-string budget.
        digest: String(row.digest),
      },
    };
  } catch {
    return null;
  }
}

/** Filter values as provider metadata, each cut to the indexed-string budget. */
function metadataFilters(
  filters: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  const metadata: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(filters)) {
    metadata[name] = typeof value === "string" ? truncateUtf8(value, VECTOR_FILTER_MAX_BYTES) : value;
  }
  return metadata;
}

/**
 * Records what the provider accepted and forgets the intents it answered for.
 *
 * The state row is written unconditionally: the provider now holds that digest,
 * whatever happened to the queue meanwhile. The intent is only dropped when it
 * is still the one submitted — a write that landed while the batch was in
 * flight moved `seq` and must be materialised and sent, not swallowed.
 */
function acceptUpserts(
  sql: SqlExecutor,
  config: ConfiguredVectorize,
  rows: readonly QueueRow[],
  mutationId: string,
  now: number
): void {
  sql.transactionSync(() => {
    for (const row of rows) {
      sql.exec(
        `INSERT INTO "${VECTOR_STATE_TABLE}" (model, row_id, digest, mutation_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(model, row_id) DO UPDATE SET
           digest = excluded.digest, mutation_id = excluded.mutation_id, updated_at = excluded.updated_at`,
        config.model,
        row.row_id,
        row.digest,
        mutationId,
        now
      );
      sql.exec(
        `DELETE FROM "${VECTOR_QUEUE_TABLE}" WHERE id = ? AND seq = ? AND digest = ?`,
        row.id,
        row.seq,
        row.digest
      );
    }
  });
}

/** Records a deletion and forgets the intent and the state it described. */
function acceptDeletes(
  sql: SqlExecutor,
  config: ConfiguredVectorize,
  rows: readonly QueueRow[],
  mutationId: string,
  now: number
): void {
  sql.transactionSync(() => {
    for (const row of rows) {
      sql.exec(
        `DELETE FROM "${VECTOR_STATE_TABLE}" WHERE model = ? AND row_id = ?`,
        config.model,
        row.row_id
      );
      sql.exec(
        `DELETE FROM "${VECTOR_QUEUE_TABLE}" WHERE id = ? AND seq = ?`,
        row.id,
        row.seq
      );
    }
  });
  // Kept for symmetry with `acceptUpserts`'s signature; a delete carries no
  // mutation of its own to remember once the row is gone.
  void mutationId;
  void now;
}

/** Keeps each intent, counts the attempt, and schedules the retry. */
function failIntents(
  sql: SqlExecutor,
  rows: readonly QueueRow[],
  now: number,
  message: string
): void {
  if (rows.length === 0) return;
  const text = message.length > MAX_ERROR_LENGTH ? message.slice(0, MAX_ERROR_LENGTH) : message;
  sql.transactionSync(() => {
    for (const row of rows) {
      const attempts = Number(row.attempts) + 1;
      sql.exec(
        `UPDATE "${VECTOR_QUEUE_TABLE}" SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`,
        attempts,
        now + nextBackoffDelay(attempts),
        text,
        row.id
      );
    }
  });
}

// ---- Status --------------------------------------------------------------------

/**
 * What the queue holds, for `GET /status`: how many intents are waiting, how
 * many are failing, and how many rows the provider has accepted a digest for.
 * A count is enough — pending is a normal state, not an alarm, and there is no
 * per-row confirmation to offer (visibility lags acceptance by a minute or
 * more, and no watermark moves forward reliably).
 */
export function vectorQueueCounts(sql: SqlExecutor): VectorQueueCounts {
  const counts: VectorQueueCounts = {
    pending: 0,
    failing: 0,
    deadLettered: 0,
    indexed: 0,
    lastMutationId: null,
  };
  try {
    const queue = sql.one<{ total: number; failing: number; dead: number }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN attempts > 0 AND attempts < ? THEN 1 ELSE 0 END), 0) AS failing,
              COALESCE(SUM(CASE WHEN attempts >= ? THEN 1 ELSE 0 END), 0) AS dead
         FROM "${VECTOR_QUEUE_TABLE}"`,
      VECTOR_DEAD_LETTER_ATTEMPTS,
      VECTOR_DEAD_LETTER_ATTEMPTS
    );
    // `pending` is the depth of work not yet accepted, which includes the
    // intents that stopped retrying: nothing about them has been published.
    counts.pending = Number(queue?.total ?? 0);
    counts.failing = Number(queue?.failing ?? 0);
    counts.deadLettered = Number(queue?.dead ?? 0);
    const indexed = sql.one<{ total: number }>(
      `SELECT COUNT(*) AS total FROM "${VECTOR_STATE_TABLE}"`
    );
    counts.indexed = Number(indexed?.total ?? 0);
    const last = sql.one<{ mutation_id: string | null }>(
      `SELECT mutation_id FROM "${VECTOR_STATE_TABLE}" ORDER BY updated_at DESC, rowid DESC LIMIT 1`
    );
    if (typeof last?.mutation_id === "string" && last.mutation_id.length > 0) {
      counts.lastMutationId = last.mutation_id;
    }
  } catch {
    // Configured but not installed yet (a boot that has not finished).
    return { pending: 0, failing: 0, deadLettered: 0, indexed: 0, lastMutationId: null };
  }
  return counts;
}

/** When the queue next has work, or null when it is empty. */
export function vectorQueueDueAt(sql: SqlExecutor): number | null {
  try {
    const row = sql.one<{ next_at: number | null }>(
      `SELECT MIN(next_attempt_at) AS next_at FROM "${VECTOR_QUEUE_TABLE}"`
    );
    return row?.next_at === null || row?.next_at === undefined ? null : Number(row.next_at);
  } catch {
    return null;
  }
}

/** The stored digest the provider accepted for one row, for a reconciliation. */
export function acceptedVectorDigest(
  sql: SqlExecutor,
  model: string,
  rowId: string
): string | null {
  const row = sql.one<{ digest: string }>(
    `SELECT digest FROM "${VECTOR_STATE_TABLE}" WHERE model = ? AND row_id = ?`,
    model,
    rowId
  );
  return row?.digest ?? null;
}

/** Cut a string to at most `max` bytes on a UTF-8 boundary. */
export function truncateUtf8(text: string, max: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return text;
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The parts of an intent that a test needs to read it. */
export function readVectorQueue(sql: SqlExecutor): QueueRow[] {
  return sql.all<QueueRow>(
    `SELECT id, model, row_id, kind, seq, materialised_seq, vector_id, digest, payload,
            created_at, next_attempt_at, attempts, last_error
       FROM "${VECTOR_QUEUE_TABLE}" ORDER BY seq, rowid`
  );
}

/** Re-exported so a caller reading an intent does not import two modules. */
export { SEP as VECTOR_INTENT_SEPARATOR };
