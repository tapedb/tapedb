/**
 * Outbound webhooks: capture, outbox, delivery.
 *
 * A webhook is declared once, with the Worker:
 *
 *   defineTapeDB({ schema, webhooks: [{ url, events: ["create"], models: ["tasks"], secret }] })
 *
 * **Capture happens inside the write transaction.** `installWebhookCapture`
 * creates one trigger per watched table and action, shaped like the audit and
 * personal-capture triggers: a row change records `(seq, table, row id,
 * action)` against the transaction's own `_tx_log` line. So the event carries
 * the sequence the write was given, cascade deletes are included, and a rolled
 * back transaction leaves nothing behind. Nothing about a webhook — its URL,
 * its consumer — can fail or slow the commit: a trigger only appends a row.
 *
 * **Delivery happens after the commit, from the durability alarm.** The
 * captured rows are turned into outbox rows (`drainWebhookChanges`) once the
 * write has answered, and the alarm POSTs them after the log has reached R2.
 * A consumer that is slow, down or answering 500 costs retries, never a failed
 * write.
 *
 * Guarantees:
 *
 * - at-least-once: an outbox row is kept until a 2xx, so a delivery whose
 *   answer was lost is sent again; `eventId` is generated once, at emit, and is
 *   stable across every attempt of that event;
 * - ordering per endpoint by `seq`: events are sent in sequence order and a
 *   failed delivery blocks that endpoint's later events (never a healthy
 *   endpoint's);
 * - retries persist in `_webhook_outbox`, in the workspace's own SQLite, so
 *   hibernation or eviction resumes where it stopped;
 * - exponential backoff, capped at `WEBHOOK_MAX_RETRY_MS` (30 minutes) and
 *   `WEBHOOK_MAX_AGE_MS` (24 hours), then the row is dead-lettered: kept, no
 *   longer attempted, and counted by `GET /status`;
 * - personal fields never leave the workspace: a payload carries the row's
 *   non-personal attributes, the same registry rule the log reader uses to
 *   decide what it may show.
 */

import { NAMESPACES, toSnakeCase, type NamespaceDefinition } from "./registry";
import type { SqlExecutor, SqlRow, SqlValue } from "./tx-sql";
import { fromStoredValue } from "./value-to-api";
import { WEBHOOK_SIGNATURE_HEADER, webhookSignature } from "./webhook-sign";

/** The write operations a webhook can subscribe to. */
export type WebhookEvent = "create" | "update" | "delete";

/** Every event, in the order a write produces them. */
export const WEBHOOK_EVENTS: readonly WebhookEvent[] = ["create", "update", "delete"];

/** One endpoint `defineTapeDB({ webhooks })` delivers to. */
export interface WebhookOptions {
  /** Where the POST goes: an http or https URL. */
  url: string;
  /** Which operations are delivered: any of create, update, delete. */
  events: readonly WebhookEvent[];
  /** Only these models, by API name; every model when omitted. */
  models?: readonly string[];
  /**
   * HMAC-SHA256 key for `X-Tapedb-Signature`. Store it in the Worker's
   * secrets, not in the repository.
   */
  secret: string;
}

/** The JSON body of one delivery. */
export interface WebhookEventPayload {
  /** Stable across retries: every attempt of one event carries the same id. */
  eventId: string;
  /** The transaction's `_tx_log` sequence. */
  seq: number;
  workspaceId: string;
  /** The model's API name, e.g. `tasks`. */
  model: string;
  op: WebhookEvent;
  /** When the write committed, epoch milliseconds. */
  at: number;
  /**
   * The row after the write, with personal fields left out; for a delete, the
   * values it had (its id always). `null` when the row could not be read.
   */
  row: Record<string, unknown> | null;
}

/** Change rows captured inside a transaction, before they become events. */
export const WEBHOOK_CHANGES_TABLE = "_webhook_changes";
/** Events waiting for a 2xx, and the record of those given up on. */
export const WEBHOOK_OUTBOX_TABLE = "_webhook_outbox";

/** First retry delay; doubles per attempt. */
export const WEBHOOK_FIRST_RETRY_MS = 30_000;
/** Longest wait between attempts. */
export const WEBHOOK_MAX_RETRY_MS = 30 * 60_000;
/** After this, an event that never got a 2xx is dead-lettered. */
export const WEBHOOK_MAX_AGE_MS = 24 * 60 * 60_000;
/** A write wakes the alarm this soon, so delivery follows the commit closely. */
export const WEBHOOK_DELIVERY_DELAY_MS = 1_000;
/** Attempts one alarm makes before it reschedules, keeping a pass short. */
export const WEBHOOK_PASS_ATTEMPTS = 25;
/** A consumer that has not answered by now is treated as a retryable failure. */
export const WEBHOOK_SEND_TIMEOUT_MS = 10_000;
/** After this many attempts an event is dead-lettered whatever its age. */
const WEBHOOK_MAX_ATTEMPTS = 60;
/** Captured changes turned into events per pass; the rest wait for the next. */
const CHANGES_PER_DRAIN = 500;

/** One endpoint the deployment delivers to, validated when it was defined. */
export interface ConfiguredWebhook {
  index: number;
  url: string;
  events: Set<WebhookEvent>;
  models: Set<string> | null;
  secret: string;
}

const ACTION_FOR: Record<WebhookEvent, "INSERT" | "UPDATE" | "DELETE"> = {
  create: "INSERT",
  update: "UPDATE",
  delete: "DELETE",
};

function invalid(message: string): never {
  throw new Error(message);
}

/**
 * Validates `defineTapeDB({ webhooks })` and returns this deployment's
 * endpoints. Validated once, when the Worker is defined, so a typo fails at
 * deploy time rather than at the first write.
 *
 * The result travels in the deployment's `DeploymentConfig`; a second
 * deployment in the same process has its own list, and nothing can append to
 * this one.
 */
export function resolveWebhooks(
  options: readonly WebhookOptions[] | undefined
): readonly ConfiguredWebhook[] {
  const hooks = (options ?? []).map((option, index) => {
    const where = `webhooks[${index}]`;
    if (typeof option?.url !== "string" || !/^https?:\/\/[^\s]+$/i.test(option.url)) {
      invalid(`${where}.url must be an http or https URL.`);
    }
    if (typeof option.secret !== "string" || option.secret.length === 0) {
      invalid(`${where}.secret must be a non-empty string.`);
    }
    if (!Array.isArray(option.events) || option.events.length === 0) {
      invalid(`${where}.events must list at least one of create, update, delete.`);
    }
    const events = new Set<WebhookEvent>();
    for (const event of option.events) {
      if (!WEBHOOK_EVENTS.includes(event)) {
        invalid(`${where}.events has ${JSON.stringify(event)}; use create, update or delete.`);
      }
      events.add(event);
    }
    let models: Set<string> | null = null;
    if (option.models !== undefined) {
      if (!Array.isArray(option.models) || option.models.length === 0) {
        invalid(`${where}.models must name at least one model, or be left out for every model.`);
      }
      models = new Set<string>();
      for (const model of option.models) {
        if (typeof model !== "string" || NAMESPACES[model] === undefined) {
          invalid(`${where}.models has ${JSON.stringify(model)}, which is not a model in this schema.`);
        }
        models.add(model);
      }
    }
    return { index, url: option.url, events, models, secret: option.secret };
  });
  return Object.freeze(hooks);
}

/** Whether this deployment delivers webhooks at all. */
export function webhooksConfigured(hooks: readonly ConfiguredWebhook[]): boolean {
  return hooks.length > 0;
}

// ---- Capture ------------------------------------------------------------------

const captureTriggerName = (table: string, action: string): string =>
  `_tapedb_webhook_${table}_${action.toLowerCase()}`;

function quote(value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * The old row of a delete, as JSON keyed by API field name, personal fields
 * left out. Built into the trigger so the capture carries no plaintext and no
 * ciphertext either: a personal column is never named.
 */
function capturedRow(model: NamespaceDefinition): string {
  const columns = Object.entries(model.attributes).filter(([, definition]) => !definition.personal);
  if (columns.length === 0) return "NULL";
  return `json_object(${columns
    .map(([name]) => `'${quote(name)}', OLD."${toSnakeCase(name)}"`)
    .join(", ")})`;
}

/**
 * One trigger: record that this row changed in the transaction now being
 * written. The sequence comes from the transaction's own `_tx_log` line, the
 * same way `_tx_audit` attributes a change to its writer.
 */
function captureTrigger(model: NamespaceDefinition, action: "INSERT" | "UPDATE" | "DELETE"): string {
  const row = action === "DELETE" ? "OLD" : "NEW";
  const before = action === "DELETE" ? capturedRow(model) : "NULL";
  return `CREATE TRIGGER IF NOT EXISTS "${captureTriggerName(model.table, action)}" AFTER ${action} ON "${model.table}"
    WHEN EXISTS (SELECT 1 FROM "_tx_log")
    BEGIN
      INSERT INTO "${WEBHOOK_CHANGES_TABLE}" (seq, table_name, row_id, action, before, at)
      SELECT seq, '${quote(model.table)}', ${row}."id", '${action.toLowerCase()}', ${before}, at
        FROM "_tx_log" ORDER BY seq DESC LIMIT 1;
    END`;
}

function createTables(sql: SqlExecutor): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS "${WEBHOOK_CHANGES_TABLE}" (
    seq INTEGER NOT NULL,
    table_name TEXT NOT NULL,
    row_id TEXT NOT NULL,
    action TEXT NOT NULL,
    before TEXT,
    at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS "${WEBHOOK_OUTBOX_TABLE}" (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    hook INTEGER NOT NULL,
    url TEXT NOT NULL,
    seq INTEGER NOT NULL,
    model TEXT NOT NULL,
    op TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    last_status INTEGER,
    last_error TEXT,
    delivered_at INTEGER
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS "${WEBHOOK_OUTBOX_TABLE}_due"
    ON "${WEBHOOK_OUTBOX_TABLE}" (status, next_attempt_at, seq)`);
}

/**
 * Creates the capture tables and the triggers the configuration needs: only
 * watched tables, only watched operations, so a workspace with webhooks pays
 * for the rows an endpoint actually asked about.
 */
export function installWebhookCapture(sql: SqlExecutor, hooks: readonly ConfiguredWebhook[]): void {
  if (hooks.length === 0) return;
  createTables(sql);
  const actions = new Set<"INSERT" | "UPDATE" | "DELETE">();
  for (const hook of hooks) for (const event of hook.events) actions.add(ACTION_FOR[event]);
  const watched = watchedModels(hooks);
  for (const model of Object.values(NAMESPACES)) {
    if (watched !== null && !watched.has(model.apiName)) continue;
    for (const action of actions) sql.exec(captureTrigger(model, action));
  }
}

/**
 * Removes the capture triggers. Runs on boot before migrations, so a backfill
 * or a table rebuild is not reported as a write, and when webhooks are turned
 * off so capture stops at the next boot.
 */
export function dropWebhookCapture(sql: SqlExecutor): void {
  for (const row of sql.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '\\_tapedb\\_webhook\\_%' ESCAPE '\\'`
  )) {
    sql.exec(`DROP TRIGGER IF EXISTS "${row.name}"`);
  }
}

function watchedModels(hooks: readonly ConfiguredWebhook[]): Set<string> | null {
  if (hooks.some((hook) => hook.models === null)) return null;
  return new Set(hooks.flatMap((hook) => [...(hook.models ?? [])]));
}

// ---- Emit ---------------------------------------------------------------------

interface ChangeRow extends SqlRow {
  change_rowid: number;
  seq: number;
  table_name: string;
  row_id: string;
  action: string;
  before: string | null;
  at: number;
}

function namespaceForTable(table: string): NamespaceDefinition | undefined {
  return Object.values(NAMESPACES).find((namespace) => namespace.table === table);
}

/**
 * The row as a consumer sees it: API field names, API shapes, and only the
 * attributes that are not personal — the same rule `log-read.ts` applies
 * before it shows a value.
 */
function projectRow(model: NamespaceDefinition, stored: SqlRow, id: string): Record<string, unknown> {
  const row: Record<string, unknown> = { id };
  for (const [name, definition] of Object.entries(model.attributes)) {
    if (definition.personal) continue;
    const column = toSnakeCase(name);
    if (!(column in stored)) continue;
    row[name] = fromStoredValue(definition.type, stored[column]);
  }
  return row;
}

function deletedRow(model: NamespaceDefinition, before: string | null, id: string): Record<string, unknown> {
  if (before === null) return { id };
  let parsed: unknown;
  try {
    parsed = JSON.parse(before);
  } catch {
    return { id };
  }
  if (parsed === null || typeof parsed !== "object") return { id };
  const values = parsed as Record<string, unknown>;
  const row: Record<string, unknown> = { id };
  for (const [name, definition] of Object.entries(model.attributes)) {
    if (definition.personal || !(name in values)) continue;
    row[name] = fromStoredValue(definition.type, values[name] as SqlValue);
  }
  return row;
}

/**
 * Turns captured changes into outbox events, in `seq` order, and forgets the
 * changes it consumed. Runs after the write has answered (and again before a
 * delivery pass, for writes that do not pass through `/transact`: an import,
 * the auth projection). Returns how many deliveries were queued.
 *
 * A failure here loses no capture: the change rows are only deleted by the
 * same transaction that inserts the events, and they are durable until then.
 */
export function drainWebhookChanges(
  sql: SqlExecutor,
  workspaceId: string,
  hooks: readonly ConfiguredWebhook[]
): number {
  if (hooks.length === 0) return 0;

  const changes = sql.all<ChangeRow>(
    `SELECT rowid AS change_rowid, seq, table_name, row_id, action, before, at
       FROM "${WEBHOOK_CHANGES_TABLE}" ORDER BY rowid LIMIT ?`,
    CHANGES_PER_DRAIN
  );
  if (changes.length === 0) return 0;

  // One row can be written more than once in a transaction. An insert that is
  // later updated is still a create; anything else takes its last action, so an
  // update that ends in a delete is a delete.
  const merged = new Map<string, ChangeRow>();
  for (const change of changes) {
    const key = `${change.table_name}\u001f${change.row_id}`;
    const prior = merged.get(key);
    if (prior === undefined) {
      merged.set(key, change);
      continue;
    }
    if (prior.action === "insert" && change.action === "update") continue;
    merged.set(key, change);
  }

  const lastRowid = Number(changes[changes.length - 1].change_rowid);
  const emitted = sql.transactionSync(() => {
    let queued = 0;
    const now = Date.now();
    for (const change of merged.values()) {
      const model = namespaceForTable(String(change.table_name));
      if (model === undefined) continue;
      const op: WebhookEvent =
        change.action === "insert" ? "create" : change.action === "update" ? "update" : "delete";
      const matching = hooks.filter(
        (hook) => (hook.models === null || hook.models.has(model.apiName)) && hook.events.has(op)
      );
      if (matching.length === 0) continue;

      const seq = Number(change.seq);
      let row: Record<string, unknown> | null;
      if (op === "delete") {
        row = deletedRow(model, change.before, String(change.row_id));
      } else {
        const stored = sql.one<SqlRow>(`SELECT * FROM "${model.table}" WHERE id = ?`, change.row_id);
        row = stored === undefined ? null : projectRow(model, stored, String(change.row_id));
      }
      // The row was written and then removed later in the same transaction
      // (an insert followed by a delete): there is nothing to report.
      if (row === null) continue;

      const eventId = crypto.randomUUID();
      const body = JSON.stringify({
        eventId,
        seq,
        workspaceId,
        model: model.apiName,
        op,
        at: Number(change.at),
        row,
      } satisfies WebhookEventPayload);

      for (const hook of matching) {
        sql.exec(
          `INSERT INTO "${WEBHOOK_OUTBOX_TABLE}"
             (id, event_id, hook, url, seq, model, op, workspace_id, body, created_at, next_attempt_at, attempts, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending')`,
          crypto.randomUUID(),
          eventId,
          hook.index,
          hook.url,
          seq,
          model.apiName,
          op,
          workspaceId,
          body,
          now,
          now
        );
        queued += 1;
      }
    }
    sql.exec(`DELETE FROM "${WEBHOOK_CHANGES_TABLE}" WHERE rowid <= ?`, lastRowid);
    return queued;
  });
  return emitted;
}

// ---- Delivery ------------------------------------------------------------------

/** What one POST attempt got back. */
export interface WebhookAttemptResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** One attempt: the exact body and headers to post. */
export interface WebhookRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/** The network, swappable in tests. */
export type WebhookTransport = (request: WebhookRequest) => Promise<WebhookAttemptResult>;

/**
 * The network, as a value: `fetch` with a timeout. A deployment's
 * `DeploymentConfig.webhookTransport` replaces it for that deployment only.
 */
export const defaultWebhookTransport: WebhookTransport = async (request) => {
  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(WEBHOOK_SEND_TIMEOUT_MS),
    });
    // The body is the consumer's business; dropping it frees the connection.
    try {
      await response.body?.cancel();
    } catch {
      // Already read or absent.
    }
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

/** What one delivery pass did. */
export interface WebhookDeliverySummary {
  delivered: number;
  retried: number;
  dead: number;
  /** Events still waiting, including those a failed head blocked this pass. */
  pending: number;
  /** When the next attempt is due, or null when nothing is waiting. */
  nextAt: number | null;
}

interface OutboxRow extends SqlRow {
  id: string;
  event_id: string;
  hook: number;
  url: string;
  seq: number;
  model: string;
  op: string;
  body: string;
  created_at: number;
  attempts: number;
  next_attempt_at: number;
}

/** Wait before the next attempt: 30 s, doubling, capped at 30 minutes. */
export function webhookBackoffMs(attempts: number): number {
  return Math.min(WEBHOOK_MAX_RETRY_MS, WEBHOOK_FIRST_RETRY_MS * 2 ** Math.max(0, attempts - 1));
}

/**
 * Delivers every event due at `now`, in `seq` order, one request at a time.
 * A non-2xx or a failed POST is retried with backoff; a 2xx stops. After
 * `WEBHOOK_MAX_AGE_MS` (or `WEBHOOK_MAX_ATTEMPTS`) the event is dead-lettered:
 * the row stays, marked `dead`, and the workspace counts it.
 *
 * A failed endpoint stops only its own events for this pass, so a consumer
 * that is down cannot hold up one that is not, while each consumer still sees
 * its events in sequence order.
 */
export async function deliverWebhooks(
  sql: SqlExecutor,
  options: {
    now: number;
    send: WebhookTransport;
    /** This deployment's endpoints; an event whose hook is gone is dead-lettered. */
    hooks: readonly ConfiguredWebhook[];
    limit?: number;
  }
): Promise<WebhookDeliverySummary> {
  const now = options.now;
  const hooks = options.hooks;
  const limit = Math.max(1, options.limit ?? WEBHOOK_PASS_ATTEMPTS);
  // The whole pending queue, in sequence order: an endpoint's first waiting
  // event is its head, and nothing later may overtake it. A row held back by
  // its own backoff is still the head, so it blocks the rest of its endpoint.
  const queue = sql.all<OutboxRow>(
    `SELECT id, event_id, hook, url, seq, model, op, body, created_at, attempts, next_attempt_at
       FROM "${WEBHOOK_OUTBOX_TABLE}"
      WHERE status = 'pending'
      ORDER BY seq, rowid
      LIMIT 500`
  );

  const summary: WebhookDeliverySummary = { delivered: 0, retried: 0, dead: 0, pending: 0, nextAt: null };
  /** Endpoints that must not send anything more this pass. */
  const closed = new Set<number>();
  let attempts = 0;

  for (const row of queue) {
    const hookIndex = Number(row.hook);
    if (closed.has(hookIndex)) continue;
    // Not due yet: its backoff holds this endpoint's later events too.
    if (Number(row.next_attempt_at) > now) {
      closed.add(hookIndex);
      continue;
    }
    if (attempts >= limit) {
      closed.add(hookIndex);
      continue;
    }

    const hook = hooks[hookIndex];
    if (hook === undefined) {
      // The configuration that emitted this event is gone; nothing can sign it.
      markDead(sql, row, null, "the webhook is no longer configured");
      summary.dead += 1;
      continue;
    }

    attempts += 1;
    const attempt = Number(row.attempts) + 1;
    const signature = await webhookSignature(hook.secret, Math.floor(now / 1000), String(row.body));
    let result: WebhookAttemptResult;
    try {
      result = await options.send({
        url: String(row.url),
        body: String(row.body),
        headers: {
          "content-type": "application/json",
          "user-agent": "tapedb-webhooks/1",
          "X-Tapedb-Event": String(row.op),
          "X-Tapedb-Event-Id": String(row.event_id),
          "X-Tapedb-Seq": String(row.seq),
          "X-Tapedb-Model": String(row.model),
          [WEBHOOK_SIGNATURE_HEADER]: signature,
        },
      });
    } catch (error) {
      // A transport that throws is a network failure: retry it like a 500.
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    if (result.ok) {
      sql.exec(
        `UPDATE "${WEBHOOK_OUTBOX_TABLE}"
            SET status = 'delivered', attempts = ?, last_status = ?, last_error = NULL, delivered_at = ?
          WHERE id = ?`,
        attempt,
        result.status ?? null,
        now,
        row.id
      );
      summary.delivered += 1;
      continue;
    }

    const expired = now - Number(row.created_at) >= WEBHOOK_MAX_AGE_MS || attempt >= WEBHOOK_MAX_ATTEMPTS;
    if (expired) {
      markDead(sql, row, attempt, result.error ?? `HTTP ${result.status ?? "failure"}`, result.status ?? null);
      summary.dead += 1;
      continue;
    }
    sql.exec(
      `UPDATE "${WEBHOOK_OUTBOX_TABLE}"
          SET attempts = ?, next_attempt_at = ?, last_status = ?, last_error = ?
        WHERE id = ?`,
      attempt,
      now + webhookBackoffMs(attempt),
      result.status ?? null,
      result.error ?? `HTTP ${result.status ?? "failure"}`,
      row.id
    );
    summary.retried += 1;
    // Head-of-line: this endpoint's later events wait for this one.
    closed.add(hookIndex);
  }

  const waiting = sql.one<{ total: number; next_at: number | null }>(
    `SELECT COUNT(*) AS total, MIN(o.next_attempt_at) AS next_at
       FROM "${WEBHOOK_OUTBOX_TABLE}" o
      WHERE o.status = 'pending'
        AND o.seq = (SELECT MIN(h.seq) FROM "${WEBHOOK_OUTBOX_TABLE}" h
                      WHERE h.status = 'pending' AND h.hook = o.hook)`
  );
  summary.pending = Number(waiting?.total ?? 0);
  summary.nextAt = waiting?.next_at === null || waiting?.next_at === undefined ? null : Number(waiting.next_at);
  return summary;
}

function markDead(
  sql: SqlExecutor,
  row: OutboxRow,
  attempts: number | null,
  error: string,
  status: number | null = null
): void {
  sql.exec(
    `UPDATE "${WEBHOOK_OUTBOX_TABLE}"
        SET status = 'dead', attempts = ?, last_status = ?, last_error = ?
      WHERE id = ?`,
    attempts ?? Number(row.attempts),
    status,
    error,
    row.id
  );
}

/**
 * What the outbox holds, by state. Exposed on `GET /status` so a deployment
 * can see a dead-lettered event without reading the table.
 */
export function webhookCounts(sql: SqlExecutor): { pending: number; delivered: number; dead: number } {
  const counts = { pending: 0, delivered: 0, dead: 0 };
  let rows: Array<{ status: string; total: number }>;
  try {
    rows = sql.all<{ status: string; total: number }>(
      `SELECT status, COUNT(*) AS total FROM "${WEBHOOK_OUTBOX_TABLE}" GROUP BY status`
    );
  } catch {
    // Configured but not installed yet (a boot that has not finished).
    return counts;
  }
  for (const row of rows) {
    if (row.status === "pending" || row.status === "delivered" || row.status === "dead") {
      counts[row.status] = Number(row.total);
    }
  }
  return counts;
}
