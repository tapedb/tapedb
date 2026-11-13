/**
 * One shared WebSocket per data client, with reconnect + resubscribe.
 *
 * The role claim rides on the query string because browsers cannot set an
 * `Authorization` header on a WebSocket upgrade. A fresh token is fetched for
 * every reconnect attempt.
 */

import type { ClientMessage, ServerMessage } from "./types";

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface QuerySocketOptions {
  /** Engine websocket URL without the `claim` query parameter. */
  baseUrl: string;
  getToken: () => Promise<string>;
  onMessage: (message: ServerMessage) => void;
  /** Called on every `session:ready`, including reconnects. */
  onSessionReady?: () => void;
  createWebSocket?: WebSocketFactory;
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

const DEFAULT_MIN_RECONNECT_DELAY_MS = 250;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 5_000;

function defaultWebSocketFactory(): WebSocketFactory {
  return (url) => {
    if (typeof WebSocket === "undefined") {
      throw new Error("tapedb-data: WebSocket is not available in this runtime.");
    }
    return new WebSocket(url) as unknown as WebSocketLike;
  };
}

function withClaim(baseUrl: string, token: string): string {
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}claim=${encodeURIComponent(token)}`;
}

function parseServerMessage(value: unknown): ServerMessage | null {
  let text: string | null = null;
  if (typeof value === "string") {
    text = value;
  } else if (value instanceof ArrayBuffer) {
    text = new TextDecoder().decode(value);
  }
  if (text === null) return null;

  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).type === "string"
    ) {
      return parsed as ServerMessage;
    }
  } catch {
    // Malformed frames are ignored; the socket contract is JSON only.
  }
  return null;
}

export class QuerySocket {
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string>;
  private readonly onMessage: (message: ServerMessage) => void;
  private readonly onSessionReady: (() => void) | undefined;
  private readonly createWebSocket: WebSocketFactory;
  private readonly minReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;

  private ws: WebSocketLike | null = null;
  private connectPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private manuallyClosed = false;
  private generation = 0;
  private cancelPending: (() => void) | null = null;
  /** True when reconnecting is paused until an explicit `connect()`. */
  private suspended = false;
  private onlineHandler: (() => void) | null = null;

  constructor(options: QuerySocketOptions) {
    this.baseUrl = options.baseUrl;
    this.getToken = options.getToken;
    this.onMessage = options.onMessage;
    this.onSessionReady = options.onSessionReady;
    this.createWebSocket = options.createWebSocket ?? defaultWebSocketFactory();
    this.minReconnectDelayMs =
      options.minReconnectDelayMs ?? DEFAULT_MIN_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs =
      options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;

    if (
      typeof window !== "undefined" &&
      typeof window.addEventListener === "function"
    ) {
      this.onlineHandler = () => this.reconnectNow();
      window.addEventListener("online", this.onlineHandler);
    }
  }

  get isOpen(): boolean {
    return this.ws !== null;
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    if (this.ws) return Promise.resolve();

    this.manuallyClosed = false;
    this.suspended = false;
    const generation = ++this.generation;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.cancelPending = () => reject(new Error("Connection attempt cancelled."));
      void this.open(generation, () => {
        if (generation === this.generation) this.cancelPending = null;
        resolve();
      }, (error) => {
        if (generation === this.generation) this.cancelPending = null;
        reject(error);
      });
    });
    return this.connectPromise;
  }

  send(message: ClientMessage): boolean {
    if (!this.ws) return false;
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      this.scheduleReconnect();
      return false;
    }
  }

  /**
   * Stops reconnecting without tearing the instance down, so an explicit
   * `connect()` (or an `online` event) can resume later.
   */
  suspend(): void {
    this.suspended = true;
    this.clearRetryTimer();
    this.cancelOpen();

    const previous = this.ws;
    this.ws = null;
    this.connectPromise = null;
    if (previous) {
      try {
        previous.close();
      } catch {
        // Already closed.
      }
    }
  }

  reconnectNow(): void {
    if (this.manuallyClosed) return;
    this.clearRetryTimer();
    this.cancelOpen();

    const previous = this.ws;
    this.ws = null;
    if (previous) {
      try {
        previous.close();
      } catch {
        // Already closed.
      }
    }

    this.connectPromise = null;
    this.attempt = 0;
    void this.connect().catch(() => {
      // `connect` schedules its own retry on failure.
    });
  }

  close(): void {
    this.manuallyClosed = true;
    this.clearRetryTimer();
    this.cancelOpen();

    const previous = this.ws;
    this.ws = null;
    this.connectPromise = null;
    if (previous) {
      try {
        previous.close();
      } catch {
        // Already closed.
      }
    }

    if (
      this.onlineHandler &&
      typeof window !== "undefined" &&
      typeof window.removeEventListener === "function"
    ) {
      window.removeEventListener("online", this.onlineHandler);
      this.onlineHandler = null;
    }
  }

  private cancelOpen(): void {
    this.generation += 1;
    this.cancelPending?.();
    this.cancelPending = null;
    this.connectPromise = null;
  }

  private async open(
    generation: number,
    resolve: () => void,
    reject: (error: unknown) => void
  ): Promise<void> {
    let settled = false;

    try {
      const token = await this.getToken();
      if (generation !== this.generation || this.manuallyClosed || this.suspended) {
        reject(new Error("Connection attempt cancelled."));
        return;
      }
      const ws = this.createWebSocket(withClaim(this.baseUrl, token));
      this.ws = ws;

      ws.onopen = () => {
        if (settled || generation !== this.generation || this.ws !== ws) return;
        settled = true;
        this.attempt = 0;
        resolve();
      };

      ws.onmessage = (event) => {
        // Frames from a socket we already replaced must not be applied: a late
        // buffered payload for a reused subscription id would overwrite the
        // newer socket's state.
        if (this.ws !== ws) return;
        const message = parseServerMessage(event.data);
        if (!message) return;
        if (message.type === "session:ready") this.onSessionReady?.();
        this.onMessage(message);
      };

      ws.onerror = () => {
        // `onclose` schedules the reconnect; avoid double-handling.
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.connectPromise = null;
        if (!settled) {
          settled = true;
          reject(new Error("tapedb-data: WebSocket closed before opening."));
        }
        if (!this.manuallyClosed) this.scheduleReconnect();
      };
    } catch (error) {
      if (generation !== this.generation) {
        reject(error);
        return;
      }
      this.ws = null;
      this.connectPromise = null;
      if (!settled) {
        settled = true;
        reject(error);
      }
      if (!this.manuallyClosed) this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.suspended || this.retryTimer !== null)
      return;

    const delay = Math.min(
      this.maxReconnectDelayMs,
      this.minReconnectDelayMs * 2 ** this.attempt
    );
    this.attempt += 1;

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect().catch(() => {
        // The next close/failure schedules another attempt.
      });
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
