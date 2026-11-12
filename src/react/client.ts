"use client";

/**
 * ndex data client (KAN-394).
 *
 * Keeps InstantDB's client surface over one WebSocket per workspace:
 * `useQuery`, `transact`, `tx`, plus native room and storage adapters. Queries are
 * subscribed once per unique query shape, transactions are optimistic and
 * durable via an IndexedDB outbox, and reconnects re-auth + resubscribe.
 */
import { useRef, useSyncExternalStore } from "react";

import { id } from "../client/id";
import { createStorageClient, type StorageFetch } from "../client/storage-client";
import { createOutbox, type Outbox } from "../client/outbox";
import { applyOptimisticOps, applyQueryDiff } from "../client/query-cache";
import { resolveLink } from "../client/schema";
import { QuerySocket, type WebSocketFactory } from "../client/socket";
import { cloneJson, stableStringify } from "../client/stable";
import type {
  DataClient,
  InitConfig,
  OutboxEntry,
  PresencePeer,
  QueryDocument,
  QueryError,
  QueryResult,
  QueryState,
  SchemaDefinition,
  ServerMessage,
  TransactInput,
  TxEntity,
  TxLinkOp,
  TxOp,
  TxProxy,
  TxStep,
  TxUnlinkOp,
} from "../client/types";

const DEFAULT_API_URL = "http://localhost:8787";
const MAX_RETRY_DELAY_MS = 30_000;
const BASE_RETRY_DELAY_MS = 1_000;

/** Consecutive auth failures before reconnecting stops and the error surfaces. */
const MAX_AUTH_ATTEMPTS = 3;

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
    body: string;
  }
) => Promise<FetchResponseLike>;

export interface ClientDeps {
  fetch?: FetchLike;
  storageFetch?: StorageFetch;
  createWebSocket?: WebSocketFactory;
  outbox?: Outbox;
  now?: () => number;
}

interface ResolvedConfig {
  workspaceId: string;
  apiUrl: string;
  websocketUrl: string;
  getToken: (() => Promise<string>) | null;
  schema?: SchemaDefinition;
}

interface CacheEntry {
  key: string;
  query: QueryDocument;
  state: QueryState;
  seq: number;
  subId: string;
  listeners: Set<() => void>;
}

interface CacheSnapshot {
  key: string;
  seq: number;
  data: QueryResult;
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
    throw new Error("tapedb-data: transact() received an invalid operation.");
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

function resolveConfig(config: InitConfig): ResolvedConfig {
  const workspaceId = config.workspaceId ?? "";
  const apiUrl = trimTrailingSlash(config.apiUrl ?? DEFAULT_API_URL);
  const websocketUrl =
    config.websocketUrl ?? deriveWebSocketUrl(apiUrl, workspaceId);

  return {
    workspaceId,
    apiUrl,
    websocketUrl,
    getToken: config.getToken ?? null,
    schema: config.schema,
  };
}

function single(op: TxOp): TxStep {
  return { ops: [op], op };
}

function linkStep(
  schema: SchemaDefinition | undefined,
  namespace: string,
  entityId: string,
  links: Record<string, string>,
  op: "link" | "unlink"
): TxStep {
  const entries = Object.entries(links);
  if (entries.length === 0) {
    throw new Error(`tapedb-data: ${op}() requires at least one link.`);
  }

  const ops = entries.map(([label, targetId]) => {
    const resolved = resolveLink(schema, namespace, label);
    const wireOp: TxLinkOp | TxUnlinkOp = {
      op,
      namespace,
      id: entityId,
      link: resolved.apiName,
      targetId,
    };
    return wireOp;
  });

  return { ops, op: ops[0]! };
}

function createTxEntity(
  schema: SchemaDefinition | undefined,
  namespace: string,
  entityId: string
): TxEntity {
  return {
    update(values) {
      return single({ op: "update", namespace, id: entityId, values });
    },
    merge(values) {
      return single({ op: "merge", namespace, id: entityId, values });
    },
    delete() {
      return single({ op: "delete", namespace, id: entityId });
    },
    link(links) {
      return linkStep(schema, namespace, entityId, links, "link");
    },
    unlink(links) {
      return linkStep(schema, namespace, entityId, links, "unlink");
    },
  };
}

export function createTxProxy(schema: SchemaDefinition | undefined): TxProxy {
  return new Proxy({} as TxProxy, {
    get(_target, namespace) {
      if (typeof namespace !== "string") return undefined;

      return new Proxy({} as Record<string, TxEntity>, {
        get(_entityTarget, entityId) {
          if (typeof entityId !== "string") return undefined;
          return createTxEntity(schema, namespace, entityId);
        },
      });
    },
  });
}

class DataClientImpl {
  readonly tx: TxProxy;

  private readonly config: ResolvedConfig;
  private readonly fetchImpl: FetchLike;
  private readonly createWebSocket: WebSocketFactory | undefined;
  private readonly outbox: Outbox;
  private readonly now: () => number;

  private readonly cache = new Map<string, CacheEntry>();
  private readonly subIdToKey = new Map<string, string>();
  private nextSubId = 0;

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

  constructor(config: InitConfig, deps: ClientDeps = {}) {
    this.config = resolveConfig(config);
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
    this.createWebSocket = deps.createWebSocket;
    this.outbox = deps.outbox ?? createOutbox();
    this.now = deps.now ?? (() => Date.now());
    this.tx = createTxProxy(this.config.schema);

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

  async transact(input: TransactInput): Promise<void> {
    const ops = normalizeOps(input);
    if (ops.length === 0) return;

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
      await this.sendTransaction(outboxEntry);
      await this.outbox.remove(clientTxId);
      this.pendingOps.delete(clientTxId);
      this.retryAttempt = 0;
      this.clearRetryTimer();
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
    } finally {
      this.inFlight.delete(clientTxId);
    }
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
      throw new Error("tapedb-data: WebSocket is not available.");
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
      return "tapedb-data: missing workspaceId. Pass init({ workspaceId }) or set NEXT_PUBLIC_NDEX_WORKSPACE_ID.";
    }
    if (!this.config.getToken) {
      return "tapedb-data: missing getToken. Pass init({ getToken: () => Promise<string> }).";
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
      query: entry.query,
    });
  }

  private resubscribeAll(): void {
    for (const entry of this.cache.values()) {
      if (entry.listeners.size > 0) this.sendSubscribe(entry);
    }
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
        const entry = this.entryBySubId(message.id);
        if (!entry || entry.state.data === null) return;
        entry.seq = message.seq;
        entry.state = {
          data: applyQueryDiff(entry.state.data, message),
          isLoading: false,
          error: null,
        };
        this.notify(entry);
        return;
      }
      case "query:error": {
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

  private async sendTransaction(entry: OutboxEntry): Promise<void> {
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
  }

  private async requireToken(): Promise<string> {
    if (!this.config.getToken) {
      throw new Error("tapedb-data: missing getToken.");
    }
    return this.config.getToken();
  }

  private async doFlush(): Promise<void> {
    const entries = await this.outbox.list(this.config.workspaceId);

    for (const entry of entries) {
      if (this.inFlight.has(entry.clientTxId)) continue;
      this.inFlight.add(entry.clientTxId);

      this.pendingOps.set(entry.clientTxId, entry.ops);

      try {
        await this.sendTransaction(entry);
        await this.outbox.remove(entry.clientTxId);
        this.pendingOps.delete(entry.clientTxId);
        this.retryAttempt = 0;
      } catch (error) {
        if (isServerError(error) && !isRetryableServerError(error)) {
          await this.outbox.remove(entry.clientTxId).catch(() => undefined);
          this.pendingOps.delete(entry.clientTxId);
          // The optimistic row will not be reconciled by a push; refetch.
          this.resubscribeAll();
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

export function createDataClient(
  config: InitConfig,
  deps: ClientDeps = {}
): DataClient {
  const impl = new DataClientImpl(config, deps);

  /**
   * A custom hook (name starts with `use`) so React's rules-of-hooks lint
   * understands the hook calls below. Keeping it outside the class avoids
   * treating the client as a class component.
   */
  function useQuery(query: QueryDocument): QueryState {
    const key = stableStringify(query);
    const queryRef = useRef(query);
    queryRef.current = query;

    const subscriptionRef = useRef<{
      key: string;
      subscribe: (onStoreChange: () => void) => () => void;
    } | null>(null);

    let subscription = subscriptionRef.current;
    if (subscription === null || subscription.key !== key) {
      subscription = {
        key,
        subscribe: (onStoreChange) =>
          impl.subscribeQuery(queryRef.current, onStoreChange),
      };
      subscriptionRef.current = subscription;
    }

    const getSnapshot = () => impl.getQueryState(queryRef.current);

    return useSyncExternalStore(
      subscription.subscribe,
      getSnapshot,
      getSnapshot
    );
  }

  return {
    useQuery,
    transact: (input) => impl.transact(input),
    tx: impl.tx,
    get files() {
      return createStorageClient({
        apiUrl: resolveConfig(config).apiUrl,
        workspaceId: resolveConfig(config).workspaceId,
        getToken: async () => {
          if (!config.getToken) throw new Error("Storage requires getToken.");
          return config.getToken();
        },
        fetch: deps.storageFetch,
      });
    },
    storage: (appId) =>
      createStorageClient({
        apiUrl: resolveConfig(config).apiUrl,
        appId,
        getToken: async () => {
          if (!config.getToken) throw new Error("Storage requires getToken.");
          return config.getToken();
        },
        fetch: deps.storageFetch,
      }),
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
}

/** Creates a workspace engine client with native room and storage adapters. */
export function init(config: InitConfig): DataClient {
  return createDataClient(config);
}
