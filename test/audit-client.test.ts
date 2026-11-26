/** `db.$history` and `db.$metrics`: the client side of the admin reads. */

import { describe, expect, test } from "bun:test";

import { MemoryOutbox } from "../src/client/outbox";
import { createClient } from "../src/model/client";
import { model, schema, t } from "../src/schema";

const WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";
const appSchema = schema({ note: model({ body: t.string() }) });

function client(fetch: (url: string, init: { method: string; headers: Record<string, string> }) => Promise<Response>) {
  return createClient(
    { schema: appSchema, url: "http://engine.test", workspace: WORKSPACE, getToken: async () => "token" },
    {
      outbox: new MemoryOutbox(),
      createWebSocket: () => {
        throw new Error("no socket here");
      },
      fetch,
    }
  );
}

describe("$history", () => {
  test("reads one row's history with the caller's token", async () => {
    const entries = [{ seq: 4, at: 1, sub: "alice", role: 3, action: "insert" }];
    const db = client(async (url, init) => {
      expect(url).toBe(`http://engine.test/engine/workspaces/${WORKSPACE}/history?model=note&id=n+1`);
      expect(init.method).toBe("GET");
      expect(init.headers.authorization).toBe("Bearer token");
      return Response.json({ ok: true, data: entries });
    });
    expect(await db.$history({ model: "note", id: "n 1" })).toEqual(entries);
  });

  test("a refusal surfaces the engine's code", async () => {
    const db = client(async () =>
      Response.json({ ok: false, error: { code: "audit_disabled", message: "off" } }, { status: 409 })
    );
    await expect(db.$history({ model: "note", id: "n1" })).rejects.toMatchObject({ code: "audit_disabled", status: 409 });
  });

});

describe("$metrics", () => {
  const report = {
    metrics: {
      since: 1,
      uptimeMs: 2,
      restartsCounters: true,
      counters: { "transactions.committed": 3 },
      latency: {
        estimated: true,
        bucketsMs: [1, 2],
        timers: { transaction: { count: 1, sumMs: 2, maxMs: 2, meanMs: 2, p50Ms: 2, p95Ms: 2, p99Ms: 2, buckets: [0, 1, 0] } },
      },
    },
    gauges: { sockets: 0, txLogRows: 3 },
    measurement: { counters: "measured" },
  };

  test("reads the workspace's metrics with the caller's token", async () => {
    const db = client(async (url, init) => {
      expect(url).toBe(`http://engine.test/engine/workspaces/${WORKSPACE}/metrics`);
      expect(init.method).toBe("GET");
      expect(init.headers.authorization).toBe("Bearer token");
      return Response.json({ ok: true, ...report });
    });

    const answer = await db.$metrics();
    expect(answer.metrics.counters["transactions.committed"]).toBe(3);
    expect(answer.gauges.txLogRows).toBe(3);
    // The two flags a caller must not lose: the counters' window, and that the
    // quantiles are estimates.
    expect(answer.metrics.restartsCounters).toBe(true);
    expect(answer.metrics.latency.estimated).toBe(true);
  });

  test("a refusal surfaces the engine's code", async () => {
    const db = client(async () =>
      Response.json({ ok: false, error: { code: "insufficient_role", message: "admin only" } }, { status: 403 })
    );
    await expect(db.$metrics()).rejects.toMatchObject({ code: "insufficient_role", status: 403 });
  });

  test("an answer missing its parts is an error, not an empty report", async () => {
    // A proxy or a future engine answering 200 with something else must not
    // read as a workspace doing no work at all.
    const db = client(async () => Response.json({ ok: true }));
    await expect(db.$metrics()).rejects.toMatchObject({ code: "http_error" });
  });
});
