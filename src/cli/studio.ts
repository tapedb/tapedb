/**
 * `tapedb studio`: a local table browser.
 *
 * A devtool that needs no build and no dependencies: it serves one HTML page
 * and proxies to the running Worker, minting a dev claim the same way the
 * client does. Nothing here ships to production, and it only talks to the
 * Worker you point it at.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface StudioOptions {
  /** Base URL of the running Worker, e.g. http://localhost:8787 */
  url: string;
  /** Workspace to open; prompted for in the page when empty. */
  workspace: string;
  port: number;
}

interface StudioState {
  token: string | null;
  workspace: string;
}

/** A client mistake, reported as 400 rather than as a server error. */
class BadRequest extends Error {}

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
</style>
</head>
<body>
<header>
  <strong>tapedb</strong>
  <input id="workspace" placeholder="workspace uuid" size="38" />
  <select id="namespace"><option value="">(connect)</option></select>
  <button id="refresh">refresh</button>
  <span id="status" class="muted"></span>
</header>
<main>
  <div id="error" class="err"></div>
  <div id="table" class="muted">no data yet</div>
  <div>
    <div class="muted">transact (JSON ops, sent as one transaction)</div>
    <textarea id="ops">[{"op":"update","namespace":"boards","id":"board-1","values":{"name":"Hello"}}]</textarea>
    <button id="send">send</button>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const state = { token: sessionStorage.getItem("tapedb-token") || null };

function showError(message) { $("error").textContent = message || ""; }

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

async function loadSchema() {
  const workspace = $("workspace").value.trim();
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
  await loadRows();
}

async function loadRows() {
  const namespace = $("namespace").value;
  if (!namespace) return;
  const { data, pageInfo } = await api("/api/query", {
    workspaceId: $("workspace").value.trim(),
    query: { [namespace]: { $: { limit: 50 } } },
  });
  const rows = data[namespace] || [];
  if (rows.length === 0) { $("table").textContent = "no rows in " + namespace; return; }

  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const head = "<tr>" + columns.map((c) => "<th>" + c + "</th>").join("") + "</tr>";
  const body = rows.map((row) =>
    "<tr>" + columns.map((c) => {
      const value = row[c];
      const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
      return "<td title='" + text.replace(/'/g, "&#39;") + "'>" + text.replace(/</g, "&lt;") + "</td>";
    }).join("") + "</tr>").join("");
  $("table").innerHTML = "<table>" + head + body + "</table>";
  $("status").textContent = namespace + ": " + rows.length + " rows" +
    (pageInfo?.[namespace]?.hasMore ? " (more available)" : "");
}

$("refresh").addEventListener("click", () => { loadSchema().catch((e) => showError(e.message)); });
$("namespace").addEventListener("change", () => { loadRows().catch((e) => showError(e.message)); });
$("send").addEventListener("click", async () => {
  try {
    showError("");
    const ops = JSON.parse($("ops").value);
    const result = await api("/api/transact", {
      workspaceId: $("workspace").value.trim(),
      body: { txId: "studio-" + Date.now(), ops },
    });
    $("status").textContent = "applied seq " + (result?.result?.seq ?? "?");
    await loadRows();
  } catch (error) { showError(error.message); }
});
$("workspace").value = localStorage.getItem("tapedb-workspace") || "";
$("workspace").addEventListener("change", () => {
  localStorage.setItem("tapedb-workspace", $("workspace").value.trim());
  state.token = null;
  loadSchema().catch((e) => showError(e.message));
});
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
        if (typeof parsed.workspaceId === "string") {
          if (parsed.workspaceId !== state.workspace) state.token = null;
          state.workspace = parsed.workspaceId;
        }
        const upstream = await engine(base, state, "/schema");
        sendJson(response, upstream.status, await upstream.json());
        return;
      }

      if (url.pathname === "/api/query") {
        const parsed = parseJsonBody<{ workspaceId?: string; query?: unknown }>(body);
        if (typeof parsed.workspaceId === "string") state.workspace = parsed.workspaceId;
        const upstream = await engine(base, state, "/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: parsed.query }),
        });
        sendJson(response, upstream.status, await upstream.json());
        return;
      }

      if (url.pathname === "/api/transact") {
        const parsed = parseJsonBody<{ workspaceId?: string; body?: unknown }>(body);
        if (typeof parsed.workspaceId === "string") state.workspace = parsed.workspaceId;
        const upstream = await engine(base, state, "/transact", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(parsed.body),
        });
        sendJson(response, upstream.status, await upstream.json());
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
      resolve({
        url: `http://127.0.0.1:${options.port}`,
        close: () => server.close(),
      });
    });
  });
}
