/**
 * The Cloudflare Vectorize binding, behind `VectorIndex`.
 *
 * The binding is the platform's own object (`env.MY_INDEX`): four methods, all
 * asynchronous, `upsert` and `deleteByIds` answering with a mutation ID. This
 * file is only the adapter — array shapes, `readonly` to mutable, and a
 * mutation ID that is always a string. There is deliberately no retry,
 * batching or digest logic here: those belong to the queue, which has durable
 * state to retry with.
 *
 * The binding is looked up by name at drain time, so a deployment that does not
 * ask for vector search never needs the binding to exist, never has one
 * resolved, and its `Env` needs nothing added.
 */

import type {
  VectorIndex,
  VectorIndexDescription,
  VectorIndexMutation,
  VectorQueryOptions,
  VectorQueryResult,
  VectorRecord,
} from "./types";

/**
 * The parts of `VectorizeIndex` this adapter calls. Structurally satisfied by
 * the real binding; declared here so the adapter compiles without the global
 * binding type and so a test can stand in a recording stub.
 */
export interface VectorizeBinding {
  upsert(vectors: Array<Record<string, unknown>>): Promise<{ mutationId?: string } | undefined>;
  deleteByIds(ids: string[]): Promise<{ mutationId?: string } | undefined>;
  query(vector: number[], options?: Record<string, unknown>): Promise<unknown>;
  describe(): Promise<Record<string, unknown>>;
}

/** True for anything that answers the four methods the adapter needs. */
export function isVectorizeBinding(value: unknown): value is VectorizeBinding {
  const candidate = value as Partial<VectorizeBinding> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.upsert === "function" &&
    typeof candidate.deleteByIds === "function" &&
    typeof candidate.query === "function" &&
    typeof candidate.describe === "function"
  );
}

/** Wraps a Vectorize binding as a `VectorIndex`. */
export function cloudflareVectorIndex(binding: VectorizeBinding, name?: string): VectorIndex {
  return {
    async upsert(vectors: readonly VectorRecord[]): Promise<VectorIndexMutation> {
      const accepted = await binding.upsert(vectors.map(toBindingVector));
      return { mutationId: mutationIdOf(accepted) };
    },

    async deleteByIds(ids: readonly string[]): Promise<VectorIndexMutation> {
      const accepted = await binding.deleteByIds([...ids]);
      return { mutationId: mutationIdOf(accepted) };
    },

    async query(vector: readonly number[], options: VectorQueryOptions = {}): Promise<VectorQueryResult> {
      const result = (await binding.query([...vector], {
        ...(options.topK === undefined ? {} : { topK: options.topK }),
        ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
        ...(options.filter === undefined ? {} : { filter: options.filter }),
        ...(options.returnValues === undefined ? {} : { returnValues: options.returnValues }),
        ...(options.returnMetadata === undefined ? {} : { returnMetadata: options.returnMetadata }),
      })) as
        | { matches?: Array<Record<string, unknown>>; count?: number }
        | undefined;

      const matches = (result?.matches ?? []).map((match) => ({
        id: String(match.id ?? ""),
        score: Number(match.score ?? 0),
        ...(Array.isArray(match.values) ? { values: (match.values as number[]).map(Number) } : {}),
        ...(typeof match.namespace === "string" ? { namespace: match.namespace } : {}),
        ...(isMetadata(match.metadata) ? { metadata: match.metadata } : {}),
      }));
      return { matches, count: Number(result?.count ?? matches.length) };
    },

    async describe(): Promise<VectorIndexDescription> {
      const details = await binding.describe();
      return {
        ...(name === undefined ? {} : { name }),
        ...(typeof details.dimensions === "number" ? { dimensions: details.dimensions } : {}),
        ...(typeof details.metric === "string" ? { metric: details.metric } : {}),
        // Forwarded for a purge to *match* a delete's own mutation ID. Nothing
        // compares it: it is replica inconsistent.
        ...(typeof details.processedUpToMutation === "string"
          ? { processedUpToMutation: details.processedUpToMutation }
          : {}),
      };
    },
  };
}

/** One `VectorRecord` in the binding's shape. */
function toBindingVector(record: VectorRecord): Record<string, unknown> {
  return {
    id: record.id,
    values: [...record.values],
    ...(record.namespace === undefined ? {} : { namespace: record.namespace }),
    ...(record.metadata === undefined ? {} : { metadata: { ...record.metadata } }),
  };
}

/**
 * The mutation ID, or an empty string when the binding answered without one:
 * it is recorded for correlation, and a missing one must not fail a drain that
 * the provider accepted.
 */
function mutationIdOf(accepted: { mutationId?: string } | undefined): string {
  return typeof accepted?.mutationId === "string" ? accepted.mutationId : "";
}

function isMetadata(value: unknown): value is Record<string, string | number | boolean> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
