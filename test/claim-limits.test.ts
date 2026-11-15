/**
 * Built-in claim limits: exact token buckets in limiter Durable Objects,
 * through the real Worker and real WorkspaceRoom instances.
 */

import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS } from "../src/claims";
import { isLimiterName, limiterKey, takeToken } from "../src/engine/claim-limits";
import { durableObjectSqlExecutor } from "../src/engine/tx-sql";
import { model, schema, t } from "../src/schema";
import { FakeRoomContext } from "./fixtures/room-harness";
import { FakeR2Bucket } from "./fixtures/test-support";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");

const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";
const SECRET = "test-secret-test-secret-test-secret";

function memorySql() {
  const context = new FakeRoomContext(new Database(":memory:"), "tapedb-limits-0");
  return { sql: durableObjectSqlExecutor(context.storage as never), db: context.db };
}

describe("token buckets", () => {
  test("allow exactly the burst, then refill at the stated rate", () => {
    const { sql } = memorySql();
    const limit = { requests: 30, perSeconds: 60 };
    const at = 1_000_000;
    const results = Array.from({ length: 31 }, () => takeToken(sql, "k", limit, at));
    expect(results.filter((result) => result.allowed)).toHaveLength(30);
    expect(results[30]).toEqual({ allowed: false, retryAfterSeconds: 2 });
    // 60 s / 30 tokens: one token every 2 s.
    expect(takeToken(sql, "k", limit, at + 1_999).allowed).toBe(false);
    expect(takeToken(sql, "k", limit, at + 2_000).allowed).toBe(true);
    expect(takeToken(sql, "k", limit, at + 2_000).allowed).toBe(false);
    // Another key has its own bucket.
    expect(takeToken(sql, "other", limit, at).allowed).toBe(true);
  });

  test("forget buckets once they have refilled", () => {
    const { sql, db } = memorySql();
    takeToken(sql, "a", { requests: 2, perSeconds: 10 }, 0);
    expect(db.query(`SELECT COUNT(*) AS n FROM "_claim_buckets"`).get()).toEqual({ n: 1 });
    takeToken(sql, "b", { requests: 2, perSeconds: 10 }, 10_001);
    expect(db.query(`SELECT key FROM "_claim_buckets"`).all()).toEqual([{ key: "b" }]);
  });

  test("keys are HMACs: the same caller maps to the same bucket, and no address is stored", async () => {
    const one = await limiterKey(SECRET, "ip:203.0.113.7");
    expect(await limiterKey(SECRET, "ip:203.0.113.7")).toEqual(one);
    expect((await limiterKey(SECRET, "ip:203.0.113.8")).key).not.toBe(one.key);
    expect((await limiterKey("another-secret-another-secret", "ip:203.0.113.7")).key).not.toBe(one.key);
    expect(one.key).toMatch(/^[0-9a-f]{32}$/);
    expect(one.key).not.toContain("203");
    expect(isLimiterName(`tapedb-limits-${one.shard}`)).toBe(true);
    expect(isLimiterName(WORKSPACE)).toBe(false);
  });
});

describe("the claim route", () => {
  const task = model({ title: t.string() });

  function deployment(limits: Parameters<typeof defineTapeDB>[0]["identity"] extends infer I ? (I extends { limits?: infer L } ? L : never) : never, options: { failLimiter?: boolean } = {}) {
    const tapedb = defineTapeDB({
      schema: schema({ task }),
      identity: {
        getSubject: async (headers) => {
          const sub = headers.get("x-user");
          return sub ? { sub } : null;
        },
        getRole: async () => WORKSPACE_ROLE_LEVELS.MEMBER,
        ...(limits === undefined ? {} : { limits }),
      },
    });
    const rooms = new Map<string, { room: InstanceType<typeof tapedb.WorkspaceRoom>; context: FakeRoomContext }>();
    const env: Record<string, unknown> = { FILES: new FakeR2Bucket(), DATA: new FakeR2Bucket(), TAPEDB_CLAIM_SECRET: SECRET, ENVIRONMENT: "production" };
    env.WORKSPACE = {
      idFromName: (name: string) => name,
      get: (name: string) => {
        if (options.failLimiter) throw new Error("no limiter");
        if (!rooms.has(name)) {
          const context = new FakeRoomContext(new Database(":memory:"), name);
          rooms.set(name, { room: new tapedb.WorkspaceRoom(context as never, env as never), context });
        }
        const { room, context } = rooms.get(name)!;
        return { fetch: async (input: RequestInfo, init?: RequestInit) => (await context.ready, room.fetch(new Request(input, init))) };
      },
    };
    const claim = (ip: string, user = "u1") =>
      tapedb.worker.fetch(
        new Request("https://app.test/_tapedb/claim", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": ip, "x-user": user },
          body: JSON.stringify({ workspaceId: WORKSPACE }),
        }),
        env as never,
        {} as ExecutionContext
      );
    return { claim, rooms };
  }

  test("refuse a caller past its limit with 429 and Retry-After, counted per IP and per subject", async () => {
    const { claim, rooms } = deployment({ ip: { requests: 3, perSeconds: 60 }, subject: { requests: 5, perSeconds: 60 } });
    const statuses = [];
    for (let n = 0; n < 4; n += 1) statuses.push((await claim("203.0.113.1", `u${n}`)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const refused = await claim("203.0.113.1", "u9");
    expect(refused.headers.get("retry-after")).toBe("20");
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("rate_limited");

    // Another address has its own bucket; one subject across addresses shares one.
    const spread = [];
    for (let n = 0; n < 6; n += 1) spread.push((await claim(`198.51.100.${n}`, "same")).status);
    expect(spread).toEqual([200, 200, 200, 200, 200, 429]);

    // The limiters are limiter objects: buckets only, no workspace tables.
    for (const { context } of rooms.values()) {
      const tables = context.db.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all();
      expect(tables).toEqual([{ name: "_claim_buckets" }]);
    }
  });

  test("are on by default", async () => {
    const { claim, rooms } = deployment(undefined);
    const statuses = [];
    for (let n = 0; n < 31; n += 1) statuses.push((await claim(`192.0.2.${n}`, "busy")).status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(30);
    expect(statuses[30]).toBe(429);
    expect(rooms.size).toBeGreaterThan(0);
  });

  test("can be turned off, and an unreachable limiter lets claims through", async () => {
    const off = deployment(false);
    for (let n = 0; n < 40; n += 1) expect((await off.claim("203.0.113.2", "u")).status).toBe(200);
    expect(off.rooms.size).toBe(0);

    const down = deployment({ ip: { requests: 1, perSeconds: 60 } }, { failLimiter: true });
    expect((await down.claim("203.0.113.3")).status).toBe(200);
    expect((await down.claim("203.0.113.3")).status).toBe(200);
  });

  test("refuse a limit that is not a positive count", () => {
    expect(() => deployment({ ip: { requests: 0, perSeconds: 60 } })).toThrow(/positive integer/);
  });
});
