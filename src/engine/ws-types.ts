/**
 * WebSocket wire contract for workspace live queries (KAN-393).
 *
 * Client -> server: `ping`, `query:subscribe`, `query:unsubscribe`.
 * Server -> client: `session:ready`, `session:error`, `pong`, `query:data`,
 * `query:diff`, `query:unsubscribed`, `query:error`, `error`.
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

export interface StoredSubscription {
  id: string;
  /** Monotonic per-subscription sequence; persisted so wake does not rewind. */
  seq: number;
  query: QueryDocument;
}

export interface PresenceState {
  /** Presence target, e.g. a diagram id. */
  target: string;
  /** Arbitrary JSON presence (name, colour, ...); never persisted. */
  presence?: unknown;
  cursor?: unknown;
  drag?: unknown;
}

export interface PresencePeer {
  clientId: string;
  presence: unknown;
  cursor?: unknown;
  drag?: unknown;
}

export const PRESENCE_TARGET_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

export function isPresenceTarget(value: unknown): value is string {
  return typeof value === "string" && PRESENCE_TARGET_PATTERN.test(value);
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

export type ClientMessage =
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
  | ErrorMessage;

/**
 * Validates a deserialized attachment. Returns `null` for a socket accepted
 * before its claim was verified, or for any value that does not match the
 * persisted contract.
 */
export function parseSocketAttachment(value: unknown): SocketAttachment | null {
  if (!isRecord(value)) return null;

  const { clientId, sub, role, exp, subscriptions, presence } = value;
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

  return {
    clientId,
    sub,
    role: role as WorkspaceRole,
    exp,
    subscriptions: stored,
    ...(parsedPresence ? { presence: parsedPresence } : {}),
  };
}

function parsePresenceState(value: unknown): PresenceState | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  if (!isPresenceTarget(value.target)) return null;
  return {
    target: value.target,
    presence: value.presence,
    cursor: value.cursor,
    drag: value.drag,
  };
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
