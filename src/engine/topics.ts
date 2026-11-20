/**
 * Realtime: who may join a presence room or a broadcast topic, and how much
 * of each the room keeps.
 *
 * Presence and broadcast topics share one authorizer
 * (`defineTapeDB({ realtime: { authorize } })`): it is handed the caller's
 * claim, the kind of channel, its target and whether the caller is joining it
 * or sending to it, and may answer asynchronously. Presence is checked
 * *before* any state is stored, so a refusal leaves the socket exactly as it
 * was.
 *
 * `defineTapeDB({ topics })` is the older spelling and keeps working: its
 * `authorize` applies to topic kinds only, and is consulted only when
 * `realtime.authorize` is absent, so a deployment that configures both gets
 * one rule set per kind rather than two competing ones.
 *
 * Topics keep the last `replaySeconds` of each channel (default 60, at most
 * `REPLAY_MESSAGES`) for a client that rejoins after a reconnect and passes
 * the last sequence it saw.
 */

import type { RoleClaim } from "../claims";

/** Topic names: the same alphabet and length as presence targets. */
export const TOPIC_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;

export function isTopic(value: unknown): value is string {
  return typeof value === "string" && TOPIC_PATTERN.test(value);
}

/** @experimental May change in a minor release. */
export type TopicAction = "join" | "send";

/** The kinds of realtime channel the authorizer covers. */
export type RealtimeKind = "presence" | "topic";

/** How many presence rooms one socket may hold at once, unless configured. */
export const DEFAULT_MAX_PRESENCE_ROOMS = 4;

/** What an authorizer is told about one request. */
export interface RealtimeAuthorizeContext {
  auth: { sub: string; role: number; workspaceId: string };
  kind: RealtimeKind;
  /** The presence target or topic name being joined or sent to. */
  target: string;
  action: TopicAction;
}

/**
 * Decides whether a caller may join a channel or send to it. Return false (or
 * throw) to refuse: presence answers `presence_denied`, topics answer
 * `permission_denied`, and nothing is stored either way.
 *
 * @experimental May change in a minor release.
 */
export type RealtimeAuthorizer = (
  context: RealtimeAuthorizeContext
) => boolean | Promise<boolean>;

/**
 * The authorizer `defineTapeDB({ topics })` installs: the same decision, told
 * the topic rather than a generic target.
 *
 * @experimental May change in a minor release.
 * @deprecated Use `RealtimeAuthorizer` with `realtime.authorize`.
 */
export type TopicAuthorizer = (context: {
  auth: { sub: string; role: number; workspaceId: string };
  topic: string;
  action: TopicAction;
}) => boolean;

let authorizer: RealtimeAuthorizer | null = null;
let replayMs = 60_000;
let maxRooms = DEFAULT_MAX_PRESENCE_ROOMS;

/** Messages kept per topic for replay, however short their age. */
export const REPLAY_MESSAGES = 1000;

/**
 * Realtime options for `defineTapeDB({ realtime })`.
 *
 * @experimental May change in a minor release.
 */
export interface RealtimeOptions {
  /** One rule set for presence rooms and broadcast topics. */
  authorize?: RealtimeAuthorizer;
  /**
   * Presence rooms one socket may hold at once. Default 4; 1 restores the
   * single-room behaviour, 0 refuses presence altogether.
   */
  maxPresenceRooms?: number;
  /** Seconds of each topic kept for clients that reconnect; 0 keeps none. Default 60. */
  replaySeconds?: number;
}

/**
 * Topic options for `defineTapeDB({ topics })`.
 *
 * @experimental May change in a minor release.
 * @deprecated Use `defineTapeDB({ realtime })`.
 */
export interface TopicOptions {
  /** @deprecated Use `realtime.authorize`, which covers topics as well. */
  authorize?: TopicAuthorizer;
  /** Seconds of each topic kept for clients that reconnect; 0 keeps none. Default 60. */
  replaySeconds?: number;
}

/** The authorizer tells topic callers the topic; realtime callers the target. */
function asRealtime(authorize: TopicAuthorizer): RealtimeAuthorizer {
  return (context) =>
    authorize({
      auth: context.auth,
      topic: context.target,
      action: context.action,
    });
}

function checkReplaySeconds(seconds: unknown, where: string): void {
  if (!(typeof seconds === "number" && seconds >= 0 && Number.isFinite(seconds))) {
    throw new Error(`${where}.replaySeconds must be a number of seconds, 0 or more.`);
  }
}

/**
 * Installed by `defineTapeDB({ realtime, topics })`. `realtime` wins for
 * both kinds; `topics` covers topic kinds when `realtime.authorize` is
 * absent, so an existing deployment keeps its topic rules untouched.
 */
export function configureRealtime(
  realtime: RealtimeOptions | undefined,
  topics: TopicOptions | undefined
): void {
  if (realtime?.authorize !== undefined) {
    authorizer = realtime.authorize;
  } else if (topics?.authorize !== undefined) {
    authorizer = asRealtime(topics.authorize);
  } else {
    authorizer = null;
  }

  const seconds = realtime?.replaySeconds ?? topics?.replaySeconds ?? 60;
  checkReplaySeconds(seconds, realtime?.replaySeconds !== undefined ? "realtime" : "topics");
  replayMs = seconds * 1000;

  const rooms = realtime?.maxPresenceRooms ?? DEFAULT_MAX_PRESENCE_ROOMS;
  if (!(Number.isInteger(rooms) && rooms >= 0)) {
    throw new Error("realtime.maxPresenceRooms must be a whole number of rooms, 0 or more.");
  }
  maxRooms = rooms;
}

/** Installed by `defineTapeDB({ topics })` on its own; keeps `realtime` unset. */
export function configureTopics(options: TopicOptions | undefined): void {
  configureRealtime(undefined, options);
}

export function topicReplayMs(): number {
  return replayMs;
}

/** How many presence rooms one socket may hold. */
export function maxPresenceRooms(): number {
  return maxRooms;
}

/**
 * Runs the configured authorizer. Anything but a plain `true` — `false`, a
 * throw, a rejected promise — refuses; with no authorizer configured everyone
 * with a claim for the workspace may join and send.
 *
 * @experimental May change in a minor release.
 */
export async function realtimeAllowed(
  claim: RoleClaim,
  kind: RealtimeKind,
  target: string,
  action: TopicAction
): Promise<boolean> {
  if (authorizer === null) return true;
  try {
    return (
      (await authorizer({
        auth: { sub: claim.sub, role: claim.role, workspaceId: claim.workspaceId },
        kind,
        target,
        action,
      })) === true
    );
  } catch {
    return false;
  }
}

/** Whether a caller may join or send to a topic. */
export function topicAllowed(claim: RoleClaim, topic: string, action: TopicAction): Promise<boolean> {
  return realtimeAllowed(claim, "topic", topic, action);
}
