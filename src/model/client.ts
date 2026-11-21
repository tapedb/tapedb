/**
 * `createClient()`: one accessor per model, plus `$transaction`, `$files` and
 * `$presence`.
 *
 * Reads return a `Query`: await it for one result over HTTP, or subscribe to
 * it for live results over the workspace socket. Writes return a `Write`:
 * await it to send it alone, or pass several to `$transaction` to send them as
 * one log entry. Both are lazy, so building one costs nothing.
 */

import {
  createClientParts,
  type ClientDeps,
  type HistoryEntry,
  type DataClientImpl,
  type HeadlessDataClient,
  type StoredFile,
} from "../client/data-client";
import { stableStringify } from "../client/stable";
import type { Outbox, OutboxFactory } from "../client/outbox";
import type { StorageObject } from "../client/storage-client";
import type {
  AggregateGroup,
  PresencePeer,
  PresencePeersOptions,
  PresenceSubscribeOptions,
  TopicGap,
  TopicSender,
  QueryDocument,
  QueryError,
  QueryPageInfo,
  QueryResult,
  QueryState,
  TxOp,
  VectorSearchRequest,
  WriteRejection,
} from "../client/types";
import type {
  CreateData,
  Fields,
  FieldsOf,
  FilterKeys,
  Include,
  ModelInfo,
  Models,
  RelationInfo,
  OrderBy,
  Row,
  Schema,
  AggregateMeasures,
  AggregateOutput,
  GroupKeys,
  GroupRow,
  Select,
  Selected,
  UpdateData,
  WithInclude,
} from "./schema";
import { acrossModel, type AcrossQuery, type WorkspaceClients } from "./across";
import { plan, READ_METHODS } from "./plan";
import { splitSelect, toEngineWhere, type Where } from "./where";

// ---- Public types ----------------------------------------------------------

export interface LiveState<T> {
  /** Undefined until the first result arrives. */
  data: T | undefined;
  isLoading: boolean;
  error: QueryError | null;
}

export interface Page<R> {
  rows: R[];
  hasMore: boolean;
  /** Pass back as `after` for the next page; null on the last page. */
  cursor: string | null;
}

export interface WriteResult {
  id: string;
  /** "queued" when the send failed transiently and the outbox will retry. */
  status: "applied" | "queued";
}

export interface BulkResult {
  /**
   * Rows the filter matched, and therefore wrote. While the write is queued
   * offline: the cached rows it changed so far; the engine decides the rest
   * when the write reaches it.
   */
  count: number;
  /** Set while the write waits in the offline queue. */
  queued?: true;
}

export interface FindArgs<M extends Models, F extends Fields> {
  where?: Where<F, M>;
  orderBy?: OrderBy<F>;
  take?: number;
  include?: Include<M, F>;
  /**
   * Return only these fields. The engine reads and sends only them, plus the
   * id and sequence it needs for live updates; the result type narrows to
   * match. Relations named here are included. Not combined with `include`.
   */
  select?: Select<M, F>;
}

export interface AggregateArgs<M extends Models, F extends Fields> extends AggregateMeasures<F> {
  where?: Where<F, M>;
}

export interface GroupByArgs<M extends Models, F extends Fields> extends AggregateMeasures<F> {
  /** Fields to group by: one result row per distinct combination. */
  by: GroupKeys<F>[];
  where?: Where<F, M>;
  /** Orders groups by their key fields. Default: every key ascending. */
  orderBy?: Partial<Record<GroupKeys<F>, "asc" | "desc">>;
  /** At most this many groups (1 to 1000). */
  take?: number;
}

export interface PageArgs<M extends Models, F extends Fields> extends FindArgs<M, F> {
  /** A previous page's `cursor`. */
  after?: string | null;
}

/**
 * Equality on the attributes an index was declared to filter on, typed as each
 * attribute is.
 *
 * The client knows which attributes of the model are filterable; the
 * deployment's `vectorize.filterFields` is a subset of them, chosen in the
 * Worker, and an attribute outside that subset is refused by the engine
 * (`invalid_value`) rather than matched against nothing. A value of the wrong
 * type for its attribute is refused the same way.
 */
export type SearchFilter<F extends Fields> = Partial<
  Record<FilterKeys<F>, string | number | boolean>
>;

/**
 * What `search` takes: words or a query embedding, and what narrows the rows it
 * ranks. `text` and `vector` are alternatives.
 */
export interface SearchArgs<M extends Models, F extends Fields> {
  /**
   * The query embedding: the numbers a write takes for the same field. Send
   * this or `text`, not both.
   */
  vector?: number[];
  /**
   * The query in words. The engine embeds it with the deployment's
   * `vectorize.embed` binding, so the question goes through the same model the
   * corpus was embedded with and the caller never runs that model itself.
   */
  text?: string;
  /**
   * At most this many matches. Defaults to 10. A search returns at most 50 —
   * the provider's ceiling for a query that returns metadata — and a larger
   * number is refused, not clamped to 50.
   */
  limit?: number;
  /** Equality on the index's declared filter fields only. */
  filter?: SearchFilter<F>;
  /** The engine's `where`, applied to the candidate rows the index returned. */
  where?: Where<F, M>;
  /**
   * Return only these fields, as a read's `select` does. The embedding itself
   * is never returned, even when it is named here.
   */
  select?: Select<M, F>;
}

/**
 * What a search answers: rows in rank order, each with the score it was found
 * by, and `mode`/`reranked` saying what that score means.
 */
export interface SearchResult<R> {
  /** Nearest first. A row the caller may not read is simply not here. */
  rows: R[];
  /**
   * True when the index answered with as many candidates as the limit asked
   * for: there may be matches ranked below the last one returned.
   */
  truncated: boolean;
  /**
   * What the score means: `vector` is the provider's cosine similarity,
   * `hybrid` is a fused rank because the deployment indexes keyword fields and
   * the query was text. Comparable within one answer, not across modes.
   */
  mode: "vector" | "hybrid";
  /**
   * True when the deployment's reranker decided the order and the scores. Its
   * relevance replaces the retrieval score, so a reranked answer's score is not
   * comparable with an unreranked one.
   */
  reranked: boolean;
}

export type Result<M extends Models, F extends Fields, A> = (A extends { select: infer S }
  ? Selected<M, F, S>
  : Row<F>) &
  (A extends { include: infer I } ? WithInclude<M, F, I> : unknown);

export interface ModelClient<M extends Models, F extends Fields> {
  findMany<A extends FindArgs<M, F> = FindArgs<M, F>>(args?: A): Query<Result<M, F, A>[]>;
  /**
   * Nearest-neighbour search over the vector field this deployment indexes.
   *
   * Resolves to rows in rank order, each with its `score`, and whether the
   * answer was cut off at `limit`. It is a one-shot read: no cache, no live
   * updates. Read rules apply — a row the caller may not read is absent rather
   * than scored null — and a row the index still holds but the database no
   * longer does is dropped, so what comes back is what exists now.
   *
   * `vector` must be the field's declared length and `limit` 1 to 50 (default
   * 10); anything else is refused by the engine with `invalid_value`.
   *
   * @experimental May change in a minor release.
   */
  search<A extends SearchArgs<M, F> = SearchArgs<M, F>>(
    args: A
  ): Promise<SearchResult<Array<Result<M, F, A> & { score: number }>>>;
  findFirst<A extends FindArgs<M, F> = FindArgs<M, F>>(args?: A): Query<Result<M, F, A> | null>;
  findUnique<A extends { where: { id: string }; include?: Include<M, F>; select?: Select<M, F> }>(
    args: A
  ): Query<Result<M, F, A> | null>;
  /** One page in a stable order. Defaults to `orderBy: { id: "asc" }` (ids are time-ordered). */
  findPage<A extends PageArgs<M, F> = PageArgs<M, F>>(args?: A): PageQuery<Result<M, F, A>>;
  count(args?: { where?: Where<F, M> }): Query<number>;
  /**
   * Count, sum, average, minimum and maximum over the rows matching `where`,
   * as the caller's read rules see them. Await it or subscribe to it.
   *
   * @experimental The result shape may change in a minor release.
   */
  aggregate<A extends AggregateArgs<M, F>>(args: A): Query<AggregateOutput<F, A>>;
  /**
   * The same measures, one row per distinct value of the `by` fields.
   *
   * @experimental The result shape may change in a minor release.
   */
  groupBy<A extends GroupByArgs<M, F>>(args: A): Query<GroupRow<F, A>[]>;

  create(args: { data: CreateData<F, M> }): Write;
  /**
   * Writes every row matching `where`, in one transaction however many
   * match: it commits whole or not at all. Like single-row writes it is
   * queued offline and applied to the cache at once, to the cached rows it
   * certainly matches; the engine resolves which rows match when the write
   * reaches it, so a write queued offline applies to the rows matching then.
   */
  updateMany(args: { where: Where<F, M>; data: UpdateData<F, M> }): Promise<BulkResult>;
  /** Deletes every row matching `where`, in one transaction like `updateMany`. */
  deleteMany(args: { where: Where<F, M> }): Promise<BulkResult>;
  update(args: { where: { id: string }; data: UpdateData<F, M> }): Write;
  upsert(args: { where: { id: string }; create: CreateData<F, M>; update: UpdateData<F, M> }): Write;
  delete(args: { where: { id: string } }): Write;
}

export interface FilesClient {
  upload(file: Blob, options: { path: string }): Promise<StorageObject>;
  download(path: string): Promise<Blob>;
  delete(path: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<StoredFile[]>;
}

export interface PresenceRoom {
  set(presence: unknown): void;
  cursor(cursor: unknown): void;
  drag(drag: unknown): void;
  clearDrag(): void;
  /**
   * The peers in the room now, your own entry included and marked `isSelf`;
   * pass `{ includeSelf: false }` to leave it out.
   */
  peers(options?: PresencePeersOptions): Promise<PresencePeer[]>;
  /**
   * Listens for the room's peers until the returned function is called, with
   * the same self-exclusion as `peers()`.
   *
   * `onError` hears the engine refuse something this room asked for — a room
   * the authorizer denied, one past `maxPresenceRooms`, a state past the
   * socket's byte budget. A refusal leaves the peers and the subscription as
   * they were; the callback is the only sign it happened.
   */
  subscribe(
    listener: (peers: PresencePeer[]) => void,
    options?: PresenceSubscribeOptions
  ): () => void;
  leave(): void;
}

/**
 * A broadcast topic: fire-and-forget messages between clients of a workspace.
 *
 * @experimental May change in a minor release.
 */
export interface BroadcastTopic<T = unknown> {
  /**
   * Sends to every other client listening on the topic: `true`. While the
   * socket is down the message waits and goes out after reconnecting:
   * `"queued"` (up to 100 per topic, for 60 seconds). `false` when that
   * queue is full.
   */
  send(message: T): boolean | "queued";
  /**
   * Listens until the returned function is called. Your own messages are not
   * delivered back to you. `onError` hears refusals, such as an `authorize`
   * hook saying no. `onGap` hears a jump in the topic's sequence: messages
   * the replay window dropped while this client was away.
   */
  subscribe(
    listener: (message: T, from: TopicSender) => void,
    options?: {
      onError?: (error: QueryError) => void;
      onGap?: (gap: TopicGap) => void;
    }
  ): () => void;
  /**
   * The highest sequence this client has seen on the topic, or `undefined`
   * before the first one. Pass it to `subscribe` on a new listening session,
   * or to your own storage, to resume without asking for what you have.
   */
  readonly lastSeq: number | undefined;
  /**
   * The last run of sequences this client jumped over, or `null`. It stays
   * set until the topic is left: a lost message is a fact about this
   * subscription, not a state that clears itself once new ones arrive.
   * Resync from `lastSeq` and the gap stops being the last word on it.
   */
  readonly gap: TopicGap | null;
}

/** One line of `$export()`. */
export type ExportRecord<M extends Models = Models> =
  | {
      type: "header";
      format: "tapedb-export";
      version: 1;
      workspaceId: string;
      /** Workspace sequence when the export started. */
      seq: number;
      exportedAt: number;
      schemaVersion: string | null;
      /** Models exported, in order. */
      models: string[];
      /** Models the caller may not read, and why. */
      skipped: Array<{ model: string; reason: string }>;
    }
  | {
      [K in keyof M & string]: { type: "row"; model: K; data: Row<FieldsOf<M[K]>> };
    }[keyof M & string]
  | { type: "file"; file: StoredFile & { id: string; r2Key: string; createdAt: number; updatedAt: number } }
  | {
      type: "end";
      startSeq: number;
      /** Workspace sequence when the export finished. */
      seq: number;
      rows: number;
      counts: Record<string, number>;
      /** True when no write landed during the export: it is the workspace exactly at `seq`. */
      consistent: boolean;
    }
  | { type: "error"; code: string; message: string };

export interface ClientExtras {
  /** Sends several writes as one log entry: one sequence, all or nothing. */
  $transaction(writes: Write[]): Promise<WriteResult[]>;
  $files: FilesClient;
  $presence(room: string): PresenceRoom;
  /**
   * A broadcast topic on the workspace socket. Topics are 1-128 of A-Z a-z 0-9 : _ . -
   *
   * @experimental May change in a minor release.
   */
  $broadcast<T = unknown>(topic: string): BroadcastTopic<T>;
  /**
   * Every row the caller may read, model by model, then the file index, as
   * the engine streams it. Read rules apply. The last record is `end` (or
   * `error` if the export stopped).
   */
  $export(): AsyncIterable<ExportRecord<Models>>;
  /** Deletes a subject key so its personal fields become unreadable. Owners only. */
  $erasePerson(subject: string): Promise<void>;
  /**
   * Who changed one row and when, oldest first, within the retention.
   * Admins and owners only; needs `defineTapeDB({ audit: true })`.
   */
  $history(target: { model: keyof Models & string; id: string }): Promise<HistoryEntry[]>;
  /** Retries queued writes now (also runs on reconnect and when back online). */
  $flush(): Promise<void>;
  /** Closes the socket. */
  $close(): void;
}

/** One model's reads over several workspaces; every row carries its `workspaceId`. */
export interface AcrossModel<M extends Models, F extends Fields> {
  findMany<A extends FindArgs<M, F> = FindArgs<M, F>>(args?: A): AcrossQuery<Array<Result<M, F, A> & { workspaceId: string }>>;
  findFirst<A extends FindArgs<M, F> = FindArgs<M, F>>(args?: A): AcrossQuery<(Result<M, F, A> & { workspaceId: string }) | null>;
  findPage<A extends PageArgs<M, F> = PageArgs<M, F>>(args?: A): PromiseLike<Page<Result<M, F, A> & { workspaceId: string }>>;
  count(args?: { where?: Where<F, M> }): AcrossQuery<number>;
}

export type Across<M extends Models> = {
  [K in keyof M & string]: AcrossModel<M, FieldsOf<M[K]>>;
};

export interface AcrossOptions {
  /**
   * A claim for one workspace. Required unless the client uses the
   * development claim route (no `getToken`).
   */
  getToken?: (workspaceId: string) => Promise<string>;
}

export type Client<M extends Models> = {
  [K in keyof M & string]: ModelClient<M, FieldsOf<M[K]>>;
} & Omit<ClientExtras, "$export" | "$history"> & {
  /**
   * This socket's session id, assigned by the server on `session:ready` and
   * the same id a peer entry carries. Use it to tell which peer is you when
   * something needs the whole room. `undefined` until the socket opens, and
   * against a Worker that predates multiple presence rooms.
   */
  readonly clientId: string | undefined;
  $export(): AsyncIterable<ExportRecord<M>>;
  $history(target: { model: keyof M & string; id: string }): Promise<HistoryEntry[]>;
  /**
   * Reads over several workspaces: one request (or live socket) per
   * workspace with that workspace's claim, merged in `orderBy` order.
   * A workspace that fails rejects a one-off read with `AcrossError`
   * (the others' rows in `partial`) and shows in a live state's `errors`.
   */
  $across(workspaceIds: string[], options?: AcrossOptions): Across<M>;
};

export interface ClientConfig<M extends Models> {
  /** Claim subject; required for authenticated browser persistence. Recreate the client on account changes. */
  userId?: string;
  schema: Schema<M>;
  /** The Worker's origin, e.g. https://tapedb-app.<account-subdomain>.workers.dev or http://localhost:8787. */
  url: string;
  /** Workspace id (a UUID): which database this client talks to. */
  workspace: string;
  /** Returns a short-lived claim for every request. Omit in `tapedb dev`. */
  getToken?: () => Promise<string>;
  /** A queued write the engine refused for good during a background flush. */
  onWriteRejected?: (rejection: WriteRejection) => void;
  /**
   * Where writes wait for the network. Leave it out in a browser: the default
   * is an IndexedDB queue scoped to `userId`, replayed when the page loads.
   * Elsewhere that default does not survive a restart, so a runtime without
   * IndexedDB passes its own — React Native uses
   * `createReactNativeClient()` from `@tapedb/react-native`, which supplies
   * `AsyncStorageOutbox`. A factory is called once, for this client and the
   * `$across` clients it creates, so they share one queue.
   *
   * An injected outbox also replaces the browser's `userId` requirement: the
   * caller has already decided where the queue lives and how it is scoped.
   */
  outbox?: Outbox | OutboxFactory;
}

// ---- Runtime ---------------------------------------------------------------

interface Runtime {
  impl: DataClientImpl;
  parts: HeadlessDataClient;
  graph: Record<string, ModelInfo>;
  snapshots: Map<string, { state: QueryState; view: LiveState<unknown> }>;
}

type Project<T> = (data: QueryResult, pageInfo: QueryPageInfo) => T;

export class Query<T> implements PromiseLike<T> {
  /** Identifies the query: equal keys share one live subscription. */
  readonly key: string;

  constructor(
    protected readonly runtime: Runtime,
    readonly document: QueryDocument,
    private readonly project: Project<T>,
    kind: string
  ) {
    this.key = `${kind}:${stableStringify(document)}`;
  }

  then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): Promise<R1 | R2> {
    return this.runtime.impl
      .queryOnce(this.document)
      .then(({ data, pageInfo }) => this.project(data, pageInfo))
      .then(onFulfilled, onRejected);
  }

  catch<R = never>(onRejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<T | R> {
    return this.then(undefined, onRejected);
  }

  finally(onFinally?: (() => void) | null): Promise<T> {
    return this.then().finally(onFinally);
  }

  /** Live results. The listener runs now with the current state, then on every change. */
  subscribe(listener: (state: LiveState<T>) => void): () => void {
    const stop = this.runtime.impl.subscribeQuery(this.document, () => listener(this.snapshot()));
    listener(this.snapshot());
    return stop;
  }

  /**
   * The current live state. Referentially stable while nothing changed, so it
   * can back `useSyncExternalStore`.
   */
  snapshot(): LiveState<T> {
    const state = this.runtime.impl.getQueryState(this.document);
    const cached = this.runtime.snapshots.get(this.key);
    if (cached && cached.state === state) return cached.view as LiveState<T>;

    const view: LiveState<T> = {
      data: state.data === null ? undefined : this.project(state.data, state.pageInfo ?? {}),
      isLoading: state.isLoading,
      error: state.error,
    };
    this.runtime.snapshots.set(this.key, { state, view });
    return view;
  }
}

export class PageQuery<R> extends Query<Page<R>> {
  /** Live only: appends the next page to this subscription. False when there is none. */
  loadMore(): Promise<boolean> {
    return this.runtime.impl.loadMore(this.document);
  }
}

export class Write implements PromiseLike<WriteResult> {
  private sent: Promise<WriteResult> | null = null;

  constructor(
    private readonly runtime: Runtime,
    readonly ops: TxOp[],
    readonly id: string
  ) {}

  then<R1 = WriteResult, R2 = never>(
    onFulfilled?: ((value: WriteResult) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): Promise<R1 | R2> {
    this.sent ??= this.runtime.impl
      .transact(this.ops)
      .then((status) => ({ id: this.id, status }));
    return this.sent.then(onFulfilled, onRejected);
  }

  catch<R = never>(onRejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<WriteResult | R> {
    return this.then(undefined, onRejected);
  }

  finally(onFinally?: (() => void) | null): Promise<WriteResult> {
    return this.then().finally(onFinally);
  }
}

// ---- Client ----------------------------------------------------------------

function modelClient(runtime: Runtime, model: ModelInfo): ModelClient<Models, Fields> {
  const read = (method: string, args: unknown) => {
    const planned = plan(runtime.graph, model, method, args);
    if (planned.kind !== "read") throw new Error(`"${model.key}.${method}" is not a read.`);
    const Kind = planned.key === "page" ? PageQuery : Query;
    return new Kind(runtime, planned.document, planned.project as Project<never>, planned.key);
  };
  const write = (method: string, args: unknown) => {
    const planned = plan(runtime.graph, model, method, args);
    if (planned.kind !== "write") throw new Error(`"${model.key}.${method}" is not a write.`);
    return new Write(runtime, planned.ops, planned.id);
  };
  const bulk = async (method: string, args: unknown) => {
    const planned = plan(runtime.graph, model, method, args);
    if (planned.kind !== "bulk") throw new Error(`"${model.key}.${method}" is not a bulk write.`);
    return runtime.impl.bulk(planned.op);
  };

  /**
   * A search is not a query document: the engine takes the embedding, the
   * metadata filter and the limit directly, and answers with rows it re-read
   * plus a score per row. `where` and `select` are the client's own shapes, so
   * they are translated here the way a read translates them.
   */
  const search = async (args: SearchArgs<Models, Fields>) => {
    let fields: string[] | undefined;
    if (args.select !== undefined) {
      const { fields: selected, relations } = splitSelect(model, args.select as Record<string, unknown>);
      if (Object.keys(relations).length > 0) {
        throw new Error(
          `"${model.key}.search" returns rows, not relations: name fields in select, or read the linked rows separately.`
        );
      }
      fields = selected;
    }
    if (args.vector === undefined && args.text === undefined) {
      throw new Error(`"${model.key}.search" needs a query: send "text", or "vector" if you embed the question yourself.`);
    }
    if (args.vector !== undefined && args.text !== undefined) {
      throw new Error(`"${model.key}.search" takes "text" or "vector", not both.`);
    }
    const answer = await runtime.impl.searchOnce({
      model: model.key,
      ...(args.vector === undefined ? {} : { vector: args.vector }),
      ...(args.text === undefined ? {} : { text: args.text }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
      ...(args.filter === undefined ? {} : { filter: args.filter as Record<string, string | number | boolean> }),
      // The client's `where` mirror does not carry the engine-only `$link`, so
      // the translated value is handed over as the engine's shape.
      ...(args.where === undefined
        ? {}
        : { where: toEngineWhere(model, args.where) as unknown as VectorSearchRequest["where"] }),
      ...(fields === undefined ? {} : { select: fields }),
    });
    // The engine ranks and scores every row it returns, so a row without a
    // score is a contradiction rather than a row to show with 0.
    const rows = answer.rows.flatMap((row) => {
      const score = answer.scores[String(row.id)];
      return score === undefined ? [] : [{ ...row, score }];
    });
    return { rows, truncated: answer.truncated, mode: answer.mode, reranked: answer.reranked };
  };

  const client: Record<string, unknown> = {};
  for (const method of READ_METHODS) client[method] = (args?: unknown) => read(method, args);
  for (const method of ["create", "update", "upsert", "delete"]) client[method] = (args: unknown) => write(method, args);
  for (const method of ["updateMany", "deleteMany"]) client[method] = (args: unknown) => bulk(method, args);
  client.search = (args: SearchArgs<Models, Fields>) => search(args);
  return client as unknown as ModelClient<Models, Fields>;
}


/** Creates a client for one workspace. */
export function createClient<M extends Models>(
  config: ClientConfig<M>,
  deps: ClientDeps = {}
): Client<M> {
  // One queue for this client and every `$across` workspace client: resolve a
  // factory here, so it is called once rather than once per workspace.
  const injected = typeof config.outbox === "function" ? config.outbox() : config.outbox;
  const outbox = injected ?? deps.outbox;
  const { client: parts, impl } = createClientParts(
    {
      workspaceId: config.workspace,
      userId: config.userId,
      apiUrl: config.url,
      getToken: config.getToken,
      schema: config.schema.clientSchema,
      onWriteRejected: config.onWriteRejected,
    },
    outbox ? { ...deps, outbox } : deps
  );
  const runtime: Runtime = { impl, parts, graph: config.schema.graph, snapshots: new Map() };

  const extras: ClientExtras = {
    async $transaction(writes) {
      if (writes.length === 0) return [];
      const status = await impl.transact(writes.flatMap((write) => write.ops));
      return writes.map((write) => ({ id: write.id, status }));
    },
    $files: {
      upload: (file, { path }) => parts.files.upload(path, file),
      download: (path) => parts.files.download(path),
      delete: (path) => parts.files.delete(path),
      list: async ({ prefix } = {}) => {
        const files = await impl.listFiles();
        return prefix === undefined ? files : files.filter((file) => file.path.startsWith(prefix));
      },
    },
    $presence: (room) => ({
      set: (presence) => impl.publishPresence(room, presence),
      cursor: (cursor) => impl.publishCursor(room, cursor),
      drag: (drag) => impl.publishDrag(room, drag),
      clearDrag: () => impl.clearDrag(room),
      peers: (options) => impl.presencePeers(room, options),
      subscribe: (listener, options) => impl.subscribePresence(room, listener, options),
      leave: () => impl.clearPresence(room),
    }),
    $broadcast: <T>(topic: string): BroadcastTopic<T> => {
      if (!/^[A-Za-z0-9:_.-]{1,128}$/.test(topic)) {
        throw new Error(`"${topic}" is not a topic name: use 1-128 of A-Z a-z 0-9 : _ . -`);
      }
      return {
        send: (message) => impl.sendTopic(topic, message),
        subscribe: (listener, options) =>
          impl.subscribeTopic(topic, {
            message: (message, from) => listener(message as T, from),
            error: options?.onError,
            gap: options?.onGap,
          }),
        // Read through to the client: one topic, one position, however many
        // times `$broadcast(topic)` is called.
        get lastSeq() {
          return impl.topicLastSeq(topic);
        },
        get gap() {
          return impl.topicGap(topic);
        },
      };
    },
    $erasePerson: (subject) => impl.erasePerson(subject),
    $history: ({ model, id }) => impl.history(model, id),
    $export: () => impl.exportRecords() as AsyncIterable<ExportRecord<Models>>,
    $flush: () => impl.flushOutbox(),
    $close: () => {
      impl.close();
      for (const other of acrossClients.values()) other.$close();
      acrossClients.clear();
    },
  };

  // Workspace clients for `$across`, one per workspace and token source.
  const acrossClients = new Map<string, Client<M>>();
  const acrossTokens = new Map<string, (workspaceId: string) => Promise<string>>();
  const across = (workspaceIds: string[], options: AcrossOptions = {}): Across<M> => {
    if (!Array.isArray(workspaceIds) || workspaceIds.length === 0) {
      throw new Error("$across needs at least one workspace id.");
    }
    const ids = [...new Set(workspaceIds)];
    if (config.getToken && !options.getToken) {
      throw new Error("$across needs getToken(workspaceId): each workspace has its own claim.");
    }
    const clients = ids.map((workspaceId) => {
      if (workspaceId === config.workspace) return { workspaceId, client: client as unknown as Client<M> };
      // The latest getToken given for a workspace is the one its client uses.
      if (options.getToken) acrossTokens.set(workspaceId, options.getToken);
      let other = acrossClients.get(workspaceId);
      if (!other) {
        other = createClient(
          {
            ...config,
            workspace: workspaceId,
            // The same queue, already resolved: one outbox holds entries for
            // every workspace, keyed by `workspaceId`.
            ...(outbox ? { outbox } : {}),
            ...(options.getToken ? { getToken: () => acrossTokens.get(workspaceId)!(workspaceId) } : {}),
          },
          deps
        );
        acrossClients.set(workspaceId, other);
      }
      return { workspaceId, client: other };
    });
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(config.schema.graph)) {
      out[key] = acrossModel(
        clients.map(({ workspaceId, client: one }) => ({
          workspaceId,
          model: (one as unknown as Record<string, unknown>)[key] as WorkspaceClients[number]["model"],
        }))
      );
    }
    return out as Across<M>;
  };

  const client: Record<string, unknown> = {
    ...extras,
    $across: across,
    get clientId() {
      return impl.clientId;
    },
  };
  for (const [key, info] of Object.entries(config.schema.graph)) {
    client[key] = modelClient(runtime, info);
  }
  return client as Client<M>;
}
