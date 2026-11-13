/**
 * `createClient()`: one accessor per model, plus `$transaction`, `$files` and
 * `$presence`.
 *
 * Reads return a `Query`: await it for one result over HTTP, or subscribe to
 * it for live results over the workspace socket. Writes return a `Write`:
 * await it to send it alone, or pass several to `$transaction` to send them as
 * one log entry. Both are lazy, so building one costs nothing.
 *
 * Everything below translates into the engine's query documents and ops; the
 * socket, cache, outbox and retry logic are the same ones the engine client
 * has always used.
 */

import {
  createClientParts,
  type ClientDeps,
  type DataClientImpl,
  type HeadlessDataClient,
  type StoredFile,
} from "../client/data-client";
import { id as newId } from "../client/id";
import { stableStringify } from "../client/stable";
import type { StorageObject } from "../client/storage-client";
import type {
  PresencePeer,
  QueryDocument,
  QueryError,
  QueryPageInfo,
  QueryResult,
  QueryState,
  TxOp,
  WriteRejection,
} from "../client/types";
import type {
  CreateData,
  Fields,
  FieldsOf,
  Include,
  ModelInfo,
  Models,
  OrderBy,
  Row,
  Schema,
  UpdateData,
  WithInclude,
} from "./schema";
import { toEngineNode, toEngineWhere, type NodeArgs, type Where } from "./where";

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
  /** Rows the filter matched, and therefore wrote. */
  count: number;
}

export interface FindArgs<M extends Models, F extends Fields> {
  where?: Where<F, M>;
  orderBy?: OrderBy<F>;
  take?: number;
  include?: Include<M, F>;
}

export interface PageArgs<M extends Models, F extends Fields> extends FindArgs<M, F> {
  /** A previous page's `cursor`. */
  after?: string | null;
}

export type Result<M extends Models, F extends Fields, A> = Row<F> &
  (A extends { include: infer I } ? WithInclude<M, F, I> : unknown);

export interface ModelClient<M extends Models, F extends Fields> {
  findMany<A extends FindArgs<M, F> = FindArgs<M, F>>(args?: A): Query<Result<M, F, A>[]>;
  findFirst<A extends FindArgs<M, F> = FindArgs<M, F>>(args?: A): Query<Result<M, F, A> | null>;
  findUnique<A extends { where: { id: string }; include?: Include<M, F> }>(
    args: A
  ): Query<Result<M, F, A> | null>;
  /** One page in a stable order. Defaults to `orderBy: { id: "asc" }` (ids are time-ordered). */
  findPage<A extends PageArgs<M, F> = PageArgs<M, F>>(args?: A): PageQuery<Result<M, F, A>>;
  count(args?: { where?: Where<F, M> }): Query<number>;

  create(args: { data: CreateData<F> }): Write;
  /**
   * Writes every row matching `where`, up to 1000. Sent straight to the
   * engine, which resolves the rows: unlike single-row writes it is not
   * applied optimistically and not queued offline, because which rows match
   * is the engine's answer, not the cache's.
   */
  updateMany(args: { where: Where<F, M>; data: UpdateData<F> }): Promise<BulkResult>;
  /** Deletes every row matching `where`, up to 1000. Sent like `updateMany`. */
  deleteMany(args: { where: Where<F, M> }): Promise<BulkResult>;
  update(args: { where: { id: string }; data: UpdateData<F> }): Write;
  upsert(args: { where: { id: string }; create: CreateData<F>; update: UpdateData<F> }): Write;
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
  subscribe(listener: (peers: PresencePeer[]) => void): () => void;
  leave(): void;
}

export interface ClientExtras {
  /** Sends several writes as one log entry: one sequence, all or nothing. */
  $transaction(writes: Write[]): Promise<WriteResult[]>;
  $files: FilesClient;
  $presence(room: string): PresenceRoom;
  /** Retries queued writes now (also runs on reconnect and when back online). */
  $flush(): Promise<void>;
  /** Closes the socket. */
  $close(): void;
}

export type Client<M extends Models> = {
  [K in keyof M & string]: ModelClient<M, FieldsOf<M[K]>>;
} & ClientExtras;

export interface ClientConfig<M extends Models> {
  schema: Schema<M>;
  /** The Worker's origin, e.g. https://api.example.com or http://localhost:8787. */
  url: string;
  /** Workspace id (a UUID): which database this client talks to. */
  workspace: string;
  /** Returns a short-lived claim for every request. Omit in `tapedb dev`. */
  getToken?: () => Promise<string>;
  /** A queued write the engine refused for good during a background flush. */
  onWriteRejected?: (rejection: WriteRejection) => void;
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

// ---- Writes ----------------------------------------------------------------

function inputValue(model: ModelInfo, field: string, value: unknown): unknown {
  return model.scalars[field]?.kind === "date" && value instanceof Date ? value.getTime() : value;
}

/** Splits write data into column values and the link ops for hasMany relations. */
function splitData(
  model: ModelInfo,
  rowId: string,
  data: Record<string, unknown>,
  allowLinks: boolean
): { values: Record<string, unknown>; links: TxOp[] } {
  const values: Record<string, unknown> = {};
  const links: TxOp[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || key === "id") continue;
    if (key in model.scalars) {
      values[key] = inputValue(model, key, value);
      continue;
    }
    if (model.filterable.has(key)) {
      // A foreign key written directly, e.g. columnId.
      values[key] = value;
      continue;
    }
    const relation = model.relations[key];
    if (!relation) {
      throw new Error(`"${model.key}" has no field "${key}".`);
    }
    if (relation.kind === "belongsTo") {
      if (value === null || (value as { disconnect?: unknown }).disconnect === true) {
        values[relation.foreignKey!] = null;
      } else if (typeof (value as { connect?: unknown }).connect === "string") {
        values[relation.foreignKey!] = (value as { connect: string }).connect;
      } else {
        throw new Error(`"${model.key}.${key}" takes { connect: id }, { disconnect: true } or null.`);
      }
      continue;
    }
    if (!allowLinks) {
      throw new Error(`"${model.key}.${key}": connect children with create or update, not upsert.`);
    }
    const { connect = [], disconnect = [] } = value as { connect?: string[]; disconnect?: string[] };
    for (const targetId of connect) {
      links.push({ op: "link", namespace: model.key, id: rowId, link: relation.link, targetId });
    }
    for (const targetId of disconnect) {
      links.push({ op: "unlink", namespace: model.key, id: rowId, link: relation.link, targetId });
    }
  }

  return { values, links };
}

function withDefaults(model: ModelInfo, values: Record<string, unknown>): Record<string, unknown> {
  const filled = { ...values };
  for (const [field, scalar] of Object.entries(model.scalars)) {
    if (!(field in filled) && scalar.hasDefault) {
      filled[field] = inputValue(model, field, scalar.defaultValue);
    }
  }
  return filled;
}

function requireId(model: ModelInfo, where: { id?: unknown } | undefined): string {
  if (typeof where?.id !== "string" || where.id.length === 0) {
    throw new Error(`"${model.key}" writes address one row: pass where: { id }.`);
  }
  return where.id;
}

// ---- Client ----------------------------------------------------------------

function modelClient(runtime: Runtime, model: ModelInfo): ModelClient<Models, Fields> {
  const document = (args: NodeArgs, extra: Record<string, unknown> = {}): QueryDocument => ({
    [model.key]: toEngineNode(runtime.graph, model, args, extra) as QueryDocument[string],
  });
  const rows = (data: QueryResult) => (data[model.key] ?? []) as never[];

  return {
    findMany: (args?: NodeArgs) => new Query(runtime, document(args ?? {}), rows, "many"),
    findFirst: (args?: NodeArgs) =>
      new Query(runtime, document({ ...args, take: 1 }), (data) => rows(data)[0] ?? null, "first"),
    findUnique: (args: { where: { id?: unknown }; include?: Record<string, unknown> }) =>
      new Query(
        runtime,
        document({ where: { id: requireId(model, args.where) }, include: args.include, take: 1 }),
        (data) => rows(data)[0] ?? null,
        "first"
      ),
    findPage: (args?: NodeArgs & { after?: string | null }) => {
      const { after, ...rest } = args ?? {};
      return new PageQuery(
        runtime,
        document({
          ...rest,
          orderBy: rest.orderBy ?? { id: "asc" },
          take: rest.take ?? 50,
          ...(after ? { after } : {}),
        }),
        (data, pageInfo) => ({
          rows: rows(data),
          hasMore: pageInfo[model.key]?.hasMore ?? false,
          cursor: pageInfo[model.key]?.nextCursor ?? null,
        }),
        "page"
      );
    },
    count: (args?: { where?: unknown }) =>
      new Query(
        runtime,
        document({ where: args?.where }, { count: true, limit: 0 }),
        (_data, pageInfo) => pageInfo[model.key]?.count ?? 0,
        "count"
      ),

    create: ({ data }: { data: Record<string, unknown> }) => {
      const rowId = typeof (data as { id?: unknown }).id === "string" ? (data as { id: string }).id : newId();
      const { values, links } = splitData(model, rowId, data as Record<string, unknown>, true);
      return new Write(
        runtime,
        [{ op: "insert", namespace: model.key, id: rowId, values: withDefaults(model, values) }, ...links],
        rowId
      );
    },
    update: ({ where, data }: { where: { id?: unknown }; data: Record<string, unknown> }) => {
      const rowId = requireId(model, where);
      const { values, links } = splitData(model, rowId, data as Record<string, unknown>, true);
      return new Write(runtime, [{ op: "patch", namespace: model.key, id: rowId, values }, ...links], rowId);
    },
    upsert: ({ where, create, update }: { where: { id?: unknown }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const rowId = requireId(model, where);
      const created = splitData(model, rowId, create as Record<string, unknown>, false);
      const updated = splitData(model, rowId, update as Record<string, unknown>, false);
      return new Write(
        runtime,
        [
          {
            op: "upsert",
            namespace: model.key,
            id: rowId,
            values: updated.values,
            create: withDefaults(model, created.values),
          },
        ],
        rowId
      );
    },
    delete: ({ where }: { where: { id?: unknown } }) => {
      const rowId = requireId(model, where);
      return new Write(runtime, [{ op: "delete", namespace: model.key, id: rowId }], rowId);
    },

    updateMany: async ({ where, data }: { where: unknown; data: Record<string, unknown> }) => {
      const { values, links } = splitData(model, "", data, false);
      if (links.length > 0) {
        throw new Error(`"${model.key}.updateMany" cannot connect or disconnect relations.`);
      }
      return runtime.impl.bulk({
        op: "patchMany",
        namespace: model.key,
        where: toEngineWhere(model, where as never, runtime.graph) as Record<string, unknown>,
        values,
      });
    },
    deleteMany: async ({ where }: { where: unknown }) =>
      runtime.impl.bulk({
        op: "deleteMany",
        namespace: model.key,
        where: toEngineWhere(model, where as never, runtime.graph) as Record<string, unknown>,
      }),
  } as unknown as ModelClient<Models, Fields>;
}

/** Creates a client for one workspace. */
export function createClient<M extends Models>(
  config: ClientConfig<M>,
  deps: ClientDeps = {}
): Client<M> {
  const { client: parts, impl } = createClientParts(
    {
      workspaceId: config.workspace,
      apiUrl: config.url,
      getToken: config.getToken,
      schema: config.schema.clientSchema,
      onWriteRejected: config.onWriteRejected,
    },
    deps
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
      subscribe: (listener) => impl.subscribePresence(room, listener),
      leave: () => impl.clearPresence(room),
    }),
    $flush: () => impl.flushOutbox(),
    $close: () => impl.close(),
  };

  const client: Record<string, unknown> = { ...extras };
  for (const [key, info] of Object.entries(config.schema.graph)) {
    client[key] = modelClient(runtime, info);
  }
  return client as Client<M>;
}
