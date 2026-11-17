/**
 * `tapedb studio`: a local table browser.
 *
 * A devtool that needs no build and no dependencies: it serves one HTML page
 * and proxies to the running Worker, minting a dev claim the same way the
 * client does. Nothing here ships to production, and it only talks to the
 * Worker you point it at.
 *
 * Two things make it usable against a real workspace: it remembers every
 * workspace you have opened (in the browser, never on disk) and it pages
 * through a namespace one cursor at a time instead of stopping at the first
 * fifty rows.
 */

import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { studioPage } from "./studio-page";
import { applyEdit, previewEdit, readStructure } from "./studio-structure";
import type { SchemaEdit } from "./schema-edit";

export interface StudioOptions {
  /** Base URL of the running Worker, e.g. http://localhost:8787 */
  url: string;
  /** Workspace to open; prompted for in the page when empty. */
  workspace: string;
  /** Port to bind. `0` asks the OS for an ephemeral port. */
  port: number;
  /** The project folder, for editing its schema. Without it the structure is read-only. */
  project?: string;
}

interface StudioState {
  token: string | null;
  workspace: string;
}

/** A client mistake, reported as 400 rather than as a server error. */
class BadRequest extends Error {}

/** Rows per page. Small enough to page quickly, large enough to be useful. */
export const PAGE_LIMIT = 50;

function parseJsonBody<T>(body: string): T {
  try {
    return JSON.parse(body || "{}") as T;
  } catch {
    throw new BadRequest("Request body must be JSON.");
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

/**
 * Passes an upstream response through with its status intact.
 *
 * The engine answers JSON, but a misrouted request can come back as HTML or as
 * an empty body. Parsing unconditionally would turn that into a 500 here and
 * hide the real status, so a non-JSON body is forwarded verbatim.
 */
async function forward(response: ServerResponse, upstream: Response): Promise<void> {
  const text = await upstream.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(text),
    });
    response.end(text);
    return;
  }
  sendJson(response, upstream.status, parsed);
}

export async function mintToken(base: string, workspace: string): Promise<string> {
  const response = await fetch(`${base}/_tapedb/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: workspace }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `claim failed (${response.status}): ${text.slice(0, 200)}. ` +
        `Is the Worker running with \`tapedb dev\`?`
    );
  }
  const parsed = JSON.parse(text) as { token?: unknown };
  if (typeof parsed.token !== "string") throw new Error("claim returned no token");
  return parsed.token;
}

/**
 * Points the studio at a workspace, dropping the cached claim when it changes.
 *
 * A claim is scoped to one workspace, so reusing it after a switch would make
 * every request fail as unauthorized.
 */
function setWorkspace(state: StudioState, workspace: string): void {
  if (workspace === state.workspace) return;
  state.workspace = workspace;
  state.token = null;
}

/** Calls the engine with a claim, re-minting once on 401. */
async function engine(
  base: string,
  state: StudioState,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  if (state.workspace.length === 0) {
    throw new Error("No workspace id. Enter one in the page.");
  }
  if (state.token === null) state.token = await mintToken(base, state.workspace);

  const call = (token: string) =>
    fetch(`${base}/engine/workspaces/${state.workspace}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${token}`,
      },
    });

  let response = await call(state.token);
  if (response.status === 401) {
    state.token = await mintToken(base, state.workspace);
    response = await call(state.token);
  }
  return response;
}

/**
 * One page of a namespace, in the shape `/api/query` expects.
 *
 * The order is fixed to `id asc` so the cursor the engine hands back stays
 * valid on the next request: a cursor is only meaningful against a total order,
 * and an unordered page would silently skip or repeat rows.
 */
export function pageQuery(
  namespace: string,
  cursor: string | null = null,
  limit: number = PAGE_LIMIT
): Record<string, unknown> {
  const options: Record<string, unknown> = { limit, order: { id: "asc" } };
  if (cursor !== null && cursor.length > 0) options.after = cursor;
  return { [namespace]: { $: options } };
}

const PAGE = studioPage(PAGE_LIMIT);

/** The brand fonts the page uses, shipped in the package's `assets/fonts`. */
const FONTS = new Set(["space-grotesk.woff2", "inter.woff2", "jetbrains-mono.woff2"]);

/** `assets/fonts` of this package, found from wherever the code runs (src or dist). */
function fontDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "assets", "fonts");
    if (existsSync(join(candidate, "inter.woff2"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function startStudio(options: StudioOptions): Promise<{ url: string; close: () => void }> {
  const base = options.url.replace(/\/+$/, "");
  const state: StudioState = { token: null, workspace: options.workspace };

  let port = options.port;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      // Only the studio's own page may call it: a page on another site must not
      // read the local database or edit the project. Requests from elsewhere
      // carry another Host (DNS rebinding) or Origin; a JSON body cannot be
      // sent cross-site without a preflight, which this server never grants.
      const own = [`127.0.0.1:${port}`, `localhost:${port}`];
      const origin = request.headers.origin;
      if (!own.includes(request.headers.host ?? "") || (origin !== undefined && !own.some((host) => origin === `http://${host}`))) {
        sendJson(response, 403, { error: { message: "The studio only answers its own page." } });
        return;
      }
      if (request.method !== "GET" && !(request.headers["content-type"] ?? "").startsWith("application/json")) {
        sendJson(response, 415, { error: { message: "Send JSON." } });
        return;
      }


      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(PAGE);
        return;
      }

      // The Worker lists its local workspaces during `tapedb dev`; anywhere
      // else it has no such route and the page falls back to typing an id.
      if (url.pathname === "/api/workspaces") {
        const known = url.searchParams.get("known");
        const upstream = await fetch(`${base}/_tapedb/workspaces${known === null ? "" : `?known=${encodeURIComponent(known)}`}`).catch(() => null);
        if (upstream?.ok) await forward(response, upstream);
        else sendJson(response, 200, { workspaces: null });
        return;
      }

      if (url.pathname.startsWith("/fonts/")) {
        const name = url.pathname.slice("/fonts/".length);
        const dir = FONTS.has(name) ? fontDir() : null;
        if (!dir) {
          sendJson(response, 404, { error: { message: `No font ${name}` } });
          return;
        }
        const bytes = readFileSync(join(dir, name));
        response.writeHead(200, {
          "content-type": "font/woff2",
          "content-length": bytes.length,
          "cache-control": "public, max-age=86400",
        });
        response.end(bytes);
        return;
      }

      if (url.pathname === "/api/health") {
        sendJson(response, 200, { base, workspace: state.workspace });
        return;
      }

      if (url.pathname === "/api/structure") {
        sendJson(response, 200, options.project ? await readStructure(options.project) : { editable: false, reason: "Start the studio from your project with npx tapedb-cli dev to change the schema here." });
        return;
      }

      const body = await readBody(request);

      if (url.pathname === "/api/structure/preview" || url.pathname === "/api/structure/apply") {
        if (!options.project) throw new BadRequest("Start the studio from your project with npx tapedb-cli dev to change the schema here.");
        const parsed = parseJsonBody<{ edit?: SchemaEdit; base?: string }>(body);
        if (!parsed.edit || typeof parsed.edit !== "object") throw new BadRequest("Send the edit.");
        if (url.pathname.endsWith("/preview")) {
          sendJson(response, 200, await previewEdit(options.project, parsed.edit));
        } else {
          if (typeof parsed.base !== "string") throw new BadRequest("Preview the edit first.");
          sendJson(response, 200, await applyEdit(options.project, parsed.edit, parsed.base));
        }
        return;
      }


      if (url.pathname === "/api/schema") {
        const parsed = parseJsonBody<{ workspaceId?: string }>(body);
        if (typeof parsed.workspaceId === "string") setWorkspace(state, parsed.workspaceId);
        const upstream = await engine(base, state, "/schema");
        await forward(response, upstream);
        return;
      }

      // The workspace's transaction count, for the page's live counter.
      if (url.pathname === "/api/status") {
        const parsed = parseJsonBody<{ workspaceId?: string; after?: number }>(body);
        if (typeof parsed.workspaceId === "string") setWorkspace(state, parsed.workspaceId);
        // With `after`, the room answers once a transaction lands past it (or after 25 s).
        const after = typeof parsed.after === "number" && Number.isFinite(parsed.after) ? `?after=${parsed.after}` : "";
        await forward(response, await engine(base, state, `/status${after}`));
        return;
      }

      if (url.pathname === "/api/query") {
        const parsed = parseJsonBody<{
          workspaceId?: string;
          query?: unknown;
          namespace?: string;
          cursor?: string | null;
          limit?: number;
        }>(body);
        if (typeof parsed.workspaceId === "string") setWorkspace(state, parsed.workspaceId);

        let query = parsed.query;
        if (query === undefined) {
          // The page sends a namespace plus the cursor it was handed, and the
          // studio composes the query, so `order` cannot drift between pages.
          if (typeof parsed.namespace !== "string" || parsed.namespace.length === 0) {
            throw new BadRequest("Send either a `query` document or a `namespace` to page through.");
          }
          const cursor = typeof parsed.cursor === "string" ? parsed.cursor : null;
          const limit = typeof parsed.limit === "number" ? parsed.limit : PAGE_LIMIT;
          query = pageQuery(parsed.namespace, cursor, limit);
        }

        const upstream = await engine(base, state, "/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query }),
        });
        await forward(response, upstream);
        return;
      }

      if (url.pathname === "/api/transact") {
        const parsed = parseJsonBody<{ workspaceId?: string; body?: unknown }>(body);
        if (typeof parsed.workspaceId === "string") setWorkspace(state, parsed.workspaceId);
        const upstream = await engine(base, state, "/transact", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(parsed.body),
        });
        await forward(response, upstream);
        return;
      }

      sendJson(response, 404, { error: { message: `No studio route for ${url.pathname}` } });
    } catch (error) {
      const status = error instanceof BadRequest ? 400 : 500;
      sendJson(response, status, {
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(
              `Port ${options.port} is already in use. Pass --port <port> to pick another.`
            )
          : error
      );
    });

    server.listen(options.port, "127.0.0.1", () => {
      // `port: 0` lets the OS choose, so the bound port is read back rather
      // than assumed: tests rely on it to avoid fixed ports entirely.
      const address = server.address();
      const bound = typeof address === "object" && address !== null ? address.port : options.port;
      port = bound;
      resolve({
        url: `http://127.0.0.1:${bound}`,
        close: () => {
          server.close();
          // A browser (or a test client) holds keep-alive sockets open, and
          // `close` alone would wait for them before releasing the port.
          server.closeAllConnections();
        },
      });
    });
  });
}
