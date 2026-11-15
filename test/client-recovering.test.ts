/** A workspace restoring from R2 answers 503 `workspace_recovering`: the client waits it out. */

import { describe, expect, test } from "bun:test";

import { MemoryOutbox } from "../src/client/outbox";
import { retryWhileRecovering } from "../src/client/recovering";
import { createStorageClient } from "../src/client/storage-client";
import { createClient } from "../src/model/client";
import { model, schema, t } from "../src/schema";

const WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";
const appSchema = schema({ note: model({ body: t.string() }) });

const recovering = (retryAfter: string | null = "2") =>
  Response.json(
    { ok: false, error: { code: "workspace_recovering", message: "restoring" } },
    { status: 503, headers: retryAfter === null ? {} : { "retry-after": retryAfter } }
  );

function clock() {
  let time = 0;
  const slept: number[] = [];
  return {
    slept,
    options: {
      now: () => time,
      sleep: async (ms: number) => {
        slept.push(ms);
        time += ms;
      },
    },
  };
}

function client(fetch: (url: string, init: { method: string; body?: string }) => Promise<Response>, retry: ReturnType<typeof clock>["options"]) {
  return createClient(
    { schema: appSchema, url: "http://engine.test", workspace: WORKSPACE, getToken: async () => "token" },
    {
      fetch: fetch as never,
      outbox: new MemoryOutbox(),
      createWebSocket: () => {
        throw new Error("no socket here");
      },
      recoveringRetry: retry,
    }
  );
}

describe("a request during a restore", () => {
  test("a read waits, as Retry-After says, and gets its answer", async () => {
    const time = clock();
    let calls = 0;
    const db = client(async (url) => {
      expect(url).toEndWith("/query");
      calls += 1;
      return calls <= 2 ? recovering() : Response.json({ ok: true, data: { note: [{ id: "n1", body: "x" }] } });
    }, time.options);
    expect((await db.note.findMany()).map((row) => row.body)).toEqual(["x"]);
    expect(calls).toBe(3);
    expect(time.slept).toEqual([2000, 2000]);
  });

  test("gives up after the wait and surfaces the 503", async () => {
    const time = clock();
    const db = client(async () => recovering("5"), { ...time.options });
    await expect(Promise.resolve(db.note.findMany())).rejects.toMatchObject({ code: "workspace_recovering" });
    // 60 s of waiting, in pauses of at most 5 s.
    expect(time.slept.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(60_000);
    expect(time.slept.length).toBeGreaterThan(10);
  });

  test("other 503s are not retried", async () => {
    const time = clock();
    let calls = 0;
    const db = client(async () => {
      calls += 1;
      return Response.json({ ok: false, error: { code: "move_incomplete", message: "no" } }, { status: 503 });
    }, time.options);
    await expect(Promise.resolve(db.note.findMany())).rejects.toMatchObject({ code: "move_incomplete" });
    expect(calls).toBe(1);
  });

  test("a write waits too, and is not reported rejected", async () => {
    const time = clock();
    let calls = 0;
    const rejected: unknown[] = [];
    const db = createClient(
      {
        schema: appSchema,
        url: "http://engine.test",
        workspace: WORKSPACE,
        getToken: async () => "token",
        onWriteRejected: (event) => rejected.push(event),
      },
      {
        fetch: (async (url: string) => {
          if (!url.endsWith("/transact")) return Response.json({ ok: true, data: { note: [] } });
          calls += 1;
          return calls === 1 ? recovering("1") : Response.json({ ok: true, result: { seq: 1 } });
        }) as never,
        outbox: new MemoryOutbox(),
        createWebSocket: () => {
          throw new Error("no socket here");
        },
        recoveringRetry: time.options,
      }
    );
    await db.note.create({ data: { body: "x" } });
    expect(calls).toBe(2);
    expect(time.slept).toEqual([1000]);
    expect(rejected).toEqual([]);
  });

  test("file requests wait too; a streamed body is sent once", async () => {
    const time = clock();
    let calls = 0;
    const storage = createStorageClient({
      apiUrl: "http://engine.test",
      workspaceId: WORKSPACE,
      getToken: async () => "token",
      fetch: async () => {
        calls += 1;
        return calls === 1 ? recovering(null) : new Response("bytes");
      },
      recoveringRetry: time.options,
    });
    expect(await (await storage.download("a.txt")).text()).toBe("bytes");
    expect(time.slept).toEqual([1000]);

    let streamed = 0;
    const once = retryWhileRecovering(async () => {
      streamed += 1;
      return recovering();
    }, time.options);
    const response = await once("http://engine.test/x", { body: new ReadableStream() });
    expect(response.status).toBe(503);
    expect(streamed).toBe(1);
  });
});
