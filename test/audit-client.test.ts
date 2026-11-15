/** `db.$history`: the client side of the per-row audit. */

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
