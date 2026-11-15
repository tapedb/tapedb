/**
 * How long a workspace keeps history: old values in R2 log segments, older
 * snapshots and the local replay log. Storage limitation: a value deleted or
 * overwritten at time T is gone from every copy by T + retention.
 *
 * The bound holds because, with R the retention:
 * - a workspace with changes since its newest snapshot takes a new one once
 *   that snapshot is R/2 old, so a pre-T snapshot is superseded by T + R/2;
 * - a superseded snapshot, a log segment it covers and a covered local log row
 *   are deleted once older than R/2, with a superseded snapshot kept at least
 *   SUPERSEDED_GRACE_MS as a fallback should the new one prove unreadable.
 * R/2 + grace <= R because the minimum retention is twice the grace.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_HISTORY_RETENTION_MS = 30 * DAY_MS;
export const SUPERSEDED_GRACE_MS = DAY_MS;
export const MIN_HISTORY_RETENTION_MS = 2 * SUPERSEDED_GRACE_MS;

let configured = DEFAULT_HISTORY_RETENTION_MS;

export interface RetentionOptions {
  /** Days a deleted or overwritten value may remain in history. Defaults to 30; at least 2. */
  days?: number;
}

/** Installed by defineTapeDB; the room reads it on every durability pass. */
export function configureRetention(options: RetentionOptions | undefined): void {
  const days = options?.days ?? DEFAULT_HISTORY_RETENTION_MS / DAY_MS;
  if (typeof days !== "number" || !Number.isFinite(days) || days * DAY_MS < MIN_HISTORY_RETENTION_MS) {
    throw new Error(`retention.days must be a number of at least ${MIN_HISTORY_RETENTION_MS / DAY_MS}.`);
  }
  configured = days * DAY_MS;
}

export function historyRetentionMs(): number {
  return configured;
}

/** History older than this (relative to now) is due for deletion. */
export function historyAgeLimit(retentionMs: number): number {
  return retentionMs / 2;
}
