/**
 * Built-in limits for the claim route: exact token buckets, global per key.
 *
 * Each bucket lives in one of `LIMITER_SHARDS` Durable Objects of the
 * workspace class, addressed by a name that is not a workspace id, so a
 * deployment needs no extra binding or migration. A Durable Object is one
 * place in the world and runs one request at a time, so a count is exact and
 * shared by every location, unlike Cloudflare's rate-limit binding, which
 * counts per location and approximately.
 *
 * Keys are HMACs of the caller's IP or subject under the claim secret: the
 * limiter never stores an address or a user id. A bucket that has refilled
 * is indistinguishable from none and is deleted.
 */

import { apiError, json } from "../http";
import type { SqlExecutor } from "./tx-sql";

export interface ClaimLimit {
  /** Requests a caller may make in a burst; the bucket's size. */
  requests: number;
  /** Seconds the bucket takes to refill from empty. */
  perSeconds: number;
}

/**
 * Limits on `POST /_tapedb/claim`. `ip` is checked before the session lookup
 * (it protects your identity system from floods), `subject` after it.
 * `false` turns one off.
 */
export interface ClaimLimits {
  ip?: ClaimLimit | false;
  subject?: ClaimLimit | false;
}

/**
 * Defaults: a signed-in user rarely needs more than a claim per connect and
 * per renewal, while one office or mobile carrier can put hundreds of users
 * behind one address, hence the larger per-IP bucket.
 */
export const DEFAULT_CLAIM_LIMITS: Required<{ [K in keyof ClaimLimits]: ClaimLimit }> = {
  ip: { requests: 300, perSeconds: 60 },
  subject: { requests: 30, perSeconds: 60 },
};

export const LIMITER_SHARDS = 32;
const LIMITER_PREFIX = "tapedb-limits-";
export const BUCKETS_TABLE = "_claim_buckets";

export function limiterName(shard: number): string {
  return `${LIMITER_PREFIX}${shard}`;
}

export function isLimiterName(name: string | undefined): boolean {
  return typeof name === "string" && new RegExp(`^${LIMITER_PREFIX}\\d+$`).test(name);
}

export function resolveClaimLimits(limits: ClaimLimits | false | undefined): Required<ClaimLimits> {
  if (limits === false) return { ip: false, subject: false };
  const pick = (kind: keyof ClaimLimits): ClaimLimit | false => {
    const given = limits?.[kind];
    if (given === false) return false;
    const limit = given ?? DEFAULT_CLAIM_LIMITS[kind];
    if (!(Number.isInteger(limit.requests) && limit.requests > 0 && limit.perSeconds > 0)) {
      throw new Error(`identity.limits.${kind} needs a positive integer \`requests\` and a positive \`perSeconds\`.`);
    }
    return limit;
  };
  return { ip: pick("ip"), subject: pick("subject") };
}

/** The bucket key for a caller, and the shard that holds it. */
export async function limiterKey(secret: string, value: string): Promise<{ key: string; shard: number }> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`tapedb-claim-limits:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(value)));
  const key = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { key, shard: digest[16] % LIMITER_SHARDS };
}

export interface LimitDecision {
  allowed: boolean;
  /** Whole seconds until one more request is allowed; 0 when allowed. */
  retryAfterSeconds: number;
}

/** Takes one token from `key`'s bucket, exactly. */
export function takeToken(sql: SqlExecutor, key: string, limit: ClaimLimit, now: number): LimitDecision {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS "${BUCKETS_TABLE}" (key TEXT PRIMARY KEY, tokens REAL NOT NULL, at INTEGER NOT NULL, refill_ms INTEGER NOT NULL) WITHOUT ROWID`
  );
  const refillMs = limit.perSeconds * 1000;
  const row = sql.one<{ tokens: number; at: number }>(`SELECT tokens, at FROM "${BUCKETS_TABLE}" WHERE key = ?`, key);
  const elapsed = row ? Math.max(0, now - Number(row.at)) : refillMs;
  const tokens = Math.min(limit.requests, (row ? Number(row.tokens) : limit.requests) + (elapsed * limit.requests) / refillMs);
  const allowed = tokens >= 1;
  const left = allowed ? tokens - 1 : tokens;
  sql.exec(
    `INSERT INTO "${BUCKETS_TABLE}" (key, tokens, at, refill_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET tokens = excluded.tokens, at = excluded.at, refill_ms = excluded.refill_ms`,
    key,
    left,
    now,
    refillMs
  );
  // Buckets that have refilled hold nothing worth keeping.
  sql.exec(
    `DELETE FROM "${BUCKETS_TABLE}" WHERE key IN (SELECT key FROM "${BUCKETS_TABLE}" WHERE at + refill_ms < ? LIMIT 100)`,
    now
  );
  return {
    allowed,
    retryAfterSeconds: allowed ? 0 : Math.ceil(((1 - left) * refillMs) / limit.requests / 1000),
  };
}

/** The limiter object's one route: `POST { key, requests, perSeconds }`. */
export async function handleLimitRequest(request: Request, sql: SqlExecutor, now = Date.now()): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const key = body?.key;
  const requests = body?.requests;
  const perSeconds = body?.perSeconds;
  if (
    request.method !== "POST" ||
    typeof key !== "string" || !/^[0-9a-f]{32}$/.test(key) ||
    !Number.isInteger(requests) || (requests as number) <= 0 ||
    typeof perSeconds !== "number" || perSeconds <= 0
  ) {
    return apiError(400, "invalid_limit", "A limit request is POST { key, requests, perSeconds }.");
  }
  return json(takeToken(sql, key, { requests: requests as number, perSeconds }, now));
}
