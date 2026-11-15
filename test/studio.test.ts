/**
 * The studio's proxy layer.
 *
 * The browser half is deliberately untested here (no DOM), so what is asserted
 * is the wire behaviour the page depends on: every `/api/*` route reaches the
 * engine with the right path and claim, a bad body is the client's fault and
 * not a crash, an expired claim is re-minted once and only once, and switching
 * workspace drops the claim instead of reusing it.
 *
 * Everything binds to port 0. A fixed port would collide with another studio
 * (or another agent's test run) on the same machine.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "node:http";

import { PAGE_LIMIT, pageQuery, startStudio } from "../src/cli/studio";

interface Recorded {
  method: string;
  path: string;
  authorization: string | null;
  body: any;
}

interface FakeUpstream {
  url: string;
  /** The workspaceId of every claim minted, in order. */
  claims: string[];
  requests: Recorded[];
  /** 401s still owed per engine route, decremented as they are served. */
  unauthorized: { schema: number; query: number; transact: number };
  close: () => void;
}

async function readJson(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length === 0 ? undefined : JSON.parse(text);
}

/** A stand-in for the Worker: a claim route and the three engine routes. */
function startFake(): Promise<FakeUpstream> {
  const claims: string[] = [];
  const requests: Recorded[] = [];
  const unauthorized = { schema: 0, query: 0, transact: 0 };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://upstream");
    const body = await readJson(request);
    requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      authorization: request.headers.authorization ?? null,
      body,
    });

    const json = (status: number, payload: unknown) => {
      const text = JSON.stringify(payload);
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(text),
      });
      response.end(text);
    };

    if (url.pathname === "/_tapedb/claim" && request.method === "POST") {
      claims.push(String(body?.workspaceId ?? ""));
      json(200, { token: `token-${claims.length}` });
      return;
    }

    const matched = /^\/engine\/workspaces\/([^/]+)\/(schema|query|transact)$/.exec(url.pathname);
    if (matched === null) {
      json(404, { error: { code: "not_found", message: `no route for ${url.pathname}` } });
      return;
    }

    const workspace = decodeURIComponent(matched[1]);
    const route = matched[2] as "schema" | "query" | "transact";

    if (unauthorized[route] > 0) {
      unauthorized[route] -= 1;
      json(401, { error: { code: "unauthorized", message: "claim expired" } });
      return;
    }

    if (route === "schema") {
      json(200, {
        ok: true,
        data: {
          namespaces: [
            { apiName: "boards", attributes: { name: { type: "string" } } },
            {
              apiName: "tasks",
              attributes: { title: { type: "string" }, done: { type: "boolean" } },
            },
          ],
        },
      });
      return;
    }

    if (route === "query") {
      const namespace = Object.keys(body?.query ?? {})[0] ?? "boards";
      const options = body?.query?.[namespace]?.$ ?? {};
      json(200, {
        ok: true,
        data: { [namespace]: [{ id: `row-${workspace}`, cursorUsed: options.after ?? null }] },
        pageInfo: {
          [namespace]: {
            limit: options.limit ?? null,
            returned: 1,
            hasMore: true,
            nextCursor: "cursor-2",
          },
        },
      });
      return;
    }

    json(200, { ok: true, result: { seq: 7 } });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        claims,
        requests,
        unauthorized,
        close: () => {
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}

interface Stack {
  upstream: FakeUpstream;
  studio: { url: string; close: () => void };
  post: (path: string, payload: unknown) => Promise<Response>;
  postText: (path: string, text: string) => Promise<Response>;
  shutdown: () => Promise<void>;
}

async function stack(workspace = ""): Promise<Stack> {
  const upstream = await startFake();
  let studio: { url: string; close: () => void };
  try {
    studio = await startStudio({ url: upstream.url, workspace, port: 0 });
  } catch (error) {
    upstream.close();
    throw error;
  }

  const postText = (path: string, text: string) =>
    fetch(`${studio.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
    });

  return {
    upstream,
    studio,
    post: (path, payload) => postText(path, JSON.stringify(payload)),
    postText,
    shutdown: async () => {
      studio.close();
      upstream.close();
      // Let the destroyed sockets settle so the next test starts clean.
      await new Promise((done) => setTimeout(done, 20));
    },
  };
}

// The first node:http server and fetch in a test process pay a one-time
// start-up cost. On the CI builder it ranged from 30 ms to 13 s (7 of 50
// runs over 250 ms, always this file's first test, whatever ran before), and
// three times it went past the 5 s test timeout. It is paid here, under its
// own limit, so the tests below measure the studio alone.
beforeAll(async () => {
  const { studio, shutdown } = await stack();
  await fetch(`${studio.url}/api/health`);
  await shutdown();
}, 60_000);

describe("studio page", () => {
  test("serves the browser page with the workspace picker and load-more control", async () => {
    const { studio, shutdown } = await stack();
    try {
      const response = await fetch(`${studio.url}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      expect(html).toContain("<title>tapedb studio</title>");
      // The two controls this slice adds, by id, so the page cannot lose them.
      expect(html).toContain('id="workspaces"');
      expect(html).toContain('id="more"');
      expect(html).toContain("tapedb-workspaces");
    } finally {
      await shutdown();
    }
  });

  test("reports the bound port for an ephemeral listen", async () => {
    const { studio, shutdown } = await stack();
    try {
      expect(new URL(studio.url).port).not.toBe("0");
      const health = await fetch(`${studio.url}/api/health`);
      expect(health.status).toBe(200);
    } finally {
      await shutdown();
    }
  });
});

describe("studio proxies", () => {
  test("/api/schema proxies with a minted claim and lists namespaces", async () => {
    const { upstream, post, shutdown } = await stack();
    try {
      const response = await post("/api/schema", { workspaceId: "ws-1" });
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data.namespaces.map((n: any) => n.apiName)).toEqual(["boards", "tasks"]);

      expect(upstream.claims).toEqual(["ws-1"]);
      const call = upstream.requests.find((entry) => entry.path.endsWith("/schema"));
      expect(call?.path).toBe("/engine/workspaces/ws-1/schema");
      expect(call?.authorization).toBe("Bearer token-1");
    } finally {
      await shutdown();
    }
  });

  test("/api/query proxies a raw query document unchanged", async () => {
    const { upstream, post, shutdown } = await stack("ws-1");
    try {
      const query = { tasks: { $: { where: { done: false }, limit: 5 } } };
      const response = await post("/api/query", { workspaceId: "ws-1", query });
      expect(response.status).toBe(200);

      const sent = upstream.requests.find((entry) => entry.path.endsWith("/query"));
      expect(sent?.body).toEqual({ query });
      const body = (await response.json()) as any;
      expect(body.pageInfo.tasks.nextCursor).toBe("cursor-2");
    } finally {
      await shutdown();
    }
  });

  test("/api/query pins the order on the first page and pages by cursor", async () => {
    const { upstream, post, shutdown } = await stack("ws-1");
    try {
      const first = await post("/api/query", { workspaceId: "ws-1", namespace: "boards" });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as any;
      const cursor = firstBody.pageInfo.boards.nextCursor;
      expect(cursor).toBe("cursor-2");

      const second = await post("/api/query", {
        workspaceId: "ws-1",
        namespace: "boards",
        cursor,
      });
      expect(second.status).toBe(200);

      const queries = upstream.requests.filter((entry) => entry.path.endsWith("/query"));
      // Same limit and same order on both pages: a cursor is only valid against
      // an unchanged total order.
      expect(queries[0]?.body.query).toEqual({
        boards: { $: { limit: PAGE_LIMIT, order: { id: "asc" } } },
      });
      expect(queries[1]?.body.query).toEqual({
        boards: { $: { limit: PAGE_LIMIT, order: { id: "asc" }, after: "cursor-2" } },
      });
    } finally {
      await shutdown();
    }
  });

  test("/api/query rejects a page request with neither query nor namespace", async () => {
    const { post, shutdown } = await stack("ws-1");
    try {
      const response = await post("/api/query", { workspaceId: "ws-1" });
      expect(response.status).toBe(400);
      const body = (await response.json()) as any;
      expect(body.error.message).toContain("namespace");
    } finally {
      await shutdown();
    }
  });

  test("/api/transact proxies the transaction body", async () => {
    const { upstream, post, shutdown } = await stack("ws-1");
    try {
      const ops = [{ op: "update", namespace: "boards", id: "board-1", values: { name: "Hi" } }];
      const response = await post("/api/transact", {
        workspaceId: "ws-1",
        body: { txId: "studio-test", ops },
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as any).result.seq).toBe(7);

      const sent = upstream.requests.find((entry) => entry.path.endsWith("/transact"));
      expect(sent?.path).toBe("/engine/workspaces/ws-1/transact");
      expect(sent?.body).toEqual({ txId: "studio-test", ops });
    } finally {
      await shutdown();
    }
  });

  test("malformed JSON is a 400, not a 500", async () => {
    const { postText, shutdown } = await stack("ws-1");
    try {
      for (const path of ["/api/schema", "/api/query", "/api/transact"]) {
        const response = await postText(path, "{ this is not json");
        expect(response.status).toBe(400);
        const body = (await response.json()) as any;
        expect(body.error.message).toBe("Request body must be JSON.");
      }
    } finally {
      await shutdown();
    }
  });
});

describe("studio claims", () => {
  test("a 401 from upstream re-mints exactly once and retries", async () => {
    const { upstream, post, shutdown } = await stack("ws-1");
    try {
      upstream.unauthorized.query = 1;

      const response = await post("/api/query", { workspaceId: "ws-1", namespace: "boards" });
      expect(response.status).toBe(200);

      // One claim for the first attempt, one for the retry, and no more.
      expect(upstream.claims).toEqual(["ws-1", "ws-1"]);
      const attempts = upstream.requests.filter((entry) => entry.path.endsWith("/query"));
      expect(attempts.length).toBe(2);
      expect(attempts[0]?.authorization).toBe("Bearer token-1");
      expect(attempts[1]?.authorization).toBe("Bearer token-2");
    } finally {
      await shutdown();
    }
  });

  test("a second 401 is passed through instead of looping", async () => {
    const { upstream, post, shutdown } = await stack("ws-1");
    try {
      upstream.unauthorized.query = 2;

      const response = await post("/api/query", { workspaceId: "ws-1", namespace: "boards" });
      expect(response.status).toBe(401);
      expect(upstream.claims.length).toBe(2);
      expect(upstream.requests.filter((entry) => entry.path.endsWith("/query")).length).toBe(2);
    } finally {
      await shutdown();
    }
  });

  test("switching workspace drops the cached claim and re-mints for the new one", async () => {
    const { upstream, post, shutdown } = await stack("ws-1");
    try {
      await post("/api/schema", { workspaceId: "ws-1" });
      expect(upstream.claims).toEqual(["ws-1"]);

      // Same workspace again: the claim is reused.
      await post("/api/schema", { workspaceId: "ws-1" });
      expect(upstream.claims).toEqual(["ws-1"]);

      // A different workspace: a claim scoped to the old one would be refused.
      await post("/api/query", { workspaceId: "ws-2", namespace: "boards" });
      expect(upstream.claims).toEqual(["ws-1", "ws-2"]);
      const call = upstream.requests.find((entry) => entry.path.includes("/ws-2/"));
      expect(call?.authorization).toBe("Bearer token-2");

      // And back again, which mints a third rather than reviving either.
      await post("/api/schema", { workspaceId: "ws-1" });
      expect(upstream.claims).toEqual(["ws-1", "ws-2", "ws-1"]);
    } finally {
      await shutdown();
    }
  });
});

describe("studio port handling", () => {
  test("a busy port rejects with a message naming that port", async () => {
    const first = await startStudio({ url: "http://127.0.0.1:1", workspace: "", port: 0 });
    const port = Number(new URL(first.url).port);
    try {
      expect(port).toBeGreaterThan(0);
      const second = startStudio({ url: "http://127.0.0.1:1", workspace: "", port });
      await expect(second).rejects.toThrow(new RegExp(`Port ${port} is already in use`));
    } finally {
      first.close();
      await new Promise((done) => setTimeout(done, 20));
    }
  });
});

describe("pageQuery", () => {
  test("pins the order and adds the cursor only on later pages", () => {
    expect(pageQuery("boards")).toEqual({
      boards: { $: { limit: PAGE_LIMIT, order: { id: "asc" } } },
    });
    expect(pageQuery("boards", "abc")).toEqual({
      boards: { $: { limit: PAGE_LIMIT, order: { id: "asc" }, after: "abc" } },
    });
    expect(pageQuery("boards", null, 10)).toEqual({
      boards: { $: { limit: 10, order: { id: "asc" } } },
    });
  });
});
