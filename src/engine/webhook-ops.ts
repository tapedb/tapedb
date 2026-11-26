/**
 * Operating the webhook outbox: seeing why a delivery failed, and getting it
 * moving again.
 *
 * The delivery machinery itself is in webhooks.ts and is not changed here.
 * This module only reads the outbox and re-queues rows that are already in it.
 * That distinction is the whole safety argument:
 *
 * - **A retry is not a new event.** It re-queues the existing row, so the
 *   `event_id`, the `seq` and the signed body are the ones first captured.
 *   A consumer that already saw the event sees the same event again, which
 *   at-least-once delivery already allows it to expect. Nothing re-reads the
 *   database, so a retry cannot pick up a row's later state and pass it off
 *   as the original change.
 * - **Ordering survives a retry.** The queue is ordered by `seq`, so a revived
 *   dead event becomes its endpoint's head again and the endpoint's newer
 *   events wait behind it, exactly as they would have before it died. That is
 *   a consequence worth knowing rather than a side effect to hide: reviving
 *   an old event holds up newer ones for that endpoint until it is delivered
 *   or dies again.
 * - **One endpoint cannot hold up another.** Re-queuing touches only its own
 *   rows, and the head-of-line rule in webhooks.ts is per endpoint.
 * - **Nothing here can roll back a write.** The outbox is downstream of the
 *   commit; these functions change delivery bookkeeping and never application
 *   rows.
 *
 * Exactly-once is not claimed and cannot be. A delivery that timed out may
 * have arrived; retrying it may deliver it twice. Consumers key on
 * `X-Tapedb-Event-Id`.
 */

import {
  WEBHOOK_FIRST_RETRY_MS,
  WEBHOOK_MAX_AGE_MS,
  WEBHOOK_MAX_RETRY_MS,
  WEBHOOK_OUTBOX_TABLE,
  WEBHOOK_PASS_ATTEMPTS,
  webhookMaxAttempts,
  type ConfiguredWebhook,
} from "./webhooks";
import type { SqlExecutor, SqlRow } from "./tx-sql";

/** The most rows one `retryWebhooks` call will re-queue. */
export const WEBHOOK_RETRY_LIMIT = 500;
/** The most deliveries one `listWebhookDeliveries` call will return. */
export const WEBHOOK_LIST_LIMIT = 200;

/**
 * One delivery, as an operator may see it.
 *
 * **The body is deliberately absent.** It carries the row's non-personal
 * values, and a webhook body is written for the endpoint rather than filtered
 * through the caller's read rules — so returning it here would show an admin
 * row values their own rules may hide. Everything in this shape is delivery
 * bookkeeping: what the event was about, not what it contained.
 */
export interface WebhookDeliveryView {
  id: string;
  /** Stable across retries: what a consumer deduplicates on. */
  eventId: string;
  /** The endpoint's position in the deployment's `webhooks` list. */
  endpoint: number;
  url: string;
  /** The transaction that caused it. Delivery order per endpoint follows this. */
  seq: number;
  model: string;
  op: string;
  status: "pending" | "delivered" | "dead";
  attempts: number;
  /** HTTP status of the last attempt, null if the request never answered. */
  lastStatus: number | null;
  lastError: string | null;
  createdAt: number;
  nextAttemptAt: number;
  deliveredAt: number | null;
  /** When it was last re-queued by hand, null if never. */
  revivedAt: number | null;
}

/** How one endpoint is doing. */
export interface WebhookEndpointHealth {
  endpoint: number;
  url: string;
  events: readonly string[];
  /** Models it watches, or null for every model. */
  models: readonly string[] | null;
  /** True when the deployment no longer configures this endpoint. */
  retired: boolean;
  pending: number;
  delivered: number;
  dead: number;
  /**
   * The event this endpoint is waiting on. Everything else it has waits behind
   * this one, so this row is the whole explanation of a stalled endpoint.
   */
  head: WebhookDeliveryView | null;
  /** True when the head is not due yet: the endpoint is in backoff. */
  backingOff: boolean;
  /** Age of the oldest pending event, or null when none is waiting. */
  oldestPendingAgeMs: number | null;
}

export interface WebhookReport {
  endpoints: WebhookEndpointHealth[];
  totals: { pending: number; delivered: number; dead: number };
  /**
   * The retry schedule in force, so a reader can tell a backoff from a stall
   * without knowing the engine's constants.
   */
  policy: {
    firstRetryMs: number;
    maxRetryMs: number;
    maxAgeMs: number;
    maxAttempts: number;
    attemptsPerPass: number;
    retryLimit: number;
  };
}

interface OutboxView extends SqlRow {
  id: string;
  event_id: string;
  hook: number;
  url: string;
  seq: number;
  model: string;
  op: string;
  status: string;
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  created_at: number;
  next_attempt_at: number;
  delivered_at: number | null;
  revived_at: number | null;
}

const COLUMNS = `id, event_id, hook, url, seq, model, op, status, attempts,
  last_status, last_error, created_at, next_attempt_at, delivered_at, revived_at`;

function view(row: OutboxView): WebhookDeliveryView {
  const status = String(row.status);
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    endpoint: Number(row.hook),
    url: String(row.url),
    seq: Number(row.seq),
    model: String(row.model),
    op: String(row.op),
    status: status === "delivered" || status === "dead" ? status : "pending",
    attempts: Number(row.attempts),
    lastStatus: row.last_status === null ? null : Number(row.last_status),
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: Number(row.created_at),
    nextAttemptAt: Number(row.next_attempt_at),
    deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
    revivedAt: row.revived_at === null ? null : Number(row.revived_at),
  };
}

/**
 * True when the outbox exists. A deployment that configures webhooks installs
 * it on boot, so a request arriving first would otherwise see a SQL error
 * rather than an empty report.
 */
function installed(sql: SqlExecutor): boolean {
  try {
    sql.one(`SELECT 1 AS present FROM "${WEBHOOK_OUTBOX_TABLE}" LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

export interface DeliveryQuery {
  status?: "pending" | "delivered" | "dead";
  endpoint?: number;
  /** Only rows with a lower `seq`, for paging back through history. */
  before?: number;
  limit?: number;
}

/**
 * Deliveries, newest transaction first.
 *
 * Ordered by `seq` descending rather than by time, because `seq` is what
 * delivery order follows: an operator reading this list sees the same order
 * the endpoint does, reversed.
 */
export function listWebhookDeliveries(sql: SqlExecutor, query: DeliveryQuery = {}): WebhookDeliveryView[] {
  if (!installed(sql)) return [];
  const limit = Math.min(Math.max(1, query.limit ?? 50), WEBHOOK_LIST_LIMIT);
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (query.status !== undefined) {
    where.push("status = ?");
    params.push(query.status);
  }
  if (query.endpoint !== undefined) {
    where.push("hook = ?");
    params.push(query.endpoint);
  }
  if (query.before !== undefined) {
    where.push("seq < ?");
    params.push(query.before);
  }
  const rows = sql.all<OutboxView>(
    `SELECT ${COLUMNS} FROM "${WEBHOOK_OUTBOX_TABLE}"
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY seq DESC, rowid DESC
      LIMIT ?`,
    ...params,
    limit
  );
  return rows.map(view);
}

/**
 * Per-endpoint health, including endpoints the deployment has since dropped:
 * their events are still in the outbox and will dead-letter unsigned, so
 * hiding them would hide the reason a count never falls.
 */
export function webhookReport(
  sql: SqlExecutor,
  hooks: readonly ConfiguredWebhook[],
  now: number
): WebhookReport {
  const policy = {
    firstRetryMs: WEBHOOK_FIRST_RETRY_MS,
    maxRetryMs: WEBHOOK_MAX_RETRY_MS,
    maxAgeMs: WEBHOOK_MAX_AGE_MS,
    maxAttempts: webhookMaxAttempts(),
    attemptsPerPass: WEBHOOK_PASS_ATTEMPTS,
    retryLimit: WEBHOOK_RETRY_LIMIT,
  };
  const totals = { pending: 0, delivered: 0, dead: 0 };
  if (!installed(sql)) {
    return {
      endpoints: hooks.map((hook, index) => ({
        endpoint: index,
        url: hook.url,
        events: [...hook.events],
        models: hook.models === null ? null : [...hook.models],
        retired: false,
        pending: 0,
        delivered: 0,
        dead: 0,
        head: null,
        backingOff: false,
        oldestPendingAgeMs: null,
      })),
      totals,
      policy,
    };
  }

  const counts = sql.all<{ hook: number; status: string; total: number; oldest: number | null }>(
    `SELECT hook, status, COUNT(*) AS total, MIN(created_at) AS oldest
       FROM "${WEBHOOK_OUTBOX_TABLE}" GROUP BY hook, status`
  );

  // Every endpoint the outbox knows about, plus every one configured now:
  // the two sets differ exactly when configuration changed under a queue.
  const indexes = new Set<number>(hooks.map((_, index) => index));
  for (const row of counts) indexes.add(Number(row.hook));

  const endpoints: WebhookEndpointHealth[] = [];
  for (const index of [...indexes].sort((a, b) => a - b)) {
    const hook = hooks[index];
    const mine = counts.filter((row) => Number(row.hook) === index);
    const of = (status: string) => mine.find((row) => row.status === status);
    const pending = Number(of("pending")?.total ?? 0);
    const delivered = Number(of("delivered")?.total ?? 0);
    const dead = Number(of("dead")?.total ?? 0);
    totals.pending += pending;
    totals.delivered += delivered;
    totals.dead += dead;

    const headRow = sql.one<OutboxView>(
      `SELECT ${COLUMNS} FROM "${WEBHOOK_OUTBOX_TABLE}"
        WHERE status = 'pending' AND hook = ?
        ORDER BY seq, rowid LIMIT 1`,
      index
    );
    const head = headRow === undefined ? null : view(headRow);
    const oldestPending = of("pending")?.oldest;

    endpoints.push({
      endpoint: index,
      // A configured endpoint's url comes from the configuration; a retired
      // one's from the events still queued for it, which is the only place
      // its address survives.
      url: hook?.url ?? head?.url ?? queuedUrl(sql, index) ?? "",
      events: hook === undefined ? [] : [...hook.events],
      models: hook === undefined ? null : hook.models === null ? null : [...hook.models],
      retired: hook === undefined,
      pending,
      delivered,
      dead,
      head,
      backingOff: head !== null && head.nextAttemptAt > now,
      oldestPendingAgeMs:
        oldestPending === null || oldestPending === undefined ? null : Math.max(0, now - Number(oldestPending)),
    });
  }

  return { endpoints, totals, policy };
}

/** The url an endpoint's queued events were addressed to, for a retired one. */
function queuedUrl(sql: SqlExecutor, endpoint: number): string | null {
  const row = sql.one<{ url: string }>(
    `SELECT url FROM "${WEBHOOK_OUTBOX_TABLE}" WHERE hook = ? ORDER BY seq DESC LIMIT 1`,
    endpoint
  );
  return row === undefined ? null : String(row.url);
}

export interface RetryRequest {
  /** Exactly these deliveries, by outbox id. */
  ids?: readonly string[];
  /** Or every delivery in this state, bounded by `limit`. */
  status?: "pending" | "dead";
  endpoint?: number;
  limit?: number;
}

export interface RetryOutcome {
  requeued: number;
  ids: string[];
  /** Ids asked for that were not re-queued, and why. */
  skipped: Array<{ id: string; reason: "not_found" | "already_delivered" }>;
  /** True when more matched the filter than the limit allowed. */
  more: boolean;
}

/**
 * Makes deliveries due now.
 *
 * A `dead` row returns to `pending`; a `pending` row stops waiting out its
 * backoff. Either way the attempt count restarts and `revived_at` is set, so
 * a revived event gets a full retry budget and a fresh age window instead of
 * dying again on the first pass — a dead event has by definition exhausted
 * both, and re-queuing one without resetting them would be a no-op dressed up
 * as a retry.
 *
 * `last_error` is left in place. It is the last thing that actually happened,
 * and clearing it would make a queue that is about to fail the same way look
 * untouched.
 *
 * A `delivered` row is never re-queued, even when named by id. The engine
 * cannot tell a deliberate redelivery from a duplicate, and a consumer that
 * already acknowledged this event did not ask to see it again; the caller is
 * told which ids were skipped and why.
 */
export function retryWebhooks(sql: SqlExecutor, request: RetryRequest, now: number): RetryOutcome {
  const outcome: RetryOutcome = { requeued: 0, ids: [], skipped: [], more: false };
  if (!installed(sql)) {
    for (const id of request.ids ?? []) outcome.skipped.push({ id, reason: "not_found" });
    return outcome;
  }
  const limit = Math.min(Math.max(1, request.limit ?? WEBHOOK_RETRY_LIMIT), WEBHOOK_RETRY_LIMIT);

  let targets: string[] = [];
  if (request.ids !== undefined) {
    // Named ids: report each one's fate rather than silently dropping it.
    for (const id of request.ids) {
      const row = sql.one<{ status: string }>(
        `SELECT status FROM "${WEBHOOK_OUTBOX_TABLE}" WHERE id = ?`,
        id
      );
      if (row === undefined) outcome.skipped.push({ id, reason: "not_found" });
      else if (String(row.status) === "delivered") outcome.skipped.push({ id, reason: "already_delivered" });
      else targets.push(id);
    }
    if (targets.length > limit) {
      outcome.more = true;
      targets = targets.slice(0, limit);
    }
  } else {
    const where: string[] = ["status != 'delivered'"];
    const params: Array<string | number> = [];
    if (request.status !== undefined) {
      where.push("status = ?");
      params.push(request.status);
    }
    if (request.endpoint !== undefined) {
      where.push("hook = ?");
      params.push(request.endpoint);
    }
    // One more than the limit, so `more` is a fact rather than a guess.
    const rows = sql.all<{ id: string }>(
      `SELECT id FROM "${WEBHOOK_OUTBOX_TABLE}" WHERE ${where.join(" AND ")} ORDER BY seq, rowid LIMIT ?`,
      ...params,
      limit + 1
    );
    outcome.more = rows.length > limit;
    targets = rows.slice(0, limit).map((row) => String(row.id));
  }

  for (const id of targets) {
    sql.exec(
      `UPDATE "${WEBHOOK_OUTBOX_TABLE}"
          SET status = 'pending', attempts = 0, next_attempt_at = ?, revived_at = ?
        WHERE id = ? AND status != 'delivered'`,
      now,
      now,
      id
    );
    outcome.requeued += 1;
    outcome.ids.push(id);
  }
  return outcome;
}
