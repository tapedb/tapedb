import { DurableObject } from "cloudflare:workers";

import { stableStringify } from "./tx-hash";
import type { RoleClaim } from "../claims";
import { apiError, discardBody, json } from "../http";
import type { Env } from "../types";
import {
  durabilityTick,
  durableObjectRecoverySqlExecutor,
  readFlushState,
  readSnapshotState,
  recoverWorkspace,
  historyPruneAt,
  snapshotDueAt,
} from "./durability";
import {
  isEngineMigration,
  WORKSPACE_MIGRATIONS,
  type BundledWorkspaceMigration,
} from "./migrations-bundle";
import {
  assertMigrationOrder,
  migrationChecksum,
  applyMigrationWithoutCascades,
  MIGRATIONS_TABLE_SQL,
} from "./migrations";
import { forgetFileEntry, recordFileEntry } from "./file-index";
import { compileQuery, type CompiledQuery } from "./query-compile";
import {
  authorizeQuery,
  executeCompiledQuery,
  executeCompiledQueryWithPageInfo,
  executeQueryWithPageInfo,
  viewAccess,
} from "./query-execute";
import {
  isPlainObject,
  type QueryDocument,
  type QueryPageInfo,
  type QueryResult,
} from "./query-types";
import { filesPrefix, isWorkspaceId, manifestKey, workspacePrefix } from "./r2-keys";
import { deleteR2Keys, listAllR2 } from "./r2-list";
import { WORKSPACE_ROLE_LEVELS } from "../claims";
import { ENGINE_TABLES, LINKS, NAMESPACES } from "./registry";
import {
  DEFAULT_INVALIDATION_DEBOUNCE_MS,
  diffQueryResults,
  queryMatchesTouched,
  touchedNamespacesFromEnvelope,
} from "./subscriptions";
import { exportStream } from "./export";
import { importWorkspace, assertEmpty } from "./import-workspace";
import { readMove, writeMove, sourceEnvironment, jurisdiction, copyWorkspace, type MoveState } from "./workspace-move";
import { flushPending, snapshotWorkspace } from "./durability";
import { viewDependsOnSubject } from "./tx-permissions";
import { isTopic, topicAllowed } from "./topics";
import { handleLimitRequest, isLimiterName } from "./claim-limits";
import { acceptPart, forgetOtherSockets, forgetSocket, isSpilled, loadAttachment, storeAttachment } from "./socket-state";
import { authorizeFile, fileRulesConfigured, readableFiles, type FileInfo } from "./file-access";
import { readTrustedRoleClaim } from "./trusted-claim";
import { runTransaction } from "./tx-pipeline";
import { durableObjectSqlExecutor, type SqlValue } from "./tx-sql";
import { TxError, type TxErrorCode } from "./tx-types";
import { acceptVerifiedSocket } from "./ws-handshake";
import { offeredProtocols, SOCKET_PROTOCOL } from "../socket-protocol";
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

/** Recovery work a boot may do; Cloudflare resets a boot past 30 s. */
let RECOVERY_BOOT_BUDGET_MS = 15_000;
/** Recovery work per alarm while a large restore continues. */
let RECOVERY_STEP_BUDGET_MS = 20_000;

/** Test hook: recovery budgets (0 = one chunk or segment per step). */
export function setRecoveryBudgetsForTests(boot: number, step: number): void {
  RECOVERY_BOOT_BUDGET_MS = boot;
  RECOVERY_STEP_BUDGET_MS = step;
}

/**
 * One workspace engine, addressed by `idFromName(workspaceId)`.
 *
 * Owns its SQLite schema, applies bundled Atlas migrations on boot, commits
 * transactions, and flushes/snapshots to R2 on a 30-second alarm.
 */
/** Left in an erased workspace's otherwise empty SQLite: when it was erased, nothing else. */
const ERASED_TABLE = "_tapedb_erased";

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

  private erased = false;
  private importing = false;
  private moving = false;
  private moveState: MoveState | null = null;
  private readonly roomEnv: Env;
  /** Restoring from R2 in budgeted steps; requests wait (503). */
  private recovering = false;
  private limiter = false;
  private misplaced: string | null = null;
  private invalidationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.roomEnv = env.TAPEDB_MOVE_FROM !== undefined &&
      (ctx.id.jurisdiction ?? undefined) === jurisdiction(env.TAPEDB_MOVE_FROM) &&
      jurisdiction(env.TAPEDB_MOVE_FROM) !== jurisdiction(env.TAPEDB_JURISDICTION)
      ? sourceEnvironment(env) : env;
    env = this.roomEnv;
    void ctx.blockConcurrencyWhile(async () => {
      // A room reached outside the configured jurisdiction stores nothing.
      const expected = env.TAPEDB_JURISDICTION;
      if (expected && ctx.id.jurisdiction !== expected) {
        this.misplaced = `This workspace's Durable Object is in jurisdiction ${JSON.stringify(ctx.id.jurisdiction ?? null)}, not ${JSON.stringify(expected)}; it serves nothing.`;
        return;
      }

      // A claim-limiter object (see claim-limits.ts) holds buckets only.
      if (isLimiterName(ctx.id.name)) {
        this.limiter = true;
        return;
      }

      // An erased workspace stays erased: no migrations, no recovery, no alarm.
      if (ctx.storage.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${ERASED_TABLE}'`).toArray().length > 0) {
        this.erased = true;
        return;
      }

      if (isWorkspaceId(ctx.id.name ?? "")) {
        this.moveState = await readMove(env.DATA, ctx.id.name!);
        if (this.moveState?.state === "moved") return;
      }

      // Foreign-key enforcement is per connection and off by default in
      // SQLite. Set it before migrations so every request sees it.
      ctx.storage.sql.exec("PRAGMA foreign_keys = ON");
      await this.applyMigrations();

      // A wiped DO rebuilds from the R2 manifest before serving traffic. A
      // populated DO returns immediately without touching R2.
      // Recovery gets a budget well inside the 30 s Cloudflare allows a
      // boot; a larger restore continues from alarms (see recoverStep).
      await this.recoverStep(RECOVERY_BOOT_BUDGET_MS);

      // Sockets that closed while the object was evicted left their stored
      // state behind; hibernated sockets still open keep theirs.
      const live = (ctx.getWebSockets?.() ?? [])
        .map((socket) => (socket.deserializeAttachment() as { clientId?: unknown } | null)?.clientId)
        .filter((clientId): clientId is string => typeof clientId === "string");
      forgetOtherSockets(durableObjectSqlExecutor(ctx.storage), live);
      if (!this.recovering) await this.scheduleNextDurabilityAlarm(Date.now());
    });
  }

  /**
   * One budgeted step of a restore from R2. Progress is committed as it
   * goes; a step that runs out of budget leaves the workspace recovering,
   * answering 503, and continues on an alarm right away.
   */
  private async recoverStep(budgetMs: number): Promise<void> {
    const recovery = await recoverWorkspace(
      this.roomEnv.DATA,
      durableObjectRecoverySqlExecutor(this.ctx.storage),
      this.workspaceId,
      { deadline: Date.now() + budgetMs }
    );
    // Recovery may toggle foreign keys while restoring; make sure the
    // connection is back in enforcing mode before serving writes.
    this.ctx.storage.sql.exec("PRAGMA foreign_keys = ON");
    if (!recovery.recovered && recovery.reason === "paused") {
      if (!this.recovering) console.log("workspace_recovering", { workspaceId: this.workspaceId });
      this.recovering = true;
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }
    const wasRecovering = this.recovering;
    this.recovering = false;
    if (recovery.recovered) {
      console.log("workspace_recovered", {
        workspaceId: this.workspaceId,
        baseSeq: recovery.baseSeq,
        logSeq: recovery.logSeq,
        rows: recovery.rows,
        replayed: recovery.replayed,
      });
    }
    if (wasRecovering) await this.scheduleNextDurabilityAlarm(Date.now());
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
   * failed boot cannot leave a half-migrated schema, and each runs with
   * foreign keys off and checked before commit (see
   * `applyMigrationWithoutCascades`).
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

      await this.applyMigration(migration, checksum);
    }
  }

  private async applyMigration(
    migration: BundledWorkspaceMigration,
    checksum: string
  ): Promise<void> {
    const storage = this.ctx.storage;
    const sql = storage.sql;
    await applyMigrationWithoutCascades(
      {
        run: (statements) => void sql.exec(statements),
        all: (query) => sql.exec<Record<string, SqlValue>>(query).toArray(),
        transaction: (fn) => storage.transactionSync(fn),
        settle: async () => {
          // Writes made so far in this event sit in an implicit transaction;
          // syncing them closes it, so the pragma that follows takes effect.
          if (typeof storage.sync === "function") await storage.sync();
          else await new Promise((resolve) => setTimeout(resolve, 0));
        },
      },
      migration,
      () => {
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
      }
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (this.misplaced !== null) {
      await discardBody(request);
      return apiError(500, "jurisdiction_mismatch", this.misplaced);
    }
    if (this.moveState?.state === "moved" && !new URL(request.url).pathname.startsWith("/move/")) {
      await discardBody(request);
      return apiError(308, "workspace_moved", `This workspace moved to ${this.moveState.to}.`);
    }
    if (this.erased) {
      await discardBody(request);
      return apiError(410, "workspace_erased", "This workspace was erased.");
    }
    if (this.limiter) return handleLimitRequest(request, durableObjectSqlExecutor(this.ctx.storage));
    if (this.recovering) {
      // Serving a partly restored workspace would show data as missing that
      // is only not restored yet.
      await discardBody(request);
      const response = apiError(503, "workspace_recovering", "The workspace is being restored from storage. Retry shortly.");
      response.headers.set("retry-after", "2");
      return response;
    }
    const response = await this.route(request);
    await discardBody(request);
    return response;
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/move/")) return this.moveControl(request, url.pathname);
    if (this.importing) return apiError(409, "workspace_importing", "The import is still being checked.");
    if (url.pathname === "/import") {
      const claim = readTrustedRoleClaim(request, this.workspaceId);
      if (claim.role < WORKSPACE_ROLE_LEVELS.OWNER) return apiError(403, "insufficient_role", "Only an owner can import a workspace.");
      if (request.method !== "POST") return apiError(405, "method_not_allowed", "Import uses POST.");
      this.importing = true;
      try {
        const rows = await importWorkspace(durableObjectSqlExecutor(this.ctx.storage), request, claim, this.workspaceId);
        await this.scheduleNextDurabilityAlarm(Date.now());
        return json({ ok: true, imported: { rows } });
      } catch (error) { return apiError(error instanceof TxError && error.code === "conflict" ? 409 : 400, "import_failed", errorMessage(error)); }
      finally { this.importing = false; }
    }

    if (this.moveState?.state === "frozen" &&
      !(request.method === "GET" || url.pathname === "/query" || url.pathname === "/files/authorize")) {
      return apiError(409, "workspace_moving", "Writes resume after this workspace finishes moving.");
    }

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

    // DELETE /engine/workspaces/:id: erase everything the workspace holds.
    if (url.pathname === "/" && request.method === "DELETE") {
      return this.erase(request);
    }

    if (url.pathname === "/status" || url.pathname === "/health") {
      if (request.method !== "GET") {
        return apiError(
          405,
          "method_not_allowed",
          `${request.method} is not supported for ${url.pathname}.`
        );
      }
      try {
        readTrustedRoleClaim(request, this.workspaceId);
      } catch (error) {
        if (error instanceof TxError) return apiError(403, error.code, error.message);
        throw error;
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

    // Every row the caller may read, as NDJSON, streamed a chunk at a time.
    if (url.pathname === "/export") {
      if (request.method !== "GET") {
        return apiError(405, "method_not_allowed", `${request.method} is not supported for ${url.pathname}.`);
      }
      let claim: RoleClaim;
      try {
        claim = readTrustedRoleClaim(request, this.workspaceId);
      } catch (error) {
        if (error instanceof TxError) {
          return apiError(statusForQueryError(error.code), error.code, error.message);
        }
        throw error;
      }
      return new Response(
        exportStream(durableObjectSqlExecutor(this.ctx.storage), claim, this.workspaceId),
        { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } }
      );
    }

    // File metadata. Bytes live in R2 and are handled by the Worker; this is
    // the queryable index so a workspace can be asked what it contains.
    if (url.pathname === "/files" || url.pathname === "/files/authorize" || url.pathname === "/files/locate") {
      // Without file rules, the same roles as the byte routes the Worker
      // serves: reading files needs a member, changing them an editor. With
      // rules, the Worker asks /files/authorize before touching bytes, and
      // the list shows only the files the caller may read.
      let claim: RoleClaim;
      try {
        claim = readTrustedRoleClaim(request, this.workspaceId);
      } catch (error) {
        if (error instanceof TxError) return apiError(403, error.code, error.message);
        throw error;
      }
      if (url.pathname === "/files/locate") {
        const body = await request.json() as { path?: string; action?: string };
        const action = body.action === "delete" ? "delete" : "read";
        const sql = durableObjectSqlExecutor(this.ctx.storage);
        const stored = typeof body.path === "string" ? this.storedFile(sql, body.path) : undefined;
        const allowed = stored && (fileRulesConfigured() ? authorizeFile(sql, claim, action, stored) : claim.role >= (action === "read" ? WORKSPACE_ROLE_LEVELS.MEMBER : WORKSPACE_ROLE_LEVELS.EDITOR));
        if (!allowed) return apiError(404, "not_found", "No such file.");
        return json(sql.one<{ key: string }>(`SELECT r2_key AS key FROM "_files" WHERE path = ?`, body.path!) ?? {});
      }
      if (url.pathname === "/files/authorize") {
        return request.method === "POST"
          ? this.authorizeFileRequest(request, claim)
          : apiError(405, "method_not_allowed", `${request.method} is not supported for ${url.pathname}.`);
      }
      if (!fileRulesConfigured()) {
        const needed = request.method === "GET" ? WORKSPACE_ROLE_LEVELS.MEMBER : WORKSPACE_ROLE_LEVELS.EDITOR;
        if (claim.role < needed) return apiError(403, "insufficient_role", "Insufficient role for this file operation.");
      }
      if (request.method === "GET") return this.listFiles(claim);
      if (request.method === "POST") return this.recordFile(request, claim);
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

  private async moveControl(request: Request, path: string): Promise<Response> {
    const claim = readTrustedRoleClaim(request, this.workspaceId);
    if (claim.role < WORKSPACE_ROLE_LEVELS.OWNER) return apiError(403, "insufficient_role", "Only an owner can move a workspace.");
    if (request.method !== "POST") return apiError(405, "method_not_allowed", "Move controls require POST.");
    if (this.importing) return apiError(409, "workspace_importing", "Wait for the import to finish.");
    if (path === "/move/run") {
      if (this.moving) return apiError(409, "workspace_moving", "Another request is already moving this workspace.");
      this.moving = true;
      try {
        const env = this.roomEnv;
        const source = sourceEnvironment(env);
        const to = jurisdiction(env.TAPEDB_JURISDICTION) ?? "none";
        const body = await request.json() as { to?: string };
        if (body.to !== to || (jurisdiction(source.TAPEDB_JURISDICTION) === jurisdiction(env.TAPEDB_JURISDICTION) && !env.WORKSPACE_FROM))
          return apiError(400, "invalid_move", "The destination must match a different configured jurisdiction.");
        const sourceControl = async (action: string) => {
          let ns = source.WORKSPACE;
          if (source.TAPEDB_JURISDICTION) ns = ns.jurisdiction(source.TAPEDB_JURISDICTION as DurableObjectJurisdiction);
          return ns.get(ns.idFromName(this.workspaceId)).fetch(new Request(`https://room.internal/move/${action}`, {
            method: "POST", headers: request.headers, body: JSON.stringify({ to }),
          }));
        };
        let state = await readMove(env.DATA, this.workspaceId);
        if (state && state.to !== to) return apiError(409, "move_conflict", "Another move is in progress.");
        if (!state) assertEmpty(durableObjectSqlExecutor(this.ctx.storage));
        if (state?.state !== "ready") {
          const frozen = await sourceControl("freeze"); if (!frozen.ok) return frozen;
          if (state?.state !== "copied") {
            await writeMove(env.DATA, this.workspaceId, { state: "copying", to });
            const files = await sourceControl("files");
            if (!files.ok || !files.body) return files;
            await copyWorkspace(source, env, this.workspaceId, files.body);
            await writeMove(env.DATA, this.workspaceId, { state: "copied", to });
          }
          await this.recoverStep(RECOVERY_BOOT_BUDGET_MS);
          if (this.recovering) return apiError(503, "workspace_recovering", "Retry to finish the move.");
          await writeMove(env.DATA, this.workspaceId, { state: "ready", to });
        }
        const finished = await sourceControl("finish"); if (!finished.ok) return finished;
        return json({ ok: true, moved: { workspaceId: this.workspaceId, to } });
      } catch (error) { return apiError(error instanceof TxError ? 409 : 503, "move_incomplete", errorMessage(error)); }
      finally { this.moving = false; }
    }

    if (path === "/move/files") {
      const sql = durableObjectSqlExecutor(this.ctx.storage);
      const keys = (function* () {
        let after = "";
        for (;;) {
          const rows = sql.all<{ path: string; key: string }>(`SELECT path, r2_key AS key FROM "_files" WHERE path > ? ORDER BY path LIMIT 100`, after);
          if (!rows.length) break;
          for (const row of rows) { yield JSON.stringify(row.key) + "\n"; after = row.path; }
        }
      })();
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ pull(controller) { const next = keys.next(); if (next.done) controller.close(); else controller.enqueue(encoder.encode(next.value)); } }));
    }
    if (path === "/move/prepare") {
      const sql = durableObjectSqlExecutor(this.ctx.storage);
      try { assertEmpty(sql); return json({ ok: true }); }
      catch { return apiError(409, "workspace_not_empty", "The destination must be empty."); }
    }
    if (path === "/move/restore") {
      await this.recoverStep(RECOVERY_BOOT_BUDGET_MS);
      return this.recovering ? apiError(503, "workspace_recovering", "Retry to continue the restore.") : json({ ok: true });
    }
    if (path === "/move/freeze") {
      const body = await request.json() as { to?: string };
      const to = body.to;
      if (!to || !["none", "eu", "fedramp"].includes(to)) return apiError(400, "invalid_move", "Choose none, eu or fedramp.");
      if (this.moveState && this.moveState.to !== to) return apiError(409, "move_conflict", "This workspace is moving to another destination.");
      if (this.moveState?.state === "moved") return json({ ok: true, moved: true });
      this.moveState = { state: "frozen", to };
      await writeMove(this.roomEnv.DATA, this.workspaceId, this.moveState);
      for (const socket of this.ctx.getWebSockets()) this.closeSocket(socket, 1012, "workspace moving");
      const sql = durableObjectRecoverySqlExecutor(this.ctx.storage);
      for (;;) {
        const result = await flushPending(this.roomEnv.DATA, sql, this.workspaceId, Date.now());
        if (result.error) return apiError(503, "move_flush_failed", result.error);
        if (!result.flushed) break;
      }
      const snapshot = await snapshotWorkspace(this.roomEnv.DATA, sql, this.workspaceId, Date.now());
      return snapshot.snapshotted ? json({ ok: true }) : apiError(503, "move_snapshot_failed", snapshot.error ?? "Snapshot failed.");
    }
    if (path === "/move/finish") {
      const state = this.moveState;
      if (!state) return apiError(409, "move_not_started", "Freeze the source first.");
      this.moveState = { ...state, state: "moved" };
      await writeMove(this.roomEnv.DATA, this.workspaceId, this.moveState);
      const history = await listAllR2(this.roomEnv.DATA, `${workspacePrefix(this.workspaceId)}/`);
      await deleteR2Keys(this.roomEnv.DATA, history.map(object => object.key));
      if (this.roomEnv.FILES) await deleteR2Keys(this.roomEnv.FILES, (await listAllR2(this.roomEnv.FILES, filesPrefix(this.workspaceId))).map(object => object.key));
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return json({ ok: true });
    }
    return apiError(404, "not_found", "Unknown move operation.");
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

    // A client that offered subprotocols fails the handshake unless one is selected.
    const offered = offeredProtocols(request.headers.get("sec-websocket-protocol"));
    return new Response(null, {
      status: 101,
      webSocket: accepted.client,
      ...(offered.includes(SOCKET_PROTOCOL) ? { headers: { "sec-websocket-protocol": SOCKET_PROTOCOL } } : {}),
    });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (this.moveState?.state === "frozen" || this.moveState?.state === "moved") {
      this.closeSocket(ws, 1012, "workspace moving"); return;
    }
    const attachment = this.readSocket(ws);
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
    this.handleText(ws, attachment, text, false);
  }

  /**
   * One whole message. A frame is at most Cloudflare's 32 MiB; a larger
   * message comes as `part` frames, stored until the last (see
   * socket-state.ts), and then runs here like any other.
   */
  private handleText(ws: WebSocket, attachment: SocketAttachment, text: string, reassembled: boolean): void {
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
      case "part": {
        const { id, index, last, data } = payload;
        if (
          reassembled ||
          typeof id !== "string" || id.length === 0 || id.length > 128 ||
          !Number.isInteger(index) || (index as number) < 0 ||
          typeof last !== "boolean" || typeof data !== "string"
        ) {
          this.send(ws, { type: "error", code: "invalid_part", message: "A part is { id, index, last, data }." });
          return;
        }
        const outcome = acceptPart(durableObjectSqlExecutor(this.ctx.storage), attachment.clientId, { id, index: index as number, last, data });
        if ("error" in outcome) {
          this.send(ws, { type: "error", code: outcome.error, message: `Part ${index} of message ${id} arrived out of order; the message was dropped.` });
        } else if ("text" in outcome) {
          this.handleText(ws, attachment, outcome.text, true);
        }
        return;
      }
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
      case "topic:join":
        this.handleTopicJoin(ws, attachment, payload);
        return;
      case "topic:leave":
        this.handleTopicLeave(ws, attachment, payload);
        return;
      case "topic:send":
        this.handleTopicSend(ws, attachment, payload);
        return;
      default:
        this.send(ws, { type: "error", code: "unsupported_message_type" });
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.dropSubscriptionResults(ws);
    this.removePresence(ws);
    this.forgetSocketState(ws);
    // Completes the closing handshake. A client that closes without a status
    // arrives as 1005 (an abnormal drop as 1006); those codes may not be sent,
    // and echoing them threw, so the client never got its close frame and
    // waited out its timeout. Reply 1000 instead.
    this.closeSocket(ws, sendableCloseCode(code), reason);
  }

  webSocketError(ws: WebSocket): void {
    this.dropSubscriptionResults(ws);
    this.removePresence(ws);
    this.forgetSocketState(ws);
    this.closeSocket(ws, 1011, "websocket error");
  }

  /** A socket's attachment, with any state stored past its 16 KiB. */
  private readSocket(ws: WebSocket): SocketAttachment | null {
    const raw = ws.deserializeAttachment();
    if (!isSpilled(raw)) return parseSocketAttachment(raw);
    try {
      return parseSocketAttachment(loadAttachment(durableObjectSqlExecutor(this.ctx.storage), raw));
    } catch {
      return null;
    }
  }

  private writeSocket(ws: WebSocket, attachment: SocketAttachment): void {
    const spilled = isSpilled(ws.deserializeAttachment());
    ws.serializeAttachment(storeAttachment(durableObjectSqlExecutor(this.ctx.storage), attachment, spilled));
  }

  private forgetSocketState(ws: WebSocket): void {
    const raw = ws.deserializeAttachment() as { clientId?: unknown } | null;
    if (typeof raw?.clientId !== "string") return;
    try {
      forgetSocket(durableObjectSqlExecutor(this.ctx.storage), raw.clientId);
    } catch {
      // Best effort; the next boot clears state of sockets that are gone.
    }
  }

  private handlePing(ws: WebSocket, payload: Record<string, unknown>): void {
    const pong: { type: "pong"; at?: unknown; now: number } = {
      type: "pong",
      now: Date.now(),
    };
    if ("at" in payload) pong.at = payload.at;
    this.send(ws, pong);
  }

  // ---- Broadcast topics ------------------------------------------------------

  private topicError(ws: WebSocket, topic: unknown, code: string, message: string): void {
    this.send(ws, { type: "topic:error", topic: isTopic(topic) ? topic : null, code, message });
  }

  private handleTopicJoin(
    ws: WebSocket,
    attachment: SocketAttachment,
    payload: Record<string, unknown>
  ): void {
    const topic = payload.topic;
    if (!isTopic(topic)) {
      this.topicError(ws, topic, "invalid_topic", "A topic is 1 to 128 of A-Z a-z 0-9 : _ . -");
      return;
    }
    if (!topicAllowed(claimFromAttachment(attachment, this.workspaceId), topic, "join")) {
      this.topicError(ws, topic, "permission_denied", `Not allowed to join topic "${topic}".`);
      return;
    }
    const topics = attachment.topics ?? [];
    if (!topics.includes(topic)) {
      attachment.topics = [...topics, topic];
      this.writeSocket(ws, attachment);
    }
  }

  private handleTopicLeave(
    ws: WebSocket,
    attachment: SocketAttachment,
    payload: Record<string, unknown>
  ): void {
    const topic = payload.topic;
    if (!isTopic(topic)) {
      this.topicError(ws, topic, "invalid_topic", "A topic is 1 to 128 of A-Z a-z 0-9 : _ . -");
      return;
    }
    const topics = attachment.topics ?? [];
    if (topics.includes(topic)) {
      attachment.topics = topics.filter((joined) => joined !== topic);
      this.writeSocket(ws, attachment);
    }
  }

  /**
   * Delivers to every other socket joined to the topic. The sender need not
   * be joined; it never receives its own message.
   *
   * A message too large for one frame comes as parts
   * (`{ topic, part: { id, index, last }, data }`, `data` a slice of the
   * message's JSON). Each part is checked and relayed as it arrives, and the
   * receivers join them: the room never holds a whole message, so a
   * broadcast has no size bound here.
   */
  private handleTopicSend(
    ws: WebSocket,
    attachment: SocketAttachment,
    payload: Record<string, unknown>
  ): void {
    const topic = payload.topic;
    const part = payload.part as { id?: unknown; index?: unknown; last?: unknown } | undefined;
    const isPart =
      part !== undefined &&
      typeof part === "object" &&
      part !== null &&
      typeof part.id === "string" && part.id.length > 0 && part.id.length <= 128 &&
      Number.isInteger(part.index) && (part.index as number) >= 0 &&
      typeof part.last === "boolean" &&
      typeof payload.data === "string";
    if (!isTopic(topic) || (part === undefined ? !("message" in payload) : !isPart)) {
      this.topicError(ws, topic, "invalid_topic_message", "topic:send needs a topic and a message (or a part and its data).");
      return;
    }
    if (!topicAllowed(claimFromAttachment(attachment, this.workspaceId), topic, "send")) {
      this.topicError(ws, topic, "permission_denied", `Not allowed to send to topic "${topic}".`);
      return;
    }
    const from = { clientId: attachment.clientId, sub: attachment.sub };
    const delivery = JSON.stringify(
      isPart
        ? { type: "topic:message", topic, part: { id: part!.id, index: part!.index, last: part!.last }, data: payload.data, from }
        : { type: "topic:message", topic, message: payload.message, from }
    );
    const now = Math.floor(Date.now() / 1000);
    for (const other of this.ctx.getWebSockets?.() ?? []) {
      if (other === ws) continue;
      const peer = this.readSocket(other);
      // A socket whose claim has run out hears nothing more.
      if (!peer?.topics?.includes(topic) || peer.exp <= now) continue;
      try {
        other.send(delivery);
      } catch {
        // A closing socket is cleaned up by its close handler.
      }
    }
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
    this.writeSocket(ws, attachment);
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
    this.writeSocket(ws, attachment);
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
    this.writeSocket(ws, attachment);
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
    this.writeSocket(ws, attachment);
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
    this.writeSocket(ws, attachment);
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
      const attachment = this.readSocket(ws);
      if (attachment?.presence?.target === target) {
        sockets.push({ ws, attachment });
      }
    }
    return sockets;
  }

  private removePresence(ws: WebSocket): void {
    const attachment = this.readSocket(ws);
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
      const socketClaim = claimFromAttachment(attachment, this.workspaceId);
      const compiled = compileQuery(query, viewAccess(socketClaim));
      authorizeQuery(socketClaim, compiled);
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
    this.writeSocket(ws, attachment);
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
      this.writeSocket(ws, attachment);
    }
    this.resultsFor(attachment.clientId).delete(id);
    this.send(ws, { type: "query:unsubscribed", id });
  }

  /**
   * Erases the workspace: its R2 history (manifest first, so nothing can
   * recover from what is left), its uploaded files, then its Durable Object
   * storage and alarm. Owners only. Each step is idempotent, so a failed
   * erase is retried by calling it again. A tombstone stays behind so the
   * workspace answers 410 from then on: a reconnecting client's outbox cannot
   * quietly recreate it under the same id.
   */
  private async erase(request: Request): Promise<Response> {
    let claim: RoleClaim;
    try {
      claim = readTrustedRoleClaim(request, this.workspaceId);
    } catch (error) {
      if (error instanceof TxError) return apiError(403, error.code, error.message);
      throw error;
    }
    if (claim.role < WORKSPACE_ROLE_LEVELS.OWNER) {
      return apiError(403, "insufficient_role", "Only an owner can erase a workspace.");
    }

    const workspaceId = this.workspaceId;
    this.erased = true;
    try {
      await this.roomEnv.DATA.delete(manifestKey(workspaceId));
      const history = (await listAllR2(this.roomEnv.DATA, `${workspacePrefix(workspaceId)}/`)).map((object) => object.key);
      await deleteR2Keys(this.roomEnv.DATA, history);
      const files = this.roomEnv.FILES ? (await listAllR2(this.roomEnv.FILES, filesPrefix(workspaceId))).map((object) => object.key) : [];
      if (this.roomEnv.FILES) await deleteR2Keys(this.roomEnv.FILES, files);

      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.ctx.storage.sql.exec(`CREATE TABLE "${ERASED_TABLE}" (at INTEGER NOT NULL)`);
      this.ctx.storage.sql.exec(`INSERT INTO "${ERASED_TABLE}" (at) VALUES (?)`, Date.now());

      for (const ws of this.ctx.getWebSockets()) this.closeSocket(ws, 4410, "workspace erased");
      this.subscriptionResults.clear();
      console.log("workspace_erased", { workspaceId, objects: history.length + 1, files: files.length });
      return json({ ok: true, erased: { historyObjects: history.length + 1, files: files.length } });
    } catch (error) {
      // Not erased yet: let the retry in. Each step above is idempotent.
      this.erased = false;
      console.error("workspace_erase_failed", { workspaceId, error: String(error) });
      return apiError(500, "erase_failed", `Erasing did not finish (${errorMessage(error)}); call it again.`);
    }
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
    const attachment = this.readSocket(ws);
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
    const runs = new Map<string, SubscriptionRun>();

    for (const ws of sockets) {
      const attachment = this.readSocket(ws);
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
        const claim = claimFromAttachment(attachment, this.workspaceId);
        let compiled: CompiledQuery;
        try {
          compiled = compileQuery(subscription.query, viewAccess(claim));
        } catch {
          // A subscription stored by an older deployment may no longer
          // compile; leave it registered so the client can resubscribe.
          continue;
        }
        if (!queryMatchesTouched(compiled, touched)) continue;

        // Read rules see the caller's role and, for row rules, their subject.
        // Subscriptions with the same query and the same role (and subject,
        // when a row rule is involved) get the same answer, so it runs once
        // per flush and is shared.
        const bySubject = queriedNamespaces(compiled).some(viewDependsOnSubject);
        const key = `${bySubject ? attachment.sub : ""}\u0000${attachment.role}\u0000${stableStringify(subscription.query)}`;
        let run = runs.get(key);
        if (run === undefined) {
          run = this.runSubscription(sql, compiled, claim);
          runs.set(key, run);
        }
        if (run.kind === "error") {
          this.send(ws, {
            type: "query:error",
            id: subscription.id,
            code: run.code,
            message: run.message,
          });
          results.delete(subscription.id);
          continue;
        }
        const { data, pageInfo } = run;

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
            ...(diff.order ? { order: diff.order } : {}),
            ...(index === 0 && pageInfoChanged ? { pageInfo } : {}),
          };
          this.send(ws, message);
        }
        attachmentChanged = true;
      }

      if (attachmentChanged) this.writeSocket(ws, attachment);
    }
  }

  /** One subscription's re-run for this flush: its result, or why it failed. */
  private runSubscription(
    sql: ReturnType<typeof durableObjectSqlExecutor>,
    compiled: CompiledQuery,
    claim: RoleClaim
  ): SubscriptionRun {
    try {
      return { kind: "result", ...executeCompiledQueryWithPageInfo(sql, compiled, claim) };
    } catch (error) {
      const txError = error instanceof TxError ? error : null;
      return {
        kind: "error",
        code: txError?.code ?? "internal_error",
        message: txError?.message ?? errorMessage(error),
      };
    }
  }

  /**
   * Runs the durability pass (flush then snapshot) and schedules the next
   * pass only while there is work left. The 30s delay lets transactions
   * accumulate into fewer, larger log segments.
   */
  async alarm(): Promise<void> {
    if (this.limiter) return;
    if (this.erased || this.misplaced !== null) return;
    if (this.recovering) {
      try {
        await this.recoverStep(RECOVERY_STEP_BUDGET_MS);
      } catch (error) {
        console.error("workspace_recovery_failed", { workspaceId: this.workspaceId, error: String(error) });
        await this.ctx.storage.setAlarm(Date.now() + DURABILITY_ALARM_DELAY_MS);
      }
      return;
    }
    const workspaceId = this.workspaceId;

    try {
      const tick = await durabilityTick(
        this.roomEnv.DATA,
        this.ctx.storage.sql,
        workspaceId,
        Date.now()
      );
      // A failed flush is retried with backoff; say so, or nobody knows the
      // log is not reaching R2.
      if (tick.flushError) console.error("workspace_flush_failed", { workspaceId, error: tick.flushError });
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

    const later = (at: number) => {
      nextAt = nextAt === null ? at : Math.min(nextAt, at);
    };
    // Snapshots and age-based pruning keep history inside the retention,
    // so they are scheduled even when nothing else is pending.
    const snapshotAt = snapshotDueAt(sql);
    if (snapshotAt !== null) later(Math.max(snapshotAt, now + DURABILITY_ALARM_DELAY_MS));
    const pruneAt = historyPruneAt(sql);
    if (pruneAt !== null) later(Math.max(pruneAt, now + DURABILITY_ALARM_DELAY_MS));

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
  private listFiles(claim: RoleClaim): Response {
    const sql = durableObjectSqlExecutor(this.ctx.storage);
    const rows = sql.all<Record<string, SqlValue>>(
      `SELECT "id", "path", "r2_key" AS "r2Key", "size",
              "content_type" AS "contentType", "uploaded_by" AS "uploadedBy",
              "created_at" AS "createdAt", "updated_at" AS "updatedAt"
         FROM "${ENGINE_TABLES.files}"
        ORDER BY "path"`
    ) as unknown as Array<FileInfo & Record<string, SqlValue>>;
    return json({ ok: true, data: fileRulesConfigured() ? readableFiles(sql, claim, rows) : rows });
  }

  /** The stored file at `path`, as file rules see it. */
  private storedFile(sql: ReturnType<typeof durableObjectSqlExecutor>, path: string): FileInfo | undefined {
    return sql.one<FileInfo & Record<string, SqlValue>>(
      `SELECT "path", "size", "content_type" AS "contentType", "uploaded_by" AS "uploadedBy"
         FROM "${ENGINE_TABLES.files}" WHERE "path" = ?`,
      path
    );
  }

  /**
   * Decides one file operation for the Worker, before it touches bytes:
   * `{ path, action, size?, contentType? }`. A read of a file the caller may
   * not see answers 404, like a file that does not exist, so a rule does not
   * reveal what it hides.
   */
  private async authorizeFileRequest(request: Request, claim: RoleClaim): Promise<Response> {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const path = body?.path;
    const action = body?.action;
    if (typeof path !== "string" || path.length === 0) return apiError(400, "invalid_path", "path is required.");
    if (action !== "read" && action !== "write" && action !== "delete") {
      return apiError(400, "invalid_action", "action must be read, write or delete.");
    }
    const sql = durableObjectSqlExecutor(this.ctx.storage);
    const stored = this.storedFile(sql, path);
    if (action === "write") {
      const incoming: FileInfo = {
        path,
        size: typeof body?.size === "number" ? body.size : null,
        contentType: typeof body?.contentType === "string" ? body.contentType : null,
        uploadedBy: claim.sub,
      };
      return authorizeFile(sql, claim, "write", incoming, stored)
        ? json({ ok: true })
        : apiError(403, "file_access_denied", "The file rules do not allow this write.");
    }
    if (stored === undefined || !authorizeFile(sql, claim, action, stored)) {
      return stored === undefined || action === "read" || !authorizeFile(sql, claim, "read", stored)
        ? apiError(404, "not_found", "No such file.")
        : apiError(403, "file_access_denied", "The file rules do not allow this delete.");
    }
    return json({ ok: true });
  }

  private async recordFile(request: Request, claim: RoleClaim): Promise<Response> {
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
    const sql = durableObjectSqlExecutor(this.ctx.storage);
    const previousKey = sql.one<{ key: string }>(`SELECT r2_key AS key FROM "_files" WHERE path = ?`, path)?.key;
    recordFileEntry(sql, {
      path,
      key,
      size,
      contentType: typeof contentType === "string" ? contentType : null,
      uploadedBy: claim.sub,
    });
    await this.scheduleFileFlush();

    return json({ ok: true, data: { path, size }, previousKey }, 201);
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

    // How far the log has reached R2: everything at or below `flushedSeq`
    // survives losing this object's storage.
    const flush = readFlushState(sql);
    const seq = sql.exec<{ seq: number | null }>(`SELECT high_water_seq AS seq FROM "_tx_state" WHERE "id" = 1`).toArray()[0]?.seq ?? 0;

    return json({
      ok: true,
      workspaceId: this.workspaceId,
      schemaVersion: migrations.at(-1) ?? null,
      migrations,
      tables,
      counts: { txLog, files },
      durability: {
        seq,
        flushedSeq: flush.lastSeq,
        snapshotSeq: readSnapshotState(sql).baseSeq,
        lastFlushError: flush.lastError,
      },
    });
  }
}

/** Every namespace a compiled query reads: its levels and their relation filters. */
function queriedNamespaces(compiled: CompiledQuery): string[] {
  const namespaces = new Set<string>();
  const visit = (node: CompiledQuery["nodes"][number]): void => {
    namespaces.add(node.namespace);
    for (const reference of node.references) namespaces.add(reference);
    for (const child of node.children) visit(child.node);
  };
  for (const node of compiled.nodes) visit(node);
  return [...namespaces];
}

type SubscriptionRun =
  | { kind: "error"; code: string; message: string }
  | { kind: "result"; data: QueryResult; pageInfo: QueryPageInfo };

/** Close codes the runtime refuses to send (reserved for local use). */
const RESERVED_CLOSE_CODES = new Set([1004, 1005, 1006, 1015]);

function sendableCloseCode(code: number): number {
  return RESERVED_CLOSE_CODES.has(code) || code < 1000 || code > 4999 ? 1000 : code;
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
    case "not_found":
    case "unique_violation":
    case "foreign_key_violation":
      return 409;
    case "retry_expired":
      return 410;
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
