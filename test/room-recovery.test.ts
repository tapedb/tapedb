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
});
