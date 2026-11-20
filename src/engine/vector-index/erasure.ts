/**
 * Erasing a workspace from the vector index: fence, drain, delete, verify.
 *
 * Deleting a *row* is handled by the queue — it enqueues a delete of that row's
 * vector, retried from the alarm like any other intent. Erasing a *workspace*
 * cannot be built that way, for three reasons that were measured rather than
 * assumed:
 *
 * 1. **The room is destroyed by the erase.** Progress kept in the Durable
 *    Object, or in its alarm, is gone at the moment it is needed. So the fence,
 *    the ID inventory and each delete's mutation ID live in the purge ledger
 *    (`purge-ledger.ts`) and this module is a *reader* of that ledger: every
 *    step is derived from it, so an erasure interrupted anywhere resumes when
 *    the coordinator runs again.
 * 2. **A check followed by a submission is not a fence.** On a live index, a
 *    drain that checked the erasure marker, awaited something, and then
 *    submitted re-emitted one upsert *after* the fence, and the vector was
 *    present again 114 s later; a drain that serialised the check with the
 *    start of the submission emitted zero. The guarantee is therefore "no
 *    submission begins after the fence", implemented as one serialised step
 *    (see `VectorSubmissionGate`) that any retry recovered from `_vector_state`
 *    re-runs.
 * 3. **A provider read is not confirmation.** An accepted upsert took ~73–103 s
 *    to become visible; a deleted vector left `getByIds` in ~18 s while the
 *    mutation watermark only reached the delete at ~75 s; and
 *    `processedUpToMutation` moved *backwards* between two reads. So
 *    confirmation matches the delete's own mutation ID, recorded in the ledger,
 *    and never tests for forward movement — on a shared index the watermark is
 *    usually some other workspace's mutation, which must confirm nothing here.
 *
 * What an erasure does *not* need: a row to still exist. The inventory is taken
 * from `_vector_queue` (intents not yet submitted, which carry their derived
 * IDs) and `_vector_state` (rows the provider accepted a digest for, whose IDs
 * are re-derived from the row ID), so an ID whose row was deleted after it was
 * published is still deleted. Between them those two tables cover every
 * submission this workspace could have made: `acceptUpserts` writes the state
 * row and drops the queue row in one transaction, so an accepted upsert always
 * leaves one of the two behind.
 */

import type { SqlExecutor } from "../tx-sql";
import { nextBackoffDelay } from "../durability/flusher";
import { vectorIdFor, vectorNamespaceFor } from "./identity";
import type { ConfiguredVectorize } from "./definition";
import type { VectorIndex } from "./types";
import {
  VECTOR_PURGE_BATCH,
  VECTOR_PURGE_MAX_ATTEMPTS,
  VECTOR_PURGE_VERSION,
  createVectorPurgeLedger,
  isVectorPurgeFenced,
  purgeRetryDelay,
  readVectorPurgeIds,
  readVectorPurgeLedger,
  updateVectorPurgeLedger,
  vectorPurgeStatus,
  writeVectorPurgeIds,
  writeVectorPurgeMarker,
  type VectorPurgeBatch,
  type VectorPurgeLedger,
  type VectorPurgeStatus,
  type VectorPurgeTarget,
} from "./purge-ledger";
import { VECTOR_QUEUE_TABLE, VECTOR_STATE_TABLE } from "./queue";

/**
 * The operations a workspace's erase path calls. Implemented by
 * `VectorPurgeErasure` below; `VECTOR_ERASURE_HOOK` is the one a room uses.
 *
 * Every input repeats the binding and workspace so a caller cannot erase the
 * wrong index: the implementation refuses a target that differs from the one it
 * was built for.
 */
export interface VectorErasureHook {
  /**
   * Fences the workspace, then inventories, deletes and verifies. Resolves with
   * the purge's state — `complete` when the provider has processed every
   * delete, anything else when the work is still outstanding and the ledger
   * holds it, so the caller can retry without knowing where it stopped.
   *
   * `inventory` is called once, before the workspace's SQLite is wiped, and
   * only when no inventory has been written yet: after that the ledger is the
   * truth and a second call would replace a complete list with a shorter one.
   */
  erase(input: {
    binding: string;
    workspaceId: string;
    model: string;
    inventory?: () => Promise<readonly string[]>;
  }): Promise<VectorPurgeStatus>;

  /**
   * Whether a workspace may be opened to indexing, a restore or a rebuild:
   * true while its erasure marker stands.
   */
  isFenced(input: { binding: string; workspaceId: string }): Promise<boolean>;

  /** The purge's durable state, or null when the workspace was never fenced. */
  status(input: { binding: string; workspaceId: string }): Promise<VectorPurgeStatus | null>;

  /**
   * Continues an interrupted erasure using nothing but the ledger: no SQLite,
   * no room state. This is the coordinator's entry point, and the reason a room
   * and its alarm can both be destroyed without losing the purge.
   */
  resume(input: { binding: string; workspaceId: string }): Promise<VectorPurgeStatus | null>;
}

/**
 * A submission gate, as the drain consumes it.
 *
 * `submit` runs the operation only when the fence does not stand, and the check
 * and the start of the submission happen in one serialised step: a fence
 * written while a submission is in flight waits for it, and a submission that
 * begins after the fence has been written sees it. Resolves `null` when the
 * workspace is fenced.
 */
export interface VectorSubmissionGate {
  submit<T>(operation: () => Promise<T>): Promise<T | null>;
}

/** What an implementation needs: the bucket, the target, and the index (if any). */
export interface VectorErasureDeps {
  /** The deployment's DATA bucket — where the ledger lives. */
  bucket: R2Bucket;
  /** The deployment's own name, so two deployments in one bucket never collide. */
  deployment: string;
  workspaceId: string;
  config: ConfiguredVectorize;
  /** The index this room submits to, or null when the binding is absent. */
  index: () => VectorIndex | null;
  now?: () => number;
}

const MAX_ERROR_LENGTH = 500;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(message: string): string {
  return message.length > MAX_ERROR_LENGTH ? message.slice(0, MAX_ERROR_LENGTH) : message;
}

/**
 * The watermark the provider reports, if it reports one.
 *
 * `describe()` is the only read the engine makes outside a submission, and on
 * Vectorize it carries `processedUpToMutation`. It is returned for *matching*,
 * never for comparison: the value is replica-inconsistent and was measured
 * going backwards between two reads.
 */
export async function vectorIndexWatermark(index: VectorIndex): Promise<string | null> {
  const description = await index.describe();
  const watermark = description.processedUpToMutation;
  return typeof watermark === "string" && watermark.length > 0 ? watermark : null;
}

/**
 * Confirms the batches a watermark covers, by matching a mutation ID this
 * ledger recorded.
 *
 * The rule, and the reason it is not a comparison:
 *
 * - a batch is confirmed when the watermark **equals that batch's own mutation
 *   ID**, or the mutation ID of a batch this ledger submitted *after* it (our
 *   own submission order, which we do know, unlike the provider's);
 * - a watermark that matches nothing we recorded confirms nothing — on a shared
 *   index it is usually another workspace's mutation;
 * - a watermark that is *older* than one we already confirmed changes nothing.
 *   Confirmations are never withdrawn, so the ledger's `confirmed` is monotonic
 *   even though the provider's watermark is not.
 */
export function confirmVectorDeletes(
  ledger: VectorPurgeLedger,
  watermark: string | null,
  now: number
): VectorPurgeLedger {
  if (watermark === null) return ledger;
  const reached = ledger.batches.filter(
    (batch) => batch.mutationId !== null && batch.mutationId === watermark
  );
  if (reached.length === 0) return ledger;
  const upTo = Math.max(...reached.map((batch) => batch.n));
  let changed = false;
  const batches = ledger.batches.map((batch) => {
    if (batch.n > upTo || batch.mutationId === null || batch.confirmedAt !== null) return batch;
    changed = true;
    return { ...batch, confirmedAt: now };
  });
  if (!changed) return ledger;
  const complete = batches.every(
    (batch) => batch.mutationId === null ? false : batch.confirmedAt !== null
  );
  return {
    ...ledger,
    batches,
    phase: complete ? "complete" : "verifying",
    completedAt: complete ? now : null,
    updatedAt: now,
  };
}

/**
 * Every vector ID this workspace could have written, read from its own SQLite
 * before that SQLite is wiped.
 *
 * Two sources, and the pair is complete rather than a sample: a queue row holds
 * an intent that has not been accepted, and a state row holds a row the
 * provider accepted — `acceptUpserts` writes the state row and deletes the
 * queue row in one transaction, so nothing accepted can be missing from both.
 * IDs are re-derived from the stored row ID, which is why a row deleted from
 * the indexed table long ago still contributes its vector.
 */
export async function vectorIdsInWorkspace(
  sql: SqlExecutor,
  input: { binding: string; workspaceId: string; config: ConfiguredVectorize }
): Promise<string[]> {
  const rowIds = new Set<string>();
  for (const table of [VECTOR_QUEUE_TABLE, VECTOR_STATE_TABLE]) {
    let rows: Array<{ model: string; row_id: string }>;
    try {
      rows = sql.all<{ model: string; row_id: string }>(
        `SELECT DISTINCT model, row_id FROM "${table}"`
      );
    } catch {
      // Configured but not installed (a boot that never finished): no rows.
      continue;
    }
    for (const row of rows) rowIds.add(`${row.model}\u001f${String(row.row_id)}`);
  }
  const ids = await Promise.all(
    [...rowIds]
      .sort()
      .map((key) => {
        const [model, rowId] = key.split("\u001f") as [string, string];
        return vectorIdFor({
          binding: input.binding,
          workspaceId: input.workspaceId,
          model,
          field: input.config.field,
          rowId,
        });
      })
  );
  return [...new Set(ids)].sort();
}

/** One pass over the ledger. */
export interface VectorPurgeRun {
  /** Batches submitted in this pass. */
  submitted: number;
  /** Batches confirmed in this pass. */
  confirmed: number;
  /** Batches that failed and are waiting for their retry. */
  retried: number;
  /** Where the purge stands afterwards. */
  status: VectorPurgeStatus;
}

/**
 * The implementation. Bound to one workspace, one deployment and one index; a
 * caller passes the target again so a mismatch is refused rather than erasing
 * something else.
 */
export class VectorPurgeErasure implements VectorErasureHook {
  private readonly target: VectorPurgeTarget;
  private readonly now: () => number;

  constructor(private readonly deps: VectorErasureDeps) {
    this.target = { deployment: deps.deployment, workspace: deps.workspaceId };
    this.now = deps.now ?? Date.now;
  }

  private assertTarget(input: { binding: string; workspaceId: string }): void {
    if (input.workspaceId !== this.deps.workspaceId || input.binding !== this.deps.config.binding) {
      throw new Error(
        `This erasure belongs to workspace ${this.deps.workspaceId} on ${this.deps.config.binding}.`
      );
    }
  }

  async isFenced(input: { binding: string; workspaceId: string }): Promise<boolean> {
    this.assertTarget(input);
    return isVectorPurgeFenced(this.deps.bucket, this.target);
  }

  async status(input: { binding: string; workspaceId: string }): Promise<VectorPurgeStatus | null> {
    this.assertTarget(input);
    return this.read();
  }

  private async read(): Promise<VectorPurgeStatus | null> {
    const fenced = await isVectorPurgeFenced(this.deps.bucket, this.target);
    const stored = await readVectorPurgeLedger(this.deps.bucket, this.target);
    return vectorPurgeStatus(stored?.ledger ?? null, { fenced, now: this.now() });
  }

  /**
   * The fence, written before anything is deleted.
   *
   * Create-only, so a retried erase cannot move `fencedAt` forward, and cheap
   * to re-run: this is the step every other step depends on, and re-running it
   * after a crash is how the flow resumes without knowing where it stopped.
   */
  async fence(): Promise<void> {
    const marker = {
      version: VECTOR_PURGE_VERSION,
      deployment: this.deps.deployment,
      workspace: this.deps.workspaceId,
      index: this.deps.config.binding,
      namespace: await vectorNamespaceFor(this.deps.config.binding, this.deps.workspaceId),
      fencedAt: this.now(),
    } as const;
    await writeVectorPurgeMarker(this.deps.bucket, marker);
  }

  async erase(input: {
    binding: string;
    workspaceId: string;
    model: string;
    inventory?: () => Promise<readonly string[]>;
  }): Promise<VectorPurgeStatus> {
    this.assertTarget(input);
    // Fence first. Nothing below it — no delete, no inventory, no wipe of the
    // workspace — may run before the marker that refuses new submissions stands.
    await this.fence();

    let ledger = (await readVectorPurgeLedger(this.deps.bucket, this.target))?.ledger ?? null;
    if (ledger === null) {
      const ids = input.inventory === undefined ? [] : [...new Set(await input.inventory())].sort();
      const namespace = await vectorNamespaceFor(this.deps.config.binding, this.deps.workspaceId);
      const batches: VectorPurgeBatch[] = [];
      for (let offset = 0, n = 1; offset < ids.length; offset += VECTOR_PURGE_BATCH, n += 1) {
        const slice = ids.slice(offset, offset + VECTOR_PURGE_BATCH);
        await writeVectorPurgeIds(this.deps.bucket, this.target, n, slice);
        batches.push({
          n,
          ids: slice.length,
          mutationId: null,
          submittedAt: null,
          confirmedAt: null,
          attempts: 0,
          nextAttemptAt: 0,
          lastError: null,
        });
      }
      const at = this.now();
      ledger = await createVectorPurgeLedger(this.deps.bucket, this.target, {
        version: VECTOR_PURGE_VERSION,
        deployment: this.deps.deployment,
        workspace: this.deps.workspaceId,
        index: this.deps.config.binding,
        namespace,
        fencedAt: at,
        // An empty inventory is already "everything submitted": the purge then
        // verifies nothing and completes, because the workspace wrote no IDs.
        phase: batches.length === 0 ? "complete" : "deleting",
        batches,
        ids: ids.length,
        updatedAt: at,
        completedAt: batches.length === 0 ? at : null,
        lastError: null,
      });
    }
    await this.run();
    return (await this.read())!;
  }

  async resume(input: { binding: string; workspaceId: string }): Promise<VectorPurgeStatus | null> {
    this.assertTarget(input);
    const stored = await readVectorPurgeLedger(this.deps.bucket, this.target);
    if (stored === null) return this.read();
    if (stored.ledger.phase !== "complete") await this.run();
    return this.read();
  }

  /**
   * Submits what is due and confirms what the watermark matches, one batch at a
   * time, until there is nothing left that can be done now.
   *
   * A failed submission records the attempt and its backoff in the ledger and
   * stops the pass: the next alarm (or the next coordinator) picks it up. A
   * watermark that matches nothing leaves the batch submitted-and-unconfirmed,
   * which is the honest state — measured at ~75 s behind the delete, so most
   * passes end there and the purge finishes on a later one.
   */
  async run(options: { maxBatches?: number } = {}): Promise<VectorPurgeRun> {
    const run: VectorPurgeRun = { submitted: 0, confirmed: 0, retried: 0, status: (await this.read())! };
    const index = this.deps.index();
    const maxBatches = Math.max(1, options.maxBatches ?? 4);

    for (let step = 0; step < maxBatches * 2 + 2; step += 1) {
      const stored = await readVectorPurgeLedger(this.deps.bucket, this.target);
      if (stored === null) return run;
      const ledger = stored.ledger;
      if (ledger.phase === "complete") break;

      const now = this.now();
      const due = ledger.batches.find(
        (batch) =>
          batch.mutationId === null &&
          batch.attempts < VECTOR_PURGE_MAX_ATTEMPTS &&
          batch.nextAttemptAt <= now
      );

      if (due !== undefined) {
        if (index === null) {
          // No binding resolved in this room: the fence stands and the ledger
          // holds the work, so a deployment that forgot the binding loses the
          // purge's progress, never its record.
          await this.recordError("The Vectorize binding is not available in this room.");
          run.retried += 1;
          break;
        }
        try {
          const ids = await readVectorPurgeIds(this.deps.bucket, this.target, due.n);
          const { mutationId } = await index.deleteByIds(ids);
          await updateVectorPurgeLedger(this.deps.bucket, this.target, (current) => {
            const at = this.now();
            return {
              ...current,
              phase: "verifying",
              updatedAt: at,
              lastError: null,
              batches: current.batches.map((batch) =>
                batch.n === due.n
                  ? { ...batch, mutationId, submittedAt: at, nextAttemptAt: at, lastError: null }
                  : batch
              ),
            };
          });
          run.submitted += 1;
        } catch (error) {
          const message = truncate(errorMessage(error));
          await updateVectorPurgeLedger(this.deps.bucket, this.target, (current) => {
            const at = this.now();
            return {
              ...current,
              updatedAt: at,
              lastError: message,
              batches: current.batches.map((batch) => {
                if (batch.n !== due.n) return batch;
                const attempts = batch.attempts + 1;
                return {
                  ...batch,
                  attempts,
                  nextAttemptAt: at + nextBackoffDelay(attempts),
                  lastError: message,
                };
              }),
            };
          });
          run.retried += 1;
          break;
        }
        continue;
      }

      // Nothing to submit: confirm what the watermark matches, or stop.
      if (index === null) break;
      let watermark: string | null = null;
      try {
        watermark = await vectorIndexWatermark(index);
      } catch {
        // A describe() that failed says nothing about the delete's fate.
        break;
      }
      let confirmed = 0;
      const next = await updateVectorPurgeLedger(this.deps.bucket, this.target, (current) => {
        const updated = confirmVectorDeletes(current, watermark, this.now());
        confirmed = updated.batches.filter(
          (batch) => batch.confirmedAt !== null && current.batches.some((was) => was.n === batch.n && was.confirmedAt === null)
        ).length;
        return updated;
      });
      run.confirmed += confirmed;
      if (next.phase === "complete") break;
      if (confirmed === 0) break;
    }

    run.status = (await this.read())!;
    return run;
  }

  private async recordError(message: string): Promise<void> {
    await updateVectorPurgeLedger(this.deps.bucket, this.target, (current) => ({
      ...current,
      updatedAt: this.now(),
      lastError: message,
    })).catch(() => undefined);
  }
}

/** Builds the erasure a room uses. The room owns the bucket and the index lookup. */
export const VECTOR_ERASURE_HOOK = (deps: VectorErasureDeps): VectorPurgeErasure =>
  new VectorPurgeErasure(deps);

// ---- Restore -------------------------------------------------------------------

/**
 * The identity a workspace's vector bookkeeping belongs to: the binding and the
 * workspace whose IDs were derived. Recorded in `_engine_meta` so a restored or
 * copied SQLite can be told apart from one that belongs here.
 */
export interface VectorIdentity {
  binding: string;
  workspace: string;
}

const IDENTITY_KEY = "vector_identity";

/** The identity the stored bookkeeping was written under, or null before it was recorded. */
export function readVectorIdentity(sql: SqlExecutor): VectorIdentity | null {
  let row: { value?: string } | undefined;
  try {
    row = sql.one<{ value: string }>(`SELECT value FROM "_engine_meta" WHERE "key" = ?`, IDENTITY_KEY);
  } catch {
    return null;
  }
  if (typeof row?.value !== "string") return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<VectorIdentity>;
    return typeof parsed.binding === "string" && typeof parsed.workspace === "string"
      ? { binding: parsed.binding, workspace: parsed.workspace }
      : null;
  } catch {
    return null;
  }
}

/** Records which identity this workspace's queue and state belong to. */
export function recordVectorIdentity(sql: SqlExecutor, identity: VectorIdentity): void {
  sql.exec(
    `INSERT OR REPLACE INTO "_engine_meta" ("key", value) VALUES (?, ?)`,
    IDENTITY_KEY,
    JSON.stringify(identity)
  );
}

/** What a restore did to this workspace's vector bookkeeping. */
export interface VectorRestoreOutcome {
  /** True when the stored bookkeeping belonged to another identity. */
  adopted: boolean;
  /** Queue rows re-materialised under this workspace's identity. */
  reidentified: number;
  /** Queue rows dropped because a covering marker stands. */
  dropped: number;
  /** True when nothing may be indexed for these rows. */
  fenced: boolean;
}

/**
 * Makes a restored workspace's vector bookkeeping its own.
 *
 * The identity a vector ID is derived from includes the workspace, so a
 * restored row cannot be published under the ID it had in the workspace the
 * backup came from — that is what stops a copy from resurrecting vectors that
 * were erased at the source. This function makes sure the *bookkeeping* agrees:
 *
 * - bookkeeping written under another identity is discarded, and every
 *   surviving intent is marked unmaterialised so it is re-derived here;
 * - when the source's marker stands, the restored rows are not indexed at all:
 *   a backup of an erased workspace imports no vectors, however it was copied;
 * - when this workspace's own marker stands, nothing is indexed either.
 */
export function adoptRestoredVectors(
  sql: SqlExecutor,
  input: {
    binding: string;
    workspaceId: string;
    fencedSource: boolean;
    fencedDestination: boolean;
    now: number;
  }
): VectorRestoreOutcome {
  const current = readVectorIdentity(sql);
  const adopted = current === null || current.binding !== input.binding || current.workspace !== input.workspaceId;
  const fenced = input.fencedSource || input.fencedDestination;
  let reidentified = 0;
  let dropped = 0;
  try {
    if (fenced) {
      dropped = Number(
        sql.one<{ total: number }>(`SELECT COUNT(*) AS total FROM "${VECTOR_QUEUE_TABLE}"`)?.total ?? 0
      );
      sql.exec(`DELETE FROM "${VECTOR_QUEUE_TABLE}"`);
      sql.exec(`DELETE FROM "${VECTOR_STATE_TABLE}"`);
    } else if (adopted) {
      // The digests name what the provider accepted for *another* identity, so
      // none of them describe this workspace's index; dropping them forces a
      // full re-publication under this workspace's IDs.
      sql.exec(`DELETE FROM "${VECTOR_STATE_TABLE}"`);
      reidentified = Number(
        sql.one<{ total: number }>(`SELECT COUNT(*) AS total FROM "${VECTOR_QUEUE_TABLE}"`)?.total ?? 0
      );
      sql.exec(
        `UPDATE "${VECTOR_QUEUE_TABLE}"
            SET materialised_seq = 0, vector_id = NULL, digest = NULL, payload = NULL,
                attempts = 0, next_attempt_at = ?, last_error = NULL`,
        input.now
      );
    }
  } catch {
    // No queue table: nothing was ever captured, so there is nothing to adopt.
  }
  recordVectorIdentity(sql, { binding: input.binding, workspace: input.workspaceId });
  return { adopted, reidentified, dropped, fenced };
}
