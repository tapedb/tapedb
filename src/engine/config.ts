/**
 * One deployment's configuration, carried by value.
 *
 * `defineTapeDB` builds exactly one of these from its options and hands it to
 * every `WorkspaceRoom` it constructs (`WorkspaceRoomOptions.config`). Nothing
 * reads it from a module global: a Worker isolate runs `defineTapeDB` once, but
 * the same engine also runs in Node (`@tapedb/tapedb/backend`), and there two
 * deployments in one process would otherwise share one set of flags.
 *
 * The values that used to live in module-level `let`s — the audit flag, file
 * rules, the realtime authorizer and caps, webhooks, the log part size — are
 * fields here instead. They are read-only and frozen: `deploymentConfig()` is
 * the only constructor, and the frozen default below is what a standalone
 * engine call (a durability repair, a unit test with no room) gets. There is
 * no setter anywhere, so one deployment cannot change another's answer.
 */

import type { ConfiguredQuery } from "./sql-query";
import type { FileRules } from "./file-access";
import type { RealtimeAuthorizer } from "./topics";
import { DEFAULT_MAX_PRESENCE_ROOMS, DEFAULT_TOPIC_REPLAY_MS } from "./topics";
import type { ConfiguredVectorize } from "./vector-index/definition";
import type { ConfiguredWebhook, WebhookTransport } from "./webhooks";
import { LOG_PART_BYTES } from "./tx-log";

/** Resolved realtime settings: who may join a channel, and how much is kept. */
export interface RealtimeConfig {
  /** Absent when the deployment configures no authorizer: everyone with a claim may join. */
  readonly authorizer: RealtimeAuthorizer | null;
  /** Topic replay window in milliseconds; 0 keeps nothing. */
  readonly replayMs: number;
  /** Presence rooms one socket may hold at once. */
  readonly maxRooms: number;
}

/**
 * Everything that used to be a module-level mutable in the engine.
 *
 * Frozen by `deploymentConfig()`, so a room cannot write to it and two rooms
 * cannot disagree about it.
 */
export interface DeploymentConfig {
  /** `defineTapeDB({ audit })`: record who wrote each row. */
  readonly audit: boolean;
  /** `schema.files`: how file reads, writes and deletes are decided. */
  readonly files: FileRules;
  readonly realtime: RealtimeConfig;
  /** `defineTapeDB({ webhooks })`, validated once at definition time. */
  readonly webhooks: readonly ConfiguredWebhook[];
  /**
   * `defineTapeDB({ vectorize })`, validated against the schema at definition
   * time; `null` when this deployment indexes nothing, in which case no table
   * is created and no binding is read.
   */
  readonly vectorize: ConfiguredVectorize | null;
  /** Bytes per stored log part (see tx-log.ts). */
  readonly logPartBytes: number;
  /** `schema({ queries })`: the named SQL queries, prepared at definition time (sql-query.ts). */
  readonly queries: Readonly<Record<string, ConfiguredQuery>>;
  /**
   * The network webhooks post to; `null` means `fetch`. A test replaces it for
   * the one deployment it builds instead of globally.
   */
  readonly webhookTransport: WebhookTransport | null;
}

/**
 * The unconfigured deployment: audit off, role-based file access, no
 * realtime authorizer, the default room cap and replay window, no webhooks,
 * nothing indexed, the standard log part size, `fetch` for delivery.
 *
 * Immutable. Standalone engine calls default to it; a room never does, because
 * `defineTapeDB` always passes the deployment's own config.
 */
export function defaultDeploymentConfig(): DeploymentConfig {
  return deploymentConfig({});
}

/** Builds a frozen config, filling whatever the caller does not set. */
export function deploymentConfig(overrides: Partial<DeploymentConfig>): DeploymentConfig {
  return Object.freeze({
    audit: overrides.audit ?? false,
    files: Object.freeze({ ...(overrides.files ?? {}) }),
    realtime: Object.freeze({
      authorizer: overrides.realtime?.authorizer ?? null,
      replayMs: overrides.realtime?.replayMs ?? DEFAULT_TOPIC_REPLAY_MS,
      maxRooms: overrides.realtime?.maxRooms ?? DEFAULT_MAX_PRESENCE_ROOMS,
    }),
    webhooks: Object.freeze([...(overrides.webhooks ?? [])]),
    vectorize: overrides.vectorize ?? null,
    logPartBytes: overrides.logPartBytes ?? LOG_PART_BYTES,
    queries: overrides.queries ?? Object.freeze({}),
    webhookTransport: overrides.webhookTransport ?? null,
  });
}
