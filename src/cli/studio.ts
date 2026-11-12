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

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface StudioOptions {
  /** Base URL of the running Worker, e.g. http://localhost:8787 */
  url: string;
  /** Workspace to open; prompted for in the page when empty. */
  workspace: string;
  /** Port to bind. `0` asks the OS for an ephemeral port. */
  port: number;
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

async function mintToken(base: string, workspace: string): Promise<string> {
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

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>tapedb studio</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #0d1117; color: #e6edf3; }
  header { display: flex; gap: 8px; align-items: center; padding: 10px 14px;
           border-bottom: 1px solid #21262d; flex-wrap: wrap; }
  input, select, button, textarea { font: inherit; background: #161b22; color: #e6edf3;
           border: 1px solid #30363d; border-radius: 6px; padding: 6px 8px; }
  button { cursor: pointer; } button:hover { border-color: #8b949e; }
  main { padding: 14px; display: grid; gap: 14px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #21262d;
           vertical-align: top; max-width: 360px; overflow: hidden; text-overflow: ellipsis; }
  th { color: #8b949e; font-weight: 600; }
  .muted { color: #8b949e; }
  .err { color: #ff7b72; white-space: pre-wrap; }
  textarea { width: 100%; min-height: 90px; }
  #more { margin-top: 8px; }
</style>
</head>
<body>
<header>
  <strong>tapedb</strong>
  <select id="workspaces" title="workspaces opened before"></select>
  <input id="workspace" placeholder="workspace uuid" size="38" />
  <select id="namespace"><option value="">(connect)</option></select>
  <button id="refresh">refresh</button>
  <span id="status" class="muted"></span>
</header>
<main>
  <div id="error" class="err"></div>
  <div id="table-wrap" class="muted">no data yet</div>
  <div>
    <button id="more" style="display:none">load more</button>
  </div>
  <div>
    <div class="muted">transact (JSON ops, sent as one transaction)</div>
    <textarea id="ops">[{"op":"update","namespace":"boards","id":"board-1","values":{"name":"Hello"}}]</textarea>
    <button id="send">send</button>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const LIST_KEY = "tapedb-workspaces";
const CURRENT_KEY = "tapedb-workspace";
const PAGE_LIMIT = ${PAGE_LIMIT};
const MAX_REMEMBERED = 8;

// The token lives on the server, keyed by workspace; the page only knows which
// workspace is open, so switching one resets the other.
const state = { namespace: "", cursor: null, rows: [] };

function showError(message) { $("error").textContent = message || ""; }

function readWorkspaces() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LIST_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id) => typeof id === "string" && id.length > 0);
  } catch { return []; }
}

function renderWorkspaces() {
  const select = $("workspaces");
  const list = readWorkspaces();
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = list.length > 0 ? "recent workspaces" : "no saved workspaces";
  select.append(placeholder);
  for (const id of list) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id.length > 12 ? id.slice(0, 8) + "…" + id.slice(-3) : id;
    option.title = id;
    select.append(option);
  }
  select.value = "";
}

function rememberWorkspace(id) {
  if (!id) return;
  const next = [id].concat(readWorkspaces().filter((existing) => existing !== id)).slice(0, MAX_REMEMBERED);
  localStorage.setItem(LIST_KEY, JSON.stringify(next));
  localStorage.setItem(CURRENT_KEY, id);
  renderWorkspaces();
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!response.ok) throw new Error(parsed?.error?.message || text.slice(0, 300));
  return parsed;
}

function workspaceId() { return $("workspace").value.trim(); }

function cell(value) {
  const text = value === null || value === undefined
    ? ""
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/'/g, "&#39;");
  return "<td title='" + escaped + "'>" + escaped + "</td>";
}

// Rebuilt from every row loaded so far, so a later page can add columns the
// first one did not have and nothing already on screen is lost.
function renderRows() {
  if (state.rows.length === 0) {
    $("table-wrap").textContent = "no rows in " + state.namespace;
    return;
  }
  const columns = [...new Set(state.rows.flatMap((row) => Object.keys(row)))];
  const head = "<tr>" + columns.map((column) => "<th>" + column + "</th>").join("") + "</tr>";
  const body = state.rows
    .map((row) => "<tr>" + columns.map((column) => cell(row[column])).join("") + "</tr>")
    .join("");
  $("table-wrap").innerHTML = "<table>" + head + body + "</table>";
}

function applyPage(namespace, data, pageInfo, append) {
  const rows = data[namespace] || [];
  state.rows = append ? state.rows.concat(rows) : rows;
  const info = pageInfo?.[namespace];
  state.cursor = info && info.hasMore && info.nextCursor ? info.nextCursor : null;
  renderRows();
  $("more").style.display = state.cursor ? "" : "none";
  $("status").textContent = namespace + ": " + state.rows.length + " rows" +
    (state.cursor ? " (more available)" : "");
}

async function fetchPage(cursor) {
  return api("/api/query", {
    workspaceId: workspaceId(),
    namespace: state.namespace,
    limit: PAGE_LIMIT,
    cursor: cursor || undefined,
  });
}

async function loadSchema() {
  const workspace = workspaceId();
  if (!workspace) { showError("Enter a workspace id first."); return; }
  showError("");
  const { data } = await api("/api/schema", { workspaceId: workspace });
  const select = $("namespace");
  select.innerHTML = "";
  for (const namespace of data.namespaces) {
    const option = document.createElement("option");
    option.value = namespace.apiName;
    option.textContent = namespace.apiName + " (" + Object.keys(namespace.attributes).length + " attrs)";
    select.append(option);
  }
  $("status").textContent = data.namespaces.length + " namespaces";
  state.namespace = select.value || "";
  state.cursor = null;
  state.rows = [];
  await loadRows();
}

async function loadRows() {
  if (!state.namespace) { state.namespace = $("namespace").value; }
  if (!state.namespace) return;
  const { data, pageInfo } = await fetchPage(null);
  applyPage(state.namespace, data, pageInfo, false);
}

async function loadMore() {
  if (!state.cursor) return;
  const { data, pageInfo } = await fetchPage(state.cursor);
  applyPage(state.namespace, data, pageInfo, true);
}

// A workspace switch invalidates both the cached claim (server side) and the
// rows on screen (here), so schema and first page are always fetched together.
function connect(workspace) {
  $("workspace").value = workspace;
  rememberWorkspace(workspace);
  state.cursor = null;
  state.rows = [];
  $("more").style.display = "none";
  loadSchema().catch((error) => showError(error.message));
}

$("refresh").addEventListener("click", () => { loadSchema().catch((e) => showError(e.message)); });
$("namespace").addEventListener("change", () => {
  state.namespace = $("namespace").value;
  state.cursor = null;
  state.rows = [];
  loadRows().catch((e) => showError(e.message));
});
$("more").addEventListener("click", () => { loadMore().catch((e) => showError(e.message)); });
$("workspaces").addEventListener("change", () => {
  const selected = $("workspaces").value;
  if (selected) connect(selected);
});
$("workspace").addEventListener("change", () => {
  const entered = workspaceId();
  if (entered) connect(entered); else showError("Enter a workspace id first.");
});
$("send").addEventListener("click", async () => {
  try {
    showError("");
    const ops = JSON.parse($("ops").value);
    const result = await api("/api/transact", {
      workspaceId: workspaceId(),
      body: { txId: "studio-" + Date.now(), ops },
    });
    $("status").textContent = "applied seq " + (result?.result?.seq ?? "?");
    state.cursor = null;
    state.rows = [];
    await loadRows();
  } catch (error) { showError(error.message); }
});

renderWorkspaces();
$("workspace").value = localStorage.getItem(CURRENT_KEY) || "";
loadSchema().catch((e) => showError(e.message));
</script>
</body>
</html>`;

export function startStudio(options: StudioOptions): Promise<{ url: string; close: () => void }> {
  const base = options.url.replace(/\/+$/, "");
  const state: StudioState = { token: null, workspace: options.workspace };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(PAGE);
        return;
      }

      if (url.pathname === "/api/health") {
        sendJson(response, 200, { base, workspace: state.workspace });
        return;
      }

      const body = await readBody(request);

      if (url.pathname === "/api/schema") {
        const parsed = parseJsonBody<{ workspaceId?: string }>(body);
        if (typeof parsed.workspaceId === "string") setWorkspace(state, parsed.workspaceId);
        const upstream = await engine(base, state, "/schema");
        await forward(response, upstream);
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
