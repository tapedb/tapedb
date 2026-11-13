/**
 * Retries carry a basis, so the server can refuse one it cannot dedupe.
 *
 * The first send of a write carries no `basisSeq`: nothing can have applied it
 * yet. Every later send does, with the highest sequence the client had seen
 * when the write was created. The attempt count is persisted before each send,
 * so a crash mid-send still leaves the next flush knowing it is a retry.
 */

import { describe, expect, test } from "bun:test";

import { createHeadlessClient } from "../src/index";
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
  test("the first send has no basis; the retry sends the basis from creation", async () => {
    const { db, socket, bodies, outbox } = harness(["network"]);

    // Rows the client has seen carry updatedSeq; the highest is the basis.
    db.subscribeQuery({ boards: {} }, () => {});
    await tick();
    socket.open();
    socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1 });
    await tick();
    const subscribe = socket.sent.find((message) => message.type === "query:subscribe")!;
    socket.push({
      type: "query:data",
      id: subscribe.id,
      seq: 1,
      data: { boards: [{ id: "b0", name: "a", updatedSeq: 7 }, { id: "b9", name: "b", updatedSeq: 4 }] },
    });

    await db.transact([op as never]);
    expect(bodies[0]).not.toHaveProperty("basisSeq");

    // Seeing a newer row after creation does not move this write's basis.
    socket.push({ type: "query:diff", id: subscribe.id, seq: 2, namespace: "boards", added: [{ id: "b5", name: "c", updatedSeq: 30 }], updated: [], removed: [] });

    const [queued] = await outbox.list(WORKSPACE);
    expect(queued).toMatchObject({ basisSeq: 7, attempts: 1 });

    await db.flushOutbox();
    expect(bodies[1]).toMatchObject({ clientTxId: bodies[0].clientTxId, basisSeq: 7 });
    expect(await outbox.list(WORKSPACE)).toEqual([]);
    db.close();
  });

  test("an acknowledgement raises the basis of the next write", async () => {
    const { db, bodies, outbox } = harness([
      { status: 200, body: { ok: true, result: { txId: "t", seq: 12, applied: 1 } } },
      "network",
    ]);

    await db.transact([op as never]);
    await db.transact([op as never]);
    const [queued] = await outbox.list(WORKSPACE);
    expect(queued.basisSeq).toBe(12);
    expect(bodies).toHaveLength(2);
    db.close();
  });

  test("an entry from an older client is treated as a retry from seq 0", async () => {
    const { db, bodies, outbox } = harness([]);
    const legacy: OutboxEntry = {
      clientTxId: "legacy-1",
      txId: "tx-legacy",
      workspaceId: WORKSPACE,
      ops: [op as never],
      createdAt: 1,
    };
    await outbox.add(legacy);

    await db.flushOutbox();
    expect(bodies[0]).toMatchObject({ clientTxId: "legacy-1", basisSeq: 0 });
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

  test("dedupe_expired drops the entry and tells the app", async () => {
    const { db, outbox, rejections } = harness([
      "network",
      {
        status: 409,
        body: { ok: false, error: { code: "dedupe_expired", message: "may already be applied" } },
      },
    ]);

    await db.transact([op as never]);
    await db.flushOutbox();

    expect(await outbox.list(WORKSPACE)).toEqual([]);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ code: "dedupe_expired", ops: [op] });
    db.close();
  });
});
