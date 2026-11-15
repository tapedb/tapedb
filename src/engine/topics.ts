/**
 * Broadcast topics: fire-and-forget messages between the sockets of one
 * workspace, on the socket they already hold.
 *
 * A socket joins topics; a message sent to a topic reaches every other socket
 * joined to it, with the sender's client id and subject. Nothing is stored or
 * replayed: a socket that is not joined when a message is sent never sees it.
 * Joined topics live in the socket attachment, so they survive hibernation,
 * and the client rejoins them after a reconnect.
 *
 * Who may join or send is the deployment's call (`defineTapeDB({ topics })`);
 * by default any member of the workspace may, as with presence.
 */

import type { RoleClaim } from "../claims";

/** Topic names: the same alphabet and length as presence targets. */
export const TOPIC_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;

export function isTopic(value: unknown): value is string {
  return typeof value === "string" && TOPIC_PATTERN.test(value);
}

/** @experimental May change in a minor release. */
export type TopicAction = "join" | "send";

/**
 * Decides whether a caller may join a topic or send to it. Return false (or
 * throw) to refuse; the socket gets a `topic:error` and nothing else happens.
 *
 * @experimental May change in a minor release.
 */
export type TopicAuthorizer = (context: {
  auth: { sub: string; role: number; workspaceId: string };
  topic: string;
  action: TopicAction;
}) => boolean;

let authorizer: TopicAuthorizer | null = null;

/** Installed by `defineTapeDB({ topics: { authorize } })`. */
export function configureTopics(options: { authorize?: TopicAuthorizer } | undefined): void {
  authorizer = options?.authorize ?? null;
}

export function topicAllowed(claim: RoleClaim, topic: string, action: TopicAction): boolean {
  if (authorizer === null) return true;
  try {
    return (
      authorizer({
        auth: { sub: claim.sub, role: claim.role, workspaceId: claim.workspaceId },
        topic,
        action,
      }) === true
    );
  } catch {
    return false;
  }
}
