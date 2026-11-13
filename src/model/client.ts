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
  AggregateGroup,
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
import { shapeFor, toEngineNode, toEngineWhere, type NodeArgs, type Where } from "./where";

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

export type Result<M extends Models, F extends Fields, A> = A extends { select: infer S }
  ? Selected<M, F, S>
  : Row<F> & (A extends { include: infer I } ? WithInclude<M, F, I> : unknown);

export interface ModelClient<M extends Models, F extends Fields> {
  findMany<A extends FindArgs<M, F> = FindArgs<M, F>>(args?: A): Query<Result<M, F, A>[]>;
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
   */
  aggregate<A extends AggregateArgs<M, F>>(args: A): Query<AggregateOutput<F, A>>;
  /** The same measures, one row per distinct value of the `by` fields. */
  groupBy<A extends GroupByArgs<M, F>>(args: A): Query<GroupRow<F, A>[]>;

  create(args: { data: CreateData<F, M> }): Write;
  /**
   * Writes every row matching `where`. Sent straight to the engine, which
   * resolves the rows: unlike single-row writes it is not applied
   * optimistically and not queued offline, because which rows match is the
   * engine's answer, not the cache's.
   *
   * Up to 1000 rows commit as one transaction. Past that the rows are written
   * in batches of 1000, in id order, each its own transaction; if one fails,
   * a `BulkWriteError` reports how many rows the earlier batches wrote, and
   * running the same call again continues with the rows still matching.
   */
  updateMany(args: { where: Where<F, M>; data: UpdateData<F, M> }): Promise<BulkResult>;
  /** Deletes every row matching `where`. Batched like `updateMany`. */
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


interface SplitResult {
  values: Record<string, unknown>;
  /** Rows this one points at: inserted before it, so its key resolves. */
  before: TxOp[];
  /** Rows that point at this one, and link ops: applied after it exists. */
  after: TxOp[];
}

function splitData(
  graph: Record<string, ModelInfo>,
  model: ModelInfo,
  rowId: string,
  data: Record<string, unknown>,
  allowLinks: boolean
): SplitResult {
  const values: Record<string, unknown> = {};
  const before: TxOp[] = [];
  const after: TxOp[] = [];

  /** Expands a nested `create` into its own insert, recursively. */
  const nested = (relation: RelationInfo, input: Record<string, unknown>): string => {
    const target = graph[relation.target];
    const id = typeof input.id === "string" ? input.id : newId();
    const child = splitData(graph, target, id, input, true);
    const childValues = withDefaults(target, child.values);

    before.push(...child.before);
    before.push({ op: "insert", namespace: target.key, id, values: childValues });
    after.push(...child.after);
    return id;
  };

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
      const create = (value as { create?: unknown } | null)?.create;
      if (value === null || (value as { disconnect?: unknown }).disconnect === true) {
        values[relation.foreignKey!] = null;
      } else if (typeof (value as { connect?: unknown }).connect === "string") {
        values[relation.foreignKey!] = (value as { connect: string }).connect;
      } else if (isRecord(create)) {
        if (!allowLinks) {
          throw new Error(`"${model.key}.${key}": upsert cannot create related rows.`);
        }
        // The parent is inserted first, so this row's key points at a row
        // that exists by the time it is written.
        values[relation.foreignKey!] = nested(relation, create as Record<string, unknown>);
      } else {
        throw new Error(
          `"${model.key}.${key}" takes { connect: id }, { create: {...} }, { disconnect: true } or null.`
        );
      }
      continue;
    }
    if (!allowLinks) {
      throw new Error(`"${model.key}.${key}": connect children with create or update, not upsert.`);
    }
    const {
      connect = [],
      disconnect = [],
      create = [],
    } = value as { connect?: string[]; disconnect?: string[]; create?: Record<string, unknown>[] };
    for (const child of Array.isArray(create) ? create : [create]) {
      if (!isRecord(child)) {
        throw new Error(`"${model.key}.${key}.create" takes a row, or an array of rows.`);
      }
      // Children carry this row's key, so they are written after it exists.
      const childOps: TxOp[] = [];
      const target = graph[relation.target];
      const id = typeof child.id === "string" ? child.id : newId();
      const split = splitData(graph, target, id, child, true);
      const childValues = withDefaults(target, split.values);
      childValues[relation.foreignKey!] = rowId;
      childOps.push(...split.before, { op: "insert", namespace: target.key, id, values: childValues }, ...split.after);
      after.push(...childOps);
    }
    for (const targetId of connect) {
      after.push({ op: "link", namespace: model.key, id: rowId, link: relation.link, targetId });
    }
    for (const targetId of disconnect) {
      after.push({ op: "unlink", namespace: model.key, id: rowId, link: relation.link, targetId });
    }
  }

  return { values, before, after };
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

// ---- Aggregates ------------------------------------------------------------

function requireGroupKey(model: ModelInfo, field: unknown): string {
  if (
    typeof field !== "string" ||
    !(model.filterable.has(field) || field === "createdAt" || field === "updatedAt")
  ) {
    throw new Error(`"${model.key}" cannot be grouped by "${String(field)}".`);
  }
  return field;
}

/** Fields named by one measure, checked against the model. */
function measureFields(
  model: ModelInfo,
  measure: string,
  value: unknown,
  accepts: (field: string) => boolean
): string[] {
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`"${model.key}.${measure}" takes an object of fields.`);
  }
  const fields: string[] = [];
  for (const [field, on] of Object.entries(value)) {
    if (on === undefined || on === false) continue;
    if (!accepts(field)) {
      throw new Error(`"${model.key}.${measure}" cannot measure "${field}".`);
    }
    fields.push(field);
  }
  return fields;
}

/**
 * Translates `_count` / `_sum` / `_avg` / `_min` / `_max` into the engine's
 * aggregate, and back from one engine group into the public shape.
 */
function aggregateMeasures(model: ModelInfo, args: Record<string, unknown>) {
  const kind = (field: string) => model.scalars[field]?.kind;
  const isRowField = (field: string) =>
    field === "id" || field === "createdAt" || field === "updatedAt" || field in model.scalars || model.filterable.has(field);
  const isNumber = (field: string) => kind(field) === "number";
  const isOrdered = (field: string) =>
    isRowField(field) && kind(field) !== "boolean" && kind(field) !== "json";

  const countArg = args._count;
  const countAll = countArg === true || (typeof countArg === "object" && countArg !== null && (countArg as { _all?: unknown })._all === true);
  const countOf =
    countArg === true || countArg === undefined || countArg === false
      ? []
      : measureFields(
          model,
          "_count",
          Object.fromEntries(Object.entries(countArg as object).filter(([field]) => field !== "_all")),
          isRowField
        );
  const sum = measureFields(model, "_sum", args._sum, isNumber);
  const avg = measureFields(model, "_avg", args._avg, isNumber);
  const min = measureFields(model, "_min", args._min, isOrdered);
  const max = measureFields(model, "_max", args._max, isOrdered);

  const engine: Record<string, unknown> = {};
  if (countAll) engine.count = true;
  if (countOf.length > 0) engine.countOf = countOf;
  if (sum.length > 0) engine.sum = sum;
  if (avg.length > 0) engine.avg = avg;
  if (min.length > 0) engine.min = min;
  if (max.length > 0) engine.max = max;

  const output = (group: AggregateGroup): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (countArg === true) {
      out._count = group.count ?? 0;
    } else if (typeof countArg === "object" && countArg !== null) {
      const counts: Record<string, number> = {};
      if (countAll) counts._all = group.count ?? 0;
      for (const field of countOf) counts[field] = group.countOf?.[field] ?? 0;
      out._count = counts;
    }
    if (args._sum !== undefined) out._sum = pick(sum, group.sum);
    if (args._avg !== undefined) out._avg = pick(avg, group.avg);
    if (args._min !== undefined) out._min = pick(min, group.min);
    if (args._max !== undefined) out._max = pick(max, group.max);
    return out;
  };
  return { engine, output };
}

function pick(fields: string[], values: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = values?.[field] ?? null;
  return out;
}

// ---- Client ----------------------------------------------------------------

function modelClient(runtime: Runtime, model: ModelInfo): ModelClient<Models, Fields> {
  const document = (args: NodeArgs, extra: Record<string, unknown> = {}): QueryDocument => ({
    [model.key]: toEngineNode(runtime.graph, model, args, extra) as QueryDocument[string],
  });
  const reader = (args: NodeArgs | undefined) => {
    const shape = shapeFor(runtime.graph, model, args ?? {});
    return (data: QueryResult) => {
      const list = (data[model.key] ?? []) as Record<string, unknown>[];
      return (shape === null ? list : list.map(shape)) as never[];
    };
  };

  return {
    findMany: (args?: NodeArgs) => new Query(runtime, document(args ?? {}), reader(args), "many"),
    findFirst: (args?: NodeArgs) => {
      const rows = reader(args);
      return new Query(runtime, document({ ...args, take: 1 }), (data) => rows(data)[0] ?? null, "first");
    },
    findUnique: (args: { where: { id?: unknown }; include?: Record<string, unknown>; select?: Record<string, unknown> }) => {
      const rows = reader(args);
      return new Query(
        runtime,
        document({
          where: { id: requireId(model, args.where) },
          include: args.include,
          select: args.select,
          take: 1,
        }),
        (data) => rows(data)[0] ?? null,
        "first"
      );
    },
    findPage: (args?: NodeArgs & { after?: string | null }) => {
      const { after, ...rest } = args ?? {};
      const rows = reader(rest);
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

    aggregate: (args: Record<string, unknown>) => {
      const measures = aggregateMeasures(model, args);
      return new Query(
        runtime,
        document({ where: args.where }, { limit: 0, aggregate: measures.engine }),
        (_data, pageInfo) => {
          const group = pageInfo[model.key]?.aggregate?.[0];
          return group === undefined ? null : measures.output(group);
        },
        "aggregate"
      );
    },
    groupBy: (args: Record<string, unknown>) => {
      const measures = aggregateMeasures(model, args);
      const by = args.by;
      if (!Array.isArray(by) || by.length === 0) {
        throw new Error(`"${model.key}.groupBy" needs a non-empty "by" array.`);
      }
      for (const field of by) requireGroupKey(model, field);
      const order: Record<string, "asc" | "desc"> = {};
      for (const [field, direction] of Object.entries((args.orderBy ?? {}) as Record<string, unknown>)) {
        if (!by.includes(field)) {
          throw new Error(`"${model.key}.groupBy" can only order by a "by" field; "${field}" is not one.`);
        }
        if (direction !== "asc" && direction !== "desc") {
          throw new Error(`Order for "${model.key}.${field}" must be "asc" or "desc".`);
        }
        order[field] = direction;
      }
      const engine = {
        ...measures.engine,
        groupBy: by as string[],
        ...(Object.keys(order).length > 0 ? { order } : {}),
        ...(args.take !== undefined ? { limit: args.take } : {}),
      };
      return new Query(
        runtime,
        document({ where: args.where }, { limit: 0, aggregate: engine }),
        (_data, pageInfo) =>
          (pageInfo[model.key]?.aggregate ?? []).map((group) => ({
            ...group.key,
            ...measures.output(group),
          })),
        "groupBy"
      );
    },

    create: ({ data }: { data: Record<string, unknown> }) => {
      const rowId = typeof (data as { id?: unknown }).id === "string" ? (data as { id: string }).id : newId();
      const { values, before, after } = splitData(
        runtime.graph,
        model,
        rowId,
        data as Record<string, unknown>,
        true
      );
      return new Write(
        runtime,
        [
          ...before,
          { op: "insert", namespace: model.key, id: rowId, values: withDefaults(model, values) },
          ...after,
        ],
        rowId
      );
    },
    update: ({ where, data }: { where: { id?: unknown }; data: Record<string, unknown> }) => {
      const rowId = requireId(model, where);
      const { values, before, after } = splitData(
        runtime.graph,
        model,
        rowId,
        data as Record<string, unknown>,
        true
      );
      return new Write(
        runtime,
        [...before, { op: "patch", namespace: model.key, id: rowId, values }, ...after],
        rowId
      );
    },
    upsert: ({ where, create, update }: { where: { id?: unknown }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const rowId = requireId(model, where);
      const created = splitData(runtime.graph, model, rowId, create as Record<string, unknown>, false);
      const updated = splitData(runtime.graph, model, rowId, update as Record<string, unknown>, false);
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
      const { values, after } = splitData(runtime.graph, model, "", data, false);
      if (after.length > 0) {
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
