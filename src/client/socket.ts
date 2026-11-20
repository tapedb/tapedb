/**
 * One shared WebSocket per data client, with reconnect + resubscribe.
 *
 * Browsers cannot set an `Authorization` header on a WebSocket upgrade, so
 * the role claim rides in `Sec-WebSocket-Protocol` (see socket-protocol.ts),
 * never in the URL. A fresh token is fetched for every reconnect attempt.
 */

import { randomUuid } from "./id";
import { MAX_SOCKET_MESSAGE_BYTES, MAX_SOCKET_PENDING_BYTES, MAX_SOCKET_MESSAGE_PARTS, socketProtocols } from "../socket-protocol";
import type { ClientMessage, ServerMessage } from "./types";

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

/** Creates a socket for `url`, offering `protocols` (they carry the claim; pass them on). */
export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;

export interface QuerySocketOptions {
  /** Engine websocket URL. The claim is sent as a subprotocol, not in the URL. */
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
  return (url, protocols) => {
    if (typeof WebSocket === "undefined") {
      throw new Error("tapedb-data: WebSocket is not available in this runtime.");
    }
    return new WebSocket(url, protocols) as unknown as WebSocketLike;
  };
}

/**
 * Characters per frame before a message is sent in parts: 256 Ki UTF-16
 * units is at most 768 KiB of UTF-8, far inside the 32 MiB Cloudflare
 * accepts per frame, and small enough not to stall other traffic.
 */
export const FRAME_PART_CHARS = 256 * 1024;

/** Splits text into parts without cutting a surrogate pair. */
function splitText(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + size, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

/**
 * The frames for one message. A large topic message goes as topic parts,
 * which the room relays as they come; any other large message as `part`
 * frames the room joins before running it.
 */
export function framesFor(message: ClientMessage, size = FRAME_PART_CHARS): string[] {
  const text = JSON.stringify(message);
  if (text.length <= size) return [text];
  const id = randomUuid();
  if (message.type === "topic:send" && "message" in message) {
    const parts = splitText(JSON.stringify(message.message), size);
    return parts.map((data, index) =>
      JSON.stringify({
        type: "topic:send",
        topic: message.topic,
        part: { id, index, last: index === parts.length - 1 },
        data,
        ...(message.origin !== undefined ? { origin: message.origin } : {}),
      })
    );
  }
  const parts = splitText(text, size);
  return parts.map((data, index) => JSON.stringify({ type: "part", id, index, last: index === parts.length - 1, data }));
}

/**
 * Joins topic messages that arrive in parts, per sender and message. A part
 * out of order (a sender that dropped mid-message) discards what was joined.
 */
export class TopicParts {
  private readonly pending = new Map<string, { next: number; parts: string[]; bytes: number; at: number }>();

  take(message: Extract<ServerMessage, { type: "topic:message" }>): ServerMessage | null {
    if (!("part" in message)) return message;
    const key = `${message.from.clientId}\u0000${message.part.id}`;
    const now = Date.now();
    for (const [id, entry] of this.pending) if (now - entry.at > 60_000) this.pending.delete(id);
    const entry = this.pending.get(key) ?? { next: 0, parts: [], bytes: 0, at: now };
    const bytes = message.data.length > MAX_SOCKET_MESSAGE_BYTES ? MAX_SOCKET_MESSAGE_BYTES + 1 : new TextEncoder().encode(message.data).byteLength;
    const total = [...this.pending.values()].reduce((sum, item) => sum + item.bytes, 0);
    if (entry.next >= MAX_SOCKET_MESSAGE_PARTS || entry.bytes + bytes > MAX_SOCKET_MESSAGE_BYTES || total + bytes > MAX_SOCKET_PENDING_BYTES || (!this.pending.has(key) && this.pending.size >= 32)) {
      this.pending.delete(key);
      return null;
    }
    entry.bytes += bytes;
    if (message.part.index !== entry.next) {
      this.pending.delete(key);
      return null;
    }
    entry.parts.push(message.data);
    entry.next += 1;
    if (!message.part.last) {
      this.pending.set(key, entry);
      return null;
    }
    this.pending.delete(key);
    try {
      return {
        type: "topic:message",
        topic: message.topic,
        message: JSON.parse(entry.parts.join("")),
        from: message.from,
        // The last part's sequence stands for the whole message.
        ...(message.seq !== undefined ? { seq: message.seq } : {}),
        ...(message.origin !== undefined ? { origin: message.origin } : {}),
      };
    } catch {
      return null;
    }
  }

  clear(): void {
    this.pending.clear();
  }
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
  private readonly topicParts = new TopicParts();
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
      for (const frame of framesFor(message)) this.ws.send(frame);
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
      const ws = this.createWebSocket(this.baseUrl, socketProtocols(token));
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
        const parsed = parseServerMessage(event.data);
        const message = parsed?.type === "topic:message" ? this.topicParts.take(parsed) : parsed;
        if (!message) return;
        if (message.type === "session:ready") this.onSessionReady?.();
        this.onMessage(message);
      };

      ws.onerror = () => {
        // `onclose` schedules the reconnect; avoid double-handling.
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        // A peer's message half-received on this socket will not continue.
        this.topicParts.clear();
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
