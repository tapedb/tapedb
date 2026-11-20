/**
 * Per-model and per-workspace write budgets.
 *
 * A deployment declares them once:
 *
 *   defineTapeDB({
 *     schema,
 *     limits: { writes: { models: { tasks: { count: 60, windowSeconds: 60 } },
 *                         workspace: { count: 600, windowSeconds: 60 } } },
 *   })
 *
 * **Fixed windows, not a smoothing algorithm.** A budget is a counter and the
 * moment its window opened. When `now` is past `windowStart + windowSeconds`
 * the counter starts again at zero. This is the simplest rule that is exact:
 * the state is one row per scope, the decision is one read, and `retryAfterMs`
 * is the exact end of the window rather than an estimate. The cost is the
 * known fixed-window burst — a caller can spend a full budget at the end of
 * one window and another immediately after the next opens, so up to `2 ×
 * count` writes in a span of `windowSeconds`. A GCRA or token bucket would
 * spread that burst out, but it would also need a rate, an accumulated
 * allowance and a recomputed `retryAfterMs`, and the honest smoothing it buys
 * is worth less to a write budget than state a reader can check by eye.
 *
 * **The counters live in the workspace's own SQLite** (`_write_limits`), so
 * they survive eviction, hibernation and a Worker restart: a budget that
 * reset whenever the object went cold would protect nothing. They are not
 * part of the log, so a workspace rebuilt from R2 after its storage was lost
 * resumes with empty counters. The table is created on first use and only
 * when a limit is configured, so a deployment that does not use this pays one
 * option check and holds no table.
 *
 * **A charged write is a write that passed validation.** The caller validates
 * the envelope, charges the budget, and gives the charge back when the write
 * fails, so a refused or rolled-back write never consumes budget. Charges are
 * per operation, not per row: a bulk `patchMany` counts once, because its rows
 * are only known inside the transaction that applies them.
 *
 * The clock is always a parameter. Nothing here reads `Date.now()`.
 */

import { NAMESPACES, registryConfigured } from "./registry";
import type { SqlExecutor } from "./tx-sql";
import { TxError } from "./tx-types";

/** What one scope may spend in one window. */
export interface WriteLimit {
  /** Writes allowed per window. */
  count: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/** `limits.writes`: per-model budgets, and one budget for the workspace. */
export interface WriteLimitsOptions {
  /** Per model, by API name. */
  models?: Readonly<Record<string, WriteLimit>>;
  /** One budget across every model, checked with the per-model ones. */
  workspace?: WriteLimit;
}

/** `defineTapeDB({ limits })`. */
export interface LimitsOptions {
  writes?: WriteLimitsOptions;
}

/** One row per budget: what it has spent, and when its window opened. */
export const WRITE_LIMITS_TABLE = "_write_limits";

/** The scope name a workspace-wide budget is stored under. */
export const WORKSPACE_SCOPE = "workspace";

/** Budgets as the room uses them: models resolved to a map, nothing to parse. */
export interface ResolvedWriteLimits {
  readonly models: ReadonlyMap<string, WriteLimit>;
  readonly workspace?: WriteLimit;
}

/** What a write spends, before anything is charged. */
export interface WriteCounts {
  /** Operations in the envelope, whatever model they touch. */
  readonly total: number;
  /** Operations per configured model, by API name. */
  readonly byModel: ReadonlyMap<string, number>;
}

/**
 * A charge already taken. Kept so a write that fails after validation can
 * return its budget: the counters, and the windows they were taken in.
 */
export interface WriteBudget {
  readonly charges: ReadonlyArray<{ scope: string; units: number; windowStart: number }>;
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS "${WRITE_LIMITS_TABLE}"
  (scope TEXT PRIMARY KEY, used INTEGER NOT NULL, window_start INTEGER NOT NULL) WITHOUT ROWID`;

function checkedLimit(where: string, limit: WriteLimit): WriteLimit {
  if (!Number.isInteger(limit.count) || limit.count <= 0) {
    throw new Error(`${where} needs a positive integer \`count\`.`);
  }
  if (!(typeof limit.windowSeconds === "number" && Number.isFinite(limit.windowSeconds) && limit.windowSeconds > 0)) {
    throw new Error(`${where} needs a positive \`windowSeconds\`.`);
  }
  return { count: limit.count, windowSeconds: limit.windowSeconds };
}

/**
 * Validates `limits` once, when the deployment (or the room) is built, and
 * returns `undefined` when nothing is configured: an unconfigured deployment
 * never reaches the limiter at all.
 */
export function resolveWriteLimits(limits: WriteLimitsOptions | undefined): ResolvedWriteLimits | undefined {
  if (limits === undefined) return undefined;
  const models = new Map<string, WriteLimit>();
  for (const [name, limit] of Object.entries(limits.models ?? {})) {
    // A typo would otherwise silently limit nothing.
    if (registryConfigured() && !(name in NAMESPACES)) {
      throw new Error(`limits.writes.models.${name} names no model in this schema.`);
    }
    models.set(name, checkedLimit(`limits.writes.models.${name}`, limit));
  }
  const workspace = limits.workspace === undefined ? undefined : checkedLimit("limits.writes.workspace", limits.workspace);
  return models.size === 0 && workspace === undefined ? undefined : { models, workspace };
}

/** Counts an envelope's operations against the configured scopes. */
export function countWrites(limits: ResolvedWriteLimits, namespaces: readonly string[]): WriteCounts {
  const byModel = new Map<string, number>();
  for (const namespace of namespaces) {
    if (limits.models.has(namespace)) byModel.set(namespace, (byModel.get(namespace) ?? 0) + 1);
  }
  return { total: namespaces.length, byModel };
}

function spanMs(limit: WriteLimit): number {
  return Math.round(limit.windowSeconds * 1000);
}

interface PlannedCharge {
  scope: string;
  model: string;
  limit: WriteLimit;
  units: number;
  used: number;
  windowStart: number;
}

/**
 * Charges `counts` against every budget it touches, or refuses and charges
 * nothing. Every budget is decided before any counter moves, so a refusal
 * leaves the tables exactly as it found them.
 *
 * Throws `TxError("rate_limited")` carrying the scope, the limit, the window
 * and the exact milliseconds until that window closes.
 */
export function reserveWriteBudget(
  sql: SqlExecutor,
  limits: ResolvedWriteLimits,
  counts: WriteCounts,
  now: number
): WriteBudget {
  if (counts.total === 0) return { charges: [] };
  sql.exec(CREATE_TABLE);

  const plan: PlannedCharge[] = [];
  const planFor = (scope: string, model: string, limit: WriteLimit, units: number): void => {
    const row = sql.one<{ used: number; window_start: number }>(
      `SELECT used, window_start FROM "${WRITE_LIMITS_TABLE}" WHERE scope = ?`,
      scope
    );
    const span = spanMs(limit);
    const fresh = row === undefined || now >= Number(row.window_start) + span;
    plan.push({
      scope,
      model,
      limit,
      units,
      used: fresh ? 0 : Number(row!.used),
      windowStart: fresh ? now : Number(row!.window_start),
    });
  };

  for (const [model, units] of counts.byModel) {
    const limit = limits.models.get(model);
    if (limit !== undefined) planFor(model, model, limit, units);
  }
  if (limits.workspace !== undefined) planFor(WORKSPACE_SCOPE, WORKSPACE_SCOPE, limits.workspace, counts.total);

  for (const charge of plan) {
    const over = charge.used + charge.units > charge.limit.count;
    if (!over) continue;
    const retryAfterMs = Math.max(1, charge.windowStart + spanMs(charge.limit) - now);
    const what = charge.model === WORKSPACE_SCOPE
      ? `This workspace allows ${charge.limit.count} writes per ${charge.limit.windowSeconds} s across every model`
      : `The "${charge.model}" model allows ${charge.limit.count} writes per ${charge.limit.windowSeconds} s`;
    throw new TxError("rate_limited", `${what}; this write would exceed it. Retry in ${Math.ceil(retryAfterMs / 1000)} s.`, {
      detail: { model: charge.model, limit: charge.limit.count, windowSeconds: charge.limit.windowSeconds, retryAfterMs },
    });
  }

  for (const charge of plan) {
    sql.exec(
      `INSERT INTO "${WRITE_LIMITS_TABLE}" (scope, used, window_start) VALUES (?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET used = excluded.used, window_start = excluded.window_start`,
      charge.scope,
      charge.used + charge.units,
      charge.windowStart
    );
  }
  return { charges: plan.map(({ scope, units, windowStart }) => ({ scope, units, windowStart })) };
}

/**
 * Gives a charge back: the write it paid for did not commit. A charge whose
 * window has already closed is dropped, since its counter was replaced.
 */
export function releaseWriteBudget(sql: SqlExecutor, budget: WriteBudget): void {
  for (const charge of budget.charges) {
    sql.exec(
      `UPDATE "${WRITE_LIMITS_TABLE}" SET used = MAX(0, used - ?) WHERE scope = ? AND window_start = ?`,
      charge.units,
      charge.scope,
      charge.windowStart
    );
  }
}
