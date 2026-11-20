/**
 * The React hooks, in a real renderer.
 *
 * These are thin wrappers, and that is the point: the failure modes are
 * render loops, stale subscriptions when arguments change, and effects that
 * never clean up. None of those show in a unit test that calls the hook
 * directly, so this renders components against a fake socket and drives them
 * the way an app would.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

import { MemoryOutbox } from "../src/client/outbox";
import type { WebSocketLike } from "../src/client/socket";
import { createClient } from "../src/model/client";
import { useBroadcast, useLive, useLivePage, usePresence } from "../src/react/index";
import { model, schema, t } from "../src/schema";

// A DOM only while this file runs: registering it for the whole process
// replaces globals (WebSocket among them) that the engine's tests rely on.
let act: (scope: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let createRoot: typeof import("react-dom/client").createRoot;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const react = await import("react");
  const client = await import("react-dom/client");
  act = react.act as typeof act;
  createElement = react.createElement;
  createRoot = client.createRoot;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";
const appSchema = schema({ task: model({ title: t.string(), done: t.boolean().default(false) }) });

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
  push(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  subscribes(): Array<Record<string, unknown>> {
    return this.sent.filter((message) => message.type === "query:subscribe");
  }
}

function harness() {
  const socket = new FakeSocket();
  const db = createClient(
    { schema: appSchema, url: "http://engine.test", workspace: WORKSPACE, getToken: async () => "token" },
    {
      createWebSocket: () => socket,
      outbox: new MemoryOutbox(),
      fetch: async () => Response.json({ ok: true, result: { seq: 1, applied: 1 } }),
    }
  );
  return { db, socket };
}

const roots: Root[] = [];
function render(view: () => ReactNode): { rerender: (next?: () => ReactNode) => void; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  let current = view;
  // One component identity for the life of the root: a new inline component
  // per render would remount the tree, which hides every subscription bug.
  const Component = () => current() as never;
  const draw = () => act(() => root.render(createElement(Component)));
  draw();
  return {
    rerender: (next) => {
      if (next) current = next;
      draw();
    },
    unmount: () => act(() => root.unmount()),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Opens the socket and answers the latest subscription with `rows`. */
async function ready(socket: FakeSocket, rows: unknown[], pageInfo?: unknown) {
  // The client fetches a token before it opens the socket.
  await act(async () => {
    await tick();
    socket.onopen?.({});
    socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1 });
  });
  const subscribe = socket.subscribes().at(-1)!;
  await act(async () => {
    socket.push({
      type: "query:data",
      id: subscribe.id,
      seq: 1,
      data: { task: rows },
      ...(pageInfo === undefined ? {} : { pageInfo }),
    });
  });
  return subscribe;
}

describe("useLive", () => {
  test("renders loading, then rows, then live updates, without looping", async () => {
    const { db, socket } = harness();
    const seen: Array<{ titles: string[] | undefined; isLoading: boolean }> = [];

    render(() => {
      const state = useLive(db.task.findMany({ orderBy: { title: "asc" } }));
      seen.push({ titles: state.data?.map((row) => row.title), isLoading: state.isLoading });
      return null;
    });

    const subscribe = await ready(socket, [{ id: "a", title: "A" }]);
    await act(async () => {
      socket.push({
        type: "query:diff",
        id: subscribe.id,
        seq: 2,
        namespace: "task",
        added: [{ id: "b", title: "B" }],
        updated: [],
        removed: [],
      });
    });

    expect(seen.at(0)).toEqual({ titles: undefined, isLoading: true });
    expect(seen.at(-1)).toEqual({ titles: ["A", "B"], isLoading: false });
    // A new query object every render must not resubscribe or re-render
    // forever: one subscription, and a render per actual change.
    expect(socket.subscribes()).toHaveLength(1);
    expect(seen.length).toBeLessThanOrEqual(4);
  });

  test("changing the arguments resubscribes; equal arguments do not", async () => {
    const { db, socket } = harness();
    let done = false;
    const view = () => {
      useLive(db.task.findMany({ where: { done } }));
      return null;
    };

    const { rerender } = render(view);
    await ready(socket, []);
    // Counted from here: the client also re-subscribes on session:ready, and
    // that is the socket's business, not the hook's.
    const baseline = socket.subscribes().length;

    rerender();
    expect(socket.subscribes().length).toBe(baseline);

    done = true;
    rerender();
    expect(socket.subscribes().length).toBe(baseline + 1);
    expect(socket.subscribes().at(-1)!.query).toEqual({ task: { $: { where: { done: true } } } });
  });

  test("unmounting releases the subscription", async () => {
    const { db, socket } = harness();
    const { unmount } = render(() => {
      useLive(db.task.findMany());
      return null;
    });
    await ready(socket, []);

    unmount();
    expect(socket.sent.filter((message) => message.type === "query:unsubscribe")).toHaveLength(1);
  });
});

describe("useLivePage", () => {
  test("exposes rows, hasMore and a stable loadMore that appends", async () => {
    const { db, socket } = harness();
    const seen: Array<{ rows: string[]; hasMore: boolean }> = [];
    const loadMores = new Set<unknown>();

    render(() => {
      const page = useLivePage(db.task.findPage({ orderBy: { title: "asc" }, take: 1 }));
      seen.push({ rows: page.rows.map((row) => row.title), hasMore: page.hasMore });
      loadMores.add(page.loadMore);
      return null;
    });

    await ready(socket, [{ id: "a", title: "A" }], {
      task: { limit: 1, returned: 1, hasMore: true, nextCursor: "cursor-1" },
    });
    expect(seen.at(-1)).toEqual({ rows: ["A"], hasMore: true });

    const before = socket.subscribes().length;
    let pending: Promise<boolean>;
    await act(async () => {
      pending = (seen.length, [...loadMores].at(-1) as () => Promise<boolean>)();
    });
    const request = socket.subscribes().at(-1)!;
    expect(socket.subscribes().length).toBe(before + 1);
    expect((request.query as { task: { $: { after?: string } } }).task.$.after).toBe("cursor-1");

    await act(async () => {
      socket.push({
        type: "query:data",
        id: request.id,
        seq: 2,
        data: { task: [{ id: "b", title: "B" }] },
        pageInfo: { task: { limit: 1, returned: 1, hasMore: false } },
      });
      await pending;
    });

    expect(seen.at(-1)).toEqual({ rows: ["A", "B"], hasMore: false });
    // One identity across renders, so it is safe in a dependency array.
    expect(loadMores.size).toBe(1);
  });
});

describe("usePresence", () => {
  test("publishes on mount and on change, and leaves on unmount", async () => {
    const { db, socket } = harness();
    let name = "alice";
    const { rerender, unmount } = render(() => {
      usePresence(db, "board:1", { name });
      return null;
    });
    await act(async () => {
      await tick();
      socket.onopen?.({});
      socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1 });
    });

    const presenceSets = () => socket.sent.filter((message) => message.type === "presence:set");
    // Counted from here: the client republishes presence on session:ready too.
    const baseline = presenceSets().length;
    expect(baseline).toBeGreaterThan(0);

    // Same value, new object every render: no republish.
    rerender();
    expect(presenceSets().length).toBe(baseline);

    name = "bob";
    rerender();
    expect(presenceSets().length).toBe(baseline + 1);
    expect(presenceSets().at(-1)).toMatchObject({ target: "board:1", presence: { name: "bob" } });

    unmount();
    expect(socket.sent.filter((message) => message.type === "presence:clear")).toHaveLength(1);
  });

  test("renders the peers the engine sends", async () => {
    const { db, socket } = harness();
    let peers: unknown[] = [];
    render(() => {
      peers = usePresence(db, "board:1");
      return null;
    });

    await act(async () => {
      await tick();
      socket.onopen?.({});
      socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1 });
      socket.push({
        type: "presence:update",
        target: "board:1",
        peers: [{ clientId: "c1", presence: { name: "carol" } }],
      });
    });

    expect(peers).toEqual([{ clientId: "c1", presence: { name: "carol" } }]);
  });
});

describe("useBroadcast", () => {
  test("listens while mounted with the latest handler, and leaves on unmount", async () => {
    const { db, socket } = harness();
    const heard: string[] = [];
    let prefix = "a";
    let send: (message: string) => boolean = () => false;
    const { rerender, unmount } = render(() => {
      send = useBroadcast<string>(db, "board:1", (message) => heard.push(`${prefix}:${message}`));
      return null;
    });
    await act(async () => {
      await tick();
      socket.onopen?.({});
      socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1 });
    });
    const message = (text: string) =>
      socket.push({ type: "topic:message", topic: "board:1", message: text, from: { clientId: "c2", sub: "bob" } });

    message("one");
    // A new handler every render: no rejoin, and the newest one runs.
    prefix = "b";
    rerender();
    message("two");
    expect(heard).toEqual(["a:one", "b:two"]);
    expect(socket.sent.filter((sent) => sent.type === "topic:join")).toHaveLength(1);

    expect(send("hi")).toBe(true);
    expect(socket.sent.at(-1)).toEqual({ type: "topic:send", topic: "board:1", message: "hi", origin: expect.any(String) });

    unmount();
    expect(socket.sent.at(-1)).toEqual({ type: "topic:leave", topic: "board:1" });
  });
});

describe("usePresence agrees with the client on includeSelf", () => {
  // The hook used to invert the client's default: `peers()` included the
  // caller while the hook dropped it. One default, asserted from both sides.
  const roomPeers = [
    { clientId: "self-1", presence: { name: "Me" } },
    { clientId: "other-2", presence: { name: "You" } },
  ];

  async function joined(options?: { includeSelf?: boolean }) {
    const { db, socket } = harness();
    const seen: { clientId: string; isSelf?: boolean }[][] = [];
    render(() => {
      seen.push(usePresence(db, "board:1", { name: "Me" }, options));
      return null;
    });
    await act(async () => {
      await tick();
      socket.onopen?.({});
      socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1, clientId: "self-1" });
    });
    await act(async () => {
      socket.push({ type: "presence:update", target: "board:1", peers: roomPeers });
      await tick();
    });
    return { db, seen };
  }

  test("the hook returns exactly what peers() returns, self included and marked", async () => {
    const { db, seen } = await joined();
    const fromClient = await db.$presence("board:1").peers();
    expect(db.clientId).toBe("self-1");
    expect(seen.at(-1)).toEqual(fromClient);
    expect(fromClient.map((peer) => peer.isSelf)).toEqual([true, undefined]);
  });

  test("includeSelf: false removes the caller from both views", async () => {
    const { db, seen } = await joined({ includeSelf: false });
    expect(seen.at(-1)?.map((peer) => peer.clientId)).toEqual(["other-2"]);
    expect((await db.$presence("board:1").peers({ includeSelf: false })).map((peer) => peer.clientId)).toEqual(["other-2"]);
  });
});
