/**
 * tapedb: a typed database for Cloudflare.
 *
 * Describe models with `schema()`, and `tapedb init` provisions a Durable
 * Object class and two R2 buckets in your account. Each workspace is one
 * SQLite database in one Durable Object, with its transaction log shipped to
 * R2. Read and write through `createClient()`: reads can be awaited or kept
 * live, writes are optimistic and survive going offline.
 *
 * This entry is React-free and has zero runtime dependencies. Hooks live in
 * `@tapedb/tapedb/react`, the Worker in `@tapedb/tapedb/worker`; the CLI is `npx @tapedb/tapedb`.
 */

export { createClient, Query, PageQuery, Write } from "./model/client";
export { AcrossError } from "./model/across";
export type { AcrossLiveState, AcrossQuery } from "./model/across";
export type {
  Across,
  AcrossModel,
  AcrossOptions,
  Client,
  ClientConfig,
  BroadcastTopic,
  ExportRecord,
  FilesClient,
  FindArgs,
  LiveState,
  ModelClient,
  Page,
  PageArgs,
  PresenceRoom,
  Result,
  SearchArgs,
  SearchFilter,
  SearchResult,
  WriteResult,
} from "./model/client";

export { schema, model, t, role, filter, check, sqlQuery } from "./schema";
/** A vector field's value and its one codec: `f32le:v1:<base64>`. */
export { encodeVector, decodeVector, VECTOR_TAG, VECTOR_MAX_DIMENSIONS } from "./schema";
export type {
  Access,
  AccessAuth,
  CheckContext,
  CreateData,
  DeleteBehaviour,
  FieldFilter,
  Include,
  OrderBy,
  Row,
  ScalarKind,
  Schema,
  UpdateData,
  Where,
} from "./schema";

export { id } from "./client/id";
/** The model map, the constraint on `Client`, `Schema` and every generic
 *  `createClient` takes: a typed helper cannot be written without it. */
export type { Models } from "./model/schema";
export type {
  HistoryEntry,
  StoredFile,
  WebhookDelivery,
  WebhookEndpointHealth,
  WebhookReport,
  WebhookRetryOutcome,
  WebhookRetryRequest,
  WorkspaceMetricsReport,
} from "./client/data-client";
export type { PresencePeer, PresenceError, PresenceSubscribeOptions, QueryError, TopicGap, TopicSender, WriteRejection } from "./client/types";
export type { StorageObject } from "./client/storage-client";

// The offline write queue: `createClient({ outbox })` takes one of these. The
// browser default is an IndexedDB store, so a runtime without IndexedDB — React
// Native — passes `AsyncStorageOutbox` from `@tapedb/react-native`.
export { createOutbox, IndexedDbOutbox, MemoryOutbox, scopedOutboxName } from "./client/outbox";
export type { Outbox, OutboxFactory, OutboxOptions } from "./client/outbox";
export { ASYNC_STORAGE_OUTBOX_PREFIX, AsyncStorageOutbox } from "./client/async-storage-outbox";
export type { AsyncStorageLike, AsyncStorageOutboxOptions } from "./client/async-storage-outbox";
export type { OutboxEntry } from "./client/types";

export { WORKSPACE_ROLE_LEVELS, hasRole, hasRoleLevel } from "./claims";
export type { RoleClaim, WorkspaceRole } from "./claims";
