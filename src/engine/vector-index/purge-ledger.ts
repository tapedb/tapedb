/**
 * The purge ledger: the durable record an erasure leaves behind.
 *
 * An erasure cannot be a delete call. Three things make it something else:
 *
 * 1. **It must outlive the workspace.** The Durable Object is emptied as part
 *    of the erase, so a job that keeps its progress in the room loses it at the
 *    exact moment the work becomes necessary. Every fact needed to finish —
 *    which IDs were ever submitted, which delete carried them, whether the
 *    provider has processed that delete — is written here first, to the
 *    deployment's DATA bucket, and the room is re-derived from it.
 * 2. **It must fence before it deletes.** An upsert accepted a second before
 *    the wipe, and a retry recovered from `_vector_state` after the room was
 *    evicted, both arrive after a naive delete and recreate the vector. So the
 *    *marker* is written before any delete is issued, and every submission
 *    reads it immediately before it starts.
 * 3. **It cannot be confirmed by a read.** The index answers asynchronously:
 *    measured on a live index, a deleted vector left `getByIds` in ~18 s while
 *    the mutation watermark only reached the delete at ~75 s, and
 *    `processedUpToMutation` is replica-inconsistent — it was observed moving
 *    *backwards* between two reads. A single empty `getByIds` is therefore weak
 *    evidence, and "the watermark moved" is not evidence at all. Confirmation
 *    is a match against the delete's own mutation ID, recorded in this ledger.
 *
 * Layout, in the existing DATA bucket — no third bucket, no KV namespace, no
 * new binding, so no user's `wrangler.jsonc` changes:
 *
 *   vector-purge/{deployment}/{workspace}/marker.json
 *   vector-purge/{deployment}/{workspace}/ledger.json
 *   vector-purge/{deployment}/{workspace}/ids/{batch}.json
 *
 * - **`marker.json`** is created once, with `etagDoesNotMatch: "*"`, and is
 *   never deleted: it is the fence, and the tombstone that rejects
 *   resurrection. It records the deployment, the workspace, the index binding
 *   and the namespace, so the record is self-describing years later.
 * - **`ledger.json`** is the progress document, updated with an ETag-checked
 *   write (the manifest's pattern) so two attempts cannot clobber each other's
 *   transitions.
 * - **`ids/{batch}.json`** is the inventory: the opaque IDs that may have
 *   reached the provider, one immutable object per delete batch, created once.
 *   It is written before the first delete, from SQLite — including IDs whose
 *   rows no longer exist — so wiping the workspace cannot lose it.
 *
 * Nothing here is user data: opaque IDs, counts and timestamps.
 */

import { nextBackoffDelay } from "../durability/flusher";

/** Top-level prefix, in the DATA bucket, beside `ws/`. */
export const VECTOR_PURGE_PREFIX = "vector-purge";
/** IDs per delete batch, and per inventory object. */
export const VECTOR_PURGE_BATCH = 1_000;
/** The ledger's shape version; a reader refuses anything else. */
export const VECTOR_PURGE_VERSION = 1 as const;
/** Failed delete attempts before a batch is reported as stalled, not retrying. */
export const VECTOR_PURGE_MAX_ATTEMPTS = 12;

/** Where a purge lives. `deployment` keeps two deployments in one bucket apart. */
export interface VectorPurgeTarget {
  deployment: string;
  workspace: string;
}

/**
 * The fence. Written before any delete, read before every submission, and
 * retained afterwards: while it exists, nothing may be submitted for this
 * workspace and it must not be opened to indexing, a rebuild, or a restore.
 */
export interface VectorPurgeMarker {
  version: typeof VECTOR_PURGE_VERSION;
  /** The deployment's own name (`ENVIRONMENT`), never another deployment's. */
  deployment: string;
  workspace: string;
  /** The Vectorize binding name this workspace published to. */
  index: string;
  /** `base64url(SHA-256(deployment, workspace))`: the provider-side isolation boundary. */
  namespace: string;
  /** When the fence was written. */
  fencedAt: number;
}

/** One delete batch: what was submitted, and what confirmed it. */
export interface VectorPurgeBatch {
  /** 1-based; also the inventory object's name. */
  n: number;
  /** How many IDs this batch carries. */
  ids: number;
  /** The mutation the provider answered the delete with, once submitted. */
  mutationId: string | null;
  submittedAt: number | null;
  /** Set when the watermark *matched this batch's own mutation ID*. */
  confirmedAt: number | null;
  attempts: number;
  /** Earliest moment the next attempt may run. */
  nextAttemptAt: number;
  lastError: string | null;
}

/** The purge's durable state. */
export interface VectorPurgeLedger {
  version: typeof VECTOR_PURGE_VERSION;
  deployment: string;
  workspace: string;
  index: string;
  namespace: string;
  fencedAt: number;
  /**
   * `inventory`: the fence stands, the ID inventory is being written.
   * `deleting`: batches to submit. `verifying`: everything submitted, at least
   * one batch waiting for its mutation to be processed. `complete`: every batch
   * matched its own mutation ID.
   */
  phase: "inventory" | "deleting" | "verifying" | "complete";
  batches: VectorPurgeBatch[];
  /** Total IDs in the inventory. */
  ids: number;
  updatedAt: number;
  completedAt: number | null;
  lastError: string | null;
}

/** What an operator, or `GET /status`, can read about a purge. */
export interface VectorPurgeStatus {
  phase: VectorPurgeLedger["phase"];
  /** True while the marker stands: nothing is or will be submitted. */
  fenced: boolean;
  /** Delete batches in the inventory. */
  batches: number;
  /** IDs the purge will delete, or has deleted. */
  ids: number;
  /** Batches whose delete the provider accepted. */
  submitted: number;
  /** Batches whose deletion was confirmed by their own mutation ID. */
  confirmed: number;
  /** Batches still to submit or confirm. */
  pending: number;
  /** True when a batch has failed enough times to need an operator. */
  stalled: boolean;
  lastError: string | null;
  fencedAt: number;
  completedAt: number | null;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

/**
 * One path segment. A deployment name that is not a safe segment is hashed
 * rather than escaped, so the key is always a single segment and the marker —
 * which carries the name in full — stays the readable copy.
 */
function segment(value: string): string {
  if (SAFE_SEGMENT.test(value)) return value;
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(index)) >>> 0;
  }
  return `h${hash.toString(16)}`;
}

/** `vector-purge/{deployment}/{workspace}`. */
export function vectorPurgePrefix(target: VectorPurgeTarget): string {
  return `${VECTOR_PURGE_PREFIX}/${segment(target.deployment)}/${segment(target.workspace)}`;
}

/** The fence object's key. */
export function vectorPurgeMarkerKey(target: VectorPurgeTarget): string {
  return `${vectorPurgePrefix(target)}/marker.json`;
}

/** The progress document's key. */
export function vectorPurgeLedgerKey(target: VectorPurgeTarget): string {
  return `${vectorPurgePrefix(target)}/ledger.json`;
}

/** One inventory object's key. */
export function vectorPurgeIdsKey(target: VectorPurgeTarget, batch: number): string {
  if (!Number.isSafeInteger(batch) || batch < 1) throw new Error("A batch number is a positive integer.");
  return `${vectorPurgePrefix(target)}/ids/${String(batch).padStart(6, "0")}.json`;
}

// ---- The fence -----------------------------------------------------------------

function isMarker(value: unknown): value is VectorPurgeMarker {
  const marker = value as Partial<VectorPurgeMarker> | null;
  return (
    typeof marker === "object" &&
    marker !== null &&
    marker.version === VECTOR_PURGE_VERSION &&
    typeof marker.workspace === "string" &&
    typeof marker.deployment === "string" &&
    typeof marker.index === "string" &&
    typeof marker.namespace === "string" &&
    typeof marker.fencedAt === "number"
  );
}

/** The marker, or null when the workspace was never fenced. */
export async function readVectorPurgeMarker(
  bucket: R2Bucket,
  target: VectorPurgeTarget
): Promise<VectorPurgeMarker | null> {
  const object = await bucket.get(vectorPurgeMarkerKey(target));
  if (!object) return null;
  const parsed: unknown = await object.json();
  if (!isMarker(parsed)) throw new Error("The vector purge marker has an invalid shape.");
  return parsed;
}

/**
 * Whether the fence stands, for the one check that has to be cheap: a `head`
 * before a submission. Absence of the object is the only "not fenced" answer —
 * an R2 error propagates, because a submission on an unknown fence state is
 * exactly the resurrection this exists to prevent.
 */
export async function isVectorPurgeFenced(
  bucket: R2Bucket,
  target: VectorPurgeTarget
): Promise<boolean> {
  return (await bucket.head(vectorPurgeMarkerKey(target))) !== null;
}

/**
 * Writes the fence, once. A second write is not an error and cannot change the
 * marker: `etagDoesNotMatch: "*"` makes this create-only, so two racing
 * attempts — or an erase retried after a crash — converge on the first record
 * and neither can move `fencedAt` forward.
 */
export async function writeVectorPurgeMarker(
  bucket: R2Bucket,
  marker: VectorPurgeMarker
): Promise<"created" | "present"> {
  const written = await bucket.put(vectorPurgeMarkerKey(marker), `${JSON.stringify(marker, null, 2)}\n`, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return written === null ? "present" : "created";
}

// ---- The ledger ----------------------------------------------------------------

function isBatch(value: unknown): value is VectorPurgeBatch {
  const batch = value as Partial<VectorPurgeBatch> | null;
  return (
    typeof batch === "object" &&
    batch !== null &&
    typeof batch.n === "number" &&
    Number.isSafeInteger(batch.n) &&
    batch.n >= 1 &&
    typeof batch.ids === "number" &&
    typeof batch.attempts === "number" &&
    typeof batch.nextAttemptAt === "number" &&
    (batch.mutationId === null || typeof batch.mutationId === "string") &&
    (batch.submittedAt === null || typeof batch.submittedAt === "number") &&
    (batch.confirmedAt === null || typeof batch.confirmedAt === "number") &&
    (batch.lastError === null || typeof batch.lastError === "string")
  );
}

function isLedger(value: unknown): value is VectorPurgeLedger {
  const ledger = value as Partial<VectorPurgeLedger> | null;
  return (
    typeof ledger === "object" &&
    ledger !== null &&
    ledger.version === VECTOR_PURGE_VERSION &&
    typeof ledger.workspace === "string" &&
    typeof ledger.deployment === "string" &&
    typeof ledger.index === "string" &&
    typeof ledger.namespace === "string" &&
    typeof ledger.fencedAt === "number" &&
    typeof ledger.ids === "number" &&
    typeof ledger.updatedAt === "number" &&
    (ledger.phase === "inventory" ||
      ledger.phase === "deleting" ||
      ledger.phase === "verifying" ||
      ledger.phase === "complete") &&
    Array.isArray(ledger.batches) &&
    ledger.batches.every(isBatch)
  );
}

/** The ledger and the ETag a conditional write needs, or null when there is none. */
export async function readVectorPurgeLedger(
  bucket: R2Bucket,
  target: VectorPurgeTarget
): Promise<{ ledger: VectorPurgeLedger; etag: string } | null> {
  const object = await bucket.get(vectorPurgeLedgerKey(target));
  if (!object) return null;
  const parsed: unknown = await object.json();
  if (!isLedger(parsed)) throw new Error("The vector purge ledger has an invalid shape.");
  return { ledger: parsed, etag: object.etag };
}

/**
 * Applies `mutate` to the ledger under an ETag check, and returns the stored
 * result. A lost race re-reads and re-applies, which is safe because every
 * transition is a function of the document's current state — a batch that was
 * submitted and recorded by the other writer is not submitted again, because
 * `mutationId` is no longer null.
 *
 * `mutate` must be pure: it runs more than once when the write loses a race.
 */
export async function updateVectorPurgeLedger(
  bucket: R2Bucket,
  target: VectorPurgeTarget,
  mutate: (ledger: VectorPurgeLedger) => VectorPurgeLedger,
  attempts = 4
): Promise<VectorPurgeLedger> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const stored = await readVectorPurgeLedger(bucket, target);
    if (!stored) throw new Error("The vector purge ledger does not exist.");
    const next = mutate(stored.ledger);
    const written = await bucket.put(
      vectorPurgeLedgerKey(target),
      `${JSON.stringify(next, null, 2)}\n`,
      {
        onlyIf: { etagMatches: stored.etag },
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      }
    );
    if (written !== null) return next;
  }
  throw new Error("Could not write the vector purge ledger; another writer kept winning the ETag race.");
}

/** Writes the ledger's first version, failing if one already exists. */
export async function createVectorPurgeLedger(
  bucket: R2Bucket,
  target: VectorPurgeTarget,
  ledger: VectorPurgeLedger
): Promise<VectorPurgeLedger> {
  const written = await bucket.put(
    vectorPurgeLedgerKey(target),
    `${JSON.stringify(ledger, null, 2)}\n`,
    {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    }
  );
  if (written !== null) return ledger;
  const stored = await readVectorPurgeLedger(bucket, target);
  if (!stored) throw new Error("The vector purge ledger vanished between its write and its read.");
  return stored.ledger;
}

// ---- The inventory -------------------------------------------------------------

/**
 * Writes one batch of IDs, once. The inventory is derived from the workspace's
 * own SQLite before it is wiped, so a second attempt at the same batch writes
 * nothing: an existing object is the durable record, and rewriting it could
 * only replace a complete list with a shorter one.
 */
export async function writeVectorPurgeIds(
  bucket: R2Bucket,
  target: VectorPurgeTarget,
  batch: number,
  ids: readonly string[]
): Promise<void> {
  await bucket.put(
    vectorPurgeIdsKey(target, batch),
    `${JSON.stringify({ batch, ids }, null, 2)}\n`,
    {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    }
  );
}

/** One batch of IDs, as the inventory recorded it. */
export async function readVectorPurgeIds(
  bucket: R2Bucket,
  target: VectorPurgeTarget,
  batch: number
): Promise<string[]> {
  const object = await bucket.get(vectorPurgeIdsKey(target, batch));
  if (!object) throw new Error(`Vector purge inventory batch ${batch} is missing.`);
  const parsed = (await object.json()) as { ids?: unknown };
  if (!Array.isArray(parsed.ids) || parsed.ids.some((id) => typeof id !== "string")) {
    throw new Error(`Vector purge inventory batch ${batch} has an invalid shape.`);
  }
  return parsed.ids as string[];
}

// ---- Reading it ----------------------------------------------------------------

/**
 * The purge's progress, for `GET /status` and for a log line.
 *
 * `confirmed` counts batches whose *own* mutation was observed in the
 * watermark — never "the watermark changed" and never a `getByIds` miss. It is
 * therefore monotonic in this ledger even though the provider's watermark is
 * not: a confirmation, once recorded, is never taken back.
 */
export function vectorPurgeStatus(
  ledger: VectorPurgeLedger | null,
  options: { fenced: boolean; now?: number }
): VectorPurgeStatus | null {
  if (ledger === null) {
    return options.fenced
      ? {
          // Fenced with no ledger yet: the fence stands and the inventory has
          // not been taken. Reported rather than hidden, because this is the
          // state in which a purge has provably not finished.
          phase: "inventory",
          fenced: true,
          batches: 0,
          ids: 0,
          submitted: 0,
          confirmed: 0,
          pending: 0,
          stalled: false,
          lastError: null,
          fencedAt: 0,
          completedAt: null,
        }
      : null;
  }
  const submitted = ledger.batches.filter((batch) => batch.mutationId !== null).length;
  const confirmed = ledger.batches.filter((batch) => batch.confirmedAt !== null).length;
  const now = options.now ?? Date.now();
  const stalled = ledger.batches.some(
    (batch) =>
      batch.confirmedAt === null &&
      (batch.attempts >= VECTOR_PURGE_MAX_ATTEMPTS || batch.nextAttemptAt > now + 3_600_000)
  );
  return {
    phase: ledger.phase,
    fenced: options.fenced,
    batches: ledger.batches.length,
    ids: ledger.ids,
    submitted,
    confirmed,
    pending: ledger.batches.length - confirmed,
    stalled,
    lastError: ledger.lastError,
    fencedAt: ledger.fencedAt,
    completedAt: ledger.completedAt,
  };
}

/**
 * The next attempt's delay for a batch that failed: the log flusher's capped
 * exponential backoff, so a purge against an index that is down costs a retry
 * per backoff window and never a tight loop.
 */
export function purgeRetryDelay(attempts: number): number {
  return nextBackoffDelay(Math.max(1, attempts));
}
