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
  VectorSubmissionGate,
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
  VECTOR_DEAD_LETTER_ATTEMPTS,
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
  type VectorQueueStatus,
} from "./queue";
export {
  VECTOR_ERASURE_HOOK,
  VectorPurgeErasure,
  adoptRestoredVectors,
  confirmVectorDeletes,
  readVectorIdentity,
  recordVectorIdentity,
  vectorIdsInWorkspace,
  vectorIndexWatermark,
  type VectorErasureDeps,
  type VectorErasureHook,
  type VectorIdentity,
  type VectorPurgeRun,
  type VectorRestoreOutcome,
} from "./erasure";
export {
  VECTOR_PURGE_BATCH,
  VECTOR_PURGE_MAX_ATTEMPTS,
  VECTOR_PURGE_PREFIX,
  VECTOR_PURGE_VERSION,
  createVectorPurgeLedger,
  isVectorPurgeFenced,
  purgeRetryDelay,
  readVectorPurgeIds,
  readVectorPurgeLedger,
  readVectorPurgeMarker,
  updateVectorPurgeLedger,
  vectorPurgeIdsKey,
  vectorPurgeLedgerKey,
  vectorPurgeMarkerKey,
  vectorPurgePrefix,
  vectorPurgeStatus,
  writeVectorPurgeIds,
  writeVectorPurgeMarker,
  type VectorPurgeBatch,
  type VectorPurgeLedger,
  type VectorPurgeMarker,
  type VectorPurgeStatus,
  type VectorPurgeTarget,
} from "./purge-ledger";
