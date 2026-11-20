/**
 * The index side of a vector field.
 *
 * `resolveVectorize` validates `defineTapeDB({ vectorize })`; `installVectorCapture`
 * commits an intent with every write; `materialiseVectorIntents` turns intents
 * into digests; `drainVectorQueue` submits them from the durability alarm
 * through whatever `VectorIndex` the deployment has — the Cloudflare binding in
 * a Worker, `MemoryVectorIndex` in a test.
 *
 * Search is not here: this module publishes state to the index, it never reads
 * a query back.
 */

export type {
  VectorIndex,
  VectorIndexDescription,
  VectorIndexMutation,
  VectorMatch,
  VectorQueryOptions,
  VectorQueryResult,
  VectorRecord,
} from "./types";
export {
  VECTOR_DIGEST_CODEC,
  VECTOR_DIGEST_VERSION,
  vectorDigestPreimage,
  vectorRowDigest,
  type VectorDigestInput,
  type VectorFilterValue,
} from "./digest";
export {
  VECTOR_ID_MAX_BYTES,
  VECTOR_NAMESPACE_MAX_BYTES,
  vectorIdFor,
  vectorNamespaceFor,
} from "./identity";
export {
  VECTORIZE_FILTER_TYPES,
  VECTORIZE_MAX_FILTER_FIELDS,
  resolveVectorize,
  vectorIndexMatches,
  type ConfiguredVectorize,
  type VectorizeFilterField,
  type VectorizeFilterType,
  type VectorizeOptions,
} from "./definition";
export { cloudflareVectorIndex, isVectorizeBinding, type VectorizeBinding } from "./cloudflare";
export { MemoryVectorIndex } from "./memory";
export {
  VECTOR_DELETE_BATCH,
  VECTOR_FILTER_MAX_BYTES,
  VECTOR_MATERIALISE_LIMIT,
  VECTOR_QUEUE_TABLE,
  VECTOR_STATE_TABLE,
  VECTOR_UPSERT_BATCH,
  acceptedVectorDigest,
  drainVectorQueue,
  dropVectorCapture,
  installVectorCapture,
  materialiseVectorIntents,
  readVectorQueue,
  truncateUtf8,
  vectorQueueCounts,
  vectorQueueDueAt,
  type VectorDrainSummary,
  type VectorQueueCounts,
} from "./queue";
export { VECTOR_ERASURE_HOOK, type VectorErasureHook } from "./erasure";
