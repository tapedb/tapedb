/**
 * WebSocket wire contract for workspace live queries.
 *
 * Client -> server: `ping`, `query:subscribe`, `query:unsubscribe`, the
 * presence messages, `topic:join`, `topic:leave`, `topic:send`.
 * Server -> client: `session:ready`, `session:error`, `pong`, `query:data`,
 * `query:diff`, `query:unsubscribed`, `query:error`, the presence updates,
 * `topic:message`, `topic:error`, `error`.
 *
 * The socket attachment is the only durable copy of a subscription, so it is
 * persisted with `serializeAttachment` and re-read after hibernation.
 */

import {
  WORKSPACE_ROLE_LEVELS,
  type RoleClaim,
  type WorkspaceRole,
} from "../claims";
import type { QueryDocument, QueryPageInfo, QueryResult } from "./query-types";
import { isTopic } from "./topics";

export interface StoredSubscription {
  id: string;
  /** Monotonic per-subscription sequence; persisted so wake does not rewind. */
  seq: number;
  query: QueryDocument;
}

/** What one socket publishes in one presence room (one target). */
export interface PresenceEntry {
  /** Arbitrary JSON presence (name, colour, ...); never persisted. */
  presence?: unknown;
  cursor?: unknown;
  drag?: unknown;
}

/**
 * A socket's presence rooms, keyed by target (a diagram id, say). A socket
 * holds several at once — up to the deployment's `maxPresenceRooms` — and
 * leaving one leaves the others alone.
 */
export type PresenceState = Record<string, PresenceEntry>;

export interface PresencePeer {
  clientId: string;
  presence: unknown;
  cursor?: unknown;
  drag?: unknown;
  /**
   * Set on the entry that is the caller itself, which the client only
   * includes when asked for (`peers({ includeSelf: true })`).
   */
  isSelf?: true;
}

export const PRESENCE_TARGET_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

export function isPresenceTarget(value: unknown): value is string {
  return typeof value === "string" && PRESENCE_TARGET_PATTERN.test(value);
}

/** The targets this socket holds a presence room in, in join order. */
export function presenceTargets(attachment: Pick<SocketAttachment, "presence">): string[] {
  return attachment.presence ? Object.keys(attachment.presence) : [];
}

/** This socket's presence in one target, if it joined that room. */
export function presenceEntry(
  attachment: Pick<SocketAttachment, "presence">,
  target: string
): PresenceEntry | undefined {
  return attachment.presence?.[target];
}

export interface SocketAttachment {
  clientId: string;
  sub: string;
  role: WorkspaceRole;
  /** Claim expiry, seconds since epoch. */
  exp: number;
  subscriptions: StoredSubscription[];
  /** Current ephemeral presence target and values for this socket. */
  presence?: PresenceState;
  /** Broadcast topics this socket has joined. */
  topics?: string[];
}

export interface PingMessage {
  type: "ping";
  at?: unknown;
}

export interface QuerySubscribeMessage {
  type: "query:subscribe";
  id: string;
  query: unknown;
}

export interface QueryUnsubscribeMessage {
  type: "query:unsubscribe";
  id: string;
}

export interface PresenceSetMessage {
  type: "presence:set";
  target: string;
  presence: unknown;
}

export interface PresenceClearMessage {
  type: "presence:clear";
  target: string;
}

export interface CursorSetMessage {
  type: "cursor:set";
  target: string;
  cursor: unknown;
}

export interface DragSetMessage {
  type: "drag:set";
  target: string;
  drag: unknown;
}

export interface DragClearMessage {
  type: "drag:clear";
  target: string;
}

export interface TopicJoinMessage {
  type: "topic:join";
  topic: string;
}

export interface TopicLeaveMessage {
  type: "topic:leave";
  topic: string;
}

export interface TopicSendMessage {
  type: "topic:send";
  topic: string;
  message: unknown;
}

export type ClientMessage =
  | TopicJoinMessage
  | TopicLeaveMessage
  | TopicSendMessage
  | PingMessage
  | QuerySubscribeMessage
  | QueryUnsubscribeMessage
  | PresenceSetMessage
  | PresenceClearMessage
  | CursorSetMessage
  | DragSetMessage
  | DragClearMessage;

export interface SessionReadyMessage {
  type: "session:ready";
  workspaceId: string;
  connections: number;
  /**
   * The id of this socket's session, stable for its lifetime — the id that
   * appears in peer lists. Absent from a Worker older than multiple presence
   * rooms, in which case a client cannot tell which peer it is.
   */
  clientId?: string;
}

export interface SessionErrorMessage {
  type: "session:error";
  code: string;
  message: string;
}

export interface PongMessage {
  type: "pong";
  at?: unknown;
  now: number;
}

export interface QueryDataMessage {
  type: "query:data";
  id: string;
  seq: number;
  data: QueryResult;
  pageInfo?: QueryPageInfo;
}

export interface QueryDiffMessage {
  type: "query:diff";
  id: string;
  seq: number;
  /** Top-level namespace this diff applies to. */
  namespace: string;
  added: unknown[];
  updated: unknown[];
  removed: string[];
  /**
   * Every id in the namespace's result, in the query's order. Present when
   * keeping surviving rows in place and appending `added` would not give
   * that order: a row arrived mid-list, or an update moved one.
   */
  order?: string[];
  /** Present when the subscription's page metadata changed. */
  pageInfo?: QueryPageInfo;
}

export interface QueryUnsubscribedMessage {
  type: "query:unsubscribed";
  id: string;
}

export interface QueryErrorMessage {
  type: "query:error";
  id: string | null;
  code: string;
  message: string;
}

export interface PresenceUpdateMessage {
  type: "presence:update";
  target: string;
  peers: PresencePeer[];
}

export interface CursorUpdateMessage {
  type: "cursor:update";
  target: string;
  clientId: string;
  cursor: unknown;
}

export interface DragUpdateMessage {
  type: "drag:update";
  target: string;
  clientId: string;
  drag: unknown;
}

export interface TopicMessage {
  type: "topic:message";
  topic: string;
  message: unknown;
  /** The sending socket's client id and the claim subject behind it. */
  from: { clientId: string; sub: string };
}

export interface TopicErrorMessage {
  type: "topic:error";
  topic: string | null;
  code: string;
  message: string;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message?: string;
}

export type ServerMessage =
  | SessionReadyMessage
  | SessionErrorMessage
  | PongMessage
  | QueryDataMessage
  | QueryDiffMessage
  | QueryUnsubscribedMessage
  | QueryErrorMessage
  | PresenceUpdateMessage
  | CursorUpdateMessage
  | DragUpdateMessage
  | TopicMessage
  | TopicErrorMessage
  | ErrorMessage;

/**
 * Validates a deserialized attachment. Returns `null` for a socket accepted
 * before its claim was verified, or for any value that does not match the
 * persisted contract.
 */
export function parseSocketAttachment(value: unknown): SocketAttachment | null {
  if (!isRecord(value)) return null;

  const { clientId, sub, role, exp, subscriptions, presence, topics } = value;
  if (typeof clientId !== "string" || clientId.length === 0) return null;
  if (typeof sub !== "string" || sub.length === 0) return null;
  if (
    typeof role !== "number" ||
    !Number.isInteger(role) ||
    role < WORKSPACE_ROLE_LEVELS.GUEST ||
    role > WORKSPACE_ROLE_LEVELS.DEVELOPER
  ) {
    return null;
  }
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  if (!Array.isArray(subscriptions)) return null;

  const stored: StoredSubscription[] = [];
  for (const entry of subscriptions) {
    const subscription = parseSubscription(entry);
    if (subscription === null) return null;
    stored.push(subscription);
  }

  const parsedPresence = parsePresenceState(presence);
  if (parsedPresence === null) return null;

  if (topics !== undefined && (!Array.isArray(topics) || !topics.every(isTopic))) {
    return null;
  }

  return {
    clientId,
    sub,
    role: role as WorkspaceRole,
    exp,
    subscriptions: stored,
    ...(parsedPresence ? { presence: parsedPresence } : {}),
    ...(Array.isArray(topics) && topics.length > 0 ? { topics: [...topics] } : {}),
  };
}

/**
 * The whole per-target presence state of one socket, in bytes as stored.
 *
 * Rooms are cheap; bytes are what the attachment pays for and what a client
 * can abuse: past `INLINE_STATE_BYTES` (12 KiB) the state moves to
 * `_socket_state`, and from then on every cursor move is a SQLite write
 * instead of an attachment rewrite. So the room cap is paired with a byte
 * budget, checked before a `presence:set` is stored.
 */
export const PRESENCE_STATE_BYTES = 8192;

const presenceEncoder = new TextEncoder();

/** Bytes `presence` takes in the attachment's JSON. */
export function presenceStateBytes(presence: PresenceState | undefined): number {
  return presence === undefined ? 0 : presenceEncoder.encode(JSON.stringify(presence)).byteLength;
}

/**
 * A socket's presence, from the attachment. Accepts the shape stored before
 * multiple rooms existed — one `{ target, presence, cursor, drag }` per
 * socket — so a socket that hibernated across an upgrade keeps its room.
 */
function parsePresenceState(value: unknown): PresenceState | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;

  if (typeof value.target === "string") {
    if (!isPresenceTarget(value.target)) return null;
    return { [value.target]: entryOf(value) };
  }

  const rooms: PresenceState = {};
  for (const [target, stored] of Object.entries(value)) {
    if (!isPresenceTarget(target) || !isRecord(stored)) return null;
    rooms[target] = entryOf(stored);
  }
  return Object.keys(rooms).length > 0 ? rooms : undefined;
}

function entryOf(value: Record<string, unknown>): PresenceEntry {
  const entry: PresenceEntry = {};
  if ("presence" in value) entry.presence = value.presence;
  if ("cursor" in value) entry.cursor = value.cursor;
  if ("drag" in value) entry.drag = value.drag;
  return entry;
}

/** Rebuilds the claim used for permission checks on an accepted socket. */
export function claimFromAttachment(
  attachment: SocketAttachment,
  workspaceId: string
): RoleClaim {
  return {
    sub: attachment.sub,
    workspaceId,
    role: attachment.role,
    exp: attachment.exp,
    iat: 0,
  };
}

function parseSubscription(value: unknown): StoredSubscription | null {
  if (!isRecord(value)) return null;

  const { id, seq, query } = value;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    return null;
  }
  if (!isRecord(query)) return null;

  return { id, seq, query: query as QueryDocument };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
