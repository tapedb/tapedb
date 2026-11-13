import { DurableObject } from "cloudflare:workers";

import { stableStringify } from "./tx-hash";
import type { RoleClaim } from "../claims";
import { apiError, discardBody, json } from "../http";
import type { Env } from "../types";
import {
  durabilityTick,
  durableObjectRecoverySqlExecutor,
  readFlushState,
  recoverWorkspace,
  shouldSnapshot,
} from "./durability";
import {
  isEngineMigration,
  WORKSPACE_MIGRATIONS,
  type BundledWorkspaceMigration,
} from "./migrations-bundle";
import {
  assertMigrationOrder,
  migrationChecksum,
  MIGRATIONS_TABLE_SQL,
} from "./migrations";
import { forgetFileEntry, recordFileEntry } from "./file-index";
import { compileQuery, type CompiledQuery } from "./query-compile";
import {
  authorizeQuery,
  executeCompiledQuery,
  executeCompiledQueryWithPageInfo,
  executeQueryWithPageInfo,
} from "./query-execute";
import {
  isPlainObject,
  type QueryDocument,
  type QueryPageInfo,
  type QueryResult,
} from "./query-types";
import { isWorkspaceId } from "./r2-keys";
import { ENGINE_TABLES, LINKS, NAMESPACES } from "./registry";
import {
  DEFAULT_INVALIDATION_DEBOUNCE_MS,
  diffQueryResults,
  queryMatchesTouched,
  touchedNamespacesFromEnvelope,
} from "./subscriptions";
import { readTrustedRoleClaim } from "./trusted-claim";
import { runTransaction } from "./tx-pipeline";
import { durableObjectSqlExecutor, type SqlValue } from "./tx-sql";
import { TxError, type TxErrorCode } from "./tx-types";
import { acceptVerifiedSocket } from "./ws-handshake";
import {
  claimFromAttachment,
  isPresenceTarget,
  parseSocketAttachment,
  type PresencePeer,
  type QueryDiffMessage,
  type SocketAttachment,
  type StoredSubscription,
} from "./ws-types";

type AppliedRow = Record<string, SqlStorageValue> & {
  id: string;
  checksum: string;
};

type IdRow = Record<string, SqlStorageValue> & { id: string };
type NameRow = Record<string, SqlStorageValue> & { name: string };
type CountRow = Record<string, SqlStorageValue> & { total: number };

/** Delay between a write and the first durability pass. */
const DURABILITY_ALARM_DELAY_MS = 30_000;

/**
 * One workspace engine, addressed by `idFromName(workspaceId)`.
 *
 * Owns its SQLite schema, applies bundled Atlas migrations on boot, commits
 * transactions, and flushes/snapshots to R2 on a 30-second alarm.
 */
export class WorkspaceRoom extends DurableObject<Env> {
  /**
   * Last emitted result per socket client id and subscription id. This is a
   * cache, not a source of truth: hibernation clears it and the next pass
   * falls back to a full `query:data` payload.
   */
  private readonly subscriptionResults = new Map<
    string,
    Map<string, CachedResult>
  >();

  /** Namespaces touched since the current debounce window opened. */
  private pendingInvalidationNamespaces = new Set<string>();

  private invalidationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      // Foreign-key enforcement is per connection and off by default in
      // SQLite. Set it before migrations so every request sees it.
      ctx.storage.sql.exec("PRAGMA foreign_keys = ON");
      await this.applyMigrations();

      // A wiped DO rebuilds from the R2 manifest before serving traffic. A
      // populated DO returns immediately without touching R2.
      const recovery = await recoverWorkspace(
        this.env.DATA,
        durableObjectRecoverySqlExecutor(this.ctx.storage),
        this.workspaceId
      );
      if (recovery.recovered) {
        console.log("workspace_recovered", {
          workspaceId: this.workspaceId,
          baseSeq: recovery.baseSeq,
          logSeq: recovery.logSeq,
          rows: recovery.rows,
          replayed: recovery.replayed,
        });
      }

      // Recovery may toggle foreign keys while restoring; make sure the
      // connection is back in enforcing mode before serving writes.
      ctx.storage.sql.exec("PRAGMA foreign_keys = ON");
      await this.scheduleNextDurabilityAlarm(Date.now());
    });
  }

  private get workspaceId(): string {
    const name = this.ctx.id.name;
    if (!name || !isWorkspaceId(name)) {
      throw new Error("Workspace DO must be addressed by a UUID name.");
    }
    return name;
  }

  /**
   * Applies pending migrations before the object serves any request. Each
   * migration and its `_migrations` row commit in the same transaction, so a
   * failed boot cannot leave a half-migrated schema.
   */
  private async applyMigrations(): Promise<void> {
    assertMigrationOrder();

    const sql = this.ctx.storage.sql;
    sql.exec(MIGRATIONS_TABLE_SQL);

    const applied = new Map<string, string>(
      sql
        .exec<AppliedRow>(`SELECT id, checksum FROM "_migrations"`)
        .toArray()
        .map((row) => [row.id, row.checksum])
    );

    for (const migration of WORKSPACE_MIGRATIONS) {
      const checksum = await migrationChecksum(migration.sql);
      const existing = applied.get(migration.id);

      if (existing !== undefined) {
        if (existing !== checksum) {
          throw new Error(
            `Workspace migration ${migration.id} checksum mismatch; refusing to boot on a divergent schema.`
          );
        }
        continue;
      }

      this.applyMigration(migration, checksum);
    }
  }

  private applyMigration(
    migration: BundledWorkspaceMigration,
    checksum: string
  ): void {
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec(migration.sql);
      sql.exec(
        `INSERT INTO "_migrations" (id, checksum, applied_at) VALUES (?, ?, ?)`,
        migration.id,
        checksum,
        Date.now()
      );
      // Log lines record the app schema they were written under, so recovery
      // knows which later changes to read them through.
      if (!isEngineMigration(migration.id)) {
        sql.exec(
          `INSERT OR REPLACE INTO "_engine_meta" ("key", value) VALUES ('schema_version', ?)`,
          migration.id
        );
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const response = await this.route(request);
    await discardBody(request);
    return response;
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/websocket") {
      if (request.method !== "GET") {
        return apiError(
          405,
          "method_not_allowed",
          `${request.method} is not supported for ${url.pathname}.`
        );
      }
      return this.handleWebSocket(request);
    }

    if (url.pathname === "/status" || url.pathname === "/health") {
      if (request.method !== "GET") {
        return apiError(
          405,
          "method_not_allowed",
          `${request.method} is not supported for ${url.pathname}.`
        );
      }
      return this.status();
    }

    if (url.pathname === "/transact") {
      if (request.method !== "POST") {
        return apiError(
          405,
          "method_not_allowed",
          `${request.method} is not supported for ${url.pathname}.`
        );
      }
      return this.transact(request);
    }

    // Introspection for tooling (the studio, your own scripts). Costs one
    // registry read and needs the same claim as any other engine route.
    if (url.pathname === "/schema") {
      if (request.method !== "GET") {
        return apiError(
          405,
          "method_not_allowed",
          `${request.method} is not supported for ${url.pathname}.`
        );
      }
      return this.schemaDocument();
    }

    if (url.pathname === "/query") {
      if (request.method !== "POST") {
        return apiError(
          405,
          "method_not_allowed",
          `${request.method} is not supported for ${url.pathname}.`
        );
      }
      return this.query(request);
    }

    // File metadata. Bytes live in R2 and are handled by the Worker; this is
    // the queryable index so a workspace can be asked what it contains.
    if (url.pathname === "/files") {
      if (request.method === "GET") return this.listFiles();
      if (request.method === "POST") return this.recordFile(request);
      if (request.method === "DELETE") return this.forgetFile(request);
      return apiError(
        405,
        "method_not_allowed",
        `${request.method} is not supported for ${url.pathname}.`
      );
    }

    return apiError(
      404,
      "not_found",
      `No engine route for ${request.method} ${url.pathname}`
    );
  }

  private async transact(request: Request): Promise<Response> {
    let envelope: unknown;
    try {
      envelope = await request.json();
    } catch {
      return json(
        {
          ok: false,
          error: {
            code: "invalid_envelope",
            message: "Request body must be valid JSON.",
          },
        },
        400
      );
    }

    try {
      const workspaceId = this.workspaceId;
      const claim = readTrustedRoleClaim(request, workspaceId);
      const result = runTransaction(
        durableObjectSqlExecutor(this.ctx.storage),
        workspaceId,
        claim,
        envelope
      );
      try {
        await this.scheduleNextDurabilityAlarm(Date.now());
      } catch (error) {
        // The transaction is already durable; do not turn a scheduling failure
        // into a failed acknowledgement. The next write or boot retries it.
        console.error("workspace_durability_schedule_failed", {
          workspaceId,
          error: String(error),
        });
      }

      // Replays and no-op deletes changed no rows; do not re-run queries.
      const touched = touchedNamespacesFromEnvelope(envelope);
      if (result.applied > 0 && touched.size > 0) {
        this.scheduleInvalidation(touched);
      }

      return json({ ok: true, result });
    } catch (error) {
      if (error instanceof TxError) {
        return json(
          { ok: false, error: error.toJSON() },
          statusForTxError(error.code)
        );
      }
      throw error;
    }
  }

  /**
   * Runs a query document against this workspace. The claim is read from the
   * Worker-forwarded header; `executeQuery` requires `view` on every requested
   * and traversed namespace before touching SQL.
   */
  private async query(request: Request): Promise<Response> {
    let envelope: unknown;
    try {
      envelope = await request.json();
    } catch {
      return json(
        {
          ok: false,
          error: {
            code: "invalid_envelope",
            message: "Request body must be valid JSON.",
          },
        },
        400
      );
    }

    try {
      const workspaceId = this.workspaceId;
      const claim = readTrustedRoleClaim(request, workspaceId);
      const { data, pageInfo } = executeQueryWithPageInfo(
        durableObjectSqlExecutor(this.ctx.storage),
        claim,
        envelope
      );
      return json({ ok: true, data, pageInfo });
    } catch (error) {
      if (error instanceof TxError) {
        return json(
          { ok: false, error: error.toJSON() },
          statusForQueryError(error.code)
        );
      }
      throw error;
    }
  }

  // ---- WebSocket live queries ---------------------------------------------

  private handleWebSocket(request: Request): Response {
    const accepted = acceptVerifiedSocket<SocketAttachment>({
      ctx: this.ctx,
      request,
      workspaceId: this.workspaceId,
      buildAttachment: (claim, clientId) => ({
        clientId,
        sub: claim.sub,
        role: claim.role,
        exp: claim.exp,
        subscriptions: [],
      }),
    });
    if (!accepted.accepted) return accepted.response;

    const connections = Math.max(1, this.ctx.getWebSockets().length);
    this.send(accepted.server, {
      type: "session:ready",
      workspaceId: this.workspaceId,
      connections,
    });

    return new Response(null, { status: 101, webSocket: accepted.client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    const attachment = parseSocketAttachment(ws.deserializeAttachment());
    if (attachment === null) {
      this.send(ws, {
        type: "session:error",
        code: "unauthenticated",
        message: "This socket has no verified role claim.",
      });
      this.closeSocket(ws, 1008, "unauthenticated");
      return;
    }

    if (attachment.exp <= Math.floor(Date.now() / 1000)) {
      this.send(ws, {
        type: "session:error",
        code: "claim_expired",
        message: "The role claim for this socket has expired.",
      });
      this.closeSocket(ws, 1008, "claim expired");
      return;
    }

    const text =
      typeof message === "string" ? message : new TextDecoder().decode(message);

    if (text.length > 65_536) {
      this.send(ws, { type: "error", code: "message_too_large" });
      return;
    }

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isPlainObject(parsed)) {
        this.send(ws, {
          type: "error",
          code: "invalid_message",
          message: "Message must be a JSON object.",
        });
        return;
      }
      payload = parsed;
    } catch {
      this.send(ws, {
        type: "error",
        code: "invalid_json",
        message: "Message is not valid JSON.",
      });
      return;
    }

    switch (payload.type) {
      case "ping":
        this.handlePing(ws, payload);
        return;
      case "query:subscribe":
        this.handleSubscribe(ws, attachment, payload);
        return;
      case "query:unsubscribe":
        this.handleUnsubscribe(ws, attachment, payload);
        return;
      case "presence:set":
        this.handlePresenceSet(ws, attachment, payload);
        return;
      case "presence:clear":
        this.handlePresenceClear(ws, attachment, payload);
        return;
      case "cursor:set":
        this.handleCursorSet(ws, attachment, payload);
        return;
      case "drag:set":
        this.handleDragSet(ws, attachment, payload);
        return;
      case "drag:clear":
        this.handleDragClear(ws, attachment, payload);
        return;
      default:
        this.send(ws, { type: "error", code: "unsupported_message_type" });
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.dropSubscriptionResults(ws);
    this.removePresence(ws);
    this.closeSocket(ws, code, reason);
  }

  webSocketError(ws: WebSocket): void {
    this.dropSubscriptionResults(ws);
    this.removePresence(ws);
    this.closeSocket(ws, 1011, "websocket error");
  }

  private handlePing(ws: WebSocket, payload: Record<string, unknown>): void {
    const pong: { type: "pong"; at?: unknown; now: number } = {
      type: "pong",
      now: Date.now(),
    };
    if ("at" in payload) pong.at = payload.at;
    this.send(ws, pong);
  }

  private handlePresenceSet(
    ws: WebSocket,
    attachment: SocketAttachment,
    payload: Record<string, unknown>
  ): void {
    const target = payload.target;
    if (!isPresenceTarget(target)) {
      this.send(ws, { type: "error", code: "invalid_target" });
      return;
    }
    if (!("presence" in payload)) {
      this.send(ws, { type: "error", code: "invalid_presence" });
      return;
    }

    const previous = attachment.presence;
    if (previous && previous.target !== target) {
      this.broadcastPresence(previous.target, attachment.clientId);
    }
    attachment.presence =
      previous && previous.target === target
        ? { ...previous, presence: payload.presence }
        : { target, presence: payload.presence };
    ws.serializeAttachment(attachment);
    this.broadcastPresence(target);
  }

  private handlePresenceClear(
    ws: WebSocket,
    attachment: SocketAttachment,
    payload: Record<string, unknown>
  ): void {
    const target = payload.target;
    if (!isPresenceTarget(target)) {
      this.send(ws, { type: "error", code: "invalid_target" });
      return;
    }
    const current = attachment.presence;
    if (!current || current.target !== target) return;
    attachment.presence = undefined;
    ws.serializeAttachment(attachment);
    this.broadcastPresence(target, attachment.clientId);
  }

  private handleCursorSet(
    ws: WebSocket,
    attachment: SocketAttachment,
    payload: Record<string, unknown>
  ): void {
    const target = payload.target;
    if (!isPresenceTarget(target) || !("cursor" in payload)) {
      this.send(ws, { type: "error", code: "invalid_cursor" });
      return;
    }
    const current = attachment.presence;
    if (!current || current.target !== target) {
      this.send(ws, { type: "error", code: "not_in_target" });
      return;
    }
    current.cursor = payload.cursor;
    ws.serializeAttachment(attachment);
    this.broadcastToTarget(
      target,
      {
        type: "cursor:update",
        target,
        clientId: attachment.clientId,
        cursor: payload.cursor,
      },
      attachment.clientId
    );
  }

  private handleDragSet(
    ws: WebSocket,
    attachment: SocketAttachment,
    payload: Record<string, unknown>
  ): void {
    const target = payload.target;
    if (!isPresenceTarget(target) || !("drag" in payload)) {
      this.send(ws, { type: "error", code: "invalid_drag" });
      return;
    }
    const current = attachment.presence;
    if (!current || current.target !== target) {
      this.send(ws, { type: "error", code: "not_in_target" });
      return;
    }
    current.drag = payload.drag;
    ws.serializeAttachment(attachment);
    this.broadcastToTarget(
      target,
      {
        type: "drag:update",
        target,
        clientId: attachment.clientId,
        drag: payload.drag,
      },
      attachment.clientId
    );
  }

  private handleDragClear(
    ws: WebSocket,
    attachment: SocketAttachment,
    payload: Record<string, unknown>
  ): void {
    const target = payload.target;
    if (!isPresenceTarget(target)) {
      this.send(ws, { type: "error", code: "invalid_target" });
      return;
    }
    const current = attachment.presence;
    if (!current || current.target !== target) return;
    delete current.drag;
    ws.serializeAttachment(attachment);
    this.broadcastToTarget(
      target,
      {
        type: "drag:update",
        target,
        clientId: attachment.clientId,
        drag: null,
      },
      attachment.clientId
    );
  }

  private broadcastPresence(target: string, excludeClientId?: string): void {
    const peers = this.presencePeers(target, excludeClientId);
    for (const { ws, attachment } of this.socketsForTarget(target)) {
      if (excludeClientId && attachment.clientId === excludeClientId) continue;
      this.send(ws, { type: "presence:update", target, peers });
    }
  }

  private broadcastToTarget(
    target: string,
    message: unknown,
    excludeClientId?: string
  ): void {
    for (const { ws, attachment } of this.socketsForTarget(target)) {
      if (excludeClientId && attachment.clientId === excludeClientId) continue;
      this.send(ws, message);
    }
  }

  private presencePeers(
    target: string,
    excludeClientId?: string
  ): PresencePeer[] {
    const peers: PresencePeer[] = [];
    for (const { attachment } of this.socketsForTarget(target)) {
      if (excludeClientId && attachment.clientId === excludeClientId) continue;
      const presence = attachment.presence;
      if (!presence) continue;
      const peer: PresencePeer = {
        clientId: attachment.clientId,
        presence: presence.presence ?? null,
      };
      if (presence.cursor !== undefined) peer.cursor = presence.cursor;
      if (presence.drag !== undefined) peer.drag = presence.drag;
      peers.push(peer);
    }
    return peers.sort((left, right) =>
      left.clientId.localeCompare(right.clientId)
    );
  }

  private socketsForTarget(
    target: string
  ): Array<{ ws: WebSocket; attachment: SocketAttachment }> {
    const sockets: Array<{ ws: WebSocket; attachment: SocketAttachment }> = [];
    for (const ws of this.ctx.getWebSockets?.() ?? []) {
      const attachment = parseSocketAttachment(ws.deserializeAttachment());
      if (attachment?.presence?.target === target) {
        sockets.push({ ws, attachment });
      }
    }
    return sockets;
  }

  private removePresence(ws: WebSocket): void {
    const attachment = parseSocketAttachment(ws.deserializeAttachment());
    if (!attachment?.presence) return;
    this.broadcastPresence(attachment.presence.target, attachment.clientId);
  }

  private handleSubscribe(
    ws: WebSocket,
    attachment: SocketAttachment,
    payload: Record<string, unknown>
  ): void {
    const id = payload.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 128) {
      this.send(ws, {
        type: "query:error",
        id: typeof id === "string" ? id : null,
        code: "invalid_subscription_id",
        message:
          "Subscription id must be a non-empty string up to 128 characters.",
      });
      return;
    }

    const query = payload.query;
    if (!isPlainObject(query)) {
      this.send(ws, {
        type: "query:error",
        id,
        code: "invalid_query",
        message: "query must be a plain object keyed by namespace.",
      });
      return;
    }

    let data: QueryResult;
    let pageInfo: QueryPageInfo;
    try {
      const compiled = compileQuery(query);
      authorizeQuery(
        claimFromAttachment(attachment, this.workspaceId),
        compiled
      );
      ({ data, pageInfo } = executeCompiledQueryWithPageInfo(
        durableObjectSqlExecutor(this.ctx.storage),
        compiled,
        claimFromAttachment(attachment, this.workspaceId)
      ));
    } catch (error) {
      const txError = error instanceof TxError ? error : null;
      this.send(ws, {
        type: "query:error",
        id,
        code: txError?.code ?? "internal_error",
        message: txError?.message ?? errorMessage(error),
      });
      return;
    }

    const subscription = upsertSubscription(
      attachment,
      id,
      query as QueryDocument
    );
    ws.serializeAttachment(attachment);
    this.resultsFor(attachment.clientId).set(id, { data, pageInfo });
    this.send(ws, {
      type: "query:data",
      id,
      seq: subscription.seq,
      data,
      pageInfo,
    });
  }

  private handleUnsubscribe(
    ws: WebSocket,
    attachment: SocketAttachment,
    payload: Record<string, unknown>
  ): void {
    const id = payload.id;
    if (typeof id !== "string" || id.length === 0) {
      this.send(ws, {
        type: "query:error",
        id: typeof id === "string" ? id : null,
        code: "invalid_subscription_id",
        message: "Subscription id must be a non-empty string.",
      });
      return;
    }

    const remaining = attachment.subscriptions.filter(
      (subscription) => subscription.id !== id
    );
    if (remaining.length !== attachment.subscriptions.length) {
      attachment.subscriptions = remaining;
      ws.serializeAttachment(attachment);
    }
    this.resultsFor(attachment.clientId).delete(id);
    this.send(ws, { type: "query:unsubscribed", id });
  }

  private send(ws: WebSocket, message: unknown): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // A socket that is already closing is cleaned up by its close handler.
    }
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private resultsFor(clientId: string): Map<string, CachedResult> {
    let results = this.subscriptionResults.get(clientId);
    if (!results) {
      results = new Map<string, CachedResult>();
      this.subscriptionResults.set(clientId, results);
    }
    return results;
  }

  private dropSubscriptionResults(ws: WebSocket): void {
    const attachment = parseSocketAttachment(ws.deserializeAttachment());
    if (attachment) this.subscriptionResults.delete(attachment.clientId);
  }

  // ---- Invalidation --------------------------------------------------------

  private scheduleInvalidation(namespaces: Iterable<string>): void {
    for (const namespace of namespaces) {
      this.pendingInvalidationNamespaces.add(namespace);
    }
    if (this.pendingInvalidationNamespaces.size === 0) return;
    if (this.invalidationTimer !== null) return;

    this.invalidationTimer = setTimeout(() => {
      this.invalidationTimer = null;
      const touched = this.pendingInvalidationNamespaces;
      this.pendingInvalidationNamespaces = new Set();
      this.flushInvalidations(touched);
    }, DEFAULT_INVALIDATION_DEBOUNCE_MS);
  }

  private flushInvalidations(touched: ReadonlySet<string>): void {
    // `getWebSockets` is part of the Durable Object runtime. Guard the call so
    // non-WebSocket harnesses (and older test doubles) do not crash a deferred
    // invalidation pass.
    const sockets = this.ctx.getWebSockets?.() ?? [];
    if (sockets.length === 0) return;

    const sql = durableObjectSqlExecutor(this.ctx.storage);
    const now = Math.floor(Date.now() / 1000);

    for (const ws of sockets) {
      const attachment = parseSocketAttachment(ws.deserializeAttachment());
      if (attachment === null) continue;

      if (attachment.exp <= now) {
        this.send(ws, {
          type: "session:error",
          code: "claim_expired",
          message: "The role claim for this socket has expired.",
        });
        this.removePresence(ws);
        this.closeSocket(ws, 1008, "claim expired");
        this.subscriptionResults.delete(attachment.clientId);
        continue;
      }

      const results = this.resultsFor(attachment.clientId);
      let attachmentChanged = false;

      for (const subscription of attachment.subscriptions) {
        let compiled: CompiledQuery;
        try {
          compiled = compileQuery(subscription.query);
        } catch {
          // A subscription stored by an older deployment may no longer
          // compile; leave it registered so the client can resubscribe.
          continue;
        }

        if (!queryMatchesTouched(compiled, touched)) continue;

        let data: QueryResult;
        let pageInfo: QueryPageInfo;
        try {
          ({ data, pageInfo } = executeCompiledQueryWithPageInfo(
            sql,
            compiled,
            claimFromAttachment(attachment, this.workspaceId)
          ));
        } catch (error) {
          const txError = error instanceof TxError ? error : null;
          this.send(ws, {
            type: "query:error",
            id: subscription.id,
            code: txError?.code ?? "internal_error",
            message: txError?.message ?? errorMessage(error),
          });
          results.delete(subscription.id);
          continue;
        }

        const previous = results.get(subscription.id);
        results.set(subscription.id, { data, pageInfo });

        if (previous === undefined) {
          subscription.seq += 1;
          this.send(ws, {
            type: "query:data",
            id: subscription.id,
            seq: subscription.seq,
            data,
            pageInfo,
          });
          attachmentChanged = true;
          continue;
        }

        const diffs = diffQueryResults(previous.data, data);
        if (diffs === null) {
          subscription.seq += 1;
          this.send(ws, {
            type: "query:data",
            id: subscription.id,
            seq: subscription.seq,
            data,
            pageInfo,
          });
          attachmentChanged = true;
          continue;
        }

        // Page metadata moves without row changes too: a row inserted past
        // the window flips hasMore and moves nextCursor. It rides the first
        // diff, or an empty one when no row in the window changed.
        const pageInfoChanged =
          stableStringify(previous.pageInfo) !== stableStringify(pageInfo);
        if (diffs.length === 0 && !pageInfoChanged) continue;
        if (diffs.length === 0) {
          diffs.push({
            namespace: Object.keys(data)[0] ?? "",
            added: [],
            updated: [],
            removed: [],
          });
        }

        subscription.seq += 1;
        for (const [index, diff] of diffs.entries()) {
          const message: QueryDiffMessage = {
            type: "query:diff",
            id: subscription.id,
            seq: subscription.seq,
            namespace: diff.namespace,
            added: diff.added,
            updated: diff.updated,
            removed: diff.removed,
            ...(index === 0 && pageInfoChanged ? { pageInfo } : {}),
          };
          this.send(ws, message);
        }
        attachmentChanged = true;
      }

      if (attachmentChanged) ws.serializeAttachment(attachment);
    }
  }

  /**
   * Runs the durability pass (flush then snapshot) and schedules the next
   * pass only while there is work left. The 30s delay lets transactions
   * accumulate into fewer, larger log segments.
   */
  async alarm(): Promise<void> {
    const workspaceId = this.workspaceId;

    try {
      await durabilityTick(
        this.env.DATA,
        this.ctx.storage.sql,
        workspaceId,
        Date.now()
      );
    } catch (error) {
      console.error("workspace_durability_tick_failed", {
        workspaceId,
        error: String(error),
      });
      await this.scheduleDurabilityAlarm(
        Date.now() + DURABILITY_ALARM_DELAY_MS
      );
      return;
    }

    // Re-read the clock: a chunked snapshot can take long enough that the
    // timestamp captured before the tick is already in the past.
    await this.scheduleNextDurabilityAlarm(Date.now());
  }

  /**
   * Schedules an alarm for the next due durability pass. An existing alarm is
   * never pushed later: a write must not delay a flush that is already due.
   */
  private async scheduleNextDurabilityAlarm(now: number): Promise<void> {
    const sql = this.ctx.storage.sql;
    const flushState = readFlushState(sql);

    let nextAt: number | null = null;
    if (flushState.hasPending) {
      nextAt = Math.max(
        now + DURABILITY_ALARM_DELAY_MS,
        flushState.nextAttemptAt ?? 0
      );
    }

    if (shouldSnapshot(sql, now)) {
      const snapshotAt = now + DURABILITY_ALARM_DELAY_MS;
      nextAt = nextAt === null ? snapshotAt : Math.min(nextAt, snapshotAt);
    }

    if (nextAt !== null) {
      await this.scheduleDurabilityAlarm(nextAt);
    }
  }

  private async scheduleDurabilityAlarm(at: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || at < existing) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  /**
   * File metadata rows. Bytes live in R2 and never enter the transaction log;
   * this table is the queryable index over them.
   */
  private listFiles(): Response {
    const sql = durableObjectSqlExecutor(this.ctx.storage);
    const rows = sql.all<Record<string, SqlValue>>(
      `SELECT "id", "path", "r2_key" AS "r2Key", "size",
              "content_type" AS "contentType",
              "created_at" AS "createdAt", "updated_at" AS "updatedAt"
         FROM "${ENGINE_TABLES.files}"
        ORDER BY "path"`
    );
    return json({ ok: true, data: rows });
  }

  private async recordFile(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "invalid_body", "Request body must be a JSON object.");
    }

    const record = (body ?? {}) as Record<string, unknown>;
    const path = record.path;
    const key = record.key;
    const size = record.size;
    const contentType = record.contentType;

    if (typeof path !== "string" || path.length === 0) {
      return apiError(400, "invalid_path", "path is required.");
    }
    if (typeof key !== "string" || key.length === 0) {
      return apiError(400, "invalid_key", "key is required.");
    }
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
      return apiError(400, "invalid_size", "size must be a non-negative number.");
    }

    // Logged, not written in place: a row outside the log is lost by a restore
    // from R2 (see file-index.ts).
    recordFileEntry(durableObjectSqlExecutor(this.ctx.storage), {
      path,
      key,
      size,
      contentType: typeof contentType === "string" ? contentType : null,
    });
    await this.scheduleFileFlush();

    return json({ ok: true, data: { path, size } }, 201);
  }

  private async forgetFile(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "invalid_body", "Request body must be a JSON object.");
    }

    const path = ((body ?? {}) as Record<string, unknown>).path;
    if (typeof path !== "string" || path.length === 0) {
      return apiError(400, "invalid_path", "path is required.");
    }

    const removed = forgetFileEntry(
      durableObjectSqlExecutor(this.ctx.storage),
      path
    );
    if (removed > 0) await this.scheduleFileFlush();
    return json({ ok: true, removed });
  }

  /** File-index entries are log rows, so they ship to R2 like any write. */
  private async scheduleFileFlush(): Promise<void> {
    try {
      await this.scheduleNextDurabilityAlarm(Date.now());
    } catch (error) {
      // The entry is committed locally; the next write or boot reschedules.
      console.error("workspace_durability_schedule_failed", {
        workspaceId: this.workspaceId,
        error: errorMessage(error),
      });
    }
  }

  /** Registry snapshot for tooling: API names, attribute types and links. */
  private schemaDocument(): Response {
    const namespaces = Object.values(NAMESPACES).map((namespace) => ({
      apiName: namespace.apiName,
      table: namespace.table,
      attributes: Object.fromEntries(
        Object.entries(namespace.attributes).map(([name, definition]) => [
          name,
          {
            type: definition.type,
            optional: definition.optional === true,
            indexed: definition.indexed === true,
            unique: definition.unique === true,
          },
        ])
      ),
    }));

    return json({
      ok: true,
      data: {
        namespaces,
        links: Object.values(LINKS).map((link) => ({
          apiName: link.apiName,
          kind: link.kind,
          forward: link.forward,
          reverse: link.reverse,
        })),
      },
    });
  }

  private status(): Response {
    const sql = this.ctx.storage.sql;
    const migrations = sql
      .exec<IdRow>(`SELECT id FROM "_migrations" ORDER BY id`)
      .toArray()
      .map((row) => row.id);
    const tables = sql
      .exec<NameRow>(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`
      )
      .toArray()
      .map((row) => row.name);
    const txLog = sql
      .exec<CountRow>(`SELECT COUNT(*) AS total FROM "_tx_log"`)
      .one().total;
    const files = sql
      .exec<CountRow>(`SELECT COUNT(*) AS total FROM "${ENGINE_TABLES.files}"`)
      .one().total;

    return json({
      ok: true,
      workspaceId: this.workspaceId,
      schemaVersion: migrations.at(-1) ?? null,
      migrations,
      tables,
      counts: { txLog, files },
    });
  }
}

/**
 * Registers or replaces a subscription. A resubscribe keeps the per-socket
 * sequence climbing, so a client that reconnects cannot mistake a new result
 * for a replay.
 */
function upsertSubscription(
  attachment: SocketAttachment,
  id: string,
  query: QueryDocument
): StoredSubscription {
  const existing = attachment.subscriptions.find(
    (subscription) => subscription.id === id
  );
  if (existing) {
    existing.query = query;
    existing.seq += 1;
    return existing;
  }

  const created: StoredSubscription = { id, seq: 1, query };
  attachment.subscriptions.push(created);
  return created;
}

/** A subscription's last result, kept to diff the next one against. */
interface CachedResult {
  data: QueryResult;
  pageInfo: QueryPageInfo;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusForTxError(code: TxErrorCode): number {
  switch (code) {
    case "permission_denied":
      return 403;
    case "conflict":
    case "duplicate_tx":
    case "dedupe_expired":
    case "not_found":
    case "unique_violation":
    case "foreign_key_violation":
      return 409;
    case "storage_error":
      return 500;
    default:
      return 400;
  }
}

/** Read errors: permission 403, storage 500, every invalid query 400. */
function statusForQueryError(code: TxErrorCode): number {
  switch (code) {
    case "permission_denied":
      return 403;
    case "storage_error":
      return 500;
    default:
      return 400;
  }
}
