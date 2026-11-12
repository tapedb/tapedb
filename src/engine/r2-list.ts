/**
 * Shared R2 helpers.
 *
 * `listAll` was duplicated in `durability/snapshot.ts` and
 * `durability/recovery.ts`; both must paginate identically or pruning and
 * replay disagree about which objects exist. One implementation now serves
 * every caller, including the document room.
 */

/** R2 accepts at most 1000 keys per delete call. */
const R2_DELETE_BATCH = 1000;

/** Lists every object under `prefix`, following the cursor to the end. */
export async function listAllR2(
  bucket: R2Bucket,
  prefix: string
): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = await bucket.list({ prefix, cursor });
    objects.push(...page.objects);
    if (!page.truncated || !page.cursor) break;
    cursor = page.cursor;
  }

  return objects;
}

/** Deletes keys in batches, so a large prune stays within the R2 call limit. */
export async function deleteR2Keys(
  bucket: R2Bucket,
  keys: string[]
): Promise<void> {
  for (let index = 0; index < keys.length; index += R2_DELETE_BATCH) {
    await bucket.delete(keys.slice(index, index + R2_DELETE_BATCH));
  }
}
