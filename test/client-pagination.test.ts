/**
 * Client-side pagination: `pageInfo` on the query state and `db.loadMore()`.
 *
 * The engine already compiles keyset cursors (`$: { limit, order, after }`) and
 * reports the next one in `pageInfo[namespace].nextCursor`. These tests pin the
 * client half of that contract against a fake socket, using the same pattern as
 * `test/headless.test.ts`: no DOM, no React, no real WebSocket.
 */

import { describe, expect, test } from "bun:test";

import { createHeadlessClient } from "../src/index";
import { MemoryOutbox } from "../src/client/outbox";
import type { WebSocketLike } from "../src/client/socket";
import type { QueryDocument, QueryPageInfo } from "../src/client/types";

const WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";

/** A capped page: two rows, ordered by name, with an explicit limit. */
const query: QueryDocument = {
  boards: { $: { order: { name: "asc" }, limit: 2 } },
};

const firstPageInfo: QueryPageInfo = {
  boards: { limit: 2, returned: 2, hasMore: true, nextCursor: "cursor-1" },
};

class FakeSocket implements WebSocketLike {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.({});
  }

  push(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function client(socket: FakeSocket, fetchCalls: string[] = []) {
  // `init()` takes config only; the deps-taking factory is what lets a test
  // swap in a fake socket.
  return createHeadlessClient(
    {
      workspaceId: WORKSPACE,
      apiUrl: "http://localhost:8787",
      getToken: async () => "test-token",
    },
    {
      createWebSocket: () => socket,
      outbox: new MemoryOutbox(),
      fetch: async (input: RequestInfo | URL) => {
        fetchCalls.push(String(input));
        return new Response('{"ok":true,"result":{}}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }
  );
}

/** Lets the socket finish `getToken` + `createWebSocket` before opening it. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function board(id: string) {
  return { id, name: `board-${id}` };
}

function sentOfType(socket: FakeSocket, type: string) {
  return socket.sent.filter((message) => message.type === type);
}

function subscribeIds(socket: FakeSocket): string[] {
  return sentOfType(socket, "query:subscribe").map(
    (message) => message.id as string
  );
}

function lastQueryOf(socket: FakeSocket, type: string) {
  const messages = sentOfType(socket, type);
  return messages[messages.length - 1] as {
    id: string;
    query: Record<string, { $?: Record<string, unknown> }>;
  };
}

/**
 * Subscribes, opens the socket, and delivers the engine's first `query:data`.
 * This is the state `loadMore()` starts from.
 */
async function withFirstPage(pageInfo: QueryPageInfo | undefined) {
  const socket = new FakeSocket();
  const db = client(socket);
  db.subscribeQuery(query, () => {});
  await flush();

  socket.open();
  socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1 });
  await flush();

  const subscribe = lastQueryOf(socket, "query:subscribe");
  socket.push({
    type: "query:data",
    id: subscribe.id,
    seq: 1,
    data: { boards: [board("b1"), board("b2")] },
    ...(pageInfo === undefined ? {} : { pageInfo }),
  });

  return { socket, db };
}

describe("client pagination", () => {
  test("the first query:data populates pageInfo", async () => {
    const { db } = await withFirstPage(firstPageInfo);

    const state = db.getQueryState(query);
    expect(state.data?.boards?.length).toBe(2);
    expect(state.pageInfo?.boards).toEqual({
      limit: 2,
      returned: 2,
      hasMore: true,
      nextCursor: "cursor-1",
    });
    // `returned` is the engine's visible count, surfaced as sent.
    expect(state.pageInfo?.boards.returned).toBe(2);
  });

  test("loadMore sends the engine cursor as `after` and appends the page", async () => {
    const { db, socket } = await withFirstPage(firstPageInfo);
    let notifications = 0;
    db.subscribeQuery(query, () => {
      notifications += 1;
    });

    const pending = db.loadMore(query);
    await flush();

    const request = lastQueryOf(socket, "query:subscribe");
    // The cursor goes back to the engine on top of the caller's own options.
    expect(request.query).toEqual({
      boards: { $: { order: { name: "asc" }, limit: 2, after: "cursor-1" } },
    });

    socket.push({
      type: "query:data",
      id: request.id,
      seq: 2,
      data: { boards: [board("b3"), board("b4")] },
      pageInfo: { boards: { limit: 2, returned: 2, hasMore: false } },
    });

    expect(await pending).toBe(true);

    const state = db.getQueryState(query);
    expect(state.data?.boards?.map((row) => row.id)).toEqual([
      "b1",
      "b2",
      "b3",
      "b4",
    ]);
    // The page is appended and the appended metadata replaces the old cursor.
    expect(state.pageInfo?.boards.hasMore).toBe(false);
    expect(state.pageInfo?.boards.nextCursor).toBeUndefined();
    // Subscribers are notified so a React render sees the appended rows.
    expect(notifications).toBe(1);
    // The one-shot page subscription is released; it never joins the cache.
    expect(
      sentOfType(socket, "query:unsubscribe").some(
        (message) => message.id === request.id
      )
    ).toBe(true);
  });

  test("loadMore returns false and sends nothing when there is no next cursor", async () => {
    const { db, socket } = await withFirstPage({
      boards: { limit: 2, returned: 2, hasMore: false },
    });
    const before = subscribeIds(socket).length;

    expect(await db.loadMore(query)).toBe(false);
    expect(subscribeIds(socket).length).toBe(before);

    // A page that came back with a cursor, then a page without one: the second
    // loadMore is the one that stops.
    const resumed = await withFirstPage(firstPageInfo);
    const pending = resumed.db.loadMore(query);
    await flush();
    const request = lastQueryOf(resumed.socket, "query:subscribe");
    resumed.socket.push({
      type: "query:data",
      id: request.id,
      seq: 2,
      data: { boards: [board("b3"), board("b4")] },
      pageInfo: { boards: { limit: 2, returned: 2, hasMore: false } },
    });
    expect(await pending).toBe(true);
    expect(await resumed.db.loadMore(query)).toBe(false);
  });

  test("loadMore returns false before the first page arrives", async () => {
    const socket = new FakeSocket();
    const db = client(socket);

    expect(await db.loadMore(query)).toBe(false);
    expect(subscribeIds(socket).length).toBe(0);
  });

  test("calling loadMore twice with the same cursor appends once", async () => {
    const { db, socket } = await withFirstPage(firstPageInfo);

    const first = db.loadMore(query);
    const second = db.loadMore(query);
    await flush();

    // Both callers share one request, so one page can only be appended once.
    const pageRequests = sentOfType(socket, "query:subscribe").filter(
      (message) =>
        (message.query as { boards?: { $?: { after?: string } } }).boards?.$
          ?.after === "cursor-1"
    );
    expect(pageRequests.length).toBe(1);

    const request = lastQueryOf(socket, "query:subscribe");
    socket.push({
      type: "query:data",
      id: request.id,
      seq: 2,
      data: { boards: [board("b3"), board("b4")] },
      pageInfo: { boards: { limit: 2, returned: 2, hasMore: true, nextCursor: "cursor-2" } },
    });

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(db.getQueryState(query).data?.boards?.length).toBe(4);
  });

  test("a repeated page cannot duplicate entities, it only re-cursors", async () => {
    const { db, socket } = await withFirstPage(firstPageInfo);

    const pending = db.loadMore(query);
    await flush();
    const request = lastQueryOf(socket, "query:subscribe");
    // The engine repeats the boundary row b2, which dedupe has to absorb.
    socket.push({
      type: "query:data",
      id: request.id,
      seq: 2,
      data: { boards: [board("b2"), board("b3")] },
      pageInfo: { boards: { limit: 2, returned: 2, hasMore: true, nextCursor: "cursor-2" } },
    });

    expect(await pending).toBe(true);
    const state = db.getQueryState(query);
    expect(state.data?.boards?.map((row) => row.id)).toEqual(["b1", "b2", "b3"]);
    expect(state.pageInfo?.boards.nextCursor).toBe("cursor-2");
  });

  test("an engine query:error rejects the page request without appending", async () => {
    const { db, socket } = await withFirstPage(firstPageInfo);

    const pending = db.loadMore(query);
    // Attach the rejection handler before the error can be delivered.
    const settled = pending.catch((error: Error) => error);
    await flush();

    const request = lastQueryOf(socket, "query:subscribe");
    socket.push({
      type: "query:error",
      id: request.id,
      code: "invalid_query",
      message: "after cursor does not match this query's $.order",
    });

    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("after cursor");
    // A failed page leaves the cached rows untouched.
    expect(db.getQueryState(query).data?.boards?.length).toBe(2);
  });

  test("the React client exposes the same loadMore", async () => {
    const react = await import("../src/react/index");
    const db = react.createDataClient(
      {
        workspaceId: WORKSPACE,
        apiUrl: "http://localhost:8787",
        getToken: async () => "test-token",
      },
      { createWebSocket: () => new FakeSocket(), outbox: new MemoryOutbox() }
    );

    expect(typeof db.loadMore).toBe("function");
    db.close();
  });

  /** Loads page two and answers it, leaving a 4-row window. */
  async function withTwoPages() {
    const { db, socket } = await withFirstPage(firstPageInfo);
    const live = lastQueryOf(socket, "query:subscribe").id;
    const pending = db.loadMore(query);
    await flush();
    const request = lastQueryOf(socket, "query:subscribe");
    socket.push({
      type: "query:data",
      id: request.id,
      seq: 2,
      data: { boards: [board("b3"), board("b4")] },
      pageInfo: { boards: { limit: 2, returned: 2, hasMore: true, nextCursor: "cursor-2" } },
    });
    expect(await pending).toBe(true);
    return { db, socket, live };
  }

  test("loadMore widens the live subscription to every loaded row", async () => {
    const { socket, live } = await withTwoPages();

    const widened = lastQueryOf(socket, "query:subscribe");
    expect(widened.id).toBe(live);
    expect(widened.query).toEqual({ boards: { $: { order: { name: "asc" }, limit: 4 } } });
  });

  test("a reconnect restores every loaded page instead of resetting to one", async () => {
    const { db, socket, live } = await withTwoPages();

    // The socket drops and a new session starts: the client re-subscribes.
    socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1 });
    await flush();
    const resubscribe = lastQueryOf(socket, "query:subscribe");
    expect(resubscribe.id).toBe(live);
    expect(resubscribe.query.boards.$?.limit).toBe(4);

    socket.push({
      type: "query:data",
      id: live,
      seq: 3,
      data: { boards: ["b1", "b2", "b3", "b4"].map(board) },
      pageInfo: { boards: { limit: 4, returned: 4, hasMore: true, nextCursor: "cursor-2" } },
    });
    const state = db.getQueryState(query);
    expect(state.data?.boards?.map((row) => row.id)).toEqual(["b1", "b2", "b3", "b4"]);
    expect(state.pageInfo?.boards.nextCursor).toBe("cursor-2");
  });

  test("the live window is clamped to the engine's limit", async () => {
    const { db, socket } = await withFirstPage(firstPageInfo);
    const pending = db.loadMore(query);
    await flush();
    const request = lastQueryOf(socket, "query:subscribe");
    const many = Array.from({ length: 1200 }, (_, n) => board(`x${n}`));
    socket.push({
      type: "query:data",
      id: request.id,
      seq: 2,
      data: { boards: many },
      pageInfo: { boards: { limit: 2, returned: 1200, hasMore: false } },
    });
    expect(await pending).toBe(true);
    expect(lastQueryOf(socket, "query:subscribe").query.boards.$?.limit).toBe(1000);
  });
});
