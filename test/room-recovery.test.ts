/**
 * A workspace restored from R2 in budgeted steps, through the real
 * WorkspaceRoom: it answers 503 until the restore is complete, continues on
 * alarms, and then serves every row.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS } from "../src/claims";
import { flushPending } from "../src/engine/durability/flusher";
import { snapshotWorkspace } from "../src/engine/durability/snapshot";
import { encodeTrustedRoleClaim, TRUSTED_CLAIM_HEADER } from "../src/verify";
import { model, schema, t } from "../src/schema";
import { FakeRoomContext } from "./fixtures/room-harness";
import { FakeR2Bucket } from "./fixtures/test-support";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");
const { setRecoveryBudgetsForTests } = await import("../src/engine/workspace-room");

const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";
const SECRET = "test-secret-test-secret-test-secret";

afterAll(() => setRecoveryBudgetsForTests(15_000, 20_000));

describe("a room restoring from R2", () => {
  test("answers 503 until the restore is complete, then serves everything", async () => {
    const tapedb = defineTapeDB({ schema: schema({ task: model({ title: t.string() }) }) });
    const bucket = new FakeR2Bucket();
    const env = { FILES: new FakeR2Bucket(), DATA: bucket, TAPEDB_CLAIM_SECRET: SECRET, ENVIRONMENT: "development" };
    const now = Math.floor(Date.now() / 1000);
    const claim = { sub: "u1", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.OWNER, exp: now + 600, iat: now };
    const trusted = { [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim(claim as never) } as Record<string, string>;
    const call = (room: InstanceType<typeof tapedb.WorkspaceRoom>, path: string, body?: unknown) =>
      room.fetch(
        new Request(`https://room${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { ...trusted, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      );

    // A workspace with a snapshot and several log segments in R2.
    const original = new FakeRoomContext(new Database(":memory:"), WORKSPACE);
    const first = new tapedb.WorkspaceRoom(original as never, env as never);
    await original.ready;
    for (let n = 0; n < 5; n += 1) {
      expect((await call(first, "/transact", { txId: `t${n}`, ops: [{ op: "insert", namespace: "task", id: `task-${n}`, values: { title: `Task ${n}` } }] })).status).toBe(200);
      if (n === 1) {
        await flushPending(bucket as never, original.storage.sql as never, WORKSPACE, Date.now());
        await snapshotWorkspace(bucket as never, original.storage.sql as never, WORKSPACE, Date.now());
      } else {
        await flushPending(bucket as never, original.storage.sql as never, WORKSPACE, Date.now());
      }
    }

    // A fresh object (the class was wiped) restores one chunk or segment per step.
    setRecoveryBudgetsForTests(0, 0);
    const fresh = new FakeRoomContext(new Database(":memory:"), WORKSPACE);
    const restored = new tapedb.WorkspaceRoom(fresh as never, env as never);
    await fresh.ready;

    const query = { query: { task: {} } };
    const waiting = await call(restored, "/query", query);
    expect(waiting.status).toBe(503);
    expect(waiting.headers.get("retry-after")).toBe("2");
    expect(((await waiting.json()) as { error: { code: string } }).error.code).toBe("workspace_recovering");
    expect(fresh.alarm).not.toBeNull();

    let alarms = 0;
    while ((await call(restored, "/query", query)).status === 503) {
      alarms += 1;
      expect(alarms).toBeLessThan(50);
      await restored.alarm();
    }
    expect(alarms).toBeGreaterThan(1);

    const served = (await (await call(restored, "/query", query)).json()) as { data: { task: Array<{ id: string }> } };
    expect(served.data.task.map((row) => row.id).sort()).toEqual(["task-0", "task-1", "task-2", "task-3", "task-4"]);
    const status = (await (await call(restored, "/status")).json()) as { durability: { seq: number } };
    expect(status.durability.seq).toBe(5);
  });

  test("with audit on, restores the history in steps too", async () => {
    try {
    const tapedb = defineTapeDB({ schema: schema({ task: model({ title: t.string() }) }), audit: true });
    const bucket = new FakeR2Bucket();
    const env = { FILES: new FakeR2Bucket(), DATA: bucket, TAPEDB_CLAIM_SECRET: SECRET, ENVIRONMENT: "development" };
    const now = Math.floor(Date.now() / 1000);
    const claim = { sub: "u1", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.OWNER, exp: now + 600, iat: now };
    const trusted = { [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim(claim as never) } as Record<string, string>;
    const call = (room: InstanceType<typeof tapedb.WorkspaceRoom>, path: string, body?: unknown) =>
      room.fetch(
        new Request(`https://room${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { ...trusted, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      );

    // A workspace with a snapshot and several log segments in R2.
    const original = new FakeRoomContext(new Database(":memory:"), WORKSPACE);
    const first = new tapedb.WorkspaceRoom(original as never, env as never);
    await original.ready;
    for (let n = 0; n < 5; n += 1) {
      expect((await call(first, "/transact", { txId: `t${n}`, ops: [{ op: "insert", namespace: "task", id: `task-${n}`, values: { title: `Task ${n}` } }] })).status).toBe(200);
      if (n === 1) {
        await flushPending(bucket as never, original.storage.sql as never, WORKSPACE, Date.now());
        await snapshotWorkspace(bucket as never, original.storage.sql as never, WORKSPACE, Date.now());
      } else {
        await flushPending(bucket as never, original.storage.sql as never, WORKSPACE, Date.now());
      }
    }

    // A fresh object (the class was wiped) restores one chunk or segment per step.
    setRecoveryBudgetsForTests(0, 0);
    const fresh = new FakeRoomContext(new Database(":memory:"), WORKSPACE);
    const restored = new tapedb.WorkspaceRoom(fresh as never, env as never);
    await fresh.ready;

    const query = { query: { task: {} } };
    const waiting = await call(restored, "/query", query);
    expect(waiting.status).toBe(503);
    expect(waiting.headers.get("retry-after")).toBe("2");
    expect(((await waiting.json()) as { error: { code: string } }).error.code).toBe("workspace_recovering");
    expect(fresh.alarm).not.toBeNull();

    let alarms = 0;
    while ((await call(restored, "/query", query)).status === 503) {
      alarms += 1;
      expect(alarms).toBeLessThan(50);
      await restored.alarm();
    }
    expect(alarms).toBeGreaterThan(1);

    const served = (await (await call(restored, "/query", query)).json()) as { data: { task: Array<{ id: string }> } };
    expect(served.data.task.map((row) => row.id).sort()).toEqual(["task-0", "task-1", "task-2", "task-3", "task-4"]);
    const status = (await (await call(restored, "/status")).json()) as { durability: { seq: number } };
    expect(status.durability.seq).toBe(5);
    const history = (await (await call(restored, "/history?model=task&id=task-3")).json()) as { data: Array<{ sub: string; action: string }> };
    expect(history.data).toEqual([expect.objectContaining({ sub: "u1", action: "insert" })]);
    } finally {
      defineTapeDB({ schema: schema({ task: model({ title: t.string() }) }) });
    }
  });


  test("a recovery that fails at boot answers 503 and retries on alarms, never an exception", async () => {
    const tapedb = defineTapeDB({ schema: schema({ task: model({ title: t.string() }) }) });
    const bucket = new FakeR2Bucket();
    const env = { FILES: new FakeR2Bucket(), DATA: bucket, TAPEDB_CLAIM_SECRET: SECRET, ENVIRONMENT: "development" };
    const now = Math.floor(Date.now() / 1000);
    const claim = { sub: "u1", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.OWNER, exp: now + 600, iat: now };
    const headers = { [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim(claim as never), "content-type": "application/json" } as Record<string, string>;
    const original = new FakeRoomContext(new Database(":memory:"), WORKSPACE);
    const first = new tapedb.WorkspaceRoom(original as never, env as never);
    await original.ready;
    await first.fetch(new Request("https://room/transact", { method: "POST", headers, body: JSON.stringify({ txId: "t", ops: [{ op: "insert", namespace: "task", id: "task-0", values: { title: "T" } }] }) }));
    await flushPending(bucket as never, original.storage.sql as never, WORKSPACE, Date.now());
    await snapshotWorkspace(bucket as never, original.storage.sql as never, WORKSPACE, Date.now());

    // R2 fails the restore's first reads after the wipe.
    const get = bucket.get.bind(bucket);
    let failures = 3;
    bucket.get = (async (...args: Parameters<typeof get>) => {
      if (failures > 0 && !String(args[0]).startsWith("moves/")) {
        failures -= 1;
        throw new Error("R2 get failed.");
      }
      return get(...args);
    }) as typeof bucket.get;
    const fresh = new FakeRoomContext(new Database(":memory:"), WORKSPACE);
    const restored = new tapedb.WorkspaceRoom(fresh as never, env as never);
    await fresh.ready;
    const query = () => restored.fetch(new Request("https://room/query", { method: "POST", headers, body: JSON.stringify({ query: { task: {} } }) }));
    expect((await query()).status).toBe(503);
    expect(fresh.alarm).not.toBeNull();
    for (let n = 0; (await query()).status === 503; n += 1) {
      expect(n).toBeLessThan(10);
      await restored.alarm();
    }
    const served = (await (await query()).json()) as { data: { task: Array<{ id: string }> } };
    expect(served.data.task.map((row) => row.id)).toEqual(["task-0"]);
  });

  test("a restore under way continues on alarms, not in a later boot", async () => {
    const tapedb = defineTapeDB({ schema: schema({ task: model({ title: t.string() }) }) });
    const bucket = new FakeR2Bucket();
    const env = { FILES: new FakeR2Bucket(), DATA: bucket, TAPEDB_CLAIM_SECRET: SECRET, ENVIRONMENT: "development" };
    const now = Math.floor(Date.now() / 1000);
    const claim = { sub: "u1", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.OWNER, exp: now + 600, iat: now };
    const headers = { [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim(claim as never), "content-type": "application/json" } as Record<string, string>;
    const original = new FakeRoomContext(new Database(":memory:"), WORKSPACE);
    const first = new tapedb.WorkspaceRoom(original as never, env as never);
    await original.ready;
    for (let n = 0; n < 4; n += 1) {
      await first.fetch(new Request("https://room/transact", { method: "POST", headers, body: JSON.stringify({ txId: `t${n}`, ops: [{ op: "insert", namespace: "task", id: `task-${n}`, values: { title: "T" } }] }) }));
      await flushPending(bucket as never, original.storage.sql as never, WORKSPACE, Date.now());
      if (n === 0) await snapshotWorkspace(bucket as never, original.storage.sql as never, WORKSPACE, Date.now());
    }

    // A boot that gets one unit done, then a reset.
    setRecoveryBudgetsForTests(0, 0);
    const db = new Database(":memory:");
    const one = new FakeRoomContext(db, WORKSPACE);
    new tapedb.WorkspaceRoom(one as never, env as never);
    await one.ready;
    expect(db.query(`SELECT value FROM "_engine_meta" WHERE "key" = 'recovery_status'`).get()).toEqual({ value: "running" });

    // The next boot has budget to spare, and still leaves the work to alarms.
    setRecoveryBudgetsForTests(60_000, 60_000);
    const again = new FakeRoomContext(db, WORKSPACE);
    const room = new tapedb.WorkspaceRoom(again as never, env as never);
    await again.ready;
    const query = () => room.fetch(new Request("https://room/query", { method: "POST", headers, body: JSON.stringify({ query: { task: {} } }) }));
    expect((await query()).status).toBe(503);
    expect(again.alarm).not.toBeNull();
    await room.alarm();
    const served = (await (await query()).json()) as { data: { task: Array<{ id: string }> } };
    expect(served.data.task.map((row) => row.id).sort()).toEqual(["task-0", "task-1", "task-2", "task-3"]);
  });
});
