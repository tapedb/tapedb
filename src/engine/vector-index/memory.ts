/**
 * An in-memory `VectorIndex`, for tests.
 *
 * This is a double for a platform binding, and it proves only what a double
 * can: that the queue enqueues the right rows, computes the right digest,
 * batches, retries, coalesces and orders. It does **not** prove the provider's
 * semantics — visibility lag, asynchronous acceptance, idempotent deletion of
 * an absent ID, `topK` ceilings, metadata-index requirements. Those were
 * measured on a live index during the design spike and are cited there; a
 * green suite here is not evidence for any of them.
 *
 * It is deliberately strict where the real binding is lenient about nothing:
 * it refuses a record whose ID is over 64 bytes and one whose values are not
 * the declared length, so a queue bug that would have reached the provider
 * fails here first.
 */

import type {
  VectorIndex,
  VectorIndexDescription,
  VectorIndexMutation,
  VectorMatch,
  VectorQueryOptions,
  VectorQueryResult,
  VectorRecord,
} from "./types";

/** One stored vector, as this double keeps it. */
interface StoredVector extends VectorRecord {
  metadata: Record<string, string | number | boolean>;
}

export class MemoryVectorIndex implements VectorIndex {
  private readonly vectors = new Map<string, StoredVector>();
  private mutations = 0;

  /** Every upsert call, in order, as the batch it was given. */
  readonly upsertCalls: VectorRecord[][] = [];
  /** Every delete call, in order, as the IDs it was given. */
  readonly deleteCalls: string[][] = [];

  /**
   * While set, every mutation rejects with this message. Used to prove a commit
   * survives an index outage and that the queue retries rather than drops.
   */
  failWith: string | null = null;

  /**
   * What the double reports as processed, which is the last mutation it
   * accepted. A test overwrites it to model what a live index does and a double
   * otherwise cannot: a replica whose watermark is *behind* the delete it was
   * given, or one that moved backwards between two reads. Nothing here
   * simulates the provider's real lag — that was measured on a live index.
   */
  processedUpToMutation: string | null = null;

  constructor(
    readonly name: string,
    readonly dimensions: number,
    readonly metric = "cosine"
  ) {}

  async upsert(vectors: readonly VectorRecord[]): Promise<VectorIndexMutation> {
    this.upsertCalls.push(vectors.map((vector) => ({ ...vector, values: [...vector.values] })));
    this.fail();
    for (const vector of vectors) {
      if (new TextEncoder().encode(vector.id).length > 64) {
        throw new Error(`vector id ${JSON.stringify(vector.id)} is longer than 64 bytes.`);
      }
      if (vector.values.length !== this.dimensions) {
        throw new Error(
          `vector ${vector.id} holds ${vector.values.length} values; this index takes ${this.dimensions}.`
        );
      }
      this.vectors.set(this.key(vector.namespace, vector.id), {
        ...vector,
        values: [...vector.values],
        metadata: { ...(vector.metadata ?? {}) },
      });
    }
    return this.accept();
  }

  async deleteByIds(ids: readonly string[]): Promise<VectorIndexMutation> {
    this.deleteCalls.push([...ids]);
    this.fail();
    for (const id of ids) {
      for (const key of [...this.vectors.keys()]) {
        if (key.endsWith(`\u001f${id}`)) this.vectors.delete(key);
      }
    }
    return this.accept();
  }

  async query(vector: readonly number[], options: VectorQueryOptions = {}): Promise<VectorQueryResult> {
    this.fail();
    const topK = options.topK ?? 5;
    const scored: VectorMatch[] = [];
    for (const stored of this.vectors.values()) {
      if (options.namespace !== undefined && stored.namespace !== options.namespace) continue;
      if (!matchesFilter(stored.metadata, options.filter)) continue;
      scored.push({
        id: stored.id,
        score: cosine(vector, stored.values),
        ...(options.returnValues === true ? { values: [...stored.values] } : {}),
        ...(stored.namespace === undefined ? {} : { namespace: stored.namespace }),
        ...(options.returnMetadata === undefined || options.returnMetadata === "none"
          ? {}
          : { metadata: { ...stored.metadata } }),
      });
    }
    scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    const matches = scored.slice(0, Math.max(0, topK));
    return { matches, count: matches.length };
  }

  async describe(): Promise<VectorIndexDescription> {
    return {
      name: this.name,
      dimensions: this.dimensions,
      metric: this.metric,
      processedUpToMutation: this.processedUpToMutation,
    };
  }

  /** A mutation the double accepted: the watermark reaches it immediately. */
  private accept(): VectorIndexMutation {
    const mutationId = `memory-${++this.mutations}`;
    this.processedUpToMutation = mutationId;
    return { mutationId };
  }

  /** How many vectors the index holds. */
  get size(): number {
    return this.vectors.size;
  }

  /** The stored vector for an ID in a namespace, for assertions. */
  get(id: string, namespace?: string): StoredVector | undefined {
    return this.vectors.get(this.key(namespace, id));
  }

  private key(namespace: string | undefined, id: string): string {
    return `${namespace ?? ""}\u001f${id}`;
  }

  private fail(): void {
    if (this.failWith !== null) throw new Error(this.failWith);
  }
}

function matchesFilter(
  metadata: Record<string, string | number | boolean>,
  filter: Record<string, string | number | boolean> | undefined
): boolean {
  if (filter === undefined) return true;
  return Object.entries(filter).every(([name, value]) => metadata[name] === value);
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
