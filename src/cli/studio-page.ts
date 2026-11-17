/**
 * The studio's page: one HTML document, no build and no dependencies.
 *
 * It wears the tapedb brand (the landing page's "tape deck" language): the
 * cassette mark, signal orange on a dark ground, Space Grotesk headings, Inter
 * text and JetBrains Mono labels (served by the studio from `assets/fonts`),
 * hairlines, tick marks and stepped motion. Light follows the docs' light theme.
 *
 * A String.raw template: the script uses no backticks and no `${`, so the only
 * substitution is the page size.
 */

export function studioPage(pageLimit: number): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tapedb studio</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cpath fill='%23ECEEF0' fill-rule='evenodd' d='M11 10H53A7 7 0 0 1 60 17V47A7 7 0 0 1 53 54H11A7 7 0 0 1 4 47V17A7 7 0 0 1 11 10ZM13 29A8 8 0 1 0 29 29A8 8 0 1 0 13 29ZM35 29A8 8 0 1 0 51 29A8 8 0 1 0 35 29Z'/%3E%3Crect fill='%23FF6B1A' x='24' y='42' width='16' height='8' rx='1'/%3E%3C/svg%3E" />
<style>
@font-face { font-family: "Space Grotesk"; src: url("/fonts/space-grotesk.woff2") format("woff2"); font-weight: 300 700; font-display: swap; }
@font-face { font-family: "Inter"; src: url("/fonts/inter.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }
@font-face { font-family: "JetBrains Mono"; src: url("/fonts/jetbrains-mono.woff2") format("woff2"); font-weight: 100 800; font-display: swap; }

/* tapedb tokens: the landing page's dark theme, and the docs' light theme. */
:root {
  color-scheme: dark;
  --ground: #0c0d0e;
  --surface: #131517;
  --surface-2: #1a1d20;
  --line: #25292d;
  --line-strong: #3a4046;
  --text: #eceef0;
  --text-2: #a9b0b7;
  --text-3: #838b93;
  --accent: #ff6b1a;
  --accent-soft: #2a1a10;
  --on-accent: #0c0d0e;
  --ok: #4fb8a8;
  --display: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
  --sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --label: 12px;
  --tag: 2px;
  --control: 4px;
  --panel: 6px;
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --ground: #fafaf9;
    --surface: #f1f1ef;
    --surface-2: #e9e9e6;
    --line: #dededa;
    --line-strong: #c4c4bf;
    --text: #141516;
    --text-2: #4a4f55;
    --text-3: #5e646b;
    --accent: #b8440a;
    --accent-soft: #f6e4d8;
    --on-accent: #fafaf9;
    --ok: #1f6f63;
  }
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--text-2);
  font: 15px/1.5 var(--sans);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  display: grid;
  grid-template: "top top" 56px "side main" minmax(0, 1fr) "tape tape" auto / 248px minmax(0, 1fr);
}
button, input, select, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
::selection { background: var(--accent-soft); color: var(--text); }
.label { font: 500 var(--label)/20px var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-3); }
.mono { font-family: var(--mono); font-size: 13px; letter-spacing: 0.02em; }
.num { font-variant-numeric: tabular-nums; }
h1 i, h2 i { font-style: normal; color: var(--accent); }

/* Tape-style scrollbars, as on tapedb.dev: a hairline track with ticks; the thumb lights up orange. */
* { scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: repeating-linear-gradient(to bottom, var(--line-strong) 0 1px, transparent 1px 8px) left / 3px 100% no-repeat; }
::-webkit-scrollbar-thumb { background: var(--text-3); border: 3px solid var(--ground); border-radius: 0; }
::-webkit-scrollbar-thumb:hover { background: var(--accent); }

/* ---- Top bar ------------------------------------------------------------ */
.top {
  grid-area: top;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 20px;
  border-bottom: 1px solid var(--line);
}
.brand { display: inline-flex; align-items: center; gap: 10px; color: var(--text); text-decoration: none; }
.wordmark { font: 600 21px/1 var(--display); letter-spacing: -0.02em; }
.wordmark i { font-style: normal; color: var(--accent); }
.brand .label { padding-left: 12px; margin-left: 2px; border-left: 1px solid var(--line); }
.cassette .hub { transform-box: view-box; animation: hub 4s linear infinite; animation-play-state: paused; }
.cassette .hub.left { transform-origin: 22px 28px; }
.cassette .hub.right { transform-origin: 42px 28px; }
body.live .top .cassette .hub { animation-play-state: running; }
body.ff .top .cassette .hub { animation-duration: 0.4s; }
@keyframes hub { to { transform: rotate(360deg); } }
.top .spacer { flex: 1; }
.workspace { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.workspace select {
  appearance: none;
  -webkit-appearance: none;
  max-width: 300px;
  padding: 6px 28px 6px 10px;
  border: 1px solid var(--line);
  border-radius: var(--control);
  background: var(--surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23838b93' stroke-width='1.3'/%3E%3C/svg%3E") no-repeat right 10px center;
  color: var(--text);
  font: 500 12.5px/20px var(--mono);
  letter-spacing: 0.02em;
  cursor: pointer;
}
.workspace select:hover { border-color: var(--line-strong); }
.workspace input {
  width: 320px;
  padding: 6px 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--control);
  background: var(--surface);
  font: 12.5px/20px var(--mono);
}

/* ---- Sidebar -------------------------------------------------------------- */
aside { grid-area: side; border-right: 1px solid var(--line); overflow: auto; padding: 22px 12px; }
aside > .label { padding: 0 10px 10px; display: flex; justify-content: space-between; }
nav { display: grid; border-top: 1px solid var(--line); }
nav button {
  display: grid;
  grid-template-columns: 28px 1fr auto;
  align-items: center;
  min-height: 44px;
  padding: 0 10px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: none;
  text-align: left;
  cursor: pointer;
  color: var(--text-2);
}
nav button .idx { font: 12px var(--mono); color: var(--text-3); }
nav button .name { font-size: 15px; }
nav button .count { font: 12.5px var(--mono); letter-spacing: 0.02em; color: var(--text-3); }
nav button:hover { color: var(--text); background: var(--surface); }
nav button[aria-current="true"] { color: var(--text); background: var(--surface); box-shadow: inset 2px 0 0 var(--accent); }
nav button[aria-current="true"] .idx { color: var(--accent); }

/* ---- Main ------------------------------------------------------------------ */
main { grid-area: main; min-width: 0; min-height: 0; display: flex; flex-direction: column; padding: 22px 28px 20px; }
.head { display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.head h1 { margin: 2px 0 0; font: 500 34px/1.08 var(--display); letter-spacing: -0.025em; color: var(--text); }
.head .total { padding-bottom: 6px; }
.head .spacer { flex: 1; }
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 0 16px;
  border: 1px solid var(--line-strong);
  border-radius: var(--control);
  background: transparent;
  color: var(--text);
  font-size: 15px;
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover { border-color: var(--text-3); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 500; }
.btn.primary:hover { filter: brightness(1.08); }
.btn.small { min-height: 32px; padding: 0 12px; font-size: 14px; }
.btn.danger { color: var(--accent); }
.btn.danger.armed { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
.btn[disabled] { opacity: 0.5; cursor: default; }
.btn svg { display: block; }

.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; min-height: 32px; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 4px 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--control);
  background: var(--surface);
  font: 12.5px var(--mono);
  color: var(--text);
}
.chip .op { color: var(--accent); }
.chip button { border: 0; background: none; color: var(--text-3); cursor: pointer; padding: 2px 6px; font-size: 16px; line-height: 1; }
.chip button:hover { color: var(--text); }
.filter-form { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.filter-form select, .filter-form input {
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid var(--line-strong);
  border-radius: var(--control);
  background: var(--surface);
  font: 12.5px var(--mono);
}
.filter-form input { width: 200px; }
.quiet { border: 0; background: none; cursor: pointer; padding: 4px 6px; }
.quiet:hover { color: var(--text); }

/* The table panel: the demo panel's frame, mono header row, 52px rows on hairlines. */
.panel { flex: 0 1 auto; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--panel); background: var(--surface); overflow: hidden; }
.scroll { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
.panel.is-empty { flex: 1 1 auto; }
table { border-collapse: separate; border-spacing: 0; width: max-content; min-width: 100%; }
th { position: sticky; top: 0; z-index: 1; padding: 0; background: var(--surface); border-bottom: 1px solid var(--line); text-align: left; }
th button {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 10px 16px 9px;
  border: 0;
  background: none;
  text-align: left;
  cursor: pointer;
}
th button[disabled] { cursor: default; }
th .label { color: var(--text-3); text-transform: none; letter-spacing: 0.02em; }
th button:not([disabled]):hover .label { color: var(--text); }
th[aria-sort] .label { color: var(--text); }
th .dir { color: var(--accent); }
th .type { font: 11px var(--mono); letter-spacing: 0.02em; color: var(--line-strong); }
td {
  height: 52px;
  padding: 0 16px;
  border-bottom: 1px solid var(--line);
  max-width: 340px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}
tbody tr { cursor: pointer; }
tbody tr:hover td { background: var(--surface-2); }
tbody tr[aria-selected="true"] td { background: var(--surface-2); }
tbody tr[aria-selected="true"] td:first-child { box-shadow: inset 2px 0 0 var(--accent); }
tbody tr.arrived { animation: row 300ms cubic-bezier(0.2, 0.7, 0.1, 1) both; }
@keyframes row { from { transform: translateY(-8px); opacity: 0; } to { transform: none; opacity: 1; } }
td.id { color: var(--text-3); }
td .null { font: 12.5px var(--mono); color: var(--line-strong); }
td .date { color: var(--text-2); }
.bool { display: inline-flex; align-items: center; gap: 8px; font: 12.5px var(--mono); }
.bool.true { color: var(--ok); }
.bool.false { color: var(--text-3); }
.bool.false svg { color: var(--line-strong); }
.ref {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 2px 8px 2px 6px;
  border: 1px solid var(--line);
  border-radius: var(--control);
  background: var(--ground);
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
}
.ref:hover { border-color: var(--line-strong); }
.ref svg { color: var(--text-3); flex: none; }
.ref.unnamed span { font: 12.5px var(--mono); }
.tag { display: inline-block; margin-left: 10px; padding: 0 6px; border-radius: var(--tag); background: var(--accent-soft); font: 500 11px/18px var(--mono); letter-spacing: 0.08em; color: var(--accent); vertical-align: 1px; animation: fade 150ms steps(2, end) both; }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
.panel-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; padding: 0 16px; border-top: 1px solid var(--line); }

.empty { margin: auto; padding: 56px 24px; max-width: 540px; text-align: center; }
.empty h2 { margin: 12px 0 8px; font: 500 30px/1.15 var(--display); letter-spacing: -0.02em; color: var(--text); }
.empty p { margin: 0 0 20px; }
.empty pre { margin: 0 auto 20px; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--panel); background: var(--ground); text-align: left; font: 13px/1.8 var(--mono); color: var(--text-2); overflow: auto; }
.empty pre b { color: var(--accent); font-weight: 400; }
.empty .cassette { display: block; margin: 0 auto; color: var(--line-strong); }

/* ---- The transaction tape --------------------------------------------------------- */
.tape {
  grid-area: tape;
  display: flex;
  align-items: center;
  gap: 20px;
  min-height: 52px;
  padding: 0 20px;
  border-top: 1px solid var(--line);
  background: var(--ground);
}
.ticks { position: relative; flex: 1 1 200px; min-width: 120px; overflow: hidden; height: 22px; }
.ticks svg { position: absolute; left: -40px; top: 4px; width: calc(100% + 40px); height: 14px; }
.ticks svg line { stroke: var(--line-strong); }
.ticks.advance svg { animation: nudge 400ms steps(5, end); }
@keyframes nudge { from { transform: translateX(-40px); } to { transform: none; } }
.ticks .playhead { position: absolute; right: 0; top: 0; width: 2px; height: 22px; background: var(--accent); }
.tape .counter { color: var(--text); text-transform: none; letter-spacing: 0.02em; }
.tape .event { display: inline-flex; align-items: center; gap: 8px; min-width: 22ch; color: var(--text); text-transform: none; letter-spacing: 0.02em; }
.tape .event .lamp { width: 6px; height: 6px; border-radius: 1px; background: var(--accent); }
.tape .event.idle .lamp { border-radius: 50%; background: var(--ok); }
.tape .event.offline { color: var(--text-3); }
.tape .event.offline .lamp { border-radius: 50%; background: var(--line-strong); }
.tape .event.fresh { animation: enter 300ms cubic-bezier(0.2, 0.7, 0.1, 1) both; }
@keyframes enter { from { transform: translateY(6px); opacity: 0; } to { transform: none; opacity: 1; } }

/* ---- Row drawer --------------------------------------------------------------------------- */
.drawer {
  position: fixed;
  top: 56px;
  right: 0;
  bottom: 0;
  width: min(460px, 100vw);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-left: 1px solid var(--line-strong);
  transform: translateX(101%);
  transition: transform 200ms cubic-bezier(0.2, 0.7, 0.1, 1);
  z-index: 5;
}
.drawer.open { transform: none; }
.drawer header { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 0 20px; border-bottom: 1px solid var(--line); }
.drawer header .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drawer header .label b { color: var(--text); font-weight: 500; }
.keep { text-transform: none; letter-spacing: 0.02em; }
.drawer .close { border: 0; background: none; color: var(--text-3); cursor: pointer; font-size: 22px; line-height: 1; padding: 4px 6px; }
.drawer .close:hover { color: var(--text); }
.drawer .title { padding: 20px 20px 4px; }
.drawer .title h2 { margin: 0; font: 500 26px/1.15 var(--display); letter-spacing: -0.02em; color: var(--text); overflow-wrap: anywhere; }
.drawer .title .mono { color: var(--text-3); font-size: 12px; overflow-wrap: anywhere; }
.drawer form { flex: 1; overflow: auto; padding: 16px 20px 24px; display: grid; gap: 18px; align-content: start; }
.field label { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
.field label .label { color: var(--text-2); text-transform: none; letter-spacing: 0.02em; font-size: 13px; }
.field label .type { font: 11.5px var(--mono); color: var(--text-3); }
.field input[type=text], .field input[type=number], .field input[type=datetime-local], .field textarea, .field select {
  width: 100%;
  min-height: 40px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--control);
  background: var(--ground);
  color: var(--text);
  font-size: 15px;
}
.field input:hover, .field textarea:hover, .field select:hover { border-color: var(--line-strong); }
.field textarea { min-height: 96px; font: 13px/1.6 var(--mono); resize: vertical; }
.field input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--accent); margin: 0; }
.toggle { display: inline-flex; align-items: center; gap: 10px; min-height: 40px; font: 13px var(--mono); color: var(--text); }
.hint { margin: 0; font-size: 13px; color: var(--text-3); }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: 0 18px; margin: 0; padding-top: 14px; border-top: 1px solid var(--line); }
.meta dd { margin: 0; color: var(--text); font: 13px/20px var(--mono); }
.related { display: grid; gap: 4px; padding-top: 14px; border-top: 1px solid var(--line); }
.related button { justify-self: start; display: inline-flex; align-items: center; gap: 8px; padding: 6px 0; border: 0; background: none; color: var(--text); cursor: pointer; font-size: 15px; }
.related button:hover { color: var(--accent); }
.related button svg { color: var(--accent); }
.drawer footer { display: flex; align-items: center; gap: 8px; min-height: 64px; padding: 0 20px; border-top: 1px solid var(--line); }
.drawer footer .spacer { flex: 1; }

.toast {
  position: fixed;
  left: 50%;
  bottom: 68px;
  transform: translateX(-50%);
  display: none;
  align-items: center;
  gap: 10px;
  max-width: min(640px, 92vw);
  padding: 10px 14px;
  border: 1px solid var(--line-strong);
  border-radius: var(--panel);
  background: var(--surface-2);
  color: var(--text);
  font-size: 14px;
  z-index: 10;
}
.toast.show { display: inline-flex; }
.toast .lamp { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); flex: none; }
.toast.error { border-color: var(--accent); }
.toast.error .lamp { border-radius: 1px; background: var(--accent); }

@media (max-width: 800px) {
  html, body { height: auto; }
  body { grid-template: "top" auto "side" auto "main" auto "tape" auto / 1fr; }
  .top { flex-wrap: wrap; padding: 10px 14px; gap: 10px; }
  .brand .label { display: none; }
  .workspace { order: 3; flex-basis: 100%; }
  .workspace select { max-width: none; flex: 1; }
  aside { border-right: 0; border-bottom: 1px solid var(--line); padding: 10px 8px; }
  aside > .label { display: none; }
  nav { display: flex; overflow-x: auto; border-top: 0; }
  nav button { grid-template-columns: auto auto auto; gap: 8px; border-bottom: 0; white-space: nowrap; }
  main { padding: 16px 12px; }
  .panel { min-height: 60vh; }
  .ticks { display: none; }
  .drawer { top: 0; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
</style>
</head>
<body>
<header class="top">
  <a class="brand" href="/" aria-label="tapedb studio">
    <svg class="cassette" viewBox="0 0 64 64" width="28" height="28" aria-hidden="true">
      <path fill="currentColor" fill-rule="evenodd" d="M10 12H54A6 6 0 0 1 60 18V46A6 6 0 0 1 54 52H10A6 6 0 0 1 4 46V18A6 6 0 0 1 10 12ZM22 18H42A10 10 0 0 1 42 38H22A10 10 0 0 1 22 18Z"/>
      <g class="hub left"><circle cx="22" cy="28" r="5" fill="currentColor"/><rect x="21" y="20.5" width="2" height="3.5" fill="currentColor"/><rect x="21" y="20.5" width="2" height="3.5" fill="currentColor" transform="rotate(120 22 28)"/><rect x="21" y="20.5" width="2" height="3.5" fill="currentColor" transform="rotate(240 22 28)"/></g>
      <g class="hub right"><circle cx="42" cy="28" r="5" fill="currentColor"/><rect x="41" y="20.5" width="2" height="3.5" fill="currentColor"/><rect x="41" y="20.5" width="2" height="3.5" fill="currentColor" transform="rotate(120 42 28)"/><rect x="41" y="20.5" width="2" height="3.5" fill="currentColor" transform="rotate(240 42 28)"/></g>
      <rect x="24" y="43" width="16" height="4" rx="1" fill="var(--accent)"/>
    </svg>
    <span class="wordmark" translate="no">tapedb<i>.</i></span>
    <span class="label">Studio</span>
  </a>
  <span class="spacer"></span>
  <div class="workspace">
    <label class="label" for="workspace">Workspace</label>
    <select id="workspace"></select>
    <input id="workspace-id" type="text" placeholder="Paste a workspace id" hidden />
  </div>
</header>

<aside>
  <div class="label" id="models-head" hidden><span>Models</span><span>Rows</span></div>
  <nav id="models" aria-label="Models"></nav>
</aside>

<main>
  <div class="head" id="head" hidden>
    <div>
      <div class="label">Model</div>
      <h1 id="title"></h1>
    </div>
    <span class="total label num" id="total"></span>
    <span class="spacer"></span>
    <button class="btn primary" id="add" type="button">Add row</button>
  </div>
  <div class="filters" id="filters" hidden></div>
  <div class="panel" id="panel">
    <div class="scroll" id="grid"></div>
    <div class="panel-foot label" id="foot" hidden>
      <span id="shown" class="num"></span>
      <button class="btn small" id="more" type="button" hidden>Load more</button>
    </div>
  </div>
</main>

<footer class="tape label" id="tape" aria-label="Transaction tape" hidden>
  <span>Transaction tape</span>
  <div class="ticks" id="ticks" aria-hidden="true">
    <svg><defs><pattern id="tick" width="40" height="14" patternUnits="userSpaceOnUse"><line x1="0.5" y1="1" x2="0.5" y2="13"/><line x1="8.5" y1="7" x2="8.5" y2="13"/><line x1="16.5" y1="7" x2="16.5" y2="13"/><line x1="24.5" y1="7" x2="24.5" y2="13"/><line x1="32.5" y1="7" x2="32.5" y2="13"/></pattern></defs><rect width="100%" height="14" fill="url(#tick)"/><line x1="0" y1="13.5" x2="100%" y2="13.5"/></svg>
    <span class="playhead"></span>
  </div>
  <span class="counter num" id="counter" translate="no">tx_0000</span>
  <span class="event idle" id="event" aria-live="polite" translate="no"><span class="lamp"></span><span id="event-text">workspace.ready</span></span>
</footer>

<div class="drawer" id="drawer" role="dialog" aria-modal="false" aria-labelledby="drawer-title">
  <header>
    <span class="label" id="drawer-label"></span>
    <button class="close" id="close" type="button" aria-label="Close">×</button>
  </header>
  <div class="title">
    <h2 id="drawer-title"></h2>
    <div class="mono" id="drawer-sub"></div>
  </div>
  <form id="editor" novalidate></form>
  <footer>
    <button class="btn danger small" id="delete" type="button">Delete row</button>
    <span class="spacer"></span>
    <button class="btn small" id="cancel" type="button">Cancel</button>
    <button class="btn primary small" id="save" type="submit" form="editor">Save changes</button>
  </footer>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"><span class="lamp"></span><span id="toast-text"></span></div>

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
  filtering: false,
  selected: null,
  creating: false,
  dirty: false,
  seq: null,
  manual: false,
  labels: {},
  marks: {}
};

// ---- Icons (the landing page's) -------------------------------------------

var SVG = "http://www.w3.org/2000/svg";
function icon(kind, size) {
  var svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("width", size || 16);
  svg.setAttribute("height", size || 16);
  svg.setAttribute("viewBox", "0 0 18 18");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  var parts = {
    check: ["c9,9,7.25", "pM5.5 9.2l2.3 2.3 4.7-4.8"],
    ring: ["c9,9,7.25"],
    arrow: ["pM4 9h10M10 5l4 4-4 4"],
    plus: ["pM9 4v10M4 9h10"],
    link: ["pM7.5 10.5l3-3", "pM8.5 5.5l1.3-1.3a2.8 2.8 0 0 1 4 4L12.5 9.5", "pM9.5 12.5l-1.3 1.3a2.8 2.8 0 0 1-4-4L5.5 8.5"]
  }[kind];
  parts.forEach(function (part) {
    var node;
    if (part[0] === "c") {
      var c = part.slice(1).split(",");
      node = document.createElementNS(SVG, "circle");
      node.setAttribute("cx", c[0]); node.setAttribute("cy", c[1]); node.setAttribute("r", c[2]);
    } else {
      node = document.createElementNS(SVG, "path");
      node.setAttribute("d", part.slice(1));
    }
    svg.append(node);
  });
  return svg;
}

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

/** Text that ends in the brand's orange full stop. */
function stopped(node, text) {
  node.innerHTML = "";
  node.append(String(text), el("i", { text: "." }));
  return node;
}

var toastTimer = null;
function toast(message, isError) {
  var node = $("toast");
  $("toast-text").textContent = message;
  node.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { node.className = "toast"; }, isError ? 7000 : 2400);
}
function fail(error) { toast(error && error.message ? error.message : String(error), true); }

function shortId(id) { return id && id.length > 13 ? id.slice(0, 8) + "…" + id.slice(-4) : id; }
function pad(n, width) { var s = String(n); while (s.length < width) s = "0" + s; return s; }

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

// ---- Transport, tape and cassette -----------------------------------------

/** Connected or not: the reels turn while the studio follows the workspace. */
function setConnected(connected) {
  document.body.classList.toggle("live", connected);
  var node = $("event");
  if (!connected) {
    node.className = "event offline";
    $("event-text").textContent = "local database not reachable";
  } else if (node.classList.contains("offline")) {
    node.className = "event idle";
    $("event-text").textContent = "workspace.ready";
  }
}

var recTimer = null;
/** A write landed: the tape steps on, the lamp blinks, the hubs fast-forward. */
function recordOnTape(seq, event) {
  $("counter").textContent = "tx_" + pad(seq, 4);
  var node = $("event");
  node.className = "event";
  void node.offsetWidth;
  node.className = "event fresh";
  $("event-text").textContent = event;
  var ticks = $("ticks");
  ticks.classList.remove("advance");
  void ticks.offsetWidth;
  ticks.classList.add("advance");
  document.body.classList.add("ff");
  clearTimeout(recTimer);
  recTimer = setTimeout(function () { document.body.classList.remove("ff"); }, 700);
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

function labelFor(target, id) {
  var name = app.labels[target] && app.labels[target][id];
  return name ? name : shortId(String(id));
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
  if (app.workspaces.length === 0 && !app.workspace) select.append(el("option", { value: "", text: "None yet" }));
  var listed = app.workspaces.slice();
  if (app.workspace && !listed.some(function (w) { return w.id === app.workspace; })) listed.unshift({ id: app.workspace, updatedAt: null });
  listed.forEach(function (w) {
    var when = ago(w.updatedAt);
    select.append(el("option", { value: w.id, text: shortId(w.id) + (when ? "  (" + when + ")" : ""), title: w.id }));
  });
  select.append(el("option", { value: "__other", text: "Open by id…" }));
  select.value = app.workspace || "";
}

function loadWorkspaces(known) {
  return api("/api/workspaces" + (typeof known === "number" ? "?known=" + known : "")).then(function (result) {
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
  app.counts = {};
  app.labels = {};
  closeDrawer();
  renderWorkspaces();
  api("/api/schema", { workspaceId: id }).then(function (result) {
    app.schema = result.data;
    $("tape").hidden = false;
    $("models-head").hidden = app.schema.namespaces.length === 0;
    var first = app.schema.namespaces[0];
    renderModels();
    if (first) selectModel(first.apiName);
    else showEmpty("This schema has no models", "Add a model to tapedb.schema.ts, then run a migration.");
    refreshCounts();
    poll();
  }).catch(fail);
}

// ---- Sidebar --------------------------------------------------------------

function renderModels() {
  var nav = $("models");
  nav.innerHTML = "";
  if (!app.schema) return;
  app.schema.namespaces.forEach(function (n, index) {
    var count = app.counts[n.apiName];
    nav.append(el("button", {
      type: "button",
      "aria-current": n.apiName === app.model ? "true" : "false",
      onclick: function () { selectModel(n.apiName); }
    }, [
      el("span", { class: "idx", text: pad(index + 1, 2) }),
      el("span", { class: "name", text: n.apiName }),
      el("span", { class: "count num", text: count === undefined ? "" : pad(count, 3) })
    ]));
  });
}

function refreshCounts() {
  if (!app.schema) return Promise.resolve({});
  var document = {};
  app.schema.namespaces.forEach(function (n) { document[n.apiName] = { $: { count: true, limit: 0 } }; });
  return query(document).then(function (result) {
    var before = {};
    for (var name in app.counts) before[name] = app.counts[name];
    var info = result.pageInfo || {};
    Object.keys(info).forEach(function (name) { app.counts[name] = info[name].count; });
    renderModels();
    return before;
  });
}

// ---- Live: follow the workspace's sequence --------------------------------

/**
 * Follows the workspace: the room answers when a transaction lands (or after
 * 25 s with nothing new), so this is one request per write, not a timer.
 */
var watching = 0;
function poll() {
  var workspace = app.workspace;
  var run = ++watching;
  if (!workspace) return;
  var body = { workspaceId: workspace };
  if (app.seq !== null) body.after = app.seq;
  api("/api/status", body).then(function (result) {
    if (run !== watching) return;
    setConnected(true);
    var seq = (result.durability && result.durability.seq) || 0;
    var previous = app.seq;
    app.seq = seq;
    if (previous === null) { $("counter").textContent = "tx_" + pad(seq, 4); return; }
    if (seq === previous) return;
    return Promise.all([refreshCounts(), reloadRows(previous)]).then(function (results) {
      recordOnTape(seq, describeWrite(results[0], results[1], seq - previous));
    });
  }).then(function () {
    if (run === watching) poll();
  }, function () {
    if (run !== watching) return;
    setConnected(false);
    setTimeout(function () { if (run === watching) poll(); }, 3000);
  });
}

/** Names what landed, from what changed: "task.create", "column.delete", "task.update". */
function describeWrite(before, changed, transactions) {
  var parts = [];
  Object.keys(app.counts).forEach(function (name) {
    if (before[name] === undefined) return;
    var delta = app.counts[name] - before[name];
    if (delta > 0) parts.push(name + ".create" + (delta > 1 ? " ×" + delta : ""));
    if (delta < 0) parts.push(name + ".delete" + (delta < -1 ? " ×" + -delta : ""));
  });
  if (parts.length === 0 && changed > 0) parts.push(app.model + ".update" + (changed > 1 ? " ×" + changed : ""));
  if (parts.length === 0) parts.push(transactions > 1 ? transactions + " writes" : "write");
  return parts.join("  ");
}

// ---- Table ----------------------------------------------------------------

function selectModel(name) {
  app.model = name;
  app.filters = [];
  app.filtering = false;
  app.marks = {};
  app.order = { field: "id", dir: "asc" };
  closeDrawer();
  renderModels();
  $("head").hidden = false;
  stopped($("title"), name);
  loadRows(false);
}

function whereClause() {
  if (app.filters.length === 0) return undefined;
  var all = app.filters.map(function (f) {
    var condition = {};
    if (f.op === "is") condition[f.field] = f.value;
    else { var c = {}; c[f.op] = f.value; condition[f.field] = c; }
    return condition;
  });
  return all.length === 1 ? all[0] : { $and: all };
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

/**
 * After a write: the rows the page shows, fetched again. Rows that arrived
 * since the given sequence are tagged NEW, rows written since then CHANGED. Resolves to
 * how many rows on screen changed.
 */
function reloadRows(since) {
  if (!app.model) return Promise.resolve(0);
  var model = app.model;
  var known = {};
  app.rows.forEach(function (row) { known[row.id] = true; });
  var limit = Math.max(PAGE, app.rows.length);
  return query(pageDocument(null, limit)).then(function (result) {
    if (model !== app.model) return 0;
    var info = (result.pageInfo || {})[model] || {};
    app.rows = (result.data && result.data[model]) || [];
    app.cursor = info.hasMore && info.nextCursor ? info.nextCursor : null;
    app.total = typeof info.count === "number" ? info.count : null;
    var changed = 0;
    if (typeof since === "number") {
      app.rows.forEach(function (row) {
        if (!known[row.id]) { app.marks[row.id] = "new"; changed++; }
        else if (typeof row.updatedSeq === "number" && row.updatedSeq > since) { app.marks[row.id] = "changed"; changed++; }
      });
      var marked = Object.keys(app.marks);
      setTimeout(function () {
        marked.forEach(function (id) { delete app.marks[id]; });
        if (model === app.model) renderTable();
      }, 4000);
    }
    app.labels = {};
    renderTable();
    loadLabels(model, app.rows).then(function (found) { if (found && model === app.model) renderTable(); });
    if (app.selected) {
      var still = app.rows.filter(function (r) { return r.id === app.selected.id; })[0];
      if (still && !app.dirty) openRow(still);
    }
    return changed;
  }).catch(function () { return 0; });
}

function cellContent(model, field, value) {
  if (value === null || value === undefined) return el("span", { class: "null", text: "null" });
  var type = typeOf(model, field);
  var target = referenceOf(model, field);
  if (target) {
    var named = app.labels[target] && app.labels[target][value];
    return el("button", { class: "ref" + (named ? "" : " unnamed"), type: "button", title: "Open " + target + " " + value, onclick: function (event) {
      event.stopPropagation();
      jumpTo(target, value);
    } }, [icon("link", 14), el("span", { text: labelFor(target, value) })]);
  }
  if (type === "id") return el("span", { class: "mono", title: value, text: shortId(value) });
  if (type === "boolean") return el("span", { class: "bool " + (value ? "true" : "false") }, [icon(value ? "check" : "ring", 18), value ? "true" : "false"]);
  if (type === "date") return el("span", { class: "date num", title: formatDate(value), text: shortDate(value) });
  if (type === "number") return el("span", { class: "mono num", text: Number(value).toLocaleString() });
  if (type === "json" || typeof value === "object") return el("span", { class: "mono", text: JSON.stringify(value) });
  return el("span", { title: String(value), text: String(value) });
}

function renderTable() {
  var grid = $("grid");
  var model = app.model;
  grid.innerHTML = "";
  $("filters").hidden = false;
  renderFilters();
  $("total").textContent = app.total === null ? "" : pad(app.total, 2) + (app.total === 1 ? " row" : " rows");

  $("panel").classList.toggle("is-empty", app.rows.length === 0);
  if (app.rows.length === 0) {
    $("foot").hidden = true;
    if (app.filters.length > 0) {
      grid.append(el("div", { class: "empty" }, [
        stopped(el("h2"), "No rows match"),
        el("p", { text: "Change or clear the filters to see more." }),
        el("button", { class: "btn", type: "button", text: "Clear filters", onclick: function () { app.filters = []; loadRows(false); } })
      ]));
    } else {
      grid.append(el("div", { class: "empty" }, [
        el("div", { class: "label", text: model }),
        stopped(el("h2"), "Nothing on the tape yet"),
        el("p", { text: "Rows your app writes show up here as they land. You can also add one here." }),
        el("button", { class: "btn primary", type: "button", onclick: startCreate }, [icon("plus", 16), "Add row"])
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
        app.order = { field: field, dir: sorted && app.order.dir === "asc" ? "desc" : "asc" };
        loadRows(false);
      } }, [
        el("span", { class: "label" }, [field, sorted ? el("span", { class: "dir", text: app.order.dir === "asc" ? " ↑" : " ↓" }) : null]),
        el("span", { class: "type", text: target ? "→ " + target : type === "id" ? "uuid" : type })
      ])
    ]);
  }));
  var body = el("tbody", null, app.rows.map(function (row) {
    var mark = app.marks[row.id];
    return el("tr", {
      tabindex: "0",
      class: mark === "new" ? "arrived" : null,
      "aria-selected": app.selected && app.selected.id === row.id ? "true" : "false",
      onclick: function () { openRow(row); },
      onkeydown: function (event) { if (event.key === "Enter") openRow(row); }
    }, cols.map(function (field, index) {
      var cell = el("td", { class: field === "id" ? "id" : null }, [cellContent(model, field, row[field])]);
      if (index === 0 && mark) cell.append(el("span", { class: "tag", text: mark === "new" ? "NEW" : "CHANGED" }));
      return cell;
    }));
  }));
  grid.append(el("table", null, [el("thead", null, [head]), body]));

  $("foot").hidden = false;
  $("shown").textContent = "Showing " + app.rows.length + (app.total !== null ? " of " + app.total : "");
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
      f.field, el("span", { class: "op", text: label }), shown,
      el("button", { type: "button", "aria-label": "Remove filter", text: "×", onclick: function () { app.filters.splice(index, 1); loadRows(false); } })
    ]));
  });
  if (!app.filtering) {
    box.append(el("button", { class: "btn small", type: "button", onclick: function () { app.filtering = true; renderFilters(); box.querySelector("input").focus(); } }, [icon("plus", 14), app.filters.length ? "Add filter" : "Filter"]));
    if (app.filters.length > 0) box.append(el("button", { class: "quiet label", type: "button", text: "Clear", onclick: function () { app.filters = []; loadRows(false); } }));
    return;
  }
  var fields = columns(model).filter(function (f) { var t = typeOf(model, f); return t !== "json" && t !== "any"; });
  var fieldSelect = el("select", { "aria-label": "Field" }, fields.map(function (f) { return el("option", { value: f, text: f }); }));
  if (fields.length > 1) fieldSelect.value = fields[1];
  var opSelect = el("select", { "aria-label": "Condition" }, OPS.map(function (o) { return el("option", { value: o[0], text: o[1] }); }));
  var input = el("input", { type: "text", "aria-label": "Value", placeholder: "value" });
  box.append(el("form", { class: "filter-form", onsubmit: function (event) {
    event.preventDefault();
    if (input.value.trim() === "") return;
    try {
      app.filters.push({ field: fieldSelect.value, op: opSelect.value, value: parseValue(model, fieldSelect.value, input.value.trim()) });
    } catch (error) { fail(error); return; }
    app.filtering = false;
    loadRows(false);
  } }, [fieldSelect, opSelect, input, el("button", { class: "btn small primary", type: "submit", text: "Apply" }),
    el("button", { class: "quiet label", type: "button", text: "Cancel", onclick: function () { app.filtering = false; renderFilters(); } })]));
}

function jumpTo(model, id) {
  selectModel(model);
  app.filters = [{ field: "id", op: "is", value: id }];
  loadRows(false).then(function () { if (app.rows[0]) openRow(app.rows[0]); });
}

// ---- Drawer: view, edit, create, delete ------------------------------------

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
      select.replaceWith(el("input", { type: "text", id: id, class: "mono", value: current, placeholder: "id of a " + target }));
      return;
    }
    select.innerHTML = "";
    select.append(el("option", { value: "", text: optional ? "None" : "Choose a " + target }));
    ((result.data || {})[target] || []).forEach(function (row) {
      select.append(el("option", { value: row.id, text: label && row[label] ? row[label] : shortId(row.id), title: row.id }));
    });
    select.value = current;
  }).catch(function () {});
  return select;
}

function editorFor(model, field, value) {
  var attr = namespace(model).attributes[field];
  var type = attr.type;
  var target = referenceOf(model, field);
  var id = "f-" + field;
  var input;
  if (type === "boolean") {
    var box = el("input", { type: "checkbox", id: id });
    box.checked = value === true;
    var text = el("span", { text: value === true ? "true" : "false" });
    box.addEventListener("change", function () { text.textContent = box.checked ? "true" : "false"; });
    input = el("div", { class: "toggle" }, [box, text]);
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
  var note = target ? "→ " + target : type;
  if (attr.optional) note += ", optional";
  return el("div", { class: "field", "data-field": field }, [
    el("label", { for: id }, [el("span", { class: "label", text: field }), el("span", { class: "type", text: note })]),
    input
  ]);
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
  button.className = "btn danger small";
  button.textContent = "Delete row";
  button.dataset.armed = "";
}

function drawerLabel(model, suffix) {
  var node = $("drawer-label");
  node.innerHTML = "";
  node.append(el("b", { text: model }), " / ", el("span", { class: "keep", text: suffix }));
}

function openRow(row) {
  var model = app.model;
  app.selected = row;
  app.creating = false;
  app.dirty = false;
  resetDelete();
  drawerLabel(model, shortId(row.id));
  var name = labelField(model) && row[labelField(model)];
  stopped($("drawer-title"), name ? name : model);
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
    meta.append(el("dt", { class: "label", text: pair[0] }), el("dd", { class: "num", text: formatDate(pair[1]) }));
  });
  if (row.updatedSeq !== undefined) meta.append(el("dt", { class: "label", text: "Last write" }), el("dd", { class: "num", text: "tx_" + pad(row.updatedSeq, 4) }));
  form.append(meta);
  var back = referrers(model);
  if (back.length > 0) {
    var related = el("div", { class: "related" }, [el("div", { class: "label", text: "Pointing here" })]);
    back.forEach(function (ref) {
      var text = el("span", { text: ref.model + " rows" });
      related.append(el("button", { type: "button", onclick: function () {
        selectModel(ref.model);
        app.filters = [{ field: ref.field, op: "is", value: row.id }];
        loadRows(false);
      } }, [icon("arrow", 16), text]));
      var document = {};
      var where = {};
      where[ref.field] = row.id;
      document[ref.model] = { $: { where: where, count: true, limit: 0 } };
      query(document).then(function (result) {
        var count = ((result.pageInfo || {})[ref.model] || {}).count;
        if (typeof count === "number") text.textContent = count + " " + ref.model + (count === 1 ? " row" : " rows");
      }).catch(function () {});
    });
    form.append(related);
  }
  Array.prototype.forEach.call(document.querySelectorAll("tbody tr"), function (tr, i) {
    tr.setAttribute("aria-selected", app.rows[i] && app.rows[i].id === row.id ? "true" : "false");
  });
  $("drawer").classList.add("open");
}

function startCreate() {
  var model = app.model;
  app.selected = null;
  app.creating = true;
  app.dirty = false;
  drawerLabel(model, "new");
  stopped($("drawer-title"), "New " + model);
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
  $("drawer").classList.add("open");
  var first = form.querySelector("input, textarea, select");
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
  var creating = app.creating;
  var op = creating
    ? { op: "insert", namespace: model, id: uuid7(), values: values }
    : { op: "patch", namespace: model, id: app.selected.id, values: values };
  transact([op]).then(function () {
    toast(creating ? "Row added" : "Changes saved");
    app.dirty = false;
    return Promise.all([reloadRows(), refreshCounts()]).then(function () {
      var row = app.rows.filter(function (r) { return r.id === op.id; })[0];
      if (row) openRow(row); else closeDrawer();
    });
  }).catch(fail).then(function () { save.disabled = false; });
});

$("delete").addEventListener("click", function () {
  var button = $("delete");
  if (button.dataset.armed !== "yes") {
    button.dataset.armed = "yes";
    button.className = "btn danger small armed";
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
  if (event.key === "Escape") { event.target.hidden = true; return; }
  if (event.key !== "Enter") return;
  var id = event.target.value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) { fail(new Error("A workspace id is a UUID, like 0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b.")); return; }
  event.target.hidden = true;
  event.target.value = "";
  openWorkspace(id);
});

// ---- Start ------------------------------------------------------------------

function showEmpty(title, text, extra) {
  $("panel").classList.add("is-empty");
  $("head").hidden = true;
  $("filters").hidden = true;
  $("foot").hidden = true;
  $("grid").innerHTML = "";
  var cassette = document.querySelector(".brand .cassette").cloneNode(true);
  cassette.setAttribute("width", "64");
  cassette.setAttribute("height", "64");
  $("grid").append(el("div", { class: "empty" }, [cassette, stopped(el("h2"), title), el("p", { text: text }), extra || null]));
}

/** Waits for new local workspaces: one request per change, or per 25 s. */
function watchWorkspaces(onFirst) {
  if (app.manual) return;
  loadWorkspaces(app.workspaces.length).then(function (list) {
    if (list === null) return;
    renderWorkspaces();
    if (onFirst && list.length > 0) { onFirst(list[0].id); onFirst = null; }
    watchWorkspaces(onFirst);
  }, function () {
    setTimeout(function () { watchWorkspaces(onFirst); }, 3000);
  });
}

function start() {
  var saved = "";
  try { saved = localStorage.getItem(CURRENT_KEY) || ""; } catch (e) {}
  loadWorkspaces().catch(function () { app.manual = true; return null; }).then(function (found) {
    renderWorkspaces();
    if (found === null) {
      if (saved) { openWorkspace(saved); return; }
      $("workspace-id").hidden = false;
      showEmpty("Open a workspace", "Paste the id of the workspace you want to browse, at the top.");
      return;
    }
    if (found.length > 0) {
      openWorkspace(found.some(function (w) { return w.id === saved; }) ? saved : found[0].id);
      watchWorkspaces(null);
      return;
    }
    var create = el("button", { class: "btn primary", type: "button", onclick: function () { openWorkspace(uuid7()); } }, [icon("plus", 16), "Create a workspace"]);
    showEmpty("No workspaces yet", "Workspaces your app opens appear here by themselves. To look around first, create an empty one.", create);
    watchWorkspaces(function (id) { if (!app.workspace) openWorkspace(id); });
  });
}
start();
</script>
</body>
</html>`;
}
