/**
 * The headless client: no React, one socket, live query state.
 *
 * This is the path a Worker, a Svelte app or a Node script uses, so it is
 * tested against a fake socket rather than a rendered component.
 */

import { describe, expect, test } from "bun:test";

import { createHeadlessClient } from "../src/client/data-client";
import { MemoryOutbox } from "../src/client/outbox";
import type { WebSocketLike } from "../src/client/socket";
import { defineSchema } from "../src/schema";

const WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";

const schema = defineSchema({
  entities: {
    boards: { name: { type: "string" } },
  },
});

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

function client(socket: FakeSocket, calls: string[] = []) {
  // `createHeadlessClient` takes deps; the package root's `init(config)` does
  // not, so passing a fake socket to `init` silently did nothing.
  return createHeadlessClient(
    {
      workspaceId: WORKSPACE,
      apiUrl: "http://localhost:8787",
      schema,
      getToken: async () => "test-token",
    },
    {
      createWebSocket: () => socket,
      outbox: new MemoryOutbox(),
      fetch: async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response('{"ok":true,"result":{}}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }
  );
}

const query = { boards: {} } as const;

describe("headless client", () => {
  test("exposes no React hook", () => {
    const db = client(new FakeSocket());
    expect("useQuery" in db).toBe(false);
    expect(typeof db.subscribeQuery).toBe("function");
    expect(typeof db.transact).toBe("function");
  });

  test("the React entry is a superset of the headless one", async () => {
    const react = await import("../src/react/index");
    const db = react.init({ workspaceId: WORKSPACE, apiUrl: "http://localhost:8787", schema });
    expect(typeof db.useQuery).toBe("function");
    expect(typeof db.subscribeQuery).toBe("function");
  });
});
