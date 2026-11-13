import type { StorageClient } from "./storage-client";

/**
 * Types for the client runtime: engine query documents, wire ops, outbox
 * entries and the runtime facade the model client drives. They mirror the
 * engine's wire contracts without importing the engine, so the client bundle
 * stays free of server code.
 */

// ---- Schema builders -------------------------------------------------------

export type AttributeType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "json"
  | "any";

export interface AttributeDefinition<T = unknown> {
  readonly type: AttributeType;
  readonly isOptional: boolean;
  readonly isIndexed: boolean;
  readonly isUnique: boolean;
  optional(): AttributeDefinition<T>;
  indexed(): AttributeDefinition<T>;
  unique(): AttributeDefinition<T>;
}

export interface EntityDefinition {
  readonly type: "entity";
  readonly attrs: Record<string, AttributeDefinition<unknown>>;
}

export interface LinkSide {
  on: string;
  has: "one" | "many";
  label: string;
}

export interface LinkDefinition {
  forward: LinkSide;
  reverse: LinkSide;
}

export interface SchemaDefinition {
  entities: Record<string, EntityDefinition>;
  links: Record<string, LinkDefinition>;
}

// ---- Engine query documents ------------------------------------------------

export type QueryScalar = string | number | boolean | null;

export interface QueryComparison {
  $ne?: QueryScalar;
  $in?: QueryScalar[];
  $nin?: QueryScalar[];
  $gt?: QueryScalar;
  $gte?: QueryScalar;
  $lt?: QueryScalar;
  $lte?: QueryScalar;
}

export type QueryWhereValue = QueryScalar | QueryComparison;

export interface QueryWhere {
  [attribute: string]: QueryWhereValue | QueryWhere | QueryWhere[] | undefined;
  $or?: QueryWhere[];
  $and?: QueryWhere[];
  $not?: QueryWhere;
}

export interface QueryOptions {
  where?: QueryWhere;
  order?: Record<string, "asc" | "desc">;
  limit?: number;
  /**
   * Opaque cursor from a previous page's `pageInfo[namespace].nextCursor`.
   * The engine requires an explicit `order`, because a cursor is only
   * meaningful against a total order. `db.loadMore()` sends this for you.
   */
  after?: string;
  /** Top level only: report the total matching rows as `pageInfo[ns].count`. */
  count?: boolean;
}

export interface QueryNode {
  $?: QueryOptions;
  [link: string]: unknown;
}

export type QueryDocument = Record<string, QueryNode>;

/** One entity as returned by the engine. Nested links are plain properties. */
export type QueryEntity = Record<string, unknown>;

/** Result payload keyed by the requested top-level namespace names. */
export type QueryResult = Record<string, QueryEntity[]>;

export interface QueryError {
  code: string;
  message: string;
}

/** Truncation metadata the engine reports per namespace. */
export interface PageInfo {
  /** The effective limit, or null when the namespace is uncapped. */
  limit: number | null;
  /** Rows the engine returned after row-level view rules, not rows read. */
  returned: number;
  hasMore: boolean;
  /**
   * Opaque keyset cursor for the next page. Emitted only when `hasMore` is
   * true and the query has an explicit `order`; `db.loadMore()` passes it back
   * as `$: { after }`.
   */
  nextCursor?: string;
  /** Total matching rows, when the query asked for `count`. */
  count?: number;
  /** The groups, when the query asked for `aggregate`. */
  aggregate?: AggregateGroup[];
}

/** One group of an aggregate, as the engine reports it. */
export interface AggregateGroup {
  /** The group's key values; empty without a groupBy. */
  key: Record<string, unknown>;
  count?: number;
  countOf?: Record<string, number>;
  sum?: Record<string, number | null>;
  avg?: Record<string, number | null>;
  min?: Record<string, unknown>;
  max?: Record<string, unknown>;
}

export type QueryPageInfo = Record<string, PageInfo>;

export interface QueryState {
  data: QueryResult | null;
  isLoading: boolean;
  error: QueryError | null;
  /**
   * Per top-level namespace truncation metadata from the engine. `returned` is
   * the engine's own visible count; do not re-derive it from `data`.
   */
  pageInfo?: QueryPageInfo;
}

export interface PresencePeer {
  clientId: string;
  presence: unknown;
  cursor?: unknown;
  drag?: unknown;
}

// ---- Transactions ----------------------------------------------------------

export type TxOpKind =
  | "insert"
  | "patch"
  | "upsert"
  | "patchMany"
  | "deleteMany"
  | "update"
  | "merge"
  | "link"
  | "unlink"
  | "delete";

interface TxOpBase {
  op: TxOpKind;
  namespace: string;
  id: string;
}

export interface TxUpdateOp extends TxOpBase {
  op: "update";
  values: Record<string, unknown>;
}

export interface TxInsertOp extends TxOpBase {
  op: "insert";
  values: Record<string, unknown>;
}

export interface TxPatchOp extends TxOpBase {
  op: "patch";
  values: Record<string, unknown>;
}

/**
 * Creates the row from `create` when it is missing, otherwise writes `values`.
 * The engine decides inside the transaction, so the choice cannot race.
 */
export interface TxUpsertOp extends TxOpBase {
  op: "upsert";
  values: Record<string, unknown>;
  create: Record<string, unknown>;
}

export interface TxMergeOp extends TxOpBase {
  op: "merge";
  values: Record<string, unknown>;
}

export interface TxLinkOp extends TxOpBase {
  op: "link";
  link: string;
  targetId: string;
}

export interface TxUnlinkOp extends TxOpBase {
  op: "unlink";
  link: string;
  targetId: string;
}

export interface TxDeleteOp extends TxOpBase {
  op: "delete";
}

export interface TxPatchManyOp {
  op: "patchMany";
  namespace: string;
  where: Record<string, unknown>;
  values: Record<string, unknown>;
  /** Resume after this id: the engine's `more` cursor from the previous batch. */
  after?: string;
}

export interface TxDeleteManyOp {
  op: "deleteMany";
  namespace: string;
  where: Record<string, unknown>;
  after?: string;
}

export type TxOp =
  | TxPatchManyOp
  | TxDeleteManyOp
  | TxInsertOp
  | TxPatchOp
  | TxUpsertOp
  | TxUpdateOp
  | TxMergeOp
  | TxLinkOp
  | TxUnlinkOp
  | TxDeleteOp;

/** A group of ops that travels together. */
export interface TxStep {
  readonly ops: readonly TxOp[];
  readonly op: TxOp;
}

export type TransactInput = ReadonlyArray<
  TxStep | TxOp | ReadonlyArray<TxStep | TxOp>
>;


// ---- Outbox ----------------------------------------------------------------

export interface OutboxEntry {
  clientTxId: string;
  txId: string;
  workspaceId: string;
  ops: TxOp[];
  createdAt: number;
  /**
   * Highest workspace sequence the client had observed when it created this
   * write. Sent on retries so the server can refuse one it cannot dedupe.
   */
  basisSeq?: number;
  /** Sends started so far, persisted before each send. Absent means unknown. */
  attempts?: number;
}

/** A queued write the server refused for good and the outbox dropped. */
export interface WriteRejection {
  clientTxId: string;
  ops: TxOp[];
  code: string;
  message: string;
}

// ---- Config and public client ---------------------------------------------

export interface InitConfig {
  /** Workspace UUID. */
  workspaceId?: string;
  /** Engine origin, e.g. http://localhost:8787. */
  apiUrl?: string;
  /** Override the derived `${apiUrl}/engine/workspaces/:id/websocket` URL. */
  websocketUrl?: string;
  /** Returns a short-lived role-claim JWT for every HTTP/WS request. */
  getToken?: () => Promise<string>;
  schema?: SchemaDefinition;
  /**
   * Called when a queued write is refused permanently during a background
   * flush, after the outbox has dropped it. `code` "dedupe_expired" means the
   * server could not tell whether an earlier attempt landed, so it applied
   * nothing: check the data before writing again.
   */
  onWriteRejected?: (rejection: WriteRejection) => void;
}

/** Ephemeral presence channel on this client's workspace socket. */
export interface DataRoom {
  publishPresence(presence: unknown): void;
  publishCursor(cursor: unknown): void;
  publishDrag(drag: unknown): void;
  clearDrag(): void;
  subscribePresence(listener: (peers: PresencePeer[]) => void): () => void;
  /** Clears local presence; subscription disposers remain owned by their callers. */
  leave(): void;
}

export interface DataClient {
  transact(input: TransactInput): Promise<"applied" | "queued">;
  /** Files scoped to the configured workspace and authenticated by its claim. */
  files: StorageClient;
  /** Reuses the workspace socket and its reconnect/replay behavior. */
  room(target: string): DataRoom;

  /** Test/dev helper: empties the pending outbox for this workspace. */
  clearOutbox(): Promise<void>;
  /** Retries pending writes now (also runs on reconnect and `online`). */
  flushOutbox(): Promise<void>;

  /** Subscribes to a query document; the model client's live reads use it. */
  subscribeQuery(query: QueryDocument, listener: () => void): () => void;

  /** Current cached state for a query, without subscribing to it. */
  getQueryState(query: QueryDocument): QueryState;

  /**
   * Requests the next page for the cached query and appends it.
   *
   * Uses `pageInfo[namespace].nextCursor` for each **top-level** namespace that
   * reported one, re-requests with `$: { ...options, after: cursor }`, appends
   * the new rows deduped by `id`, and updates `pageInfo`. Resolves to `false`
   * when there is no cursor left (first page not loaded yet, or exhausted).
   *
   * Nested link results arrive with the page and are not paginated: a cursor is
   * only defined for the top-level namespace's order.
   *
   * After a page lands the live subscription widens to every loaded row, so a
   * reconnect restores the whole window.
   */
  loadMore(query: QueryDocument): Promise<boolean>;

  /** Opens the shared WebSocket (lazy; safe to call repeatedly). */
  connect(): Promise<void>;

  /** Publishes this client's presence for a target (e.g. a diagram id). */
  publishPresence(target: string, presence: unknown): void;

  /** Publishes this client's cursor for a target. */
  publishCursor(target: string, cursor: unknown): void;

  /** Publishes an ephemeral drag preview for a target. */
  publishDrag(target: string, drag: unknown): void;

  /** Clears this client's drag preview for a target. */
  clearDrag(target: string): void;

  /** Removes this client's presence for a target. */
  clearPresence(target: string): void;

  /** Subscribes to the peer snapshot for a target; immediate first call. */
  subscribePresence(
    target: string,
    listener: (peers: PresencePeer[]) => void
  ): () => void;

  /** Stops reconnection timers and closes the socket. */
  close(): void;
}

// ---- WebSocket wire contract ----------------------------------------------

export type ClientMessage =
  | { type: "query:subscribe"; id: string; query: QueryDocument }
  | { type: "query:unsubscribe"; id: string }
  | { type: "presence:set"; target: string; presence: unknown }
  | { type: "presence:clear"; target: string }
  | { type: "cursor:set"; target: string; cursor: unknown }
  | { type: "drag:set"; target: string; drag: unknown }
  | { type: "drag:clear"; target: string }
  | { type: "ping"; at?: unknown };

export type ServerMessage =
  | { type: "session:ready"; workspaceId: string; connections: number }
  | { type: "session:error"; code: string; message: string }
  | { type: "pong"; at?: unknown; now: number }
  | {
      type: "query:data";
      id: string;
      seq: number;
      data: QueryResult;
      pageInfo?: QueryPageInfo;
    }
  | {
      type: "query:diff";
      id: string;
      seq: number;
      namespace: string;
      added: unknown[];
      updated: unknown[];
      removed: string[];
      pageInfo?: QueryPageInfo;
    }
  | { type: "query:unsubscribed"; id: string }
  | { type: "query:error"; id: string | null; code: string; message: string }
  | { type: "presence:update"; target: string; peers: PresencePeer[] }
  | {
      type: "cursor:update";
      target: string;
      clientId: string;
      cursor: unknown;
    }
  | { type: "drag:update"; target: string; clientId: string; drag: unknown }
  | { type: "error"; code: string; message?: string };
