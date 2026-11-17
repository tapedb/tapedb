/**
 * The studio's page: one HTML document, no build and no dependencies.
 *
 * Kept apart from the server so the markup can be read on its own. It is a
 * String.raw template: the script below uses no backticks and no `${`, so the
 * only substitution is the page size.
 */

export function studioPage(pageLimit: number): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tapedb studio</title>
<link rel="icon" href="data:," />
<style>
:root {
  color-scheme: light dark;
  --paper: #eef1f4;
  --surface: #ffffff;
  --ink: #18202b;
  --muted: #5d6a79;
  --faint: #98a3b0;
  --rule: #dbe0e6;
  --hover: #f4f6f9;
  --select: #e3ebf7;
  --amber: #e09b12;
  --counter-bg: #1d232c;
  --danger: #c0352a;
  --focus: #3b6fd8;
  --radius-s: 5px;
  --radius-m: 9px;
  --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #12161c;
    --surface: #181d25;
    --ink: #e5e9ef;
    --muted: #8d98a7;
    --faint: #5c6674;
    --rule: #28303b;
    --hover: #1d2430;
    --select: #1f2b3c;
    --counter-bg: #0d1015;
    --danger: #ef6b5e;
    --focus: #79a2f2;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  font: 14px/1.45 var(--sans);
  color: var(--ink);
  background: var(--paper);
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
}
button, input, select, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.mono { font-family: var(--mono); font-size: 12.5px; }
.num { font-variant-numeric: tabular-nums; }

/* Sidebar */
aside {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100vh;
  position: sticky;
  top: 0;
  border-right: 1px solid var(--rule);
}
.brand { padding: 18px 18px 12px; font-weight: 650; font-size: 15px; letter-spacing: -0.01em; }
.brand span { color: var(--muted); font-weight: 450; }
.picker { padding: 0 12px 14px; border-bottom: 1px solid var(--rule); }
.picker label { display: block; font-size: 12px; color: var(--muted); margin: 0 6px 4px; }
.picker select, .picker input {
  width: 100%;
  padding: 7px 9px;
  border: 1px solid var(--rule);
  border-radius: var(--radius-s);
  background: var(--surface);
}
.picker input { margin-top: 6px; }
nav { flex: 1; overflow: auto; padding: 10px 8px; }
nav button {
  display: flex;
  width: 100%;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  padding: 6px 10px;
  border: 0;
  border-radius: var(--radius-s);
  background: none;
  cursor: pointer;
  text-align: left;
}
nav button:hover { background: var(--hover); }
nav button[aria-current="true"] { background: var(--select); font-weight: 600; }
nav button .count { color: var(--muted); font-size: 12.5px; font-weight: 450; }

/* The tape counter: the workspace's transaction count, ticking as writes land. */
.counter { padding: 14px 16px 18px; border-top: 1px solid var(--rule); }
.counter .digits {
  display: flex;
  gap: 3px;
  padding: 8px 10px;
  border-radius: var(--radius-s);
  background: var(--counter-bg);
  width: max-content;
}
.counter .digit {
  width: 15px;
  height: 22px;
  overflow: hidden;
  font: 600 17px/22px var(--mono);
  color: var(--amber);
  text-align: center;
}
.counter .digit.off { color: #3a3226; }
.counter .digit > span { display: block; }
.counter .digit.roll > span { animation: roll 380ms cubic-bezier(.2,.7,.2,1); }
@keyframes roll { from { transform: translateY(-100%); opacity: .2; } to { transform: none; opacity: 1; } }
.counter p { margin: 7px 2px 0; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
.live-dot.on { background: var(--amber); }
.live-dot.flash { animation: flash 900ms ease-out; }
@keyframes flash { from { box-shadow: 0 0 0 5px rgba(224,155,18,.35); } to { box-shadow: 0 0 0 0 rgba(224,155,18,0); } }

/* Main */
main { min-width: 0; display: flex; flex-direction: column; height: 100vh; }
.top { padding: 16px 24px 12px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.top h1 { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: -0.015em; }
.top .total { color: var(--muted); }
.top .spacer { flex: 1; }
.btn {
  padding: 7px 13px;
  border-radius: var(--radius-s);
  border: 1px solid var(--rule);
  background: var(--surface);
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover { border-color: var(--faint); }
.btn.primary { background: var(--ink); color: var(--paper); border-color: var(--ink); font-weight: 550; }
.btn.danger { color: var(--danger); }
.btn.danger.confirm { background: var(--danger); color: #fff; border-color: var(--danger); }
.btn[disabled] { opacity: .45; cursor: default; }

.filters { padding: 0 24px 12px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 10px;
  border-radius: 99px;
  background: var(--select);
  font-size: 13px;
}
.chip button { border: 0; background: none; cursor: pointer; color: var(--muted); padding: 0 4px; font-size: 15px; line-height: 1; }
.filter-form { display: inline-flex; gap: 6px; align-items: center; }
.filter-form select, .filter-form input {
  padding: 5px 8px;
  border: 1px solid var(--rule);
  border-radius: var(--radius-s);
  background: var(--surface);
  font-size: 13px;
}
.filter-form input { width: 180px; }
.linkish { border: 0; background: none; color: var(--muted); cursor: pointer; padding: 4px 2px; font-size: 13px; }
.linkish:hover { color: var(--ink); }

.grid-wrap { flex: 1; overflow: auto; margin: 0 24px 0; border: 1px solid var(--rule); border-bottom: 0; border-radius: var(--radius-m) var(--radius-m) 0 0; background: var(--surface); }
table { border-collapse: separate; border-spacing: 0; width: max-content; min-width: 100%; }
th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface);
  text-align: left;
  font-weight: 600;
  font-size: 13px;
  padding: 0;
  border-bottom: 1px solid var(--rule);
}
th button {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  padding: 9px 14px 8px;
  border: 0;
  background: none;
  cursor: pointer;
  text-align: left;
  font-weight: 600;
}
th small { font-weight: 450; color: var(--faint); font-size: 11.5px; }
th .dir { color: var(--muted); font-weight: 500; }
td {
  padding: 8px 14px;
  border-bottom: 1px solid var(--rule);
  max-width: 320px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: top;
}
tbody tr { cursor: pointer; }
tbody tr:hover td { background: var(--hover); }
tbody tr[aria-selected="true"] td { background: var(--select); }
.null { color: var(--faint); }
.bool-true { color: var(--ink); }
.bool-false { color: var(--faint); }
.ref {
  border: 1px solid var(--rule);
  padding: 1px 8px;
  border-radius: 4px;
  background: var(--paper);
  cursor: pointer;
  font-size: 13px;
}
.ref.unnamed { font: 12.5px var(--mono); }
.ref:hover { border-color: var(--faint); }
.foot { margin: 0 24px 16px; padding: 9px 14px; border: 1px solid var(--rule); border-radius: 0 0 var(--radius-m) var(--radius-m); background: var(--surface); display: flex; gap: 12px; align-items: center; color: var(--muted); font-size: 13px; }

.empty { padding: 56px 24px; text-align: center; color: var(--muted); }
.empty h2 { margin: 0 0 6px; font-size: 16px; color: var(--ink); font-weight: 600; }
.empty p { margin: 0 auto 16px; max-width: 46ch; }

/* Drawer */
.drawer {
  position: fixed;
  top: 0;
  right: 0;
  height: 100vh;
  width: min(440px, 100vw);
  background: var(--surface);
  border-left: 1px solid var(--rule);
  box-shadow: -18px 0 40px -28px rgba(10, 20, 35, .45);
  display: flex;
  flex-direction: column;
  transform: translateX(102%);
  transition: transform 180ms ease-out;
  z-index: 5;
}
.drawer.open { transform: none; }
.drawer header { padding: 16px 20px 12px; border-bottom: 1px solid var(--rule); display: flex; align-items: flex-start; gap: 10px; }
.drawer header h2 { margin: 0; font-size: 16px; font-weight: 650; }
.drawer header .sub { color: var(--muted); font-size: 12.5px; margin-top: 2px; word-break: break-all; }
.drawer header .close { margin-left: auto; border: 0; background: none; font-size: 20px; line-height: 1; cursor: pointer; color: var(--muted); padding: 2px 6px; }
.drawer form { flex: 1; overflow: auto; padding: 14px 20px; display: grid; gap: 14px; align-content: start; }
.field label { display: flex; justify-content: space-between; font-size: 13px; font-weight: 550; margin-bottom: 5px; }
.field label small { color: var(--faint); font-weight: 450; }
.field input[type=text], .field input[type=number], .field input[type=datetime-local], .field textarea, .field select {
  width: 100%;
  padding: 7px 9px;
  border: 1px solid var(--rule);
  border-radius: var(--radius-s);
  background: var(--paper);
}
.field textarea { min-height: 84px; font: 12.5px/1.5 var(--mono); resize: vertical; }
.field .toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.field .hint { font-size: 12px; color: var(--muted); margin-top: 4px; }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: 3px 14px; font-size: 12.5px; color: var(--muted); padding-top: 4px; }
.meta dd { margin: 0; color: var(--ink); }
.related { display: grid; gap: 6px; }
.related h3 { margin: 6px 0 0; font-size: 13px; font-weight: 600; }
.related button { justify-self: start; color: var(--ink); text-decoration: underline; text-decoration-color: var(--faint); text-underline-offset: 3px; }
.drawer footer { padding: 12px 20px; border-top: 1px solid var(--rule); display: flex; gap: 8px; align-items: center; }
.drawer footer .spacer { flex: 1; }

.toast {
  position: fixed;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  max-width: min(640px, 92vw);
  padding: 10px 14px;
  border-radius: var(--radius-m);
  background: var(--ink);
  color: var(--paper);
  font-size: 13.5px;
  display: none;
  z-index: 10;
}
.toast.show { display: block; }
.toast.error { background: var(--danger); color: #fff; }

@media (max-width: 760px) {
  html, body { height: auto; }
  body { grid-template-columns: 1fr; grid-template-rows: auto auto; }
  aside { position: static; height: auto; min-height: auto; border-right: 0; border-bottom: 1px solid var(--rule); }
  nav { min-height: 44px; }
  nav { flex: none; display: flex; gap: 4px; overflow-x: auto; padding: 8px; }
  nav button { width: auto; }
  .counter { display: none; }
  main { height: auto; min-height: 70vh; }
  .grid-wrap, .foot { margin-left: 12px; margin-right: 12px; }
  .top, .filters { padding-left: 12px; padding-right: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .drawer { transition: none; }
  .counter .digit.roll > span, .live-dot.flash { animation: none; }
}
</style>
</head>
<body>
<aside>
  <div class="brand">tapedb <span>studio</span></div>
  <div class="picker">
    <label for="workspace">Workspace</label>
    <select id="workspace"></select>
    <input id="workspace-id" type="text" placeholder="Paste a workspace id" hidden />
  </div>
  <nav id="models" aria-label="Models"></nav>
  <div class="counter" title="Transactions written to this workspace">
    <div class="digits" id="digits"></div>
    <p><span class="live-dot" id="live"></span><span id="live-text">Transactions written</span></p>
  </div>
</aside>
<main>
  <div class="top">
    <h1 id="title">Studio</h1>
    <span class="total num" id="total"></span>
    <span class="spacer"></span>
    <button class="btn primary" id="add" hidden>Add row</button>
  </div>
  <div class="filters" id="filters" hidden></div>
  <div class="grid-wrap" id="grid"></div>
  <div class="foot" id="foot" hidden>
    <span id="shown" class="num"></span>
    <span class="spacer" style="flex:1"></span>
    <button class="btn" id="more" hidden>Load more</button>
  </div>
</main>
<div class="drawer" id="drawer" role="dialog" aria-modal="false" aria-labelledby="drawer-title">
  <header>
    <div>
      <h2 id="drawer-title"></h2>
      <div class="sub mono" id="drawer-sub"></div>
    </div>
    <button class="close" id="close" aria-label="Close">×</button>
  </header>
  <form id="editor" novalidate></form>
  <footer>
    <button class="btn danger" id="delete" type="button">Delete row</button>
    <span class="spacer"></span>
    <button class="btn" id="cancel" type="button">Cancel</button>
    <button class="btn primary" id="save" type="submit" form="editor">Save changes</button>
  </footer>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>
var PAGE = ${pageLimit};
var SYSTEM = ["createdAt", "updatedAt", "updatedSeq"];
var CURRENT_KEY = "tapedb-workspace";
var $ = function (id) { return document.getElementById(id); };

var app = {
  workspace: "",
  workspaces: [],
  schema: null,
  model: "",
  counts: {},
  rows: [],
  cursor: null,
  total: null,
  order: { field: "id", dir: "asc" },
  filters: [],
  selected: null,
  creating: false,
  seq: null,
  polling: null,
  manual: false,
  labels: {},
  filtering: false
};

// ---- Talking to the studio server ----------------------------------------

function api(path, body) {
  return fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(function (response) {
    return response.text().then(function (text) {
      var parsed;
      try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }
      if (!response.ok || (parsed && parsed.ok === false)) {
        var message = (parsed && parsed.error && parsed.error.message) || text.slice(0, 300) || ("HTTP " + response.status);
        throw new Error(message);
      }
      return parsed;
    });
  });
}

function query(document) { return api("/api/query", { workspaceId: app.workspace, query: document }); }

function transact(ops) {
  return api("/api/transact", {
    workspaceId: app.workspace,
    body: { txId: "studio-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8), ops: ops }
  });
}

// ---- Small helpers --------------------------------------------------------

function el(tag, attrs, children) {
  var node = document.createElement(tag);
  if (attrs) for (var key in attrs) {
    var value = attrs[key];
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  (children || []).forEach(function (child) {
    if (child === null || child === undefined) return;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  });
  return node;
}

var toastTimer = null;
function toast(message, isError) {
  var node = $("toast");
  node.textContent = message;
  node.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { node.className = "toast"; }, isError ? 7000 : 2400);
}
function fail(error) { toast(error && error.message ? error.message : String(error), true); }

function shortId(id) { return id && id.length > 13 ? id.slice(0, 8) + "…" + id.slice(-4) : id; }

function ago(ms) {
  if (!ms) return "";
  var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}

var dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
var timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
var dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
function formatDate(ms) { return typeof ms === "number" ? dateFormat.format(new Date(ms)) : String(ms); }
/** Short in the table: the time today, the day this year, the full date otherwise. */
function shortDate(ms) {
  if (typeof ms !== "number") return String(ms);
  var d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return timeFormat.format(d);
  if (d.getFullYear() === now.getFullYear()) return dayFormat.format(d);
  return dateFormat.format(d);
}

function uuid7() {
  var bytes = crypto.getRandomValues(new Uint8Array(16));
  var now = Date.now();
  for (var i = 5; i >= 0; i--) { bytes[i] = now % 256; now = Math.floor(now / 256); }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  var hex = Array.prototype.map.call(bytes, function (b) { return (b + 256).toString(16).slice(1); }).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}

// ---- Schema ---------------------------------------------------------------

function namespace(name) {
  return app.schema.namespaces.filter(function (n) { return n.apiName === name; })[0];
}

/** The model a foreign-key field points at, or null. */
function referenceOf(model, field) {
  var links = app.schema.links || [];
  for (var i = 0; i < links.length; i++) {
    var link = links[i];
    if (!link.foreignKey || link.foreignKey.namespace !== model || link.foreignKey.attribute !== field) continue;
    return link.forward.namespace === model ? link.reverse.namespace : link.forward.namespace;
  }
  return null;
}

/** Models that point at this one: [{ model, field }]. */
function referrers(model) {
  return (app.schema.links || []).filter(function (link) {
    if (!link.foreignKey) return false;
    var owner = link.foreignKey.namespace;
    var target = link.forward.namespace === owner ? link.reverse.namespace : link.forward.namespace;
    return target === model;
  }).map(function (link) { return { model: link.foreignKey.namespace, field: link.foreignKey.attribute }; });
}

/** The field that names a row: the first plain string field, if any. */
function labelField(model) {
  var attrs = namespace(model).attributes;
  var names = Object.keys(attrs).filter(function (n) { return attrs[n].type === "string" && !referenceOf(model, n) && n !== "id"; });
  return names[0] || null;
}

/** Fetches the names of the rows these references point at, for the table. */
function loadLabels(model, rows) {
  var wanted = {};
  Object.keys(namespace(model).attributes).forEach(function (field) {
    var target = referenceOf(model, field);
    if (!target || !labelField(target)) return;
    rows.forEach(function (row) {
      var id = row[field];
      if (typeof id === "string" && !(app.labels[target] && id in app.labels[target])) {
        (wanted[target] = wanted[target] || {})[id] = true;
      }
    });
  });
  var targets = Object.keys(wanted);
  if (targets.length === 0) return Promise.resolve(false);
  var document = {};
  targets.forEach(function (target) {
    document[target] = { $: { where: { id: { $in: Object.keys(wanted[target]) } }, select: [labelField(target)] } };
  });
  return query(document).then(function (result) {
    targets.forEach(function (target) {
      var map = app.labels[target] = app.labels[target] || {};
      Object.keys(wanted[target]).forEach(function (id) { map[id] = null; });
      ((result.data || {})[target] || []).forEach(function (row) { map[row.id] = row[labelField(target)]; });
    });
    return true;
  }).catch(function () { return false; });
}

function columns(model) {
  var attrs = namespace(model).attributes;
  var names = Object.keys(attrs);
  var seen = {};
  app.rows.forEach(function (row) { Object.keys(row).forEach(function (k) { seen[k] = true; }); });
  var system = SYSTEM.filter(function (k) { return seen[k] && !attrs[k]; });
  return ["id"].concat(names.filter(function (n) { return n !== "id"; }), system);
}

function typeOf(model, field) {
  if (field === "id") return "id";
  var attr = namespace(model).attributes[field];
  if (attr) return attr.type;
  if (field === "createdAt" || field === "updatedAt") return "date";
  if (field === "updatedSeq") return "number";
  return "any";
}

// ---- Workspaces -----------------------------------------------------------

function renderWorkspaces() {
  var select = $("workspace");
  select.innerHTML = "";
  if (app.workspaces.length === 0 && !app.workspace) {
    select.append(el("option", { value: "", text: "No workspaces yet" }));
  }
  var listed = app.workspaces.slice();
  if (app.workspace && !listed.some(function (w) { return w.id === app.workspace; })) listed.unshift({ id: app.workspace, updatedAt: null });
  listed.forEach(function (w) {
    var when = ago(w.updatedAt);
    select.append(el("option", { value: w.id, text: shortId(w.id) + (when ? "  (" + when + ")" : ""), title: w.id }));
  });
  select.append(el("option", { value: "__other", text: "Open by id…" }));
  select.value = app.workspace || "";
}

function loadWorkspaces() {
  return api("/api/workspaces").then(function (result) {
    if (!Array.isArray(result.workspaces)) { app.manual = true; return null; }
    app.workspaces = result.workspaces;
    return app.workspaces;
  });
}

function openWorkspace(id) {
  if (!id) return;
  app.workspace = id;
  try { localStorage.setItem(CURRENT_KEY, id); } catch (e) {}
  app.schema = null;
  app.model = "";
  app.seq = null;
  closeDrawer();
  renderWorkspaces();
  api("/api/schema", { workspaceId: id }).then(function (result) {
    app.schema = result.data;
    var first = app.schema.namespaces[0];
    renderModels();
    if (first) selectModel(first.apiName); else showEmpty("This schema has no models", "Add a model to tapedb.schema.ts and run a migration.");
    refreshCounts();
    poll();
  }).catch(fail);
}

// ---- Sidebar --------------------------------------------------------------

function renderModels() {
  var nav = $("models");
  nav.innerHTML = "";
  if (!app.schema) return;
  app.schema.namespaces.forEach(function (n) {
    var count = app.counts[n.apiName];
    nav.append(el("button", {
      type: "button",
      "aria-current": n.apiName === app.model ? "true" : "false",
      onclick: function () { selectModel(n.apiName); }
    }, [el("span", { text: n.apiName }), el("span", { class: "count num", text: count === undefined ? "" : count.toLocaleString() })]));
  });
}

function refreshCounts() {
  if (!app.schema) return Promise.resolve();
  var document = {};
  app.schema.namespaces.forEach(function (n) { document[n.apiName] = { $: { count: true, limit: 0 } }; });
  return query(document).then(function (result) {
    var info = result.pageInfo || {};
    Object.keys(info).forEach(function (name) { app.counts[name] = info[name].count; });
    renderModels();
  });
}

function renderCounter(seq, changed) {
  var text = String(seq === null ? 0 : seq);
  var width = Math.max(6, text.length);
  var padded = ("000000000000" + text).slice(-width);
  var box = $("digits");
  var old = box.textContent;
  box.innerHTML = "";
  for (var i = 0; i < padded.length; i++) {
    var lead = padded.length - i > text.length;
    var cls = "digit" + (lead ? " off" : "") + (changed && old.length === padded.length && old[i] !== padded[i] ? " roll" : "");
    box.append(el("span", { class: cls }, [el("span", { text: padded[i] })]));
  }
}

// ---- Live: follow the workspace's sequence --------------------------------

function poll() {
  clearTimeout(app.polling);
  if (!app.workspace) return;
  var workspace = app.workspace;
  api("/api/status", { workspaceId: workspace }).then(function (result) {
    if (workspace !== app.workspace) return;
    var seq = (result.durability && result.durability.seq) || 0;
    var changed = app.seq !== null && seq !== app.seq;
    renderCounter(seq, changed);
    $("live").className = "live-dot on" + (changed ? " flash" : "");
    $("live-text").textContent = "Transactions written, live";
    if (changed) { refreshCounts(); reloadRows(); }
    app.seq = seq;
  }).catch(function () {
    $("live").className = "live-dot";
    $("live-text").textContent = "Not connected";
  }).then(function () {
    app.polling = setTimeout(poll, document.hidden ? 6000 : 1500);
  });
}

// ---- Table ----------------------------------------------------------------

function selectModel(name) {
  app.model = name;
  app.filters = [];
  app.filtering = false;
  app.order = { field: "id", dir: "asc" };
  closeDrawer();
  renderModels();
  $("title").textContent = name;
  $("add").hidden = false;
  loadRows(false);
}

function whereClause() {
  if (app.filters.length === 0) return undefined;
  var where = {};
  var all = [];
  app.filters.forEach(function (f) {
    var condition = {};
    var value = f.value;
    if (f.op === "is") condition[f.field] = value;
    else { var c = {}; c[f.op] = value; condition[f.field] = c; }
    all.push(condition);
  });
  if (all.length === 1) return all[0];
  where.$and = all;
  return where;
}

function pageDocument(cursor, limit) {
  var options = { limit: limit || PAGE, count: true, order: {} };
  options.order[app.order.field] = app.order.dir;
  if (app.order.field !== "id") options.order.id = app.order.dir;
  var where = whereClause();
  if (where) options.where = where;
  if (cursor) options.after = cursor;
  var document = {};
  document[app.model] = { $: options };
  return document;
}

function loadRows(append) {
  var model = app.model;
  return query(pageDocument(append ? app.cursor : null)).then(function (result) {
    if (model !== app.model) return;
    var rows = (result.data && result.data[model]) || [];
    var info = (result.pageInfo || {})[model] || {};
    app.rows = append ? app.rows.concat(rows) : rows;
    app.cursor = info.hasMore && info.nextCursor ? info.nextCursor : null;
    app.total = typeof info.count === "number" ? info.count : null;
    renderTable();
    loadLabels(model, rows).then(function (found) { if (found && model === app.model) renderTable(); });
  }).catch(fail);
}

/** After a write: the same rows the page already shows, fetched again. */
function reloadRows() {
  if (!app.model) return;
  var model = app.model;
  var limit = Math.max(PAGE, app.rows.length);
  return query(pageDocument(null, limit)).then(function (result) {
    if (model !== app.model) return;
    var info = (result.pageInfo || {})[model] || {};
    app.rows = (result.data && result.data[model]) || [];
    app.cursor = info.hasMore && info.nextCursor ? info.nextCursor : null;
    app.total = typeof info.count === "number" ? info.count : null;
    app.labels = {};
    renderTable();
    loadLabels(model, app.rows).then(function (found) { if (found && model === app.model) renderTable(); });
    if (app.selected) {
      var still = app.rows.filter(function (r) { return r.id === app.selected.id; })[0];
      if (still && !app.dirty) openRow(still);
    }
  }).catch(function () {});
}

function labelFor(target, id) {
  var name = app.labels[target] && app.labels[target][id];
  return name ? name : shortId(String(id));
}

function cellContent(model, field, value) {
  if (value === null || value === undefined) return el("span", { class: "null", text: "null" });
  var type = typeOf(model, field);
  var target = referenceOf(model, field);
  if (target) {
    var chip = el("button", { class: "ref", type: "button", title: target + " " + value, onclick: function (event) {
      event.stopPropagation();
      jumpTo(target, value);
    } }, [labelFor(target, value)]);
    if (!(app.labels[target] && app.labels[target][value])) chip.className = "ref unnamed";
    return chip;
  }
  if (type === "id") return el("span", { class: "mono", title: value, text: shortId(value) });
  if (type === "boolean") return el("span", { class: value ? "bool-true" : "bool-false", text: value ? "true" : "false" });
  if (type === "date") return el("span", { class: "num", title: formatDate(value), text: shortDate(value) });
  if (type === "number") return el("span", { class: "num", text: Number(value).toLocaleString() });
  if (type === "json" || typeof value === "object") return el("span", { class: "mono", text: JSON.stringify(value) });
  return el("span", { title: String(value), text: String(value) });
}

function renderTable() {
  var grid = $("grid");
  var model = app.model;
  grid.innerHTML = "";
  $("filters").hidden = false;
  renderFilters();
  $("total").textContent = app.total === null ? "" : app.total.toLocaleString() + (app.total === 1 ? " row" : " rows");

  if (app.rows.length === 0) {
    $("foot").hidden = true;
    if (app.filters.length > 0) {
      grid.append(el("div", { class: "empty" }, [
        el("h2", { text: "No rows match these filters" }),
        el("p", { text: "Change or clear the filters to see more." }),
        el("button", { class: "btn", type: "button", text: "Clear filters", onclick: function () { app.filters = []; loadRows(false); } })
      ]));
    } else {
      grid.append(el("div", { class: "empty" }, [
        el("h2", { text: "No " + model + " rows yet" }),
        el("p", { text: "Rows your app writes appear here as they land. You can also add one by hand." }),
        el("button", { class: "btn primary", type: "button", text: "Add row", onclick: startCreate })
      ]));
    }
    return;
  }

  var cols = columns(model);
  var head = el("tr", null, cols.map(function (field) {
    var type = typeOf(model, field);
    var target = referenceOf(model, field);
    var sorted = app.order.field === field;
    var attr = namespace(model).attributes[field];
    var sortable = field === "id" || SYSTEM.indexOf(field) >= 0 || (attr && type !== "json" && type !== "any");
    return el("th", { "aria-sort": sorted ? (app.order.dir === "asc" ? "ascending" : "descending") : null }, [
      el("button", { type: "button", disabled: !sortable, title: sortable ? "Sort by " + field : null, onclick: function () {
        if (!sortable) return;
        app.order = { field: field, dir: sorted && app.order.dir === "asc" ? "desc" : "asc" };
        loadRows(false);
      } }, [
        el("span", null, [field, sorted ? el("span", { class: "dir", text: app.order.dir === "asc" ? " ↑" : " ↓" }) : null]),
        el("small", { text: target ? "→ " + target : type === "id" ? "" : type })
      ])
    ]);
  }));
  var body = el("tbody", null, app.rows.map(function (row) {
    return el("tr", {
      tabindex: "0",
      "aria-selected": app.selected && app.selected.id === row.id ? "true" : "false",
      onclick: function () { openRow(row); },
      onkeydown: function (event) { if (event.key === "Enter") openRow(row); }
    }, cols.map(function (field) { return el("td", null, [cellContent(model, field, row[field])]); }));
  }));
  grid.append(el("table", null, [el("thead", null, [head]), body]));

  $("foot").hidden = false;
  $("shown").textContent = "Showing " + app.rows.length.toLocaleString() + (app.total !== null ? " of " + app.total.toLocaleString() : "");
  $("more").hidden = !app.cursor;
}

// ---- Filters --------------------------------------------------------------

var OPS = [["is", "is"], ["$ne", "is not"], ["$gt", ">"], ["$gte", "≥"], ["$lt", "<"], ["$lte", "≤"]];

function parseValue(model, field, text) {
  var type = typeOf(model, field);
  if (text === "null") return null;
  if (type === "number") { var n = Number(text); if (isNaN(n)) throw new Error(field + " is a number."); return n; }
  if (type === "boolean") { if (text !== "true" && text !== "false") throw new Error(field + " is true or false."); return text === "true"; }
  if (type === "date") { var d = Date.parse(text); if (isNaN(d)) throw new Error(field + " needs a date, like 2026-11-17 or 2026-11-17T09:30."); return d; }
  return text;
}

function renderFilters() {
  var box = $("filters");
  box.innerHTML = "";
  var model = app.model;
  app.filters.forEach(function (f, index) {
    var label = OPS.filter(function (o) { return o[0] === f.op; })[0][1];
    var target = referenceOf(model, f.field);
    var shown = typeOf(model, f.field) === "date" && typeof f.value === "number" ? formatDate(f.value)
      : target && typeof f.value === "string" ? labelFor(target, f.value)
      : f.field === "id" && typeof f.value === "string" ? shortId(f.value)
      : JSON.stringify(f.value);
    box.append(el("span", { class: "chip" }, [
      f.field + " " + label + " " + shown,
      el("button", { type: "button", "aria-label": "Remove filter", text: "×", onclick: function () { app.filters.splice(index, 1); loadRows(false); } })
    ]));
  });
  if (!app.filtering) {
    box.append(el("button", { class: "btn", type: "button", text: app.filters.length ? "Add filter" : "Filter rows", onclick: function () { app.filtering = true; renderFilters(); box.querySelector("input").focus(); } }));
    if (app.filters.length > 0) box.append(el("button", { class: "linkish", type: "button", text: "Clear filters", onclick: function () { app.filters = []; loadRows(false); } }));
    return;
  }
  var fields = columns(model).filter(function (f) { var t = typeOf(model, f); return t !== "json" && t !== "any"; });
  var fieldSelect = el("select", { "aria-label": "Field" }, fields.map(function (f) { return el("option", { value: f, text: f }); }));
  if (fields.length > 1) fieldSelect.value = fields[1];
  var opSelect = el("select", { "aria-label": "Condition" }, OPS.map(function (o) { return el("option", { value: o[0], text: o[1] }); }));
  var input = el("input", { type: "text", "aria-label": "Value", placeholder: "Value" });
  var form = el("form", { class: "filter-form", onsubmit: function (event) {
    event.preventDefault();
    if (input.value.trim() === "") return;
    try {
      app.filters.push({ field: fieldSelect.value, op: opSelect.value, value: parseValue(model, fieldSelect.value, input.value.trim()) });
    } catch (error) { fail(error); return; }
    app.filtering = false;
    loadRows(false);
  } }, [fieldSelect, opSelect, input, el("button", { class: "btn", type: "submit", text: "Apply" }),
    el("button", { class: "linkish", type: "button", text: "Cancel", onclick: function () { app.filtering = false; renderFilters(); } })]);
  box.append(form);
  if (app.filters.length > 0) box.append(el("button", { class: "linkish", type: "button", text: "Clear filters", onclick: function () { app.filters = []; loadRows(false); } }));
}

function jumpTo(model, id) {
  selectModel(model);
  app.filters = [{ field: "id", op: "is", value: id }];
  loadRows(false).then(function () { if (app.rows[0]) openRow(app.rows[0]); });
}

// ---- Drawer: view, edit, create, delete ------------------------------------

function editorFor(model, field, value) {
  var attr = namespace(model).attributes[field];
  var type = attr.type;
  var target = referenceOf(model, field);
  var id = "f-" + field;
  var input;
  if (type === "boolean") {
    input = el("input", { type: "checkbox", id: id });
    input.checked = value === true;
    input = el("div", { class: "toggle" }, [input, el("span", { text: value === true ? "true" : "false" })]);
    input.firstChild.addEventListener("change", function (e) { input.lastChild.textContent = e.target.checked ? "true" : "false"; });
  } else if (type === "number") {
    input = el("input", { type: "number", step: "any", id: id, value: value === null || value === undefined ? "" : String(value) });
  } else if (type === "date") {
    var local = "";
    if (typeof value === "number") { var d = new Date(value); local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19); }
    input = el("input", { type: "datetime-local", step: "1", id: id, value: local });
  } else if (type === "json" || type === "any") {
    input = el("textarea", { id: id, spellcheck: "false" });
    input.value = value === undefined || value === null ? "" : JSON.stringify(value, null, 2);
  } else if (target) {
    input = relationPicker(id, target, value, attr.optional);
  } else {
    input = el("input", { type: "text", id: id, value: value === null || value === undefined ? "" : String(value) });
  }
  var note = target ? (attr.optional ? "a " + target + ", optional" : "a " + target) : type + (attr.optional ? ", optional" : "");
  return el("div", { class: "field", "data-field": field }, [
    el("label", { for: id }, [field, el("small", { text: note })]),
    input
  ]);
}

/** Picks a row of the target model by name; up to 500 rows, else an id box. */
function relationPicker(id, target, value, optional) {
  var current = typeof value === "string" ? value : "";
  var select = el("select", { id: id }, [el("option", { value: "", text: optional ? "None" : "Choose a " + target })]);
  if (current) select.append(el("option", { value: current, text: labelFor(target, current) }));
  select.value = current;
  var label = labelField(target);
  var options = { limit: 500, count: true, order: {} };
  options.order[label || "id"] = "asc";
  if (label) options.select = [label];
  var document = {};
  document[target] = { $: options };
  query(document).then(function (result) {
    var info = (result.pageInfo || {})[target] || {};
    if (info.hasMore) {
      var box = el("input", { type: "text", id: id, class: "mono", value: current, placeholder: "id of a " + target });
      select.replaceWith(box);
      return;
    }
    select.innerHTML = "";
    select.append(el("option", { value: "", text: optional ? "None" : "Choose a " + target }));
    ((result.data || {})[target] || []).forEach(function (row) {
      var name = label && row[label] ? row[label] : shortId(row.id);
      select.append(el("option", { value: row.id, text: name, title: row.id }));
    });
    select.value = current;
  }).catch(function () {});
  return select;
}

function readEditor(model) {
  var values = {};
  var attrs = namespace(model).attributes;
  Array.prototype.forEach.call($("editor").querySelectorAll("[data-field]"), function (node) {
    var field = node.getAttribute("data-field");
    var type = attrs[field].type;
    var input = node.querySelector("input, textarea, select");
    var raw = input.type === "checkbox" ? input.checked : input.value;
    if (type === "boolean") { values[field] = raw; return; }
    if (raw === "") { if (attrs[field].optional) values[field] = null; return; }
    if (type === "number") { var n = Number(raw); if (isNaN(n)) throw new Error(field + " must be a number."); values[field] = n; return; }
    if (type === "date") { var d = new Date(raw).getTime(); if (isNaN(d)) throw new Error(field + " must be a date."); values[field] = d; return; }
    if (type === "json" || type === "any") { try { values[field] = JSON.parse(raw); } catch (e) { throw new Error(field + " must be valid JSON."); } return; }
    values[field] = raw;
  });
  return values;
}

function openDrawer() {
  $("drawer").classList.add("open");
  app.dirty = false;
}

function closeDrawer() {
  $("drawer").classList.remove("open");
  app.selected = null;
  app.creating = false;
  app.dirty = false;
  resetDelete();
  Array.prototype.forEach.call(document.querySelectorAll("tbody tr[aria-selected=true]"), function (tr) { tr.setAttribute("aria-selected", "false"); });
}

function resetDelete() {
  var button = $("delete");
  button.className = "btn danger";
  button.textContent = "Delete row";
  button.dataset.armed = "";
}

function openRow(row) {
  var model = app.model;
  app.selected = row;
  app.creating = false;
  resetDelete();
  $("drawer-title").textContent = model;
  $("drawer-sub").textContent = row.id;
  $("save").textContent = "Save changes";
  $("delete").hidden = false;
  var form = $("editor");
  form.innerHTML = "";
  Object.keys(namespace(model).attributes).forEach(function (field) {
    if (field === "id") return;
    form.append(editorFor(model, field, row[field]));
  });
  var meta = el("dl", { class: "meta" });
  [["Created", row.createdAt], ["Updated", row.updatedAt]].forEach(function (pair) {
    if (pair[1] === undefined) return;
    meta.append(el("dt", { text: pair[0] }), el("dd", { class: "num", text: formatDate(pair[1]) }));
  });
  if (row.updatedSeq !== undefined) meta.append(el("dt", { text: "Last transaction" }), el("dd", { class: "num", text: "#" + row.updatedSeq }));
  form.append(meta);
  var back = referrers(model);
  if (back.length > 0) {
    var related = el("div", { class: "related" }, [el("h3", { text: "Related rows" })]);
    back.forEach(function (ref) {
      var button = el("button", { class: "linkish", type: "button", text: ref.model + " where " + ref.field + " is this row", onclick: function () {
        selectModel(ref.model);
        app.filters = [{ field: ref.field, op: "is", value: row.id }];
        loadRows(false);
      } });
      related.append(button);
      var document = {};
      var where = {};
      where[ref.field] = row.id;
      document[ref.model] = { $: { where: where, count: true, limit: 0 } };
      query(document).then(function (result) {
        var count = ((result.pageInfo || {})[ref.model] || {}).count;
        if (typeof count === "number") button.textContent = count.toLocaleString() + " " + ref.model + (count === 1 ? " row" : " rows") + " point here";
      }).catch(function () {});
    });
    form.append(related);
  }
  Array.prototype.forEach.call(document.querySelectorAll("tbody tr"), function (tr, i) {
    tr.setAttribute("aria-selected", app.rows[i] && app.rows[i].id === row.id ? "true" : "false");
  });
  openDrawer();
}

function startCreate() {
  var model = app.model;
  app.selected = null;
  app.creating = true;
  $("drawer-title").textContent = "New " + model;
  $("drawer-sub").textContent = "";
  $("save").textContent = "Add row";
  $("delete").hidden = true;
  var form = $("editor");
  form.innerHTML = "";
  Object.keys(namespace(model).attributes).forEach(function (field) {
    if (field === "id") return;
    form.append(editorFor(model, field, undefined));
  });
  form.append(el("p", { class: "hint", text: "Fields left empty take their default from the schema." }));
  openDrawer();
  var first = form.querySelector("input, textarea");
  if (first) first.focus();
}

$("editor").addEventListener("input", function () { app.dirty = true; });
$("editor").addEventListener("submit", function (event) {
  event.preventDefault();
  var model = app.model;
  var values;
  try { values = readEditor(model); } catch (error) { fail(error); return; }
  var save = $("save");
  save.disabled = true;
  var op = app.creating
    ? { op: "insert", namespace: model, id: uuid7(), values: values }
    : { op: "patch", namespace: model, id: app.selected.id, values: values };
  transact([op]).then(function () {
    toast(app.creating ? "Row added" : "Changes saved");
    var id = op.id;
    app.dirty = false;
    return Promise.all([reloadRows(), refreshCounts()]).then(function () {
      var row = app.rows.filter(function (r) { return r.id === id; })[0];
      if (row) openRow(row); else closeDrawer();
    });
  }).catch(fail).then(function () { save.disabled = false; });
});

$("delete").addEventListener("click", function () {
  var button = $("delete");
  if (button.dataset.armed !== "yes") {
    button.dataset.armed = "yes";
    button.className = "btn danger confirm";
    button.textContent = "Delete for good";
    return;
  }
  var id = app.selected.id;
  transact([{ op: "delete", namespace: app.model, id: id }]).then(function () {
    toast("Row deleted");
    closeDrawer();
    reloadRows();
    refreshCounts();
  }).catch(fail);
});

$("close").addEventListener("click", closeDrawer);
$("cancel").addEventListener("click", closeDrawer);
$("add").addEventListener("click", startCreate);
$("more").addEventListener("click", function () { loadRows(true); });
document.addEventListener("keydown", function (event) { if (event.key === "Escape" && $("drawer").classList.contains("open")) closeDrawer(); });

$("workspace").addEventListener("change", function (event) {
  var value = event.target.value;
  if (value === "__other") {
    $("workspace-id").hidden = false;
    $("workspace-id").focus();
    event.target.value = app.workspace || "";
    return;
  }
  openWorkspace(value);
});
$("workspace-id").addEventListener("keydown", function (event) {
  if (event.key !== "Enter") return;
  var id = event.target.value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) { fail(new Error("A workspace id is a UUID, like 0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b.")); return; }
  event.target.hidden = true;
  event.target.value = "";
  openWorkspace(id);
});

// ---- Start ------------------------------------------------------------------

function showEmpty(title, text, extra) {
  $("grid").innerHTML = "";
  $("foot").hidden = true;
  $("filters").hidden = true;
  $("grid").append(el("div", { class: "empty" }, [el("h2", { text: title }), el("p", { text: text }), extra || null]));
}

function start() {
  renderCounter(null, false);
  var saved = "";
  try { saved = localStorage.getItem(CURRENT_KEY) || ""; } catch (e) {}
  loadWorkspaces().catch(function () { app.manual = true; return null; }).then(function (found) {
    if (found === null) {
      renderWorkspaces();
      if (saved) { openWorkspace(saved); return; }
      $("workspace-id").hidden = false;
      showEmpty("Open a workspace", "Paste the id of the workspace you want to browse.");
      return;
    }
    renderWorkspaces();
    if (found.length > 0) {
      var pick = found.some(function (w) { return w.id === saved; }) ? saved : found[0].id;
      openWorkspace(pick);
      return;
    }
    showEmpty("No workspaces yet", "Open a workspace from your app and it shows up here.");
    var wait = setInterval(function () {
      loadWorkspaces().then(function (next) {
        if (next && next.length > 0) { clearInterval(wait); openWorkspace(next[0].id); }
      }).catch(function () {});
    }, 2000);
  });
  setInterval(function () {
    if (!app.manual) loadWorkspaces().then(function () { renderWorkspaces(); }).catch(function () {});
  }, 15000);
}
start();
</script>
</body>
</html>`;
}
