/**
 * The erasure seam — left deliberately empty in this slice.
 *
 * Deleting a *row* is handled here: it enqueues a delete of that row's vector,
 * retried from the alarm like any other intent. Erasing a *workspace* is not,
 * and this file is the named place where that work attaches.
 *
 * Why it cannot be bolted onto the queue: an erasure must survive the room and
 * its alarm being destroyed (the Durable Object is emptied), it must fence new
 * submissions before deleting anything, and it must account for an upsert that
 * was accepted before the wipe and whose answer was lost — a single empty
 * provider read after a timeout is not evidence, because the provider's
 * mutations are asynchronous. That needs a ledger outside the workspace
 * (specification revision 3, §5: `vector-purge/<deployment>/<workspace>/` in
 * the existing DATA bucket), the fence → drain → delete → verify flow, and the
 * restore-time check that a copied backup cannot carry old embeddings into a
 * new namespace.
 *
 * So this slice ships:
 *
 * - row deletes through `_vector_queue`, which is everything the queue can
 *   honestly cover;
 * - `VectorErasureHook` below, empty and unwired, as the one place a later
 *   slice implements the rest. `WorkspaceRoom` does not call it, no code path
 *   depends on it, and nothing here deletes anything.
 *
 * A workspace erased through the existing erase path therefore leaves its
 * vectors in the index. They are unreachable — search is not implemented in
 * this slice, and the search gate re-reads every candidate from SQLite, which
 * an erased workspace no longer has — but they are not *gone*, and only the
 * ledger above can make them gone. That is the open work, stated rather than
 * implied.
 */

/**
 * The operations a later slice adds, named here so the room's erase path has
 * somewhere to attach without touching the queue.
 */
export interface VectorErasureHook {
  /**
   * Fences new submissions for a workspace, then accounts for every upsert that
   * may have reached the provider, deletes them, and verifies the deletion.
   * Resolves when the provider holds nothing for the workspace, or rejects so
   * the caller retries.
   */
  erase(input: { binding: string; workspaceId: string; model: string }): Promise<void>;
  /**
   * Whether a workspace may be opened to indexing, a restore or a rebuild:
   * false while its erasure marker stands.
   */
  isFenced(input: { binding: string; workspaceId: string }): Promise<boolean>;
}

/**
 * What this build wires: nothing. Present so the absence is a named value a
 * reader can grep for rather than a comment nobody finds.
 */
export const VECTOR_ERASURE_HOOK: VectorErasureHook | null = null;
