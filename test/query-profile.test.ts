/**
 * `GET /queries`: the read statements that cost a workspace the most, each
 * explained by SQLite's planner.
 *
 * The profiler and the plan reader on their own, then the real room over
 * in-memory SQLite: an indexed filter searches an index, an unindexed one
 * scans and names the column to index, nothing a caller filtered on is kept,
 * and only an admin or owner may read it.
 */

import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { MAX_STATEMENTS, QueryProfiler, readPlan } from "../src/engine/query-profile";
import { model, schema, t } from "../src/schema";
import { encodeTrustedRoleClaim, TRUSTED_CLAIM_HEADER } from "../src/verify";
import { FakeRoomContext } from "./fixtures/room-harness";
import { FakeR2Bucket } from "./fixtures/test-support";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");

const SECRET = "query-profile-test-secret-1234567890";
const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5d01";
const { MEMBER, EDITOR, ADMIN, OWNER } = WORKSPACE_ROLE_LEVELS;

describe("QueryProfiler", () => {
  test("aggregates by statement text and source", () => {
    const profiler = new QueryProfiler(() => 1);
    profiler.record("query", "SELECT 1 WHERE x = ?", 1, 2, 1, 10);
    profiler.record("live", "SELECT 1 WHERE x = ?", 1, 4, 3, 30);
    profiler.record("query", "SELECT 2", 0, 1, 1, 1);
    const [first, second] = profiler.top("rowsRead", 10);
    expect(first).toMatchObject({ sql: "SELECT 1 WHERE x = ?", sources: ["live", "query"], count: 2, rowsReturned: 4, rowsRead: 40, totalMs: 6, maxMs: 4 });
    expect(second.sql).toBe("SELECT 2");
  });

  test("stays bounded, giving up the cheapest statement", () => {
    const profiler = new QueryProfiler();
    profiler.record("query", "SELECT expensive", 0, 0, 1, 1_000_000);
    for (let n = 0; n < MAX_STATEMENTS * 2; n += 1) profiler.record("query", `SELECT ${n}`, 0, 0, 1, 1);
    expect(profiler.size).toBe(MAX_STATEMENTS);
    expect(profiler.top("rowsRead", 1)[0].sql).toBe("SELECT expensive");
  });

  test("ranks by rows returned where the runtime does not count rows read", () => {
    const profiler = new QueryProfiler();
    profiler.record("query", "SELECT a", 0, 0, 5, null);
    profiler.record("query", "SELECT b", 0, 0, 50, null);
    expect(profiler.top("rowsRead", 2).map((entry) => entry.sql)).toEqual(["SELECT b", "SELECT a"]);
    expect(profiler.top("rowsRead", 1)[0].rowsRead).toBeNull();
  });
});

describe("readPlan", () => {
  const tables = new Map([["task", "task"], ["column", "column"]]);

  test("a scan without an index is a full scan, with the compared columns as candidates", () => {
    const sql = `SELECT "id" FROM "task" WHERE (("title" = ?) AND ("done" = ?)) LIMIT ?`;
    const reading = readPlan([{ id: 2, parent: 0, detail: "SCAN task" }], sql, tables);
    expect(reading.fullScans).toEqual(["task"]);
    expect(reading.indexCandidates).toEqual([{ table: "task", columns: ["done", "title"] }]);
  });

  test("a search through an index is not a scan, and names the index", () => {
    const sql = `SELECT "id" FROM "column" AS "__r0" WHERE (("__r0"."position" < ?))`;
    const reading = readPlan([{ id: 3, parent: 0, detail: "SEARCH __r0 USING INDEX column_position_idx (position<?)" }], sql, tables);
    expect(reading.fullScans).toEqual([]);
    expect(reading.indexes).toEqual(["column_position_idx"]);
  });

  test("an aliased scan maps back to its table; engine tables are left out", () => {
    const sql = `SELECT "__r1"."id" FROM "column" AS "__r1" JOIN "_scratch" AS "s" ON 1 WHERE ("__r1"."name" = ?)`;
    const reading = readPlan([
      { id: 2, parent: 0, detail: "SCAN __r1" },
      { id: 3, parent: 0, detail: "SCAN s" },
    ], sql, tables);
    expect(reading.fullScans).toEqual(["column"]);
    expect(reading.indexCandidates).toEqual([{ table: "column", columns: ["name"] }]);
  });
});

const models = schema({
  item: model({ sku: t.string().index(), label: t.string(), secret: t.string().optional() }),
});
const app = defineTapeDB({ schema: models });

function harness() {
  const context = new FakeRoomContext(new Database(":memory:"), WORKSPACE);
  const env = { DATA: new FakeR2Bucket(), FILES: new FakeR2Bucket(), TAPEDB_CLAIM_SECRET: SECRET } as never;
  const room = new app.WorkspaceRoom(context as never, env);
  const claim = (level: number): RoleClaim => ({ sub: "user-1", workspaceId: WORKSPACE, role: level as RoleClaim["role"], iat: 0, exp: Math.floor(Date.now() / 1000) + 60 });
  const call = async (path: string, level: number, init: RequestInit = {}) => {
    await context.ready;
    return room.fetch(new Request(`https://room.internal${path}`, {
      ...init,
      headers: { "content-type": "application/json", [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim(claim(level)) },
    }));
  };
  const query = (document: unknown) => call("/query", MEMBER, { method: "POST", body: JSON.stringify({ query: document }) });
  return { call, query };
}

type Profile = {
  data: {
    recorded: number;
    statements: Array<{ sql: string; sources: string[]; count: number; rowsReturned: number; fullScans: string[]; indexes: string[]; indexCandidates: Array<{ table: string; columns: string[] }>; plan: unknown[] | null }>;
  };
};

describe("GET /queries on the room", () => {
  test("is for admins and owners only", async () => {
    const h = harness();
    for (const level of [MEMBER, EDITOR]) expect((await h.call("/queries", level)).status).toBe(403);
    for (const level of [ADMIN, OWNER]) expect((await h.call("/queries", level)).status).toBe(200);
    expect((await h.call("/queries", ADMIN, { method: "POST", body: "{}" })).status).toBe(405);
    expect((await h.call("/queries?sort=nope", ADMIN)).status).toBe(400);
    expect((await h.call("/queries?limit=0", ADMIN)).status).toBe(400);
  });

  test("an indexed filter uses its index; an unindexed one is a full scan that names the column", async () => {
    const h = harness();
    const ops = Array.from({ length: 30 }, (_, n) => ({ op: "insert", namespace: "item", id: `i${n}`, values: { sku: `sku-${n}`, label: `label-${n}`, secret: `s3cr3t-${n}` } }));
    expect((await h.call("/transact", EDITOR, { method: "POST", body: JSON.stringify({ txId: "seed", ops }) })).status).toBe(200);
    for (let n = 0; n < 3; n += 1) {
      expect((await h.query({ item: { $: { where: { sku: `sku-${n}` } } } })).status).toBe(200);
      expect((await h.query({ item: { $: { where: { label: `label-${n}` } } } })).status).toBe(200);
    }

    const profile = (await (await h.call("/queries?sort=count", ADMIN)).json()) as Profile;
    const bySku = profile.data.statements.find((s) => /"sku" = \?/.test(s.sql));
    const byLabel = profile.data.statements.find((s) => /"label" = \?/.test(s.sql));
    expect(bySku).toMatchObject({ sources: ["query"], count: 3, rowsReturned: 3, fullScans: [] });
    expect(bySku!.indexes.length).toBeGreaterThan(0);
    expect(byLabel).toMatchObject({ count: 3, fullScans: ["item"] });
    expect(byLabel!.indexCandidates).toEqual([{ table: "item", columns: ["label"] }]);
  });

  test("keeps no value anyone filtered on or stored", async () => {
    const h = harness();
    await h.call("/transact", EDITOR, { method: "POST", body: JSON.stringify({ txId: "t", ops: [{ op: "insert", namespace: "item", id: "a", values: { sku: "sku-a", label: "l", secret: "hunter2-secret" } }] }) });
    await h.query({ item: { $: { where: { label: "needle-value-42" } } } });
    const text = await (await h.call("/queries", ADMIN)).text();
    expect(text).not.toContain("needle-value-42");
    expect(text).not.toContain("hunter2-secret");
    expect(text).not.toContain("user-1");
  });

  test("DELETE clears the profile", async () => {
    const h = harness();
    await h.query({ item: {} });
    expect(((await (await h.call("/queries", ADMIN)).json()) as Profile).data.recorded).toBeGreaterThan(0);
    expect((await h.call("/queries", ADMIN, { method: "DELETE" })).status).toBe(200);
    expect(((await (await h.call("/queries", ADMIN)).json()) as Profile).data.recorded).toBe(0);
  });
});
