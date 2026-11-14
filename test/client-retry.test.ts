/**
 * A retry is the same request again: same clientTxId, same ops. The engine
 * keeps every receipt for good, so it answers a retry of an applied write
 * with the original sequence instead of applying it twice (see
 * `durability/recovery.test.ts` and the soak). The attempt count is
 * persisted before each send.
 */

import { describe, expect, test } from "bun:test";

import { createHeadlessClient } from "../src/client/data-client";
import { MemoryOutbox } from "../src/client/outbox";
import type { WebSocketLike } from "../src/client/socket";
import type { OutboxEntry, WriteRejection } from "../src/client/types";

const WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";

class FakeSocket implements WebSocketLike {
  sent: Array<Record<string, unknown>> = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {}
  open(): void {
    this.onopen?.({});
  }
  push(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

type Reply = { status: number; body: unknown } | "network";

function harness(replies: Reply[]) {
  const socket = new FakeSocket();
  const outbox = new MemoryOutbox();
  const bodies: Array<Record<string, unknown>> = [];
  const rejections: WriteRejection[] = [];
  const db = createHeadlessClient(
    {
      workspaceId: WORKSPACE,
      apiUrl: "http://localhost:8787",
      getToken: async () => "test-token",
      onWriteRejected: (rejection) => rejections.push(rejection),
    },
    {
      createWebSocket: () => socket,
      outbox,
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const reply = replies.shift() ?? { status: 200, body: { ok: true, result: { seq: 0 } } };
        if (reply === "network") throw new TypeError("network down");
        return new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { "content-type": "application/json" },
        });
      },
    }
  );
  return { db, socket, outbox, bodies, rejections };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const op = { op: "update", namespace: "boards", id: "b1", values: { name: "x" } } as const;

describe("write retries", () => {
  test("a retry resends the same clientTxId and ops, and nothing else", async () => {
    const { db, bodies, outbox } = harness(["network"]);
    await db.transact([op as never]);
    const [queued] = await outbox.list(WORKSPACE);
    expect(queued).toMatchObject({ attempts: 1 });

    await db.flushOutbox();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({ txId: bodies[0].txId, clientTxId: bodies[0].clientTxId, ops: bodies[0].ops });
    expect(bodies[1]).not.toHaveProperty("basisSeq");
    expect(await outbox.list(WORKSPACE)).toEqual([]);
    db.close();
  });

  test("the attempt is persisted before the send, so a crash still counts", async () => {
    const { db, outbox } = harness(["network", "network"]);
    await db.transact([op as never]);
    await db.flushOutbox();
    const [queued] = await outbox.list(WORKSPACE);
    expect(queued.attempts).toBe(2);
    db.close();
  });

  test("a permanent refusal drops the entry and tells the app", async () => {
    const { db, outbox, rejections } = harness([
      "network",
      {
        status: 409,
        body: { ok: false, error: { code: "conflict", message: "already used with different ops" } },
      },
    ]);

    await db.transact([op as never]);
    await db.flushOutbox();

    expect(await outbox.list(WORKSPACE)).toEqual([]);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ code: "conflict", ops: [op] });
    db.close();
  });
});
