"use client";

/**
 * The client runtime under `createClient()`.
 *
 * One WebSocket per workspace carries live queries and presence; writes go
 * over HTTP. Queries are subscribed once per unique document, writes are
 * optimistic and durable through an IndexedDB outbox, and reconnects
 * re-authenticate and resubscribe.
 */

import { id } from "./id";
import { createStorageClient, type StorageFetch } from "./storage-client";
import { createOutbox, type Outbox } from "./outbox";
import { applyOptimisticOps, applyQueryDiff } from "./query-cache";
import { QuerySocket, type WebSocketFactory } from "./socket";
import { cloneJson, stableStringify } from "./stable";
import type {
  DataClient,
  InitConfig,
  OutboxEntry,
  PresencePeer,
  QueryDocument,
  QueryEntity,
  QueryError,
  QueryOptions,
  QueryPageInfo,
  QueryResult,
  QueryState,
  SchemaDefinition,
  ServerMessage,
  TransactInput,
  TxOp,
  TxStep,
  WriteRejection,
} from "./types";

const DEFAULT_API_URL = "http://localhost:8787";
const MAX_RETRY_DELAY_MS = 30_000;
const BASE_RETRY_DELAY_MS = 1_000;

/** Consecutive auth failures before reconnecting stops and the error surfaces. */
const MAX_AUTH_ATTEMPTS = 3;

/**
 * A page request is a one-shot subscription that nothing retries, so it must
 * not hang forever when the socket drops mid-flight.
 */
const LOAD_MORE_TIMEOUT_MS = 15_000;

/**
 * `session:error` codes that mean "this token will not work". Transport and
 * internal errors stay retryable; these stop the loop instead of hammering the
 * claim endpoint every 250ms.
 */
const TERMINAL_AUTH_CODES = new Set([
  "unauthenticated",
  "permission_denied",
  "claim_expired",
  "wrong_workspace",
  "invalid_config",
]);

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  }
) => Promise<FetchResponseLike>;

export interface ClientDeps {
  fetch?: FetchLike;
  storageFetch?: StorageFetch;
  createWebSocket?: WebSocketFactory;
  outbox?: Outbox;
  now?: () => number;
}

/** One row of the workspace's file index. */
export interface StoredFile {
  id: string;
  path: string;
  r2Key: string;
  size: number;
  contentType: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ResolvedConfig {
  workspaceId: string;
  apiUrl: string;
  websocketUrl: string;
  getToken: (() => Promise<string>) | null;
  schema?: SchemaDefinition;
  onWriteRejected?: (rejection: WriteRejection) => void;
}

interface CacheEntry {
  key: string;
  query: QueryDocument;
  state: QueryState;
  seq: number;
  subId: string;
  listeners: Set<() => void>;
  /**
   * Rows loaded per top-level namespace once `loadMore()` has run. The live
   * subscription is widened to this many rows, so a reconnect re-subscribes
   * every loaded page instead of resetting to the first, and diffs reach
   * rows on later pages too.
   */
  window?: Record<string, number>;
}

/**
 * The engine's per-level limit ceiling. A live window wider than this is
 * clamped: a reconnect then comes back with this many rows, and `loadMore()`
 * continues from its cursor.
 */
export const MAX_LIVE_WINDOW = 1000;

interface CacheSnapshot {
  key: string;
  seq: number;
  data: QueryResult;
}

type QueryDataMessage = Extract<ServerMessage, { type: "query:data" }>;

/** A one-shot `query:subscribe` awaiting its `query:data` reply. */
interface PageRequest {
  timer: ReturnType<typeof setTimeout>;
  resolve: (message: QueryDataMessage) => void;
  reject: (error: Error) => void;
}

export class ServerError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "ServerError";
    this.code = code;
    this.status = status;
  }
}

function isServerError(error: unknown): error is ServerError {
  return error instanceof ServerError;
}

/**
 * A 5xx, 408 or 429 means the write may well succeed on a later attempt, so the
 * outbox entry has to survive. Only a 4xx lets us conclude the write itself was
 * refused and can be dropped.
 */
function isRetryableServerError(error: ServerError): boolean {
  if (error.status === 408 || error.status === 429) return true;
  return error.status >= 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTxStep(value: unknown): value is TxStep {
  return isRecord(value) && Array.isArray(value.ops) && isRecord(value.op);
}

function isTxOp(value: unknown): value is TxOp {
  return (
    isRecord(value) &&
    typeof value.op === "string" &&
    typeof value.namespace === "string" &&
    typeof value.id === "string"
  );
}

/**
 * Appends `incoming` rows to `existing`, dropping any row whose `id` was
 * already present.
 *
 * Deduping by id, not by position, is what makes a replayed page harmless: the
 * same cursor answered twice (a retry, a reconnect, a concurrent caller) cannot
 * duplicate rows. Engine rows always carry an id; a row without one is appended
 * as-is rather than silently dropped.
 */
function mergeRows(
  existing: readonly QueryEntity[],
  incoming: readonly QueryEntity[]
): QueryEntity[] {
  const seen = new Set<string>();
  const merged: QueryEntity[] = [];

  for (const row of [...existing, ...incoming]) {
    const rowId = typeof row.id === "string" ? row.id : null;
    if (rowId !== null) {
      if (seen.has(rowId)) continue;
      seen.add(rowId);
    }
    merged.push(row);
  }

  return merged;
}

function normalizeOps(input: TransactInput): TxOp[] {
  const ops: TxOp[] = [];

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (isTxStep(value)) {
      for (const op of value.ops) ops.push(op);
      return;
    }
    if (isTxOp(value)) {
      ops.push(value);
      return;
    }
    throw new Error("tapedb: transact() received an invalid operation.");
  };

  for (const item of input) visit(item);
  return ops;
}

function readServerError(
  payload: unknown
): { code: string; message: string } | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  const { code, message } = payload.error;
  if (typeof code !== "string" || typeof message !== "string") return null;
  return { code, message };
}

function isOkPayload(payload: unknown): boolean {
  return isRecord(payload) && payload.ok === true;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Derives the engine websocket URL from the HTTP origin. */
export function deriveWebSocketUrl(
  apiUrl: string,
  workspaceId: string
): string {
  const base = trimTrailingSlash(apiUrl).replace(/^http/, "ws");
  return `${base}/engine/workspaces/${workspaceId}/websocket`;
}

/**
 * Default token provider for development.
 *
 * `tapedb dev` exposes `POST /_tapedb/claim`, which mints an OWNER claim with
 * no session. Production Workers refuse that route, so this fallback fails
 * closed: the error names the missing option instead of silently sending an
 * unauthenticated request.
 */
function createDevTokenProvider(apiUrl: string, workspaceId: string) {
  return async (): Promise<string> => {
    const response = await fetch(`${apiUrl}/_tapedb/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    if (!response.ok) {
      throw new Error(
        `tapedb: no getToken provided and the dev claim route returned ${response.status}. ` +
          `Pass init({ getToken: () => Promise<string> }) for production.`
      );
    }
    const body = (await response.json()) as { token?: unknown };
    if (typeof body.token !== "string") {
      throw new Error("tapedb: dev claim route returned no token.");
    }
    return body.token;
  };
}

function resolveConfig(config: InitConfig): ResolvedConfig {
  const workspaceId = config.workspaceId ?? "";
  const apiUrl = trimTrailingSlash(config.apiUrl ?? DEFAULT_API_URL);
  const websocketUrl =
    config.websocketUrl ?? deriveWebSocketUrl(apiUrl, workspaceId);

  return {
    workspaceId,
    apiUrl,
    websocketUrl,
    getToken: config.getToken ?? createDevTokenProvider(apiUrl, workspaceId),
    schema: config.schema,
    onWriteRejected: config.onWriteRejected,
  };
}

class DataClientImpl {

  private readonly config: ResolvedConfig;
  private readonly fetchImpl: FetchLike;
  private readonly createWebSocket: WebSocketFactory | undefined;
  private readonly outbox: Outbox;
  private readonly now: () => number;

  private readonly cache = new Map<string, CacheEntry>();
  private readonly subIdToKey = new Map<string, string>();
  private nextSubId = 0;

  /** One-shot page subscriptions, keyed by their ephemeral subscription id. */
  private readonly pages = new Map<string, PageRequest>();
  /** Coalesces concurrent `loadMore()` calls for the same query. */
  private readonly pagesInFlight = new Map<string, Promise<boolean>>();
  private nextPageId = 0;

  private socket: QuerySocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private authFailures = 0;
  private flushing: Promise<void> | null = null;
  private readonly inFlight = new Set<string>();
  /** Unacked optimistic ops, replayed over server data until they are acked. */
  private readonly pendingOps = new Map<string, readonly TxOp[]>();
  private readonly presencePeers = new Map<string, PresencePeer[]>();
  private readonly presenceListeners = new Map<
    string,
    Set<(peers: PresencePeer[]) => void>
  >();
  private readonly localPresence = new Map<
    string,
    { presence?: unknown; cursor?: unknown; drag?: unknown }
  >();
  private onlineHandler: (() => void) | null = null;
  private closed = false;
  /**
   * Highest workspace sequence seen in row `updatedSeq` values and write
   * acknowledgements. A lower bound on the server's high-water mark, which is
   * all a retry's `basisSeq` needs to be.
   */
  private observedSeq = 0;

  constructor(config: InitConfig, deps: ClientDeps = {}) {
    this.config = resolveConfig(config);
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
    this.createWebSocket = deps.createWebSocket;
    this.outbox = deps.outbox ?? createOutbox();
    this.now = deps.now ?? (() => Date.now());

    if (
      typeof window !== "undefined" &&
      typeof window.addEventListener === "function"
    ) {
      this.onlineHandler = () => {
        this.retryAttempt = 0;
        // Coming back online is the user's chance to recover from an auth stop.
        this.authFailures = 0;
        this.socket?.reconnectNow();
        void this.flushOutbox();
      };
      window.addEventListener("online", this.onlineHandler);

      // Load pending writes from IndexedDB and replay them once the app boots.
      queueMicrotask(() => {
        void this.flushOutbox();
      });
    }
  }

  /**
   * Applies ops optimistically, queues them, and sends them. Resolves to
   * "applied" once the engine acknowledged them, or "queued" when the send
   * failed transiently and the outbox will retry. Permanent refusals reject.
   */
  async transact(input: TransactInput): Promise<"applied" | "queued"> {
    const ops = normalizeOps(input);
    if (ops.length === 0) return "applied";

    const problem = this.configProblem();
    if (problem) {
      this.failActiveQueries("invalid_config", problem);
      throw new Error(problem);
    }

    const txId = id();
    const clientTxId = id();
    const outboxEntry: OutboxEntry = {
      clientTxId,
      txId,
      workspaceId: this.config.workspaceId,
      ops: ops.map((op) => cloneJson(op)),
      createdAt: this.now(),
      basisSeq: this.observedSeq,
      // Persisted with the entry before the first send, so a crash mid-send
      // still leaves the next flush knowing this is a retry.
      attempts: 1,
    };

    const snapshot = this.snapshot();
    this.inFlight.add(clientTxId);

    try {
      await this.outbox.add(outboxEntry);
    } catch (error) {
      this.inFlight.delete(clientTxId);
      throw error;
    }

    this.pendingOps.set(clientTxId, outboxEntry.ops);
    this.applyOptimistic(ops);
    // Lazy-connect so the server push that reconciles this write can land.
    this.ensureSocket();

    try {
      await this.sendTransaction(outboxEntry, false);
      await this.outbox.remove(clientTxId);
      this.pendingOps.delete(clientTxId);
      this.retryAttempt = 0;
      this.clearRetryTimer();
      return "applied";
    } catch (error) {
      if (isServerError(error) && !isRetryableServerError(error)) {
        try {
          await this.outbox.remove(clientTxId);
        } finally {
          this.pendingOps.delete(clientTxId);
          this.restore(snapshot);
        }
        throw error;
      }
      // Transient (network, 5xx, 408, 429) or a rejected-after-retry write:
      // keep the optimistic state and the outbox entry so a later flush lands it.
      this.scheduleRetry();
      return "queued";
    } finally {
      this.inFlight.delete(clientTxId);
    }
  }

  /** One-shot read over HTTP: no socket, no cache, no live updates. */
  async queryOnce(
    query: QueryDocument
  ): Promise<{ data: QueryResult; pageInfo: QueryPageInfo }> {
    const problem = this.configProblem();
    if (problem) throw new Error(problem);

    const token = await this.requireToken();
    const response = await this.fetchImpl(
      `${this.config.apiUrl}/engine/workspaces/${this.config.workspaceId}/query`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query }),
      }
    );
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      data?: QueryResult;
      pageInfo?: QueryPageInfo;
    } | null;
    if (!response.ok || payload?.ok !== true || payload.data === undefined) {
      const error = readServerError(payload);
      throw new ServerError(
        error?.code ?? "http_error",
        error?.message ?? `Query failed with HTTP ${response.status}.`,
        response.status
      );
    }
    this.noteRows(payload.data);
    return { data: payload.data, pageInfo: payload.pageInfo ?? {} };
  }

  /** The workspace's file index. */
  async listFiles(): Promise<StoredFile[]> {
    const token = await this.requireToken();
    const response = await this.fetchImpl(
      `${this.config.apiUrl}/engine/workspaces/${this.config.workspaceId}/files`,
      { method: "GET", headers: { authorization: `Bearer ${token}` } }
    );
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      data?: StoredFile[];
    } | null;
    if (!response.ok || payload?.ok !== true || !Array.isArray(payload.data)) {
      const error = readServerError(payload);
      throw new ServerError(
        error?.code ?? "http_error",
        error?.message ?? `Listing files failed with HTTP ${response.status}.`,
        response.status
      );
    }
    return payload.data;
  }

  subscribeQuery(query: QueryDocument, listener: () => void): () => void {
    const entry = this.entry(query);
    entry.listeners.add(listener);

    if (entry.listeners.size === 1) {
      this.ensureSocket();
      this.sendSubscribe(entry);
    }

    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) {
        this.socket?.send({ type: "query:unsubscribe", id: entry.subId });
      }
    };
  }

  getQueryState(query: QueryDocument): QueryState {
    return this.entry(query).state;
  }

  /**
   * Requests the next page for the cached query and appends it.
   *
   * The cursor comes from the engine (`pageInfo[namespace].nextCursor`), never
   * from a client-side offset: keyset pagination stays correct when rows are
   * inserted or deleted between pages. One request covers every top-level
   * namespace that reported a cursor; nested link results ride along with the
   * page instead of being paginated.
   */
  loadMore(query: QueryDocument): Promise<boolean> {
    const problem = this.configProblem();
    if (problem) {
      return Promise.reject(new Error(problem));
    }

    const entry = this.entry(query);
    const inFlight = this.pagesInFlight.get(entry.key);
    // Two callers asking for the same page share one request, so the rows can
    // only be appended once.
    if (inFlight) return inFlight;

    const document = this.nextPageDocument(entry);
    if (!document) return Promise.resolve(false);

    const tracked = this.requestPage(entry, document).finally(() => {
      this.pagesInFlight.delete(entry.key);
    });
    this.pagesInFlight.set(entry.key, tracked);
    return tracked;
  }

  publishPresence(target: string, presence: unknown): void {
    const entry = this.localPresence.get(target) ?? {};
    entry.presence = presence;
    this.localPresence.set(target, entry);
    this.ensureSocket();
    this.socket?.send({ type: "presence:set", target, presence });
    // The server rejects cursor/drag until presence exists, so replay them now.
    if (entry.cursor !== undefined) {
      this.socket?.send({ type: "cursor:set", target, cursor: entry.cursor });
    }
    if (entry.drag !== undefined) {
      this.socket?.send({ type: "drag:set", target, drag: entry.drag });
    }
  }

  publishCursor(target: string, cursor: unknown): void {
    const entry = this.localPresence.get(target) ?? {};
    entry.cursor = cursor;
    this.localPresence.set(target, entry);
    this.ensureSocket();
    this.socket?.send({ type: "cursor:set", target, cursor });
  }

  publishDrag(target: string, drag: unknown): void {
    const entry = this.localPresence.get(target) ?? {};
    entry.drag = drag;
    this.localPresence.set(target, entry);
    this.ensureSocket();
    this.socket?.send({ type: "drag:set", target, drag });
  }

  clearDrag(target: string): void {
    const entry = this.localPresence.get(target);
    if (entry) delete entry.drag;
    this.socket?.send({ type: "drag:clear", target });
  }

  clearPresence(target: string): void {
    this.localPresence.delete(target);
    this.socket?.send({ type: "presence:clear", target });
    this.presencePeers.delete(target);
    this.notifyPresence(target);
  }

  subscribePresence(
    target: string,
    listener: (peers: PresencePeer[]) => void
  ): () => void {
    let listeners = this.presenceListeners.get(target);
    if (!listeners) {
      listeners = new Set();
      this.presenceListeners.set(target, listeners);
    }
    listeners.add(listener);
    this.ensureSocket();
    listener(this.presencePeers.get(target) ?? []);

    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.presenceListeners.delete(target);
    };
  }

  async connect(): Promise<void> {
    const problem = this.configProblem();
    if (problem) {
      this.failActiveQueries("invalid_config", problem);
      throw new Error(problem);
    }

    this.authFailures = 0;
    this.ensureSocket();
    if (!this.socket) {
      throw new Error("tapedb: WebSocket is not available.");
    }
    await this.socket.connect();
  }

  async flushOutbox(): Promise<void> {
    if (this.closed) return;
    if (this.configProblem()) return;
    if (this.flushing) return this.flushing;

    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async clearOutbox(): Promise<void> {
    await this.outbox.clear(this.config.workspaceId);
    this.retryAttempt = 0;
    this.clearRetryTimer();
  }

  close(): void {
    this.closed = true;
    this.clearRetryTimer();

    // No reply can arrive once the socket is gone; settle page requests now
    // instead of leaving them to time out.
    for (const id of [...this.pages.keys()]) {
      this.failPage(
        id,
        new Error(
          "tapedb: client closed while waiting for the next page."
        )
      );
    }

    if (
      this.onlineHandler &&
      typeof window !== "undefined" &&
      typeof window.removeEventListener === "function"
    ) {
      window.removeEventListener("online", this.onlineHandler);
      this.onlineHandler = null;
    }

    this.socket?.close();
    this.socket = null;
  }

  private configProblem(): string | null {
    if (!this.config.workspaceId) {
      return "tapedb: missing workspace. Pass createClient({ workspace }).";
    }
    if (!this.config.getToken) {
      return "tapedb: missing getToken. Pass createClient({ getToken: () => Promise<string> }).";
    }
    return null;
  }

  private entry(query: QueryDocument): CacheEntry {
    const key = stableStringify(query);
    const existing = this.cache.get(key);
    if (existing) {
      existing.query = query;
      return existing;
    }

    const subId = `q${(this.nextSubId += 1)}`;
    const created: CacheEntry = {
      key,
      query,
      state: { data: null, isLoading: true, error: null },
      seq: 0,
      subId,
      listeners: new Set(),
    };
    this.cache.set(key, created);
    this.subIdToKey.set(subId, key);
    return created;
  }

  private entryBySubId(subId: string): CacheEntry | undefined {
    const key = this.subIdToKey.get(subId);
    return key === undefined ? undefined : this.cache.get(key);
  }

  private sendSubscribe(entry: CacheEntry): void {
    this.socket?.send({
      type: "query:subscribe",
      id: entry.subId,
      query: this.liveDocument(entry),
    });
  }

  /**
   * The query the live subscription actually runs: the caller's query, with
   * each paged namespace's limit widened to the rows already loaded. The cache
   * key stays the caller's query, so `useQuery` callers are unaffected.
   */
  private liveDocument(entry: CacheEntry): QueryDocument {
    if (!entry.window) return entry.query;

    const document: QueryDocument = { ...entry.query };
    for (const [namespace, rows] of Object.entries(entry.window)) {
      const node = entry.query[namespace];
      if (!isRecord(node)) continue;
      const options: QueryOptions = isRecord(node.$) ? node.$ : {};
      const limit = Math.min(
        Math.max(rows, typeof options.limit === "number" ? options.limit : 0),
        MAX_LIVE_WINDOW
      );
      document[namespace] = { ...node, $: { ...options, limit } };
    }
    return document;
  }

  private resubscribeAll(): void {
    for (const entry of this.cache.values()) {
      if (entry.listeners.size > 0) this.sendSubscribe(entry);
    }
  }

  /**
   * The request for the next page: every top-level namespace with a cursor,
   * each carrying its own `after` on top of the options the caller already
   * passed. Returns null when nothing is left to fetch.
   */
  private nextPageDocument(entry: CacheEntry): QueryDocument | null {
    if (entry.state.data === null) return null;

    const document: QueryDocument = {};
    let hasCursor = false;

    for (const namespace of Object.keys(entry.query)) {
      const cursor = entry.state.pageInfo?.[namespace]?.nextCursor;
      if (typeof cursor !== "string" || cursor.length === 0) continue;

      const node = entry.query[namespace];
      const options: QueryOptions =
        isRecord(node) && isRecord(node.$) ? node.$ : {};
      document[namespace] = {
        ...(isRecord(node) ? node : {}),
        $: { ...options, after: cursor },
      };
      hasCursor = true;
    }

    return hasCursor ? document : null;
  }

  /**
   * Sends one page request and waits for its `query:data`.
   *
   * It is a subscription rather than an HTTP call because the paginated rows
   * must come from the same authenticated socket and the same view rules as the
   * first page. The id is ephemeral and unsubscribed as soon as the page lands,
   * so it never joins the live-query cache.
   */
  private async requestPage(
    entry: CacheEntry,
    document: QueryDocument
  ): Promise<boolean> {
    this.ensureSocket();
    const socket = this.socket;
    if (!socket) {
      throw new Error("tapedb: WebSocket is not available.");
    }
    await socket.connect();

    const id = `lm${(this.nextPageId += 1)}`;
    const response = new Promise<QueryDataMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failPage(
          id,
          new Error(
            "tapedb: loadMore() timed out waiting for the next page."
          )
        );
      }, LOAD_MORE_TIMEOUT_MS);
      this.pages.set(id, { timer, resolve, reject });
    });

    if (!socket.send({ type: "query:subscribe", id, query: document })) {
      this.failPage(
        id,
        new Error("tapedb: loadMore() could not send on the socket.")
      );
    }

    try {
      const message = await response;
      return this.appendPage(entry, message);
    } finally {
      socket.send({ type: "query:unsubscribe", id });
    }
  }

  /** Settles a pending page request with its reply. */
  private resolvePage(id: string, message: QueryDataMessage): boolean {
    const pending = this.pages.get(id);
    if (!pending) return false;
    this.pages.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(message);
    return true;
  }

  /** Settles a pending page request with an error, at most once. */
  private failPage(id: string, error: Error): boolean {
    const pending = this.pages.get(id);
    if (!pending) return false;
    this.pages.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
    return true;
  }

  /**
   * Appends a page to the cached result.
   *
   * Rows are deduped by id, so the same page delivered twice (a retried cursor,
   * a server that repeats a boundary row) cannot duplicate entities. `pageInfo`
   * is replaced with the page's own metadata; a namespace the engine no longer
   * caps loses its entry, which is what makes the next `loadMore()` return
   * false.
   */
  private appendPage(entry: CacheEntry, message: QueryDataMessage): boolean {
    if (entry.state.data === null) return false;

    const data: QueryResult = { ...entry.state.data };
    const pageInfo: QueryPageInfo = { ...(entry.state.pageInfo ?? {}) };

    for (const [namespace, rows] of Object.entries(message.data)) {
      if (!Array.isArray(rows)) continue;
      data[namespace] = mergeRows(data[namespace] ?? [], rows as QueryEntity[]);

      const info = message.pageInfo?.[namespace];
      if (info) pageInfo[namespace] = info;
      else delete pageInfo[namespace];
    }

    const next: QueryState = { data, isLoading: false, error: null };
    if (Object.keys(pageInfo).length > 0) next.pageInfo = pageInfo;

    entry.state = next;
    this.notify(entry);

    // Widen the live subscription to everything now loaded. The engine
    // answers with the same rows (plus anything that changed meanwhile), and
    // from then on a reconnect restores this window and diffs cover it.
    const window = { ...(entry.window ?? {}) };
    for (const namespace of Object.keys(message.data)) {
      const rows = data[namespace];
      if (Array.isArray(rows)) window[namespace] = rows.length;
    }
    entry.window = window;
    if (entry.listeners.size > 0) this.sendSubscribe(entry);
    return true;
  }

  private ensureSocket(): void {
    if (this.closed) return;

    const problem = this.configProblem();
    if (problem) {
      this.failActiveQueries("invalid_config", problem);
      return;
    }

    if (this.socket) {
      void this.socket.connect().catch(() => undefined);
      return;
    }

    this.socket = new QuerySocket({
      baseUrl: this.config.websocketUrl,
      getToken: this.config.getToken!,
      createWebSocket: this.createWebSocket,
      onSessionReady: () => {
        this.authFailures = 0;
        this.resubscribeAll();
        this.republishPresence();
        void this.flushOutbox();
      },
      onMessage: (message) => this.handleServerMessage(message),
    });

    void this.socket.connect().catch(() => {
      // QuerySocket keeps retrying; queries stay loading until the socket opens.
    });
  }

  private republishPresence(): void {
    for (const [target, entry] of this.localPresence) {
      if (entry.presence !== undefined) {
        this.socket?.send({
          type: "presence:set",
          target,
          presence: entry.presence,
        });
      }
      if (entry.cursor !== undefined) {
        this.socket?.send({ type: "cursor:set", target, cursor: entry.cursor });
      }
      if (entry.drag !== undefined) {
        this.socket?.send({ type: "drag:set", target, drag: entry.drag });
      }
    }
  }

  private patchPeer(
    target: string,
    clientId: string,
    patch: Partial<Pick<PresencePeer, "cursor" | "drag">>
  ): void {
    const peers = this.presencePeers.get(target);
    if (!peers) return;
    const index = peers.findIndex((peer) => peer.clientId === clientId);
    if (index === -1) return;
    const next = [...peers];
    next[index] = { ...next[index], ...patch };
    this.presencePeers.set(target, next);
    this.notifyPresence(target);
  }

  private notifyPresence(target: string): void {
    const peers = this.presencePeers.get(target) ?? [];
    const listeners = this.presenceListeners.get(target);
    if (!listeners) return;
    for (const listener of listeners) listener(peers);
  }

  private handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case "presence:update": {
        this.presencePeers.set(message.target, message.peers);
        this.notifyPresence(message.target);
        return;
      }
      case "cursor:update": {
        this.patchPeer(message.target, message.clientId, {
          cursor: message.cursor,
        });
        return;
      }
      case "drag:update": {
        this.patchPeer(message.target, message.clientId, {
          drag: message.drag,
        });
        return;
      }
      case "query:data": {
        // A pending loadMore() first: its id is ephemeral and never cached.
        if (this.resolvePage(message.id, message)) return;
        this.noteRows(message.data);
        const entry = this.entryBySubId(message.id);
        if (!entry) return;
        entry.seq = message.seq;
        entry.state = {
          // A reconnect re-sends full results; without the overlay the user
          // watches their queued edit revert until the flush lands.
          data: this.overlayPending(message.data),
          isLoading: false,
          error: null,
          ...(message.pageInfo === undefined
            ? {}
            : { pageInfo: message.pageInfo }),
        };
        this.notify(entry);
        return;
      }
      case "query:diff": {
        this.noteRows(message.added);
        this.noteRows(message.updated);
        const entry = this.entryBySubId(message.id);
        if (!entry || entry.state.data === null) return;
        entry.seq = message.seq;
        // A diff without pageInfo leaves it as it was; dropping it here is
        // what made loadMore() stop after the first live change.
        const pageInfo = message.pageInfo ?? entry.state.pageInfo;
        entry.state = {
          data: applyQueryDiff(entry.state.data, message),
          isLoading: false,
          error: null,
          ...(pageInfo === undefined ? {} : { pageInfo }),
        };
        this.notify(entry);
        return;
      }
      case "query:error": {
        if (
          message.id !== null &&
          this.failPage(
            message.id,
            new ServerError(message.code, message.message)
          )
        ) {
          return;
        }
        if (message.id === null) return;
        const entry = this.entryBySubId(message.id);
        if (!entry) return;
        entry.state = {
          ...entry.state,
          isLoading: false,
          error: { code: message.code, message: message.message },
        };
        this.notify(entry);
        return;
      }
      case "session:error": {
        if (TERMINAL_AUTH_CODES.has(message.code)) {
          this.authFailures += 1;
          if (this.authFailures >= MAX_AUTH_ATTEMPTS) {
            this.socket?.suspend();
            this.failActiveQueries(
              "unauthenticated",
              message.message ||
                "The engine rejected the role claim; sign in again to resume."
            );
            return;
          }
        }
        this.socket?.reconnectNow();
        return;
      }
      default:
        return;
    }
  }

  /** Re-applies every unacked optimistic write over freshly received data. */
  private overlayPending(data: QueryResult): QueryResult {
    if (this.pendingOps.size === 0) return data;

    let next = data;
    for (const ops of this.pendingOps.values()) {
      next = applyOptimisticOps(next, ops, this.config.schema);
    }
    return next;
  }

  private notify(entry: CacheEntry): void {
    for (const listener of entry.listeners) listener();
  }

  private failActiveQueries(code: string, message: string): void {
    const error: QueryError = { code, message };
    for (const entry of this.cache.values()) {
      if (entry.listeners.size === 0) continue;
      if (entry.state.error?.message === message) continue;
      entry.state = { ...entry.state, isLoading: false, error };
      this.notify(entry);
    }
  }

  private snapshot(): CacheSnapshot[] {
    const snapshots: CacheSnapshot[] = [];
    for (const entry of this.cache.values()) {
      if (entry.state.data === null) continue;
      snapshots.push({
        key: entry.key,
        seq: entry.seq,
        data: entry.state.data,
      });
    }
    return snapshots;
  }

  private restore(snapshots: CacheSnapshot[]): void {
    for (const snapshot of snapshots) {
      const entry = this.cache.get(snapshot.key);
      if (!entry) continue;
      // A newer server push means the snapshot is stale; keep the push.
      if (entry.seq !== snapshot.seq) continue;
      entry.state = { ...entry.state, data: snapshot.data };
      this.notify(entry);
    }
  }

  private applyOptimistic(ops: readonly TxOp[]): void {
    for (const entry of this.cache.values()) {
      if (entry.state.data === null) continue;
      entry.state = {
        ...entry.state,
        data: applyOptimisticOps(entry.state.data, ops, this.config.schema),
      };
      this.notify(entry);
    }
  }

  private reportRejection(entry: OutboxEntry, error: ServerError): void {
    const listener = this.config.onWriteRejected;
    if (!listener) return;
    try {
      listener({
        clientTxId: entry.clientTxId,
        ops: entry.ops,
        code: error.code,
        message: error.message,
      });
    } catch {
      // A throwing listener must not stall the rest of the queue.
    }
  }

  private noteSeq(value: unknown): void {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > this.observedSeq) {
      this.observedSeq = value;
    }
  }

  /** Raises `observedSeq` from every `updatedSeq` in a result, at any depth. */
  private noteRows(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) this.noteRows(item);
      return;
    }
    if (!isRecord(value)) return;
    this.noteSeq(value.updatedSeq);
    for (const nested of Object.values(value)) {
      if (typeof nested === "object" && nested !== null) this.noteRows(nested);
    }
  }

  private async sendTransaction(
    entry: OutboxEntry,
    retry: boolean
  ): Promise<void> {
    const token = await this.requireToken();
    const response = await this.fetchImpl(
      `${this.config.apiUrl}/engine/workspaces/${this.config.workspaceId}/transact`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          txId: entry.txId,
          clientTxId: entry.clientTxId,
          ...(retry ? { basisSeq: entry.basisSeq ?? 0 } : {}),
          ops: entry.ops,
        }),
      }
    );

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok || !isOkPayload(payload)) {
      const serverError = readServerError(payload);
      if (serverError) {
        throw new ServerError(
          serverError.code,
          serverError.message,
          response.status
        );
      }
      throw new ServerError(
        "http_error",
        `Transact failed with HTTP ${response.status}.`,
        response.status
      );
    }

    const result = (payload as { result?: unknown }).result;
    if (isRecord(result)) this.noteSeq(result.seq);
  }

  private async requireToken(): Promise<string> {
    if (!this.config.getToken) {
      throw new Error("tapedb: missing getToken.");
    }
    return this.config.getToken();
  }

  private async doFlush(): Promise<void> {
    const entries = await this.outbox.list(this.config.workspaceId);

    for (const entry of entries) {
      if (this.inFlight.has(entry.clientTxId)) continue;
      this.inFlight.add(entry.clientTxId);

      this.pendingOps.set(entry.clientTxId, entry.ops);

      // Anything already in the outbox may have reached the server. Count the
      // attempt before sending, so the retry is marked even across a crash.
      // An entry from an older client has no count and is treated as a retry.
      const attempt: OutboxEntry = {
        ...entry,
        attempts: (entry.attempts ?? 1) + 1,
      };

      try {
        await this.outbox.add(attempt).catch(() => undefined);
        await this.sendTransaction(attempt, true);
        await this.outbox.remove(entry.clientTxId);
        this.pendingOps.delete(entry.clientTxId);
        this.retryAttempt = 0;
      } catch (error) {
        if (isServerError(error) && !isRetryableServerError(error)) {
          await this.outbox.remove(entry.clientTxId).catch(() => undefined);
          this.pendingOps.delete(entry.clientTxId);
          // The optimistic row will not be reconciled by a push; refetch.
          this.resubscribeAll();
          this.reportRejection(entry, error);
          continue;
        }
        // Transient (network, 5xx, 408, 429): keep the entry and back off.
        this.scheduleRetry();
        return;
      } finally {
        this.inFlight.delete(entry.clientTxId);
      }
    }

    // The queue is empty; a pending retry timer has nothing left to do.
    this.clearRetryTimer();
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer !== null) return;

    const delay = Math.min(
      MAX_RETRY_DELAY_MS,
      BASE_RETRY_DELAY_MS * 2 ** this.retryAttempt
    );
    this.retryAttempt += 1;

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flushOutbox();
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

/**
 * Framework-free client. Everything except the hook: usable from a Worker, a
 * Node script, a Svelte store or a test.
 */
/** The runtime facade the model client and the tests drive. */
export type HeadlessDataClient = DataClient;

export function createClientParts(
  config: InitConfig,
  deps: ClientDeps = {}
): { client: HeadlessDataClient; impl: DataClientImpl } {
  const impl = new DataClientImpl(config, deps);
  const resolved = resolveConfig(config);

  const client: HeadlessDataClient = {
    transact: (input) => impl.transact(input),
    get files() {
      return createStorageClient({
        apiUrl: resolved.apiUrl,
        workspaceId: resolved.workspaceId,
        getToken: async () => {
          if (!config.getToken) throw new Error("Storage requires getToken.");
          return config.getToken();
        },
        fetch: deps.storageFetch,
      });
    },
    room: (target) => {
      if (!target.trim()) throw new Error("Room target must not be empty.");
      return {
        publishPresence: (presence) => impl.publishPresence(target, presence),
        publishCursor: (cursor) => impl.publishCursor(target, cursor),
        publishDrag: (drag) => impl.publishDrag(target, drag),
        clearDrag: () => impl.clearDrag(target),
        subscribePresence: (listener) =>
          impl.subscribePresence(target, listener),
        leave: () => impl.clearPresence(target),
      };
    },
    clearOutbox: () => impl.clearOutbox(),
    flushOutbox: () => impl.flushOutbox(),
    subscribeQuery: (query, listener) => impl.subscribeQuery(query, listener),
    getQueryState: (query) => impl.getQueryState(query),
    loadMore: (query) => impl.loadMore(query),
    publishPresence: (target, presence) =>
      impl.publishPresence(target, presence),
    publishCursor: (target, cursor) => impl.publishCursor(target, cursor),
    publishDrag: (target, drag) => impl.publishDrag(target, drag),
    clearDrag: (target) => impl.clearDrag(target),
    clearPresence: (target) => impl.clearPresence(target),
    subscribePresence: (target, listener) =>
      impl.subscribePresence(target, listener),
    connect: () => impl.connect(),
    close: () => impl.close(),
  };

  return { client, impl };
}

/** The client alone, for callers that never need the implementation handle. */
export function createHeadlessClient(
  config: InitConfig,
  deps: ClientDeps = {}
): HeadlessDataClient {
  return createClientParts(config, deps).client;
}

export { DataClientImpl };
