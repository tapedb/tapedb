/**
 * React-free client surface.
 *
 * Everything here runs in a Worker, a Node script or a test. The React bindings
 * live in `tapedb/react`, which is the only entry allowed to import React.
 */

export { id } from "./id";
export { i } from "./schema";
export type {
  AttributeDefinition,
  DataClient,
  DataRoom,
  PresencePeer,
  EntityDefinition,
  InitConfig,
  LinkDefinition,
  LinkSide,
  OutboxEntry,
  QueryComparison,
  QueryDocument,
  QueryEntity,
  QueryError,
  QueryNode,
  QueryOptions,
  QueryResult,
  QueryState,
  QueryWhere,
  SchemaDefinition,
  TransactInput,
  TxEntity,
  TxOp,
  TxProxy,
  TxStep,
} from "./types";

export { createOutbox, OUTBOX_DB_NAME, OUTBOX_STORE_NAME } from "./outbox";
export type { Outbox, OutboxOptions } from "./outbox";

export {
  applyOptimisticOp,
  applyOptimisticOps,
  applyQueryDiff,
} from "./query-cache";
export type { NamespaceDiff } from "./query-cache";

export { QuerySocket } from "./socket";
export type {
  QuerySocketOptions,
  WebSocketFactory,
  WebSocketLike,
} from "./socket";

export { stableStringify, cloneJson } from "./stable";

export {
  createStorageClient,
  StorageError,
  MAX_STORAGE_UPLOAD_BYTES,
} from "./storage-client";
export type {
  StorageClient,
  StorageClientConfig,
  StorageFetch,
  StorageObject,
} from "./storage-client";
