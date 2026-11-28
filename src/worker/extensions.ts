/**
 * Worker extensions: packages that add routes, scheduled work and change
 * handlers to a TapeDB deployment, declared with the rest of it.
 *
 *   defineTapeDB({ schema, migrations, extensions: [cms({ content })] })
 *
 * An extension's routes see every request TapeDB itself does not answer.
 * Its change handler receives the deployment's change events for the models
 * it names, delivered like a webhook (after the commit, in order, retried
 * until it succeeds) but called in the workspace's Durable Object rather
 * than over the network, so it needs no URL, secret or public address.
 */
import type { WebhookEvent, WebhookEventPayload } from "../engine/webhooks";
import type { Env } from "../types";

/** What a Worker extension gets from TapeDB besides `env` and `ctx`. @experimental */
export interface ExtensionContext {
  /** This deployment's own fetch handler, called in process: engine routes, files, claims. */
  fetch(request: Request): Promise<Response>;
  /**
   * A claim for `workspaceId`, signed with the deployment's claim secret, to
   * act as `sub` with `role` through the engine routes and their rules.
   */
  signClaim(workspaceId: string, as: { sub: string; role: number; ttlSeconds?: number }): Promise<string>;
  /** The caller's claim from a Bearer header or token, checked for `workspaceId`; null when it is missing or invalid. */
  verifyClaim(token: string | null | undefined, workspaceId: string): Promise<{ sub: string; role: number; workspaceId: string } | null>;
}

/** Change events an extension receives. @experimental */
export interface ExtensionChanges {
  /** Models by API name; every model when omitted. */
  models?: readonly string[];
  /** Default: create, update and delete. */
  events?: readonly WebhookEvent[];
  /**
   * Called after the write committed, once per changed row, in sequence order.
   * Throwing retries the event with backoff, as a failed webhook does.
   */
  handle(event: WebhookEventPayload, env: Env): Promise<void> | void;
}

/** A package's routes, cron work and change handler, for `defineTapeDB({ extensions })`. @experimental */
export interface TapeDBExtension {
  /** Names the extension in errors and in the change outbox; letters, digits and dashes. */
  name: string;
  /** Requests TapeDB does not answer: return a Response, or null to pass. */
  fetch?(request: Request, env: Env, ctx: ExecutionContext, tapedb: ExtensionContext): Response | null | undefined | Promise<Response | null | undefined>;
  /** The Worker's cron triggers. */
  scheduled?(controller: ScheduledController, env: Env, ctx: ExecutionContext, tapedb: ExtensionContext): void | Promise<void>;
  changes?: ExtensionChanges;
}

/** The URL scheme of an extension's change endpoint in the webhook outbox. */
export const EXTENSION_SCHEME = "tapedb-extension:";

export function resolveExtensions(extensions: readonly TapeDBExtension[] | undefined) {
  const list = extensions ?? [];
  const seen = new Set<string>();
  for (const [i, ext] of list.entries()) {
    if (!ext || typeof ext !== "object") throw new Error(`extensions[${i}] must be an extension object.`);
    if (typeof ext.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(ext.name)) {
      throw new Error(`extensions[${i}].name must be lowercase letters, digits and dashes.`);
    }
    if (seen.has(ext.name)) throw new Error(`Two extensions are named "${ext.name}".`);
    seen.add(ext.name);
    if (ext.changes && typeof ext.changes.handle !== "function") throw new Error(`extensions[${i}].changes.handle must be a function.`);
  }
  const handlers = new Map<string, ExtensionChanges["handle"]>();
  for (const ext of list) if (ext.changes) handlers.set(ext.name, ext.changes.handle);
  return { list: Object.freeze([...list]), handlers };
}
