/**
 * The studio's page: one HTML document, no build and no dependencies.
 *
 * It wears the tapedb brand (the landing page's "tape deck" language): the
 * cassette mark, signal orange on a dark ground, Space Grotesk headings, Inter
 * text and JetBrains Mono labels (served by the studio from `assets/fonts`),
 * hairlines, tick marks and stepped motion. Light follows the docs' light theme.
 *
 * A String.raw template: the script uses no backticks and no `${`. The
 * substitutions are the page size, the mode, the font path and the query
 * editor's translator (runner.gen.ts), which runs ahead of the page script.
 */

/**
 * `local`: served by `tapedb dev`'s studio server, which signs in with the dev
 * claim route and edits the project. `worker`: served by the deployed Worker at
 * /_tapedb/studio, signing in the way the app does (its identity decides the role).
 */
import { GRAPH_CSS, GRAPH_JS } from "./model-graph.gen";

export type StudioMode = "local" | "worker";

import { RUNNER } from "./runner.gen";

export function studioPage(pageLimit: number, mode: StudioMode = "local"): string {
  const fonts = mode === "worker" ? "/_tapedb/studio/fonts/" : "/fonts/";
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tapedb studio</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cstyle%3E.n%7Bfill:%23141516%7D.a%7Bfill:%23B8440A%7D@media(prefers-color-scheme:dark)%7B.n%7Bfill:%23ECEEF0%7D.a%7Bfill:%23FF6B1A%7D%7D%3C/style%3E%3Cpath class='n' fill-rule='evenodd' d='M11 10H53A7 7 0 0 1 60 17V47A7 7 0 0 1 53 54H11A7 7 0 0 1 4 47V17A7 7 0 0 1 11 10ZM13 29A8 8 0 1 0 29 29A8 8 0 1 0 13 29ZM35 29A8 8 0 1 0 51 29A8 8 0 1 0 35 29Z'/%3E%3Crect class='a' x='24' y='42' width='16' height='8' rx='1'/%3E%3C/svg%3E" />
<style>
@font-face { font-family: "Space Grotesk"; src: url("${fonts}space-grotesk.woff2") format("woff2"); font-weight: 300 700; font-display: swap; }
@font-face { font-family: "Inter"; src: url("${fonts}inter.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }
@font-face { font-family: "JetBrains Mono"; src: url("${fonts}jetbrains-mono.woff2") format("woff2"); font-weight: 100 800; font-display: swap; }

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
.workspace .listbox {
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
.workspace .listbox:hover { border-color: var(--line-strong); }
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
.filter-form .listbox, .filter-form input {
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid var(--line-strong);
  border-radius: var(--control);
  background: var(--surface);
  font: 12.5px var(--mono);
}
.filter-form input { width: 200px; }
.filter-form .listbox-wrap { flex: none; }
.filter-form .listbox { min-width: 140px; }
.who-pop .listbox { width: 100%; min-height: 34px; font-size: 14px; }
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

/* ---- Grid: selection, staged edits, columns, search ---- */
th.pick, td.pick { width: 76px; padding: 0 0 0 16px; white-space: nowrap; }
td.pick .open { margin-left: 8px; padding: 4px; border: 1px solid transparent; border-radius: var(--control); background: none; color: var(--text-3); cursor: pointer; vertical-align: middle; }
td.pick .open:hover, tr:hover td.pick .open { color: var(--text); border-color: var(--line-strong); }
th.pick input, td.pick input { width: 16px; height: 16px; accent-color: var(--accent); margin: 0; cursor: pointer; vertical-align: middle; }
th.pick { vertical-align: middle; }
tbody tr.picked td { background: color-mix(in srgb, var(--accent) 7%, var(--surface)); }
td.editable { cursor: text; }
td.staged { box-shadow: inset 2px 0 0 var(--accent); background: var(--accent-soft) !important; }
td.editing { padding: 0 6px; }
td.editing input { width: 100%; min-width: 120px; height: 36px; padding: 0 8px; border: 1px solid var(--accent); border-radius: var(--control); background: var(--ground); color: var(--text); font: inherit; }
.bulk { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; padding: 8px 8px 8px 14px; border: 1px solid var(--line-strong); border-radius: var(--panel); background: var(--surface-2); }
.bulk .what { color: var(--text); }
.bulk .spacer { flex: 1; }
.search { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: var(--control); background: var(--surface); color: var(--text-3); }
.search input { width: 220px; border: 0; background: none; outline: 0; color: var(--text); font-size: 14px; }
.search:focus-within { border-color: var(--text-3); }
.menu { position: relative; }
.menu .pop { position: absolute; top: calc(100% + 6px); left: 0; z-index: 4; min-width: 220px; max-height: 320px; overflow: auto; padding: 6px; border: 1px solid var(--line-strong); border-radius: var(--panel); background: var(--surface-2); }
.menu .pop label { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: var(--control); cursor: pointer; font: 13px var(--mono); color: var(--text); }
.menu .pop label:hover { background: var(--surface); }
.menu .pop input { accent-color: var(--accent); }
.menu .pop.recent { left: auto; right: 0; width: min(520px, 70vw); }
.menu .pop.end { left: auto; right: 0; min-width: 280px; }
.pop .pop-head { padding: 8px 8px 2px; text-transform: none; letter-spacing: 0.02em; }
.pop .pop-item { display: flex; width: 100%; justify-content: space-between; gap: 16px; padding: 6px 8px; border: 0; border-radius: var(--control); background: none; text-align: left; cursor: pointer; color: var(--text); font-size: 14px; }
.pop .pop-item:hover { background: var(--surface); }
.pop .pop-item .hint { font: 12.5px var(--mono); color: var(--text-3); }
.pop.recent button { display: block; width: 100%; padding: 6px 8px; border: 0; border-radius: var(--control); background: none; text-align: left; cursor: pointer; font: 13px/20px var(--mono); color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pop.recent button:hover { background: var(--surface); }
.impact { margin: 0; padding-left: 18px; }
.impact li { margin: 4px 0; }
.impact li.refused { color: var(--accent); }

/* ---- Query console ---- */
.tools { margin-top: 22px; }
.tools button { grid-template-columns: 28px 1fr; }
.tools button svg { color: var(--text-3); }
.tools button[aria-current="true"] svg { color: var(--accent); }
.console { position: relative; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.console .head p { margin: 0 0 6px; color: var(--text-3); font-size: 14px; }
.run kbd { margin-left: 4px; font: 12px var(--mono); opacity: 0.75; }
.code { position: relative; flex: none; display: grid; grid-template-columns: auto minmax(0, 1fr); height: 220px; min-height: 96px; resize: vertical; overflow: hidden; border: 1px solid var(--line-strong); border-radius: var(--panel); background: var(--ground); }
.code:focus-within { border-color: var(--text-3); }
.code .gutter { padding: 14px 10px 14px 14px; overflow: hidden; border-right: 1px solid var(--line); font: 13px/22px var(--mono); color: var(--line-strong); text-align: right; user-select: none; white-space: pre; }
.code .area { position: relative; min-width: 0; }
.code pre, .code textarea { position: absolute; inset: 0; margin: 0; padding: 14px 16px; border: 0; font: 14px/22px var(--mono); letter-spacing: 0; tab-size: 2; white-space: pre; overflow: auto; }
.code pre { pointer-events: none; color: var(--text-2); scrollbar-width: none; }
.code pre::-webkit-scrollbar { display: none; }
.code textarea { resize: none; background: none; color: transparent; caret-color: var(--text); outline: 0; }
.code textarea::selection { background: var(--accent-soft); color: transparent; }
.code .k { color: var(--text); }
.code .s { color: var(--ok); }
.code .n, .code .w { color: var(--accent); }
.code .c { color: var(--text-3); font-style: italic; }
.code .err { text-decoration: underline wavy var(--accent); text-underline-offset: 4px; }
.complete { position: absolute; z-index: 5; min-width: 200px; max-height: 232px; overflow: auto; padding: 4px; border: 1px solid var(--line-strong); border-radius: var(--panel); background: var(--surface-2); }
.complete button { display: flex; width: 100%; justify-content: space-between; gap: 18px; padding: 4px 8px; border: 0; border-radius: var(--control); background: none; text-align: left; cursor: pointer; font: 13px/20px var(--mono); color: var(--text); }
.complete button .hint { color: var(--text-3); }
.complete button[aria-selected="true"] { background: var(--accent-soft); }
.result-bar { display: flex; align-items: center; gap: 12px; min-height: 52px; flex-wrap: wrap; }
.result-bar .what { color: var(--text); }
.result-bar .what.error { color: var(--accent); }
.result-bar .spacer { flex: 1; }
.seg { display: inline-flex; border: 1px solid var(--line-strong); border-radius: var(--control); overflow: hidden; }
.seg button { min-height: 30px; padding: 0 12px; border: 0; background: none; cursor: pointer; color: var(--text-3); font-size: 14px; }
.seg button[aria-pressed="true"] { background: var(--surface-2); color: var(--text); }
.console .panel { flex: 1 1 auto; }
.json { margin: 0; padding: 14px 16px; font: 13px/20px var(--mono); color: var(--text-2); white-space: pre; }
.figure { margin: auto; padding: 48px 24px; text-align: center; }
.figure b { display: block; font: 500 64px/1 var(--display); letter-spacing: -0.03em; color: var(--text); font-variant-numeric: tabular-nums; }
.figure span { display: block; margin-top: 10px; }
.confirm { margin: auto; padding: 32px 24px; max-width: 560px; }
.confirm h2 { margin: 0 0 10px; font: 500 26px/1.2 var(--display); letter-spacing: -0.02em; color: var(--text); }
.confirm .impact { margin-bottom: 18px; }
.confirm .actions { display: flex; gap: 10px; }
.problem { margin: auto; padding: 32px 24px; max-width: 640px; }
.problem p { margin: 0; color: var(--text); font: 14px/22px var(--mono); white-space: pre-wrap; }
td .many { font: 12.5px var(--mono); color: var(--text-3); }

 /* ---- Access ---- */
.access { flex: 1 1 auto; min-height: 0; overflow: auto; }
.access .head p { margin: 0 0 6px; max-width: 72ch; color: var(--text-3); font-size: 14px; }
.access .panel { margin-bottom: 18px; }
.access-table { width: 100%; table-layout: fixed; }
.access-table th:first-child { width: 160px; }
.access-table thead th { padding: 12px 16px; }
.access-table tbody th { padding: 16px; text-align: left; vertical-align: top; font-weight: 400; color: var(--text); position: static; background: none; border-bottom: 1px solid var(--line); }
.access-table td.rule { vertical-align: top; padding: 14px 16px; white-space: normal; }
.access-table tr:last-child th, .access-table tr:last-child td { border-bottom: 0; }
.model-link { border: 0; background: none; padding: 0; cursor: pointer; color: var(--text); font-size: 15px; }
.model-link:hover { color: var(--accent); }
.rule .what { display: flex; align-items: center; gap: 10px; color: var(--text); }
.rule .you { display: flex; align-items: flex-start; gap: 6px; margin-top: 6px; font-size: 13.5px; color: var(--text-3); }
.rule .you svg { flex: none; margin-top: 3px; }
.rule .you.yes { color: var(--ok); }
.rule code, .code pre, .code textarea, .json { font-variant-ligatures: none; font-feature-settings: "calt" 0, "liga" 0; }
.rule code { display: block; margin-top: 10px; padding: 8px 10px; border-radius: var(--control); background: var(--ground); font: 12.5px/18px var(--mono); color: var(--text-2); white-space: pre-wrap; word-break: break-word; }
.rule .default { display: inline-block; margin-top: 8px; text-transform: none; letter-spacing: 0.02em; color: var(--line-strong); }
.ladder { display: inline-flex; gap: 2px; }
.ladder i { display: block; width: 4px; height: 14px; background: var(--line-strong); }
.ladder i.on { background: var(--accent); }
.ladder i.you { height: 20px; margin: -3px 0; background: var(--text-3); }
.ladder i.on.you { background: var(--text); }
button.who { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: var(--control); background: none; cursor: pointer; color: var(--text); }
button.who:hover { border-color: var(--text-3); }
button.who .role { font-size: 14px; }
button.who .sub { color: var(--text-3); max-width: 18ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button.who.as { border-color: var(--accent); background: var(--accent-soft); }
button.who.as .label { color: var(--accent); }
.who-pop { min-width: 300px; padding: 10px; }
.menu .who-pop .field { display: grid; grid-template-columns: 70px 1fr; align-items: center; gap: 10px; padding: 6px 8px; cursor: default; font: 14px var(--sans); color: var(--text-2); }
.who-pop select, .who-pop input { min-height: 32px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: var(--control); background: var(--surface); color: var(--text); font: 13px var(--mono); }
.who-pop .hint { margin: 6px 8px 10px; font-size: 13px; color: var(--text-3); }
.who-pop .actions { display: flex; justify-content: flex-end; gap: 8px; padding: 0 8px 4px; }
/* ---- History ---- */
.history { flex: 1 1 auto; min-height: 0; overflow: auto; }
.history .head p { margin: 0 0 6px; max-width: 72ch; color: var(--text-3); font-size: 14px; }
.history .select select { min-height: 32px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: var(--control); background: var(--surface); color: var(--text); font-size: 14px; }
.log { margin: 0; padding: 0; list-style: none; }
.entry { border-bottom: 1px solid var(--line); }
.entry:last-child { border-bottom: 0; }
.entry.focus { box-shadow: inset 2px 0 0 var(--accent); }
.entry-head { display: flex; align-items: center; gap: 14px; width: 100%; min-height: 52px; padding: 0 16px; border: 0; background: none; text-align: left; cursor: pointer; color: var(--text-2); }
.entry-head:hover { background: var(--surface-2); }
.entry-head .seq { font: 13px var(--mono); color: var(--text); }
.entry.open .entry-head .seq, .entry.focus .entry-head .seq { color: var(--accent); }
.entry-head .summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.entry-head .who-wrote { font: 13px var(--mono); color: var(--text-2); }
.entry-head .when { font: 12.5px var(--mono); color: var(--text-3); min-width: 9ch; text-align: right; }
.ops { margin: 0; padding: 4px 16px 16px 92px; list-style: none; display: grid; gap: 12px; }
.op-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.op-head .verb { font: 500 12px/20px var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }
.op-head .verb.insert { color: var(--ok); }
.op-head .verb.delete, .op-head .verb.deleteIds { color: var(--accent); }
.op-head .model { color: var(--text); }
.op-head .count { font: 12.5px var(--mono); color: var(--text-3); }
.op-head .ref { min-height: 26px; padding: 0 8px; }
.values { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 8px 0 0; }
.values dt { font: 12.5px/20px var(--mono); color: var(--text-3); }
.values dd { margin: 0; font-size: 12.5px; line-height: 20px; color: var(--text); word-break: break-word; }
.values dd.hidden-values { font-family: var(--sans); color: var(--text-3); }
.history .note, .drawer .note { margin: 6px 0 0; font-size: 13px; color: var(--text-3); }
.history .more { display: flex; justify-content: center; padding-bottom: 18px; }
.history .panel { margin-bottom: 14px; }
.tape .counter { border: 0; background: none; padding: 0; cursor: pointer; font: inherit; }
.tape .counter:hover { color: var(--accent); }
.tx-link { border: 0; background: none; padding: 0; cursor: pointer; color: var(--text); font: inherit; }
.tx-link:hover { color: var(--accent); }
.changes button { display: grid; grid-template-columns: 8ch 1fr auto; gap: 12px; width: 100%; font-size: 14px; }
.changes .seq, .changes .when { font: 12.5px var(--mono); color: var(--text-3); }
/* ---- Data / Structure tabs (the landing page's code tab: underline in text colour) ---- */
.tabs { display: flex; gap: 22px; margin: -4px 0 16px; border-bottom: 1px solid var(--line); }
.tabs button { position: relative; padding: 0 0 10px; border: 0; background: none; cursor: pointer; color: var(--text-3); }
.tabs button:hover { color: var(--text); }
.tabs button[aria-selected="true"] { color: var(--text); }
.tabs button[aria-selected="true"]::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: var(--text); }

/* ---- Structure ---- */
.structure { display: grid; gap: 14px; align-content: start; min-height: 0; overflow: auto; }
.structure .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.structure .bar .spacer { flex: 1; }
.fields { border: 1px solid var(--line); border-radius: var(--panel); background: var(--surface); overflow: hidden; }
.fields table { width: 100%; }
.fields td { height: 56px; max-width: none; }
.fields tbody tr { cursor: default; }
.fields td.name { font: 500 14px var(--mono); letter-spacing: 0.02em; }
.fields td.kind { color: var(--text-2); }
.fields td.kind .target { color: var(--text); }
.fields td.acts { width: 1%; text-align: right; }
.fields td.acts .quiet { opacity: 0; }
.fields tr:hover td.acts .quiet, .fields td.acts .quiet:focus-visible { opacity: 1; }
.acts-row { display: flex; gap: 2px; justify-content: flex-end; }
.danger-text { color: var(--accent); }
.th-label { display: block; padding: 10px 16px; }
.fields tr.system td { color: var(--text-3); height: 44px; }
.flag { display: inline-block; margin-right: 6px; padding: 0 6px; border: 1px solid var(--line-strong); border-radius: var(--tag); font: 11.5px/18px var(--mono); color: var(--text-2); }
.code-note { font: 12.5px var(--mono); color: var(--text-3); }
.notice { padding: 12px 14px; border: 1px solid var(--line-strong); border-radius: var(--panel); background: var(--surface); font-size: 14px; }
.notice.warn { border-color: var(--accent); background: var(--accent-soft); color: var(--text); }
.notice .label { display: block; margin-bottom: 4px; }
.notice ul { margin: 6px 0 0; padding-left: 18px; }
.new-model { display: flex; align-items: center; gap: 8px; width: 100%; margin-top: 10px; padding: 8px 10px; border: 1px dashed var(--line-strong); border-radius: var(--control); background: none; color: var(--text-2); cursor: pointer; }
.new-model:hover { color: var(--text); border-color: var(--text-3); }

/* ---- Review: the code diff and the SQL ---- */
.code { margin: 0; padding: 10px 0; border: 1px solid var(--line); border-radius: var(--panel); background: var(--ground); font: 12.5px/1.7 var(--mono); overflow: auto; }
.code div { padding: 0 14px; white-space: pre; }
.code .add { background: color-mix(in srgb, var(--ok) 14%, transparent); }
.code .add::before { content: "+ "; color: var(--ok); }
.code .del { background: var(--accent-soft); }
.code .del::before { content: "- "; color: var(--accent); }
.code .ctx::before { content: "  "; }
.code .gap { color: var(--text-3); }
.sheet .body { flex: 1; overflow: auto; padding: 16px 20px 24px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-content: start; }
.sheet .body > * { min-width: 0; }
.sheet .body .label { margin-bottom: 6px; }
.check { display: inline-flex; align-items: center; gap: 10px; font-size: 14px; color: var(--text); cursor: pointer; }
/* The input keeps the browser's semantics and .checked; the box beside it is ours. */
.check input { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; pointer-events: none; }
.check .box {
  width: 18px; height: 18px; flex: none;
  border: 1px solid var(--line-strong); border-radius: 5px; background: var(--ground);
  display: inline-flex; align-items: center; justify-content: center;
  transition: background .12s linear, border-color .12s linear;
}
.check input:checked + .box { background: var(--accent); border-color: var(--accent); }
.check input:checked + .box::after {
  content: ""; width: 9px; height: 5px;
  border-left: 2px solid var(--on-accent); border-bottom: 2px solid var(--on-accent);
  transform: rotate(-45deg) translateY(-1px);
}
.check input:focus-visible + .box { outline: 2px solid var(--accent); outline-offset: 2px; }
/* A native select opens the OS menu, which ignores the page's type and colour.
   The Landing page uses a summary/details listbox; this is the same shape. */
.listbox-wrap { position: relative; }
.field .listbox {
  width: 100%; min-height: 40px; padding: 8px 10px;
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  border: 1px solid var(--line); border-radius: var(--control);
  background: var(--ground); color: var(--text); font-size: 15px; text-align: left;
  appearance: none; cursor: pointer; transition: border-color .12s linear;
}
.field .listbox:hover { border-color: var(--line-strong); }
.listbox-chev {
  width: 7px; height: 7px; flex: none;
  border-right: 1.5px solid var(--text-3); border-bottom: 1.5px solid var(--text-3);
  transform: rotate(45deg) translateY(-2px); transition: transform .12s linear;
}
.listbox[aria-expanded=true] .listbox-chev { transform: rotate(-135deg) translateY(-2px); }
.listbox-menu {
  position: absolute; z-index: 60; left: 0; right: 0; margin-top: 6px; padding: 4px;
  background: var(--surface); border: 1px solid var(--line-strong); border-radius: var(--panel);
  box-shadow: 0 18px 40px rgb(0 0 0 / .38); max-height: 260px; overflow: auto;
}
.listbox-menu[hidden] { display: none; }
.listbox-option {
  display: block; width: 100%; min-height: 34px; padding: 0 10px;
  border: 0; border-radius: var(--control); background: transparent;
  color: var(--text-2); font-size: 14px; text-align: left; cursor: pointer;
}
.listbox-option:hover, .listbox-option:focus-visible { background: var(--surface-2); color: var(--text); outline: none; }
.listbox-option[aria-selected=true] { color: var(--text); }
.listbox-option[aria-selected=true]::after { content: "✓"; float: right; color: var(--accent); }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

/* The model graph: React Flow needs a sized box, and the page owns the chrome. */
.graph { position: relative; flex: 1 1 auto; min-height: 60vh; border: 1px solid var(--line); border-radius: var(--panel); overflow: hidden; background: var(--ground); }
.graph .react-flow__attribution { background: transparent; color: var(--text-3); }
.graph .react-flow__controls button { background: var(--surface); border-bottom: 1px solid var(--line); color: var(--text); }
.graph .react-flow__controls button:hover { background: var(--surface-2); }
.graph .react-flow__controls button svg { fill: currentColor; }

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
.field input[type=text], .field input[type=number], .field input[type=datetime-local], .field textarea {
  width: 100%;
  min-height: 40px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--control);
  background: var(--ground);
  color: var(--text);
  font-size: 15px;
}
.field input:hover, .field textarea:hover { border-color: var(--line-strong); }
.field textarea { min-height: 96px; font: 13px/1.6 var(--mono); resize: vertical; }
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
  .workspace .listbox { max-width: none; flex: 1; }
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
${GRAPH_CSS}
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
  <div class="menu" id="who-menu" hidden></div>
  <div class="workspace">
    <label class="label" for="workspace-trigger">Workspace</label>
    <span id="workspace-mount"></span>
    <input id="workspace-id" type="text" placeholder="Paste a workspace id" hidden />
  </div>
</header>

<aside>
  <div class="label" id="models-head" hidden><span>Models</span><span>Rows</span></div>
  <nav id="models" aria-label="Models"></nav>
  <button class="new-model" id="new-model" type="button" hidden>+ New model</button>
  <nav class="tools" id="tools" aria-label="Tools" hidden>
    <button type="button" id="open-query" aria-current="false"></button>
    <button type="button" id="open-access" aria-current="false"></button>
    <button type="button" id="open-history" aria-current="false"></button>
  </nav>
</aside>

<main>
  <div class="head" id="head" hidden>
    <div>
      <div class="label">Model</div>
      <h1 id="title"></h1>
    </div>
    <span class="total label num" id="total"></span>
    <span class="spacer"></span>
    <div class="menu" id="export-menu"></div>
    <button class="btn" id="import" type="button">Import</button>
    <input type="file" id="import-file" accept=".csv,.json,text/csv,application/json" hidden />
    <button class="btn primary" id="add" type="button">Add row</button>
  </div>
  <div class="tabs" id="tabs" role="tablist" hidden>
    <button type="button" role="tab" id="tab-data" aria-selected="true">Data</button>
    <button type="button" role="tab" id="tab-structure" aria-selected="false">Structure</button>
    <button type="button" role="tab" id="tab-graph" aria-selected="false">Graph</button>
  </div>
  <div class="structure" id="structure" hidden></div>
  <div class="graph" id="graph" hidden></div>
  <div class="filters" id="filters" hidden></div>
  <div class="bulk" id="bulk" hidden></div>
  <section class="history" id="history" aria-label="History" hidden>
    <div class="head">
      <div>
        <h1 id="history-title"></h1>
        <p>Every transaction the workspace keeps, newest first: what it wrote, and who wrote it when audit is on.</p>
      </div>
    </div>
    <div id="history-body"></div>
  </section>
  <section class="access" id="access" aria-label="Access" hidden>
    <div class="head">
      <div>
        <h1 id="access-title"></h1>
        <p>Who may read and change each model, from the rules in tapedb.schema.ts, and what they mean for whoever the studio is signed in as.</p>
      </div>
    </div>
    <div id="access-body"></div>
  </section>
  <section class="console" id="console" aria-label="Query" hidden>
    <div class="head">
      <div>
        <h1 id="console-title"></h1>
        <p>Calls as written in your app, run with your sign-in and its access rules.</p>
      </div>
      <span class="spacer"></span>
      <div class="menu" id="recent-menu"></div>
      <button class="btn primary run" id="run" type="button"></button>
    </div>
    <div class="code" id="code">
      <div class="gutter" id="gutter" aria-hidden="true"></div>
      <div class="area">
        <pre id="code-view" aria-hidden="true"></pre>
        <textarea id="code-input" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" aria-label="Query" aria-autocomplete="list" aria-controls="complete"></textarea>
      </div>
    </div>
    <div class="complete" id="complete" role="listbox" hidden></div>
    <div class="result-bar" id="result-bar"></div>
    <div class="panel" id="result-panel" hidden>
      <div class="scroll" id="result"></div>
    </div>
  </section>
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
  <button class="counter num" id="counter" type="button" translate="no" title="Open the history">tx_0000</button>
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
<div class="drawer sheet" id="sheet" role="dialog" aria-modal="false" aria-labelledby="sheet-title">
  <header>
    <span class="label" id="sheet-label"></span>
    <button class="close" id="sheet-close" type="button" aria-label="Close">×</button>
  </header>
  <div class="title">
    <h2 id="sheet-title"></h2>
  </div>
  <div class="body" id="sheet-body"></div>
  <footer>
    <button class="btn small" id="sheet-back" type="button" hidden>Back</button>
    <span class="spacer"></span>
    <button class="btn small" id="sheet-cancel" type="button">Cancel</button>
    <button class="btn primary small" id="sheet-go" type="button"></button>
  </footer>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"><span class="lamp"></span><span id="toast-text"></span></div>

<script>
${GRAPH_JS}
${RUNNER}
var PAGE = ${pageLimit};
var MODE = "${mode}";
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
  marks: {},
  view: "data",
  structure: null,
  picked: {},
  staged: {},
  search: "",
  tool: "",
  viewAs: {},
  ownRole: null
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
    search: ["c8,8,5", "pM12 12l3.5 3.5"],
    prompt: ["pM4 5.5l3.5 3.5L4 12.5", "pM9.5 13h4.5"],
    clock: ["c9,9,6.5", "pM9 5.5V9l2.5 1.5"],
    shield: ["pM9 2.5l5.5 2v4.2c0 3.2-2.3 5.6-5.5 6.8-3.2-1.2-5.5-3.6-5.5-6.8V4.5z"],
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

function localApi(path, body) {
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
        var failure = new Error(message);
        failure.status = response.status;
        failure.code = parsed && parsed.error && parsed.error.code;
        throw failure;
      }
      return parsed;
    });
  });
}


// ---- Deployed: sign in the way the app does, call the Worker's engine routes ----

var ROLES = ["Guest", "User", "Member", "Editor", "Moderator", "Admin", "Owner", "Founder", "Developer"];
var claims = {};

function readJson(response) {
  return response.text().then(function (text) {
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }
    if (!response.ok || (parsed && parsed.ok === false)) {
      var error = new Error((parsed && parsed.error && parsed.error.message) || text.slice(0, 300) || ("HTTP " + response.status));
      error.status = response.status;
      error.code = parsed && parsed.error && parsed.error.code;
      throw error;
    }
    return parsed;
  });
}

/** A claim for the workspace from the app's own sign-in (cookies go along). */
function claimFor(workspace, fresh) {
  if (!fresh && claims[workspace] && claims[workspace].until > Date.now()) return Promise.resolve(claims[workspace].token);
  return fetch("/_tapedb/claim", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(app.viewAs.role === undefined ? { workspaceId: workspace } : { workspaceId: workspace, role: app.viewAs.role })
  }).then(readJson, function () { throw new Error("The Worker could not be reached."); }).then(function (result) {
    var seconds = typeof result.expiresIn === "number" ? result.expiresIn : 300;
    claims[workspace] = { token: result.token, until: Date.now() + (seconds - 30) * 1000 };
    return result.token;
  }).catch(function (error) {
    if (error.status === 401) throw new Error("Sign in to the app first: this studio uses its sign-in.");
    if (error.status === 403) throw new Error("Your sign-in has no access to this workspace.");
    throw error;
  });
}

function engine(workspace, path, init) {
  var call = function (token) {
    var headers = { authorization: "Bearer " + token };
    if (init && init.body) headers["content-type"] = "application/json";
    return fetch("/engine/workspaces/" + workspace + path, { method: (init && init.method) || "GET", headers: headers, body: init && init.body });
  };
  return claimFor(workspace, false).then(call).then(function (response) {
    if (response.status !== 401) return readJson(response);
    return claimFor(workspace, true).then(call).then(readJson);
  });
}

function workerApi(path, body) {
  var ws = body && body.workspaceId;
  if (path.indexOf("/api/workspaces") === 0) return Promise.resolve({ workspaces: null });
  if (path === "/api/structure") return Promise.resolve({ editable: false, deployed: true, reason: "This is the deployed app. Change the schema in tapedb.schema.ts, then npx tapedb-cli deploy." });
  if (path === "/api/schema") return engine(ws, "/schema");
  if (path === "/api/query") return engine(ws, "/query", { method: "POST", body: JSON.stringify({ query: body.query }) });
  if (path === "/api/transact") return engine(ws, "/transact", { method: "POST", body: JSON.stringify(body.body) });
  if (path === "/api/status") return engine(ws, "/status" + (typeof body.after === "number" ? "?after=" + body.after : ""));
  if (path === "/api/log" || path === "/api/history") {
    var params = new URLSearchParams();
    Object.keys(body.params || {}).forEach(function (key) { if (body.params[key] !== undefined && body.params[key] !== null) params.set(key, String(body.params[key])); });
    var query = params.toString();
    return engine(ws, (path === "/api/log" ? "/log" : "/history") + (query ? "?" + query : ""));
  }
  return Promise.reject(new Error("The deployed studio cannot do that."));
}

function api(path, body) { return MODE === "worker" ? workerApi(path, body) : localApi(path, body); }

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
    else if (key === "style") node.style.cssText = value;
    else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  (children || []).forEach(function (child) {
    if (child === null || child === undefined) return;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  });
  return node;
}

/**
 * A listbox in place of a native select.
 *
 * A native select opens the operating system's menu, which ignores the page's
 * type, colour and radius. The Landing page answers this with a summary/details
 * listbox; this is the same shape in the studio's vocabulary. The returned node
 * mirrors the hidden input through its value property, so callers keep reading
 * and writing it as they did, and setOptions covers lists that arrive later.
 */
function listboxControl(id, options, value, onchange) {
  var items = options.slice();
  var hidden = el("input", { type: "hidden", id: id, value: value === undefined ? "" : String(value) });
  var shown = el("span", { class: "listbox-value" });
  var trigger = el(
    "button",
    { type: "button", class: "listbox", id: id + "-trigger", "aria-haspopup": "listbox", "aria-expanded": "false" },
    [shown, el("span", { class: "listbox-chev", "aria-hidden": "true" })]
  );
  var menu = el("div", { class: "listbox-menu", role: "listbox", hidden: true });
  var wrap = el("div", { class: "listbox-wrap" }, [trigger, menu, hidden]);

  function labelFor(candidate) {
    for (var index = 0; index < items.length; index += 1) if (items[index][0] === candidate) return items[index][1];
    return "";
  }
  function paint() {
    shown.textContent = labelFor(hidden.value);
    Array.prototype.forEach.call(menu.children, function (button) {
      button.setAttribute("aria-selected", button.getAttribute("data-value") === hidden.value ? "true" : "false");
    });
  }
  function paintMenu() {
    menu.innerHTML = "";
    items.forEach(function (item) {
      menu.append(el("button", {
        type: "button",
        class: "listbox-option",
        role: "option",
        "data-value": item[0],
        text: item[1],
        onclick: function () { choose(item[0]); }
      }));
    });
  }
  function close() {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", outside, true);
  }
  function outside(event) {
    if (!menu.contains(event.target) && !trigger.contains(event.target)) close();
  }
  function open() {
    if (menu.children.length === 0) return;
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", outside, true);
    var selected = menu.querySelector('[aria-selected="true"]') || menu.children[0];
    if (selected) selected.focus();
  }
  function choose(next) {
    var changed = hidden.value !== next;
    hidden.value = next;
    paint();
    close();
    trigger.focus();
    if (changed && onchange) onchange(next);
  }

  trigger.addEventListener("click", function () { if (menu.hidden) open(); else close(); });
  trigger.addEventListener("keydown", function (event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); open(); }
  });
  menu.addEventListener("keydown", function (event) {
    var buttons = Array.prototype.slice.call(menu.children);
    var index = buttons.indexOf(document.activeElement);
    if (event.key === "Escape") { event.preventDefault(); close(); trigger.focus(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); (buttons[index + 1] || buttons[0]).focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); (buttons[index - 1] || buttons[buttons.length - 1]).focus(); }
    else if (event.key === "Home") { event.preventDefault(); buttons[0].focus(); }
    else if (event.key === "End") { event.preventDefault(); buttons[buttons.length - 1].focus(); }
  });

  Object.defineProperty(wrap, "value", {
    get: function () { return hidden.value; },
    set: function (next) { hidden.value = next === undefined || next === null ? "" : String(next); paint(); }
  });
  wrap.setOptions = function (next, selected) {
    items = next.slice();
    if (selected !== undefined) hidden.value = String(selected);
    paintMenu();
    paint();
  };
  wrap.focus = function () { trigger.focus(); };

  paintMenu();
  paint();
  return wrap;
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

function hiddenColumns(model) {
  try { return JSON.parse(localStorage.getItem("tapedb-hidden:" + model) || "[]"); } catch (e) { return []; }
}

/** Every column the model has, before hiding: for the Columns menu. */
function allColumns(model) {
  var saved = app.rows;
  return columnsOf(model, saved);
}

function columns(model) {
  var hidden = hiddenColumns(model);
  return columnsOf(model, app.rows).filter(function (c) { return c === "id" || hidden.indexOf(c) < 0; });
}

function columnsOf(model, rows) {
  var attrs = namespace(model).attributes;
  var names = Object.keys(attrs);
  var seen = {};
  rows.forEach(function (row) { Object.keys(row).forEach(function (k) { seen[k] = true; }); });
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
  var options = [];
  if (app.workspaces.length === 0 && !app.workspace) options.push(["", "None yet"]);
  var listed = app.workspaces.slice();
  if (app.workspace && !listed.some(function (w) { return w.id === app.workspace; })) listed.unshift({ id: app.workspace, updatedAt: null });
  listed.forEach(function (w) {
    var when = ago(w.updatedAt);
    options.push([w.id, shortId(w.id) + (when ? "  (" + when + ")" : "")]);
  });
  options.push(["__other", "Open by id\u2026"]);
  var mount = $("workspace-mount");
  mount.innerHTML = "";
  mount.append(listboxControl("workspace", options, app.workspace || "", chooseWorkspace));
}

/** The picker's own change: __other reveals the id box instead of switching. */
function chooseWorkspace(value) {
  if (value === "__other") {
    $("workspace-id").hidden = false;
    $("workspace-id").focus();
    $("workspace").value = app.workspace || "";
    return;
  }
  openWorkspace(value);
}

function loadWorkspaces(known) {
  return api("/api/workspaces" + (typeof known === "number" ? "?known=" + known : "")).then(function (result) {
    if (!Array.isArray(result.workspaces)) { app.manual = true; return null; }
    app.workspaces = result.workspaces;
    return app.workspaces;
  });
}

var RECENT_KEY = "tapedb-recent-workspaces";
function recentWorkspaces() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").filter(function (id) { return typeof id === "string"; }); } catch (e) { return []; }
}

function openWorkspace(id) {
  if (!id) return;
  app.workspace = id;
  try { localStorage.setItem(CURRENT_KEY, id); } catch (e) {}
  if (MODE === "worker") {
    // The deployed Worker lists no workspaces: an owner of one must not learn
    // the ids of others. The picker remembers the ones opened here.
    var recent = [id].concat(recentWorkspaces().filter(function (other) { return other !== id; })).slice(0, 8);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch (e) {}
    app.workspaces = recent.map(function (other) { return { id: other, updatedAt: null }; });
  }
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
    renderWho();
    if (app.tool === "query") openQuery();
    else if (app.tool === "access") openAccess();
    else if (app.tool === "history") openHistory();
    else if (first) selectModel(first.apiName);
    else showEmpty("This schema has no models", "Add a model to tapedb.schema.ts, then run a migration.");
    refreshCounts();
    loadStructure();
    poll();
  }).catch(fail);
}

// ---- Sidebar --------------------------------------------------------------

function renderModels() {
  var nav = $("models");
  nav.innerHTML = "";
  $("tools").hidden = !app.schema;
  $("open-query").setAttribute("aria-current", app.tool === "query" ? "true" : "false");
  $("open-access").setAttribute("aria-current", app.tool === "access" ? "true" : "false");
  $("open-history").setAttribute("aria-current", app.tool === "history" ? "true" : "false");
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
      refreshHistory();
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
  if (parts.length === 0 && con.tapeLabel) parts.push(con.tapeLabel);
  con.tapeLabel = "";
  if (parts.length === 0 && changed > 0) parts.push(app.model + ".update" + (changed > 1 ? " ×" + changed : ""));
  if (parts.length === 0) parts.push(transactions > 1 ? transactions + " writes" : "write");
  return parts.join("  ");
}

// ---- Table ----------------------------------------------------------------

function selectModel(name) {
  if (stagedCount() > 0 && name !== app.model) { toast("Save or discard your changes first.", true); return; }
  if (app.tool) closeTool();
  app.staged = {};
  app.picked = {};
  app.search = "";
  app.model = name;
  app.filters = [];
  app.filtering = false;
  app.marks = {};
  app.order = { field: "id", dir: "asc" };
  closeDrawer();
  renderModels();
  $("head").hidden = false;
  $("tabs").hidden = false;
  stopped($("title"), name);
  setView(app.view);
  loadRows(false);
}

/**
 * The search box: rows whose text fields start with what was typed (the engine
 * matches ranges, so this is a prefix and case sensitive), or the row with that id.
 */
function searchClause() {
  var q = app.search;
  if (!q) return null;
  var attrs = namespace(app.model).attributes;
  var branches = Object.keys(attrs).filter(function (n) { return attrs[n].type === "string" && !referenceOf(app.model, n); }).map(function (n) {
    var c = {}; c[n] = { $gte: q, $lt: q + "\uffff" }; return c;
  });
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) branches.push({ id: q.toLowerCase() });
  if (branches.length === 0) return { id: "00000000-0000-0000-0000-000000000000" };
  return branches.length === 1 ? branches[0] : { $or: branches };
}

function whereClause() {
  var search = searchClause();
  if (app.filters.length === 0) return search || undefined;
  var all = app.filters.map(function (f) {
    var condition = {};
    if (f.op === "is") condition[f.field] = f.value;
    else { var c = {}; c[f.op] = f.value; condition[f.field] = c; }
    return condition;
  });
  if (search) all.push(search);
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
    if (!append) app.picked = {};
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
    var present = {};
    app.rows.forEach(function (row) { present[row.id] = true; });
    Object.keys(app.picked).forEach(function (id) { if (!present[id]) delete app.picked[id]; });
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
  $("filters").hidden = app.view !== "data";
  renderFilters();
  $("total").textContent = app.total === null ? "" : pad(app.total, 2) + (app.total === 1 ? " row" : " rows");

  $("panel").classList.toggle("is-empty", app.rows.length === 0);
  if (app.rows.length === 0) {
    $("foot").hidden = true;
    if (app.filters.length > 0 || app.search) {
      grid.append(el("div", { class: "empty" }, [
        stopped(el("h2"), "No rows match"),
        el("p", { text: "Change or clear the filters to see more." }),
        el("button", { class: "btn", type: "button", text: "Clear filters", onclick: function () { app.filters = []; app.search = ""; loadRows(false); } })
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
  var allPicked = app.rows.length > 0 && app.rows.every(function (row) { return app.picked[row.id]; });
  var pickAll = el("input", { type: "checkbox", "aria-label": "Select every row shown", onclick: function (event) {
    event.stopPropagation();
    var on = event.target.checked;
    app.rows.forEach(function (row) { if (on) app.picked[row.id] = true; else delete app.picked[row.id]; });
    renderTable();
  } });
  pickAll.checked = allPicked;
  var head = el("tr", null, [el("th", { class: "pick" }, [pickAll])].concat(cols.map(function (field) {
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
  })));
  var body = el("tbody", null, app.rows.map(function (row) {
    var mark = app.marks[row.id];
    var pick = el("input", { type: "checkbox", "aria-label": "Select this row", onclick: function (event) {
      event.stopPropagation();
      if (event.target.checked) app.picked[row.id] = true; else delete app.picked[row.id];
      renderTable();
    } });
    pick.checked = !!app.picked[row.id];
    var staged = app.staged[row.id] || {};
    return el("tr", {
      tabindex: "0",
      class: (mark === "new" ? "arrived " : "") + (app.picked[row.id] ? "picked" : ""),
      "aria-selected": app.selected && app.selected.id === row.id ? "true" : "false",
      // A click on an editable cell is the first half of a double-click; other cells open the row.
      onclick: function (event) { if (!event.target.closest("td.editable, td.editing")) openRow(row); },
      onkeydown: function (event) { if (event.key === "Enter" && event.target.tagName === "TR") openRow(row); }
    }, [el("td", { class: "pick", onclick: function (event) { event.stopPropagation(); } }, [pick,
      el("button", { class: "open", type: "button", title: "Open this row", "aria-label": "Open this row", onclick: function (event) { event.stopPropagation(); openRow(row); } }, [icon("arrow", 14)])
    ])].concat(cols.map(function (field, index) {
      var inline = inlineEditable(model, field);
      var value = field in staged ? staged[field] : row[field];
      var cell = el("td", {
        class: (field === "id" ? "id " : "") + (inline ? "editable " : "") + (field in staged ? "staged" : ""),
        title: inline ? "Double-click to edit" : null
      }, [cellContent(model, field, value)]);
      if (inline) cell.addEventListener("dblclick", function (event) { event.stopPropagation(); editCell(cell, row, field); });
      if (index === 0 && mark) cell.append(el("span", { class: "tag", text: mark === "new" ? "NEW" : "CHANGED" }));
      return cell;
    })));
  }));
  grid.append(el("table", null, [el("thead", null, [head]), body]));

  $("foot").hidden = false;
  $("shown").textContent = "Showing " + app.rows.length + (app.total !== null ? " of " + app.total : "");
  $("more").hidden = !app.cursor;
  renderBulk();
}

// ---- Inline edits, staged until saved together -----------------------------------

/** Scalar fields edit in the cell; relations and JSON in the row panel. */
function inlineEditable(model, field) {
  var attr = namespace(model).attributes[field];
  if (!attr || referenceOf(model, field)) return false;
  return attr.type === "string" || attr.type === "number" || attr.type === "boolean" || attr.type === "date";
}

function stagedCount() {
  var n = 0;
  Object.keys(app.staged).forEach(function (id) { n += Object.keys(app.staged[id]).length; });
  return n;
}

function editCell(cell, row, field) {
  var attr = namespace(app.model).attributes[field];
  var staged = app.staged[row.id] || {};
  var current = field in staged ? staged[field] : row[field];
  var stage = function (value) {
    var same = value === row[field] || (value === null && row[field] === undefined);
    app.staged[row.id] = app.staged[row.id] || {};
    if (same) delete app.staged[row.id][field]; else app.staged[row.id][field] = value;
    if (Object.keys(app.staged[row.id]).length === 0) delete app.staged[row.id];
    renderTable();
  };
  if (attr.type === "boolean") { stage(!current); return; }
  var input;
  if (attr.type === "date") {
    var local = "";
    if (typeof current === "number") { var d = new Date(current); local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19); }
    input = el("input", { type: "datetime-local", step: "1", value: local });
  } else {
    input = el("input", { type: attr.type === "number" ? "number" : "text", step: attr.type === "number" ? "any" : null, value: current === null || current === undefined ? "" : String(current) });
  }
  cell.innerHTML = "";
  cell.className = "editing";
  cell.append(input);
  input.focus();
  if (input.select) input.select();
  var done = false;
  var commit = function () {
    if (done) return;
    done = true;
    var raw = input.value;
    if (raw === "") { if (attr.optional) stage(null); else if (attr.type === "string") stage(""); else renderTable(); return; }
    if (attr.type === "number") { var n = Number(raw); if (isNaN(n)) { fail(new Error(field + " must be a number.")); renderTable(); return; } stage(n); return; }
    if (attr.type === "date") { var t = new Date(raw).getTime(); if (isNaN(t)) { renderTable(); return; } stage(t); return; }
    stage(raw);
  };
  input.addEventListener("click", function (event) { event.stopPropagation(); });
  input.addEventListener("keydown", function (event) {
    event.stopPropagation();
    if (event.key === "Enter") commit();
    if (event.key === "Escape") { done = true; renderTable(); }
  });
  input.addEventListener("blur", commit);
}

function saveStaged() {
  var model = app.model;
  var ops = Object.keys(app.staged).map(function (id) { return { op: "patch", namespace: model, id: id, values: app.staged[id] }; });
  if (ops.length === 0) return;
  transact(ops).then(function () {
    var n = stagedCount();
    app.staged = {};
    toast(n === 1 ? "1 change saved" : n + " changes saved, in one transaction");
    return reloadRows();
  }).catch(fail);
}

// ---- Selection and bulk actions --------------------------------------------------

function renderBulk() {
  if (app.schema && app.model) exportMenu();
  var bar = $("bulk");
  var picked = Object.keys(app.picked);
  var edits = stagedCount();
  bar.innerHTML = "";
  bar.hidden = app.view !== "data" || (picked.length === 0 && edits === 0);
  if (bar.hidden) return;
  if (edits > 0) {
    bar.append(
      el("span", { class: "what", text: edits === 1 ? "1 unsaved change" : edits + " unsaved changes" }),
      el("span", { class: "spacer" }),
      el("button", { class: "quiet label", type: "button", text: "Discard", onclick: function () { app.staged = {}; renderTable(); } }),
      el("button", { class: "btn small primary", type: "button", text: "Save changes", onclick: saveStaged })
    );
    return;
  }
  bar.append(
    el("span", { class: "what", text: picked.length === 1 ? "1 row selected" : picked.length + " rows selected" }),
    el("span", { class: "spacer" }),
    el("button", { class: "quiet label", type: "button", text: "Clear selection", onclick: function () { app.picked = {}; renderTable(); } }),
    el("button", { class: "btn small danger", type: "button", text: picked.length === 1 ? "Delete row" : "Delete " + picked.length + " rows", onclick: function () { confirmDelete(picked); } })
  );
}

/** What deleting these rows does to rows that point at them, by each relation's onDelete. */
function deleteImpact(model, ids) {
  var refs = (app.schema.links || []).filter(function (link) {
    if (!link.foreignKey) return false;
    var owner = link.foreignKey.namespace;
    var target = link.forward.namespace === owner ? link.reverse.namespace : link.forward.namespace;
    return target === model;
  });
  if (refs.length === 0) return Promise.resolve([]);
  return Promise.all(refs.map(function (link) {
    var where = {};
    where[link.foreignKey.attribute] = { $in: ids };
    var q = {};
    q[link.foreignKey.namespace] = { $: { where: where, count: true, limit: 0 } };
    return query(q).then(function (result) {
      var count = ((result.pageInfo || {})[link.foreignKey.namespace] || {}).count || 0;
      return { link: link, count: count };
    });
  })).then(function (found) {
    return found.filter(function (f) { return f.count > 0; }).map(function (f) {
      var owner = f.link.foreignKey.namespace;
      var field = f.link.foreignKey.attribute.replace(/Id$/, "");
      var rows = f.count + " " + owner + (f.count === 1 ? " row" : " rows");
      var rule = f.link.foreignKey.onDelete;
      if (rule === "CASCADE") return { text: "Also deletes " + rows + " that belong to " + (ids.length === 1 ? "it" : "them") + ", and anything that belongs to those." };
      if (rule === "RESTRICT") return { refused: true, text: rows + " point here, and " + owner + "." + field + " refuses the delete. Move or delete those first." };
      return { text: "Clears " + field + " on " + rows + "." };
    });
  });
}

function confirmDelete(ids) {
  var model = app.model;
  var many = ids.length !== 1;
  var title = many ? "Delete " + ids.length + " " + model + " rows" : "Delete this " + model;
  openSheet(model, title, [el("p", { class: "hint", text: "Checking what points at " + (many ? "them" : "it") + "…" })], many ? "Delete " + ids.length + " rows" : "Delete row", null);
  $("sheet-go").disabled = true;
  deleteImpact(model, ids).then(function (impact) {
    var refused = impact.some(function (i) { return i.refused; });
    var body = [];
    body.push(el("div", { class: "notice warn" }, [
      el("span", { class: "label", text: refused ? "Cannot delete" : "Deletes data" }),
      refused
        ? "The schema refuses this delete:"
        : (many ? "These " + ids.length + " rows are" : "This row is") + " deleted in one transaction. It cannot be undone here.",
      impact.length ? el("ul", { class: "impact" }, impact.map(function (i) { return el("li", { class: i.refused ? "refused" : null, text: i.text }); })) : null
    ]));
    if (!many) {
      var row = app.rows.filter(function (r) { return r.id === ids[0]; })[0];
      var label = row && labelField(model) && row[labelField(model)];
      body.push(el("p", { class: "hint", text: (label ? label + ", " : "") + ids[0] }));
    }
    $("sheet-body").innerHTML = "";
    body.forEach(function (node) { $("sheet-body").append(node); });
    var go = $("sheet-go");
    go.disabled = refused;
    sheetGo = function () {
      if (go.dataset.armed !== "yes") {
        go.dataset.armed = "yes";
        go.className = "btn danger small armed";
        go.textContent = "Delete for good";
        return;
      }
      go.disabled = true;
      transact(ids.map(function (id) { return { op: "delete", namespace: model, id: id }; })).then(function () {
        closeSheet();
        ids.forEach(function (id) { delete app.picked[id]; delete app.staged[id]; });
        toast(many ? ids.length + " rows deleted" : "Row deleted");
        reloadRows();
        refreshCounts();
      }).catch(function (error) { fail(error); go.disabled = false; });
    };
  }).catch(fail);
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
    var input = el("input", { type: "search", placeholder: "Text starts with…", "aria-label": "Search", value: app.search });
    var timer = null;
    input.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () { app.search = input.value.trim(); loadRows(false).then(function () { var again = $("filters").querySelector(".search input"); if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); } }); }, 300);
    });
    box.append(el("label", { class: "search", title: "Rows whose text starts with this (case sensitive), or the row with this id" }, [icon("search", 14), input]));
    box.append(columnsMenu(model));
    box.append(el("button", { class: "btn small", type: "button", onclick: function () { app.filtering = true; renderFilters(); box.querySelector(".filter-form input").focus(); } }, [icon("plus", 14), app.filters.length ? "Add filter" : "Filter"]));
    if (app.filters.length > 0) box.append(el("button", { class: "quiet label", type: "button", text: "Clear", onclick: function () { app.filters = []; loadRows(false); } }));
    return;
  }
  var fields = columns(model).filter(function (f) { var t = typeOf(model, f); return t !== "json" && t !== "any"; });
  var fieldSelect = listboxControl("filter-field", fields.map(function (f) { return [f, f]; }), fields.length > 1 ? fields[1] : fields[0]);
  var opSelect = listboxControl("filter-op", OPS, OPS[0][0]);
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

function columnsMenu(model) {
  var wrap = el("div", { class: "menu" });
  var hidden = hiddenColumns(model);
  var all = allColumns(model).filter(function (c) { return c !== "id"; });
  var button = el("button", { class: "btn small", type: "button", "aria-expanded": "false", text: hidden.length ? "Columns (" + hidden.length + " hidden)" : "Columns" });
  var pop = el("div", { class: "pop", hidden: true });
  all.forEach(function (column) {
    var box = el("input", { type: "checkbox" });
    box.checked = hidden.indexOf(column) < 0;
    box.addEventListener("change", function () {
      var now = hiddenColumns(model).filter(function (c) { return c !== column; });
      if (!box.checked) now.push(column);
      try { localStorage.setItem("tapedb-hidden:" + model, JSON.stringify(now)); } catch (e) {}
      renderTable();
      var reopened = $("filters").querySelector(".menu .pop");
      if (reopened) { reopened.hidden = false; reopened.previousSibling.setAttribute("aria-expanded", "true"); }
    });
    pop.append(el("label", null, [box, column]));
  });
  button.addEventListener("click", function (event) {
    event.stopPropagation();
    pop.hidden = !pop.hidden;
    button.setAttribute("aria-expanded", pop.hidden ? "false" : "true");
  });
  pop.addEventListener("click", function (event) { event.stopPropagation(); });
  wrap.append(button, pop);
  return wrap;
}
document.addEventListener("click", function () {
  document.querySelectorAll(".menu .pop").forEach(function (pop) {
    if (!pop.hidden) { pop.hidden = true; pop.previousSibling.setAttribute("aria-expanded", "false"); }
  });
});

function jumpTo(model, id) {
  selectModel(model);
  app.filters = [{ field: "id", op: "is", value: id }];
  loadRows(false).then(function () { if (app.rows[0]) openRow(app.rows[0]); });
}

// ---- Drawer: view, edit, create, delete ------------------------------------

/** Picks a row of the target model by name; up to 500 rows, else an id box. */
function relationPicker(id, target, value, optional) {
  var current = typeof value === "string" ? value : "";
  var select = listboxControl(id, [["", optional ? "None" : "Choose a " + target]], current);
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
    var list = [["", optional ? "None" : "Choose a " + target]];
    ((result.data || {})[target] || []).forEach(function (row) {
      list.push([row.id, label && row[label] ? row[label] : shortId(row.id)]);
    });
    select.setOptions(list, current);
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
  $("sheet").classList.remove("open");
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
  if (row.updatedSeq !== undefined) {
    meta.append(el("dt", { class: "label", text: "Last write" }), el("dd", { class: "num" }, [el("button", { class: "tx-link", type: "button", title: "Open it in the history", onclick: function () { closeDrawer(); openHistory(row.updatedSeq); } }, ["tx_" + pad(row.updatedSeq, 4)])]));
  }
  form.append(meta);
  var changes = el("div");
  form.append(changes);
  rowHistory(model, row.id, changes);
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
  $("sheet").classList.remove("open");
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
  if (app.selected) confirmDelete([app.selected.id]);
});


$("close").addEventListener("click", closeDrawer);
$("cancel").addEventListener("click", closeDrawer);
$("add").addEventListener("click", startCreate);
$("more").addEventListener("click", function () { loadRows(true); });
document.addEventListener("keydown", function (event) {
  if (event.key !== "Escape") return;
  if ($("sheet").classList.contains("open")) closeSheet();
  else if ($("drawer").classList.contains("open")) closeDrawer();
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

// ---- Structure: the models as tapedb.schema.ts defines them ------------------

var KINDS = [
  ["string", "Text"], ["number", "Number"], ["boolean", "True or false"], ["date", "Date"], ["json", "JSON"],
  ["enum", "One of a set"],
  ["belongsTo", "Points to one row of"], ["hasMany", "Has many rows of"]
];
var ON_DELETE = [["setNull", "Clear this field"], ["cascade", "Delete this row too"], ["restrict", "Refuse the delete"]];

function loadStructure() {
  return api("/api/structure").then(function (structure) {
    app.structure = structure;
    $("new-model").hidden = !structure.editable;
    if (app.view === "structure") renderStructure();
    if (app.tool === "access" && app.schema) renderAccess();
    return structure;
  }).catch(function () { app.structure = { editable: false, reason: "The studio could not read the project." }; });
}

function setView(view) {
  if (view !== app.view) closeDrawer();
  app.view = view;
  $("tab-data").setAttribute("aria-selected", view === "data" ? "true" : "false");
  $("tab-structure").setAttribute("aria-selected", view === "structure" ? "true" : "false");
  $("tab-graph").setAttribute("aria-selected", view === "graph" ? "true" : "false");
  var data = view === "data";
  $("panel").hidden = !data;
  $("filters").hidden = !data;
  $("add").hidden = !data;
  $("import").hidden = !data;
  $("export-menu").hidden = !data;
  $("structure").hidden = view !== "structure";
  $("graph").hidden = view !== "graph";
  if ($("bulk")) renderBulk();
  if (view === "structure") renderStructure();
  if (view === "graph") renderGraph();
  else unmountGraph();
}

/** One live React root for the graph, torn down when the tab is left. */
var graphRoot = null;
function unmountGraph() {
  if (graphRoot) graphRoot();
  graphRoot = null;
  $("graph").innerHTML = "";
}

/** Hands the engine's schema to the React Flow bundle, which knows nothing of it. */
function renderGraph() {
  var host = $("graph");
  if (!app.schema) return;
  unmountGraph();
  if (!window.TAPEDB_GRAPH) {
    host.append(el("p", { class: "hint", text: "The graph bundle did not load." }));
    return;
  }
  var canvas = el("div", { style: "position:absolute;inset:0" });
  host.append(canvas);
  graphRoot = window.TAPEDB_GRAPH.mount(canvas, app.schema, function (name) {
    setView("data");
    selectModel(name);
  });
}

function kindText(spec) {
  if (spec.type === "belongsTo") return ["one ", el("span", { class: "target", text: spec.target })];
  if (spec.type === "hasMany") return ["many ", el("span", { class: "target", text: spec.target })];
  if (spec.type === "enum") return ["one of ", el("span", { class: "target", text: (spec.values || []).join(", ") })];
  return [KINDS.filter(function (k) { return k[0] === spec.type; })[0][1]];
}

function flags(spec, name) {
  var out = [];
  if (spec.optional) out.push("optional");
  if (spec.default !== undefined) out.push("default " + JSON.stringify(spec.default));
  if (spec.unique) out.push("unique");
  else if (spec.index) out.push("indexed");
  if (spec.type === "belongsTo") {
    out.push("stored as " + name + "Id");
    if (spec.onDelete === "cascade") out.push("deleted with its " + spec.target);
    if (spec.onDelete === "restrict") out.push("blocks deleting its " + spec.target);
  }
  if (spec.type === "hasMany") out.push("stores nothing");
  return out.map(function (f) { return el("span", { class: "flag", text: f }); });
}

function renderStructure() {
  var box = $("structure");
  box.innerHTML = "";
  var structure = app.structure;
  if (!structure) { box.append(el("p", { class: "hint", text: "Reading tapedb.schema.ts…" })); return; }
  if (!structure.editable) {
    box.append(el("div", { class: "notice" }, [el("span", { class: "label", text: "Read only" }), structure.reason]));
    if (app.schema && namespace(app.model)) box.append(fieldsTable(schemaFields(app.model), null));
    return;
  }
  if (structure.pending.length > 0) {
    box.append(el("div", { class: "notice warn" }, [
      el("span", { class: "label", text: "Not migrated yet" }),
      "tapedb.schema.ts has changes without a migration. Changes made here include them.",
      el("ul", null, structure.pending.map(function (p) { return el("li", { text: p }); }))
    ]));
  }
  var model = structure.models.filter(function (m) { return m.name === app.model; })[0];
  if (!model) {
    box.append(el("div", { class: "notice" }, ["tapedb.schema.ts has no model " + app.model + ". The local database is still on an older schema; it reloads after the next change."]));
    return;
  }
  box.append(el("div", { class: "bar" }, [
    el("span", { class: "label", text: model.fields.length + (model.fields.length === 1 ? " field" : " fields") }),
    el("span", { class: "spacer" }),
    el("button", { class: "btn small", type: "button", text: "Rename model", onclick: function () { modelForm(model.name); } }),
    el("button", { class: "btn small danger", type: "button", text: "Delete model", onclick: function () {
      review({ kind: "deleteModel", model: model.name }, "Delete " + model.name, "The model, its relations from other models, and all its rows.");
    } }),
    el("button", { class: "btn small primary", type: "button", onclick: function () { fieldForm(model.name, null); } }, [icon("plus", 14), "Add field"])
  ]));
  box.append(fieldsTable(model.fields, model.name));
}

/** The fields as the live schema has them, for the read-only view. */
function schemaFields(model) {
  var attrs = namespace(model).attributes;
  var fields = [];
  Object.keys(attrs).forEach(function (name) {
    var attr = attrs[name];
    var target = referenceOf(model, name);
    var spec = target
      ? { type: "belongsTo", target: target, optional: attr.optional || undefined }
      : { type: attr.type, optional: attr.optional || undefined, index: attr.indexed || undefined, unique: attr.unique || undefined, default: attr.default === null ? undefined : attr.default };
    fields.push({ name: target ? name.replace(/Id$/, "") : name, code: "", spec: spec });
  });
  (app.schema.links || []).forEach(function (link) {
    if (!link.foreignKey) return;
    var owner = link.foreignKey.namespace;
    var other = link.forward.namespace === owner ? link.reverse : link.forward;
    if (other.namespace === model && other.has === "many") fields.push({ name: other.label, code: "", spec: { type: "hasMany", target: owner } });
  });
  return fields;
}

/** The fields table; with a model name, each row offers edit, rename and delete. */
function fieldsTable(fields, editable) {
  var model = { name: editable };
  var rows = fields.map(function (field) {
    var spec = field.spec;
    return el("tr", null, [
      el("td", { class: "name", text: field.name }),
      el("td", { class: "kind" }, spec ? kindText(spec) : [el("span", { class: "code-note", text: field.code })]),
      el("td", null, spec ? flags(spec, field.name) : [el("span", { class: "code-note", text: "written in code; change it in tapedb.schema.ts" })]),
      editable === null ? el("td") : el("td", { class: "acts" }, [el("div", { class: "acts-row" }, [
        spec ? el("button", { class: "quiet label", type: "button", text: "Edit", onclick: function () { fieldForm(model.name, field); } }) : null,
        el("button", { class: "quiet label", type: "button", text: "Rename", onclick: function () { renameFieldForm(model.name, field.name); } }),
        el("button", { class: "quiet label danger-text", type: "button", text: "Delete", onclick: function () {
          review({ kind: "deleteField", model: model.name, field: field.name }, "Delete " + model.name + "." + field.name, spec && spec.type === "hasMany" ? "A list relation stores nothing; no data is lost." : "The field and its value in every row.");
        } })
      ])])
    ]);
  });
  rows.push(el("tr", { class: "system" }, [
    el("td", { class: "name", text: "id" }), el("td", { text: "uuid" }),
    el("td", { colspan: "2", text: "With createdAt, updatedAt and updatedSeq: kept by tapedb on every row." })
  ]));
  return (el("div", { class: "fields" }, [el("table", null, [
    el("thead", null, [el("tr", null, ["Field", "Type", "Details", ""].map(function (h) { return el("th", null, [el("span", { class: "label th-label", text: h })]); }))]),
    el("tbody", null, rows)
  ])]));
}

// ---- Sheet: forms, then the review of what the change writes -------------------

var sheetGo = null;
function openSheet(label, title, body, goText, onGo) {
  $("sheet-label").innerHTML = "";
  $("sheet-label").append(el("b", { text: label }));
  stopped($("sheet-title"), title);
  $("sheet-body").innerHTML = "";
  body.forEach(function (node) { if (node) $("sheet-body").append(node); });
  var go = $("sheet-go");
  go.textContent = goText;
  go.className = "btn primary small";
  go.disabled = false;
  go.dataset.armed = "";
  sheetGo = onGo;
  $("sheet-back").hidden = true;
  closeDrawer();
  $("sheet").classList.add("open");
  var first = $("sheet-body").querySelector("input, select");
  if (first) first.focus();
}
function closeSheet() { $("sheet").classList.remove("open"); sheetGo = null; }
$("sheet-close").addEventListener("click", closeSheet);
$("sheet-cancel").addEventListener("click", closeSheet);
$("sheet-go").addEventListener("click", function () { if (sheetGo) sheetGo(); });

function textField(id, label, value, note, type) {
  return el("div", { class: "field" }, [
    el("label", { for: id }, [el("span", { class: "label", text: label }), note ? el("span", { class: "type", text: note }) : null]),
    el("input", { type: type || "text", id: id, value: value || "", autocomplete: "off", spellcheck: "false" })
  ]);
}

/** The default control for a type: a closed set gets a list, not a guess. */
function defaultControl(kind, current, values) {
  if (kind === "boolean") {
    return selectField("f-default", "Default", [["", "No default"], ["true", "true"], ["false", "false"]], current);
  }
  if (kind === "enum") {
    var options = [["", "No default"]].concat((values || []).map(function (v) { return [v, v]; }));
    return selectField("f-default", "Default", options, current);
  }
  if (kind === "number") return textField("f-default", "Default", current, "a number, like 0 or 12.5", "number");
  return textField("f-default", "Default", current, "used when a write leaves it out");
}
/** A labelled field around the listbox control. */
function selectField(id, label, options, value) {
  return el("div", { class: "field" }, [
    el("label", { for: id + "-trigger" }, [el("span", { class: "label", text: label })]),
    listboxControl(id, options, value)
  ]);
}

function checkField(id, label, checked) {
  var box = el("input", { type: "checkbox", id: id });
  box.checked = !!checked;
  return el("label", { class: "check", for: id }, [box, el("span", { class: "box", "aria-hidden": "true" }), el("span", { text: label })]);
}

function modelForm(renaming) {
  var name = textField("m-name", "Name", renaming || "", "letters and digits, like task");
  var starter = renaming ? null : checkField("m-starter", "Start with a name field (text)", true);
  openSheet(renaming ? renaming : "new model", renaming ? "Rename " + renaming : "New model", [name, starter,
    el("p", { class: "hint", text: renaming ? "Rows keep their data; relations that point here follow the new name." : "The model is added to tapedb.schema.ts with a migration that creates its table." })
  ], "Review change", function () {
    var value = $("m-name").value.trim();
    if (renaming) {
      if (value === renaming) { closeSheet(); return; }
      review({ kind: "renameModel", from: renaming, to: value }, "Rename " + renaming + " to " + value, "Rows keep their data.");
    } else {
      var fields = $("m-starter").checked ? [{ name: "name", spec: { type: "string" } }] : [];
      review({ kind: "addModel", model: value, fields: fields }, "Add model " + value, "Creates the table.");
    }
  });
}

function renameFieldForm(model, field) {
  openSheet(model, "Rename " + field, [textField("f-new", "New name", field), el("p", { class: "hint", text: "Values are kept under the new name." })], "Review change", function () {
    var to = $("f-new").value.trim();
    if (to === field) { closeSheet(); return; }
    review({ kind: "renameField", model: model, from: field, to: to }, "Rename " + model + "." + field + " to " + to, "Values are kept.");
  });
}

function fieldForm(model, field) {
  var spec = field ? field.spec : { type: "string" };
  var models = app.structure.models.map(function (m) { return [m.name, m.name]; });
  var parts = [
    field ? null : textField("f-name", "Name", "", "letters and digits, like dueDate"),
    selectField("f-kind", "Type", KINDS, spec.type),
    textField("f-values", "Allowed values", spec.values ? spec.values.join(", ") : "", "comma separated, like retail, business"),
    selectField("f-target", "Model", models, spec.target),
    checkField("f-optional", "Optional: a row may leave it empty", spec.optional),
    el("div", { id: "default-slot" }),
    selectField("f-index", "Lookup", [["none", "No index"], ["index", "Indexed, for filtering and sorting"], ["unique", "Unique: no two rows share a value"]], spec.unique ? "unique" : spec.index ? "index" : "none"),
    selectField("f-ondelete", "When that row is deleted", ON_DELETE, spec.onDelete || "setNull")
  ];
  openSheet(model, field ? "Edit " + field.name : "Add field", parts, "Review change", function () {
    var kind = $("f-kind").value;
    var next;
    if (kind === "belongsTo") next = { type: "belongsTo", target: $("f-target").value, optional: $("f-optional").checked || undefined, onDelete: $("f-ondelete").value };
    else if (kind === "hasMany") next = { type: "hasMany", target: $("f-target").value };
    else if (kind === "enum") {
      var values = $("f-values").value.split(",").map(function (v) { return v.trim(); }).filter(Boolean);
      if (values.length === 0) { fail(new Error("An enum needs at least one allowed value.")); return; }
      next = { type: "enum", values: values };
      if ($("f-optional").checked) next.optional = true;
      var enumDefault = $("f-default") ? $("f-default").value : "";
      if (enumDefault !== "") {
        if (values.indexOf(enumDefault) === -1) { fail(new Error("The default must be one of the allowed values.")); return; }
        next.default = enumDefault;
      }
      var enumLookup = $("f-index").value;
      if (enumLookup === "unique") next.unique = true;
      if (enumLookup === "index") next.index = true;
    }
    else {
      next = { type: kind };
      if ($("f-optional").checked) next.optional = true;
      var raw = $("f-default") ? $("f-default").value : "";
      if (raw !== "") {
        if (kind === "number") { next.default = Number(raw); if (isNaN(next.default)) { fail(new Error("The default must be a number.")); return; } }
        else if (kind === "boolean") { if (raw !== "true" && raw !== "false") { fail(new Error("The default is true or false.")); return; } next.default = raw === "true"; }
        else if (kind === "string") next.default = raw;
        else { fail(new Error("A " + kind + " field takes no default here; set it in tapedb.schema.ts.")); return; }
      }
      var index = $("f-index").value;
      if (index === "unique") next.unique = true;
      if (index === "index") next.index = true;
    }
    if (field) review({ kind: "changeField", model: model, field: field.name, spec: next }, "Change " + model + "." + field.name, "");
    else {
      var name = $("f-name").value.trim();
      review({ kind: "addField", model: model, field: name, spec: next }, "Add " + model + "." + name, "");
    }
  });
  // Show only what applies to the chosen type.
  function sync() {
    var kind = $("f-kind").value;
    var relation = kind === "belongsTo" || kind === "hasMany";
    $("f-target").closest(".field").hidden = !relation;
    $("f-values").closest(".field").hidden = kind !== "enum";
    $("f-optional").closest("label").hidden = kind === "hasMany";
    $("f-index").closest(".field").hidden = relation;
    $("f-ondelete").closest(".field").hidden = kind !== "belongsTo";

    // The default follows the type. A boolean or an enum can only take one of
    // its own values, so a free text box would let the form ask for a value the
    // field cannot hold.
    var slot = $("default-slot");
    var previous = $("f-default");
    var current = previous ? previous.value : (spec.default === undefined ? "" : String(spec.default));
    slot.innerHTML = "";
    if (relation || kind === "date" || kind === "json") return;
    var values = $("f-values").value.split(",").map(function (v) { return v.trim(); }).filter(Boolean);
    slot.append(defaultControl(kind, current, values));
  }

  // An enum's allowed values are typed above, so its default list follows them
  // without discarding a choice that is still valid.
  $("f-values").addEventListener("change", function () {
    if ($("f-kind").value !== "enum") return;
    var select = $("f-default");
    if (!select || select.tagName !== "SELECT") return;
    var keep = select.value;
    var values = $("f-values").value.split(",").map(function (v) { return v.trim(); }).filter(Boolean);
    select.innerHTML = "";
    [["", "No default"]].concat(values.map(function (v) { return [v, v]; })).forEach(function (option) {
      select.append(el("option", { value: option[0], text: option[1] }));
    });
    select.value = values.indexOf(keep) === -1 ? "" : keep;
  });
  $("f-kind").addEventListener("change", sync);
  sync();
}

/** Shows what an edit writes (the schema diff, the SQL, what it deletes), then applies it. */
function review(edit, title, what) {
  var label = edit.model || edit.from || "schema";
  openSheet(label, title, [el("p", { class: "hint", text: "Working out the change…" })], "Apply change", null);
  $("sheet-go").disabled = true;
  var refused = function (message) {
    $("sheet-body").innerHTML = "";
    $("sheet-body").append(el("div", { class: "notice warn" }, [el("span", { class: "label", text: "This change cannot be made" }), message]));
    $("sheet-go").textContent = "Apply change";
    $("sheet-go").disabled = true;
  };
  api("/api/structure/preview", { edit: edit }).then(function (preview) {
    var body = [];
    if (preview.destructive.length > 0) {
      var rows = edit.kind === "deleteModel" && app.counts[edit.model] !== undefined ? app.counts[edit.model] : null;
      body.push(el("div", { class: "notice warn" }, [
        el("span", { class: "label", text: "Deletes data" }),
        (rows !== null ? "This workspace has " + rows + (rows === 1 ? " row" : " rows") + " of " + edit.model + ". " : "") +
          "Deployed, every workspace applies this migration when it next wakes, and loses the same data.",
        el("ul", null, preview.destructive.map(function (d) { return el("li", { text: d }); }))
      ]));
    } else if (what) {
      body.push(el("p", { class: "hint", text: what }));
    }
    body.push(el("div", null, [el("div", { class: "label", text: "tapedb.schema.ts" }), el("div", { class: "code" }, preview.diff.map(function (line) {
      if (line.text === "…" && line.kind === " ") return el("div", { class: "gap", text: "  …" });
      return el("div", { class: line.kind === "+" ? "add" : line.kind === "-" ? "del" : "ctx", text: line.text });
    }))]));
    body.push(el("div", null, [el("div", { class: "label", text: "Migration " + preview.migration }), el("div", { class: "code" }, preview.sql.join("\n").split("\n").map(function (l) { return el("div", { class: "ctx", text: l }); }))]));
    $("sheet-body").innerHTML = "";
    body.forEach(function (node) { $("sheet-body").append(node); });
    var go = $("sheet-go");
    go.disabled = false;
    var destructive = preview.destructive.length > 0;
    go.textContent = destructive ? "Apply and delete data" : "Apply change";
    sheetGo = function () {
      if (destructive && go.dataset.armed !== "yes") {
        go.dataset.armed = "yes";
        go.className = "btn danger small armed";
        go.textContent = "Delete for good";
        return;
      }
      go.disabled = true;
      api("/api/structure/apply", { edit: edit, base: preview.base }).then(function (applied) {
        if (!applied.ok) { fail(new Error(applied.error)); go.disabled = false; return; }
        closeSheet();
        toast(applied.migration ? "Wrote " + applied.migration + ". Reloading the local database…" : "Schema updated.");
        afterSchemaChange(edit);
      }).catch(function (error) { fail(error); go.disabled = false; });
    };
  }).catch(function (error) { refused(error.message); });
}

/** Whether the schema the local Worker serves has this edit in it yet. */
function hasEdit(schema, edit) {
  var models = {};
  schema.namespaces.forEach(function (n) { models[n.apiName] = n.attributes; });
  var stored = function (model, field, spec) { return spec && spec.type === "belongsTo" ? field + "Id" : field; };
  switch (edit.kind) {
    case "addModel": return !!models[edit.model];
    case "deleteModel": return !models[edit.model];
    case "renameModel": return !!models[edit.to] && !models[edit.from];
    case "addField": return edit.spec.type === "hasMany" || (!!models[edit.model] && !!models[edit.model][stored(edit.model, edit.field, edit.spec)]);
    case "deleteField": return !!models[edit.model] && !models[edit.model][edit.field] && !models[edit.model][edit.field + "Id"];
    case "renameField": return !!models[edit.model] && (!!models[edit.model][edit.to] || !!models[edit.model][edit.to + "Id"]);
    default: return true;
  }
}

/**
 * The local Worker reloads with the new schema (wrangler rebuilds once for the
 * schema file and again for the migrations): wait until it serves this edit
 * and stays on it, then show it.
 */
function afterSchemaChange(edit) {
  var before = JSON.stringify(app.schema);
  var deadline = Date.now() + 45000;
  var seenAt = 0;
  (function check() {
    api("/api/schema", { workspaceId: app.workspace }).then(function (result) {
      var text = JSON.stringify(result.data);
      var ready = hasEdit(result.data, edit) && (edit.kind !== "changeField" || text !== before);
      if (!ready) seenAt = 0;
      else if (!seenAt) seenAt = Date.now();
      if (Date.now() < deadline && (!ready || Date.now() - seenAt < 1500)) { setTimeout(check, 500); return; }
      if (!ready) { fail(new Error("The local database has not picked up the change yet. Check the terminal running npx tapedb-cli dev.")); return; }
      app.schema = result.data;
      app.labels = {};
      var names = app.schema.namespaces.map(function (n) { return n.apiName; });
      var next = edit.kind === "renameModel" && app.model === edit.from ? edit.to
        : edit.kind === "addModel" ? edit.model
        : names.indexOf(app.model) >= 0 ? app.model : names[0];
      renderModels();
      refreshCounts();
      loadStructure().then(function () {
        if (next) selectModel(next);
        toast("The local database is on the new schema.");
      });
    }).catch(function () { setTimeout(check, 1000); });
  })();
}

$("tab-data").addEventListener("click", function () { setView("data"); });
$("tab-structure").addEventListener("click", function () { setView("structure"); });
$("tab-graph").addEventListener("click", function () { setView("graph"); });
$("new-model").addEventListener("click", function () { modelForm(null); });

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

// ---- Query console ---------------------------------------------------------
//
// Runs one client call, written as in app code. tapedbRunner (bundled from
// src/studio/runner.ts) parses it as data and translates it with the client's
// own model code; the studio sends the result with its claim, so reads and
// writes go through the same access rules as the app's.

var QUERY_KEY = "tapedb-query";
var HISTORY_KEY = "tapedb-query-history";
var MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
var RESULT_ROWS = 500;
var con = { result: null, view: "table", running: 0, items: [], active: 0, error: null };

var ARG_KEYS = {
  findMany: ["where", "orderBy", "take", "include", "select"],
  findFirst: ["where", "orderBy", "take", "include", "select"],
  findUnique: ["where", "include", "select"],
  findPage: ["where", "orderBy", "take", "include", "select", "after"],
  count: ["where"],
  aggregate: ["where", "_count", "_sum", "_avg", "_min", "_max"],
  groupBy: ["by", "where", "orderBy", "take", "_count", "_sum", "_avg", "_min", "_max"],
  create: ["data"],
  update: ["where", "data"],
  upsert: ["where", "create", "update"],
  delete: ["where"],
  updateMany: ["where", "data"],
  deleteMany: ["where"]
};
var METHODS = Object.keys(ARG_KEYS);
var OPERATORS = ["equals", "not", "in", "notIn", "gt", "gte", "lt", "lte"];

function history() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch (e) { return []; }
}

function remember(source) {
  var list = [source].concat(history().filter(function (other) { return other !== source; })).slice(0, 20);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch (e) {}
  renderRecent();
}

function openQuery() {
  if (!openTool("query")) return;
  var input = $("code-input");
  if (!input.value) {
    var saved = "";
    try { saved = localStorage.getItem(QUERY_KEY) || ""; } catch (e) {}
    var first = app.schema.namespaces[0];
    input.value = saved || (first ? "db." + first.apiName + ".findMany({ take: 20 })" : "");
  }
  paintCode();
  renderRecent();
  renderResult();
  input.focus();
}


// ---- Editor: highlighting, line numbers, completion ----

var TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|\x60(?:[^\x60\\]|\\[\s\S])*\x60?)|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|\b(true|false|null|undefined|new|await)\b|([A-Za-z_$][\w$]*)(?=\s*:)/g;

function paintCode() {
  var input = $("code-input");
  var text = input.value;
  var view = $("code-view");
  view.innerHTML = "";
  var at = 0;
  var error = con.error && typeof con.error.offset === "number" ? con.error.offset : -1;
  var push = function (part, cls, offset) {
    if (!part) return;
    if (error >= offset && error < offset + part.length) {
      // Underline the token the parser stopped at.
      var cut = error - offset;
      var end = cut + Math.max(1, (/^[\w$"'.]+/.exec(part.slice(cut)) || [""])[0].length);
      if (cut > 0) view.append(cls ? el("span", { class: cls, text: part.slice(0, cut) }) : part.slice(0, cut));
      view.append(el("span", { class: (cls ? cls + " " : "") + "err", text: part.slice(cut, end) }));
      if (end < part.length) view.append(cls ? el("span", { class: cls, text: part.slice(end) }) : part.slice(end));
      return;
    }
    view.append(cls ? el("span", { class: cls, text: part }) : part);
  };
  TOKEN.lastIndex = 0;
  var match;
  while ((match = TOKEN.exec(text))) {
    push(text.slice(at, match.index), "", at);
    var cls = match[1] ? "c" : match[2] ? "s" : match[3] ? "n" : match[4] ? "w" : "k";
    push(match[0], cls, match.index);
    at = match.index + match[0].length;
  }
  push(text.slice(at), "", at);
  if (error >= text.length) view.append(el("span", { class: "err", text: " " }));
  // A trailing newline needs a line after it to keep the two layers aligned.
  view.append("\n");
  var lines = text.split("\n").length;
  var numbers = [];
  for (var i = 1; i <= lines; i++) numbers.push(i);
  $("gutter").textContent = numbers.join("\n");
  syncScroll();
}

function syncScroll() {
  var input = $("code-input");
  $("code-view").scrollTop = input.scrollTop;
  $("code-view").scrollLeft = input.scrollLeft;
  $("gutter").scrollTop = input.scrollTop;
}

/** The model a call names: db.<model>.<method>( */
function callHead(text) {
  var match = /(?:\bdb\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(text);
  if (!match || !namespace(match[1])) return null;
  return { model: match[1], method: match[2], open: match.index + match[0].length };
}

/**
 * The objects and arrays enclosing the end of text, outermost first, each with
 * the key it is the value of: [{ key: "" }, { key: "where" }, { key: "column" }].
 * An object inside an array keeps the array's key, so OR: [{ ... }] reads as where.
 */
function keyPath(text) {
  var stack = [];
  var lastKey = null;
  var re = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|\x60(?:[^\x60\\]|\\[\s\S])*\x60?)|([A-Za-z_$][\w$]*)\s*:|([{}\[\],])/g;
  var match;
  while ((match = re.exec(text))) {
    if (match[1]) continue;
    if (match[2]) {
      if (/^\s*:/.test(text.slice(re.lastIndex))) lastKey = match[2].slice(1, -1);
      continue;
    }
    if (match[3]) { lastKey = match[3]; continue; }
    var char = match[4];
    if (char === "{" || char === "[") {
      var outer = stack[stack.length - 1];
      var key = lastKey !== null ? lastKey : outer && outer.array ? outer.key : "";
      stack.push({ key: key, array: char === "[", item: lastKey === null && !!(outer && outer.array) });
    } else if (char === "}" || char === "]") {
      stack.pop();
    }
    lastKey = null;
  }
  return stack;
}

function fieldsOf(model) {
  var attrs = namespace(model).attributes;
  return ["id"].concat(Object.keys(attrs).filter(function (name) { return name !== "id"; }));
}

function relationsOf(model) {
  var out = {};
  (app.schema.links || []).forEach(function (link) {
    if (link.reverse.namespace === model) out[link.reverse.label] = { many: false, target: link.forward.namespace, key: link.foreignKey.attribute };
    if (link.forward.namespace === model && link.forward.label.slice(0, 2) !== "__") out[link.forward.label] = { many: true, target: link.reverse.namespace };
  });
  return out;
}

/** Suggestions for an object key at this path inside a call to model.method. */
function keysAt(head, path) {
  var model = head.model;
  var mode = "args";
  var keys = ARG_KEYS[head.method] || [];
  for (var i = 1; i < path.length; i++) {
    if (path[i].item) continue;
    var key = path[i].key;
    var relations = relationsOf(model);
    if (mode === "args") {
      if (key === "where") mode = "where";
      else if (key === "include") mode = "include";
      else if (key === "select") mode = "select";
      else if (key === "orderBy") mode = "fields";
      else if (key === "data" || key === "create" || key === "update") mode = "data";
      else if (key.charAt(0) === "_") mode = "fields";
      else return [];
    } else if (mode === "where") {
      if (key === "AND" || key === "OR" || key === "NOT") continue;
      if (relations[key]) { model = relations[key].target; mode = relations[key].many ? "many" : "where"; }
      else mode = "filter";
    } else if (mode === "many") {
      mode = "where";
    } else if (mode === "filter") {
      if (key !== "not") return [];
    } else if (mode === "include" || mode === "select") {
      if (!relations[key]) return [];
      model = relations[key].target;
      mode = "args";
      keys = ARG_KEYS.findMany;
    } else if (mode === "data") {
      if (!relations[key]) return [];
      mode = relations[key].many ? "dataMany" : "dataOne";
      model = relations[key].target;
    } else if (mode === "dataOne" || mode === "dataMany") {
      if (key !== "create") return [];
      mode = "data";
    } else {
      return [];
    }
  }
  var relations = relationsOf(model);
  var rel = Object.keys(relations);
  var fields = fieldsOf(model);
  var hint = function (list, text) { return list.map(function (name) { return { name: name, hint: text }; }); };
  var system = ["createdAt", "updatedAt"].filter(function (name) { return fields.indexOf(name) < 0; });
  if (mode === "args") return hint(keys, "argument");
  if (mode === "where") return hint(fields.concat(system), model).concat(hint(rel, "relation"), hint(["AND", "OR", "NOT"], "combine"));
  if (mode === "many") return hint(["some", "every", "none"], model);
  if (mode === "filter") return hint(OPERATORS, "filter");
  if (mode === "include") return hint(rel, "relation");
  if (mode === "select") return hint(fields.concat(system), model).concat(hint(rel, "relation"));
  if (mode === "fields") return hint(fields.concat(system), model);
  if (mode === "data") return hint(fields.filter(function (name) { return name !== "id" && SYSTEM.indexOf(name) < 0; }), model).concat(hint(rel, "relation"));
  if (mode === "dataOne") return hint(["connect", "create", "disconnect"], "relation");
  if (mode === "dataMany") return hint(["connect", "disconnect", "create"], "relation");
  return [];
}

/** True when the end of text is inside a string or a comment. */
function inLiteral(text) {
  TOKEN.lastIndex = 0;
  var match;
  var last = null;
  while ((match = TOKEN.exec(text))) last = match;
  if (!last || last.index + last[0].length !== text.length) return false;
  var token = last[0];
  if (last[1]) return token.slice(0, 2) === "//" || token.slice(-2) !== "*/" || token.length < 4;
  if (last[2]) return !/^(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\x60(?:[^\x60\\]|\\[\s\S])*\x60)$/.test(token);
  return false;
}

function suggestions(text, caret) {
  var before = text.slice(0, caret);
  var prefix = (/[A-Za-z_$][\w$]*$/.exec(before) || [""])[0];
  var head = before.slice(0, before.length - prefix.length);
  if (inLiteral(head)) return null;
  var models = app.schema.namespaces.map(function (n) { return { name: n.apiName, hint: "model" }; });
  var list = [];
  var dotted = /(?:\bdb\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(head);
  if (/\bdb\s*\.\s*$/.test(head)) {
    list = models;
  } else if (dotted && namespace(dotted[1])) {
    list = METHODS.map(function (name) { return { name: name, hint: /create|update|upsert|delete/i.test(name) ? "write" : "read" }; });
  } else {
    var call = callHead(before);
    if (!call) {
      if (/^\s*(await\s+)?$/.test(head)) list = [{ name: "db", hint: "client" }].concat(models);
    } else if (caret >= call.open && /[{,]\s*$/.test(head)) {
      var path = keyPath(text.slice(call.open, caret - prefix.length));
      if (path.length === 0 || path[path.length - 1].array) return null;
      list = keysAt(call, path);
    }
  }
  var lower = prefix.toLowerCase();
  var seen = {};
  list = list.filter(function (item) {
    if (seen[item.name] || item.name === prefix || item.name.toLowerCase().indexOf(lower) !== 0) return false;
    seen[item.name] = true;
    return true;
  });
  return list.length ? { items: list, prefix: prefix } : null;
}

var charWidth = 0;
function caretPoint(input, caret) {
  if (!charWidth) {
    var probe = el("span", { text: "MMMMMMMMMM" });
    probe.style.font = "14px/22px var(--mono)";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    document.body.append(probe);
    charWidth = probe.getBoundingClientRect().width / 10;
    probe.remove();
  }
  var lines = input.value.slice(0, caret).split("\n");
  var area = input.getBoundingClientRect();
  var frame = $("console").getBoundingClientRect();
  return {
    left: area.left - frame.left + 16 + lines[lines.length - 1].length * charWidth - input.scrollLeft,
    top: area.top - frame.top + 14 + lines.length * 22 - input.scrollTop + 4
  };
}

function openComplete(force) {
  var input = $("code-input");
  if (input.selectionStart !== input.selectionEnd || !app.schema) { closeComplete(); return; }
  var found = suggestions(input.value, input.selectionStart);
  if (!found || (!force && found.prefix === "" && !/\.\s*$/.test(input.value.slice(0, input.selectionStart)))) { closeComplete(); return; }
  con.items = found.items.slice(0, 50);
  con.prefix = found.prefix;
  con.active = 0;
  var box = $("complete");
  box.innerHTML = "";
  con.items.forEach(function (item, index) {
    box.append(el("button", {
      type: "button",
      role: "option",
      id: "complete-" + index,
      "aria-selected": index === 0 ? "true" : "false",
      onmousedown: function (event) { event.preventDefault(); accept(index); }
    }, [el("span", { text: item.name }), el("span", { class: "hint", text: item.hint })]));
  });
  var point = caretPoint(input, input.selectionStart);
  box.style.left = Math.max(0, Math.min(point.left, $("console").clientWidth - 240)) + "px";
  box.style.top = point.top + "px";
  box.hidden = false;
  input.setAttribute("aria-activedescendant", "complete-0");
}

function closeComplete() {
  $("complete").hidden = true;
  con.items = [];
  $("code-input").removeAttribute("aria-activedescendant");
}

function moveComplete(step) {
  var buttons = $("complete").children;
  con.active = (con.active + step + con.items.length) % con.items.length;
  for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute("aria-selected", i === con.active ? "true" : "false");
  buttons[con.active].scrollIntoView({ block: "nearest" });
  $("code-input").setAttribute("aria-activedescendant", "complete-" + con.active);
}

function accept(index) {
  var input = $("code-input");
  var item = con.items[index];
  if (!item) return;
  var caret = input.selectionStart;
  var start = caret - con.prefix.length;
  input.setRangeText(item.name, start, caret, "end");
  closeComplete();
  codeChanged();
}

function codeChanged() {
  con.error = null;
  try { localStorage.setItem(QUERY_KEY, $("code-input").value); } catch (e) {}
  paintCode();
}

// ---- Running ----

function currentSource() {
  var input = $("code-input");
  var selected = input.value.slice(input.selectionStart, input.selectionEnd);
  return selected.trim() ? selected : input.value;
}

function runQuery() {
  if (!app.schema) return;
  closeComplete();
  var source = currentSource();
  if (!source.trim()) return;
  var prepared;
  try {
    prepared = tapedbRunner.prepare(source, app.schema);
  } catch (error) {
    showProblem(error, source);
    return;
  }
  remember(source.trim());
  var run = ++con.running;
  var plan = prepared.plan;
  if (plan.kind === "read") {
    setResult({ busy: "Running " + prepared.model + "." + prepared.method + "…" });
    var started = performance.now();
    query(plan.document).then(function (result) {
      if (run !== con.running) return;
      var value = plan.project(result.data || {}, result.pageInfo || {});
      setResult({ prepared: prepared, value: value, ms: Math.round(performance.now() - started) });
      var rows = rowsOf(prepared, value);
      if (rows && namespace(prepared.model)) loadLabels(prepared.model, rows).then(function (changed) { if (changed && run === con.running) renderResult(); });
    }).catch(function (error) { if (run === con.running) showProblem(error); });
    return;
  }
  setResult({ busy: "Checking what " + prepared.model + "." + prepared.method + " changes…" });
  describeQueryWrite(prepared).then(function (summary) {
    if (run === con.running) setResult({ prepared: prepared, confirm: summary });
  }).catch(function (error) { if (run === con.running) showProblem(error); });
}

function showProblem(error, source) {
  var message = error && error.message ? error.message : String(error);
  con.error = null;
  if (error && typeof error.line === "number" && source !== undefined) {
    // Place the caret where the parser stopped.
    var input = $("code-input");
    var base = input.value.indexOf(source);
    var lines = source.split("\n").slice(0, error.line - 1).join("\n");
    var offset = Math.max(0, base) + (error.line > 1 ? lines.length + 1 : 0) + error.column - 1;
    con.error = { offset: offset };
    paintCode();
    input.focus();
    input.setSelectionRange(offset, offset);
  }
  setResult({ problem: message });
}

function plural(n, word) { return n + " " + word + (n === 1 ? " row" : " rows"); }

/** What a write will do, in words, before it runs. Deletes list what they take with them. */
function describeQueryWrite(prepared) {
  var plan = prepared.plan;
  var model = prepared.model;
  if (plan.kind === "bulk") {
    var where = plan.op.where;
    var doc = {};
    doc[model] = { $: { where: where, select: ["id"] } };
    return query(doc).then(function (result) {
      var ids = ((result.data || {})[model] || []).map(function (row) { return row.id; });
      if (ids.length === 0) return { title: "No " + model + " rows match", lines: [], none: true };
      if (plan.op.op === "patchMany") {
        var values = plan.op.values || {};
        var sets = Object.keys(values).map(function (field) { return field + " to " + JSON.stringify(values[field]); });
        return { title: "Update " + plural(ids.length, model), lines: [{ text: "Sets " + sets.join(", ") + " on each, in one transaction." }], go: "Update " + (ids.length === 1 ? "1 row" : ids.length + " rows") };
      }
      return deleteImpact(model, ids).then(function (impact) {
        return { title: "Delete " + plural(ids.length, model), lines: impact, refused: refusedBy(impact), danger: true, go: "Delete " + (ids.length === 1 ? "1 row" : ids.length + " rows") };
      });
    });
  }
  var counts = {};
  plan.ops.forEach(function (op) {
    var verb = { insert: "Creates", patch: "Updates", update: "Replaces", upsert: "Creates or updates", delete: "Deletes", link: "Links", unlink: "Unlinks" }[op.op] || op.op;
    var key = verb + " " + op.namespace;
    counts[key] = (counts[key] || 0) + 1;
  });
  var lines = Object.keys(counts).map(function (key) {
    var parts = key.split(" ");
    var name = parts.pop();
    return { text: parts.join(" ") + " " + plural(counts[key], name) + "." };
  });
  var method = prepared.method;
  // The title says what happens to the row itself; the lines add what else the call writes.
  var primary = { create: "Creates", upsert: "Creates or updates", update: "Updates" }[method] + " 1 " + model + " row.";
  lines = lines.filter(function (line) { return line.text !== primary; });
  if (method === "create" || method === "upsert") {
    return Promise.resolve({ title: method === "create" ? "Create a " + model + " row" : "Create or update a " + model + " row", lines: lines, go: method === "create" ? "Create" : "Write" });
  }
  // update and delete address one row: say so plainly when there is none.
  var doc = {};
  doc[model] = { $: { where: { id: plan.id }, select: ["id"], limit: 1 } };
  return query(doc).then(function (result) {
    if (((result.data || {})[model] || []).length === 0) return { title: "No " + model + " row has this id", lines: [{ text: plan.id }], none: true };
    if (method === "delete") {
      return deleteImpact(model, [plan.id]).then(function (impact) {
        return { title: "Delete this " + model + " row", lines: [{ text: plan.id }].concat(impact), refused: refusedBy(impact), danger: true, go: "Delete row" };
      });
    }
    return { title: "Update this " + model + " row", lines: [{ text: plan.id }].concat(lines), go: "Update" };
  });
}

function refusedBy(impact) { return impact.some(function (line) { return line.refused; }); }

function runWrite(prepared) {
  var plan = prepared.plan;
  var run = ++con.running;
  setResult({ busy: "Writing…" });
  var ops = plan.kind === "bulk" ? [plan.op] : plan.ops;
  var started = performance.now();
  transact(ops).then(function (answer) {
    if (run !== con.running) return;
    var result = answer && answer.result;
    // Names the write on the tape when it lands.
    con.tapeLabel = prepared.model + "." + prepared.method;
    var matched = result && result.matched ? result.matched[0] : undefined;
    var done = plan.kind === "bulk"
      ? (plan.op.op === "patchMany" ? "Updated " : "Deleted ") + plural(matched || 0, prepared.model)
      : { create: "Created", update: "Updated", upsert: "Wrote", delete: "Deleted" }[prepared.method] + " " + prepared.model + " " + shortId(plan.id);
    setResult({ prepared: prepared, written: done + (result && typeof result.seq === "number" ? ", tx_" + pad(result.seq, 4) : "") + ".", ms: Math.round(performance.now() - started) });
  }).catch(function (error) { if (run === con.running) showProblem(error); });
}

// ---- Results ----

function setResult(result) {
  con.result = result;
  renderResult();
}

function rowsOf(prepared, value) {
  if (!prepared || prepared.plan.kind !== "read") return null;
  var key = prepared.plan.key;
  if (key === "many" || key === "groupBy") return value;
  if (key === "first") return value ? [value] : [];
  if (key === "page") return value.rows;
  return null;
}

function resultCell(model, field, value, row) {
  // An aggregate row: the value has the measured field's type, except counts and averages.
  if (row && field === "value" && "measure" in row && row.field && model && row.measure !== "_count" && row.measure !== "_avg") {
    return value === null ? el("span", { class: "null", text: "null" }) : cellContent(model, row.field, value);
  }
  if (Array.isArray(value)) return el("span", { class: "many", text: value.length === 1 ? "1 row" : value.length + " rows" });
  if (value && typeof value === "object" && model && relationsOf(model)[field]) {
    var target = relationsOf(model)[field].target;
    var name = labelField(target) && value[labelField(target)];
    return el("span", { class: "many", text: name ? String(name) : shortId(String(value.id)) });
  }
  if (model && (field === "id" || namespace(model).attributes[field] || SYSTEM.indexOf(field) >= 0)) return cellContent(model, field, value);
  if (value === null || value === undefined) return el("span", { class: "null", text: "null" });
  if (typeof value === "object") return el("span", { class: "mono", text: JSON.stringify(value) });
  if (typeof value === "number") return el("span", { class: "mono num", text: value.toLocaleString() });
  return el("span", { text: String(value) });
}

function resultTable(model, rows) {
  var keys = [];
  rows.slice(0, RESULT_ROWS).forEach(function (row) {
    Object.keys(row).forEach(function (key) { if (keys.indexOf(key) < 0) keys.push(key); });
  });
  if (keys.indexOf("id") > 0) { keys.splice(keys.indexOf("id"), 1); keys.unshift("id"); }
  var flat = function (row) {
    var out = {};
    keys.forEach(function (key) { out[key] = row[key]; });
    return out;
  };
  var table = el("table");
  var headRow = el("tr");
  keys.forEach(function (key) {
    var relation = model && relationsOf(model)[key];
    var type = relation ? (relation.many ? "many " : "one ") + relation.target : model && (key === "id" || namespace(model).attributes[key] || SYSTEM.indexOf(key) >= 0) ? typeOf(model, key) : "";
    headRow.append(el("th", {}, [el("button", { type: "button", disabled: true }, [el("span", { class: "label", text: key }), type ? el("span", { class: "type", text: type }) : null])]));
  });
  table.append(el("thead", {}, [headRow]));
  var body = el("tbody");
  rows.slice(0, RESULT_ROWS).forEach(function (row) {
    var shaped = flat(row);
    body.append(el("tr", {}, keys.map(function (key) {
      return el("td", { class: key === "id" ? "id" : "" }, [resultCell(model, key, shaped[key], row)]);
    })));
  });
  table.append(body);
  return table;
}

function figure(value, text) {
  return el("div", { class: "figure" }, [el("b", { text: typeof value === "number" ? value.toLocaleString() : String(value) }), el("span", { class: "label", text: text })]);
}

/** aggregate: one row per measure, e.g. _sum / points / 12. */
function measures(value) {
  var rows = [];
  Object.keys(value || {}).forEach(function (measure) {
    var inner = value[measure];
    if (inner && typeof inner === "object") Object.keys(inner).forEach(function (field) { rows.push({ measure: measure, field: field, value: inner[field] }); });
    else rows.push({ measure: measure, field: "", value: inner });
  });
  return rows;
}

function renderResult() {
  var bar = $("result-bar");
  var panel = $("result-panel");
  var box = $("result");
  bar.innerHTML = "";
  box.innerHTML = "";
  var result = con.result;
  panel.hidden = !result || !!result.busy;
  if (!result) {
    bar.append(el("span", { class: "label", text: (MAC ? "⌘" : "Ctrl") + " Enter runs the call, or the selected one. " + (MAC ? "⌃" : "Ctrl") + " Space suggests." }));
    return;
  }
  if (result.busy) { bar.append(el("span", { class: "what", text: result.busy })); return; }
  if (result.problem) {
    bar.append(el("span", { class: "what error", text: "The call did not run" }));
    box.append(el("div", { class: "problem" }, [el("p", { text: result.problem })]));
    return;
  }
  var prepared = result.prepared;
  var model = prepared.model;
  if (result.confirm) {
    var summary = result.confirm;
    var go = summary.none ? null : el("button", {
      class: "btn small " + (summary.danger ? "danger armed" : "primary"),
      type: "button",
      disabled: summary.refused || undefined,
      onclick: function () { runWrite(prepared); }
    }, [summary.go]);
    box.append(el("div", { class: "confirm" }, [
      stopped(el("h2"), summary.title),
      summary.lines.length ? el("ul", { class: "impact" }, summary.lines.map(function (line) {
        return el("li", { class: line.refused ? "refused" : "", text: line.text });
      })) : null,
      el("div", { class: "actions" }, [
        el("button", { class: "btn small", type: "button", onclick: function () { setResult(null); $("code-input").focus(); } }, ["Cancel"]),
        go
      ])
    ]));
    return;
  }
  if (result.written) {
    bar.append(el("span", { class: "what", text: result.written }), el("span", { class: "label num", text: result.ms + " ms" }));
    panel.hidden = true;
    return;
  }
  var value = result.value;
  var key = prepared.plan.key;
  var rows = rowsOf(prepared, value);
  var what;
  if (key === "count") what = plural(value, model) + " match";
  else if (key === "aggregate") what = "Aggregate over " + model;
  else if (key === "groupBy") what = value.length === 1 ? "1 group" : value.length + " groups";
  else if (key === "page") what = plural(rows.length, model) + (value.hasMore ? ", more after this page" : "");
  else what = rows.length === 0 ? "No " + model + " rows match" : plural(rows.length, model);
  bar.append(el("span", { class: "what", text: what }), el("span", { class: "label num", text: result.ms + " ms" }));
  if (rows && rows.length > RESULT_ROWS && con.view === "table") bar.append(el("span", { class: "label", text: "Table shows the first " + RESULT_ROWS + "; JSON has all" }));
  bar.append(el("span", { class: "spacer" }));
  if (key !== "count") {
    bar.append(el("div", { class: "seg", role: "group", "aria-label": "Result view" }, ["table", "json"].map(function (view) {
      return el("button", { type: "button", "aria-pressed": con.view === view ? "true" : "false", onclick: function () { con.view = view; renderResult(); } }, [view === "table" ? "Table" : "JSON"]);
    })));
  }
  if (key === "count") { box.append(figure(value, plural(value, model).replace(/^[\d,]+ /, "") + " match")); return; }
  if (con.view === "json") { box.append(el("pre", { class: "json", text: JSON.stringify(value, null, 2) })); return; }
  if (key === "aggregate") {
    if (!value) { box.append(figure("—", "No rows match")); return; }
    box.append(resultTable(model, measures(value)));
    return;
  }
  if (rows.length === 0) { panel.hidden = true; return; }
  box.append(resultTable(model, rows));
}

function renderRecent() {
  var menu = $("recent-menu");
  menu.innerHTML = "";
  var list = history();
  if (list.length === 0) return;
  var pop = el("div", { class: "pop recent", hidden: true });
  list.forEach(function (source) {
    pop.append(el("button", { type: "button", title: source, onclick: function () {
      $("code-input").value = source;
      pop.hidden = true;
      codeChanged();
      $("code-input").focus();
    } }, [source.replace(/\s+/g, " ")]));
  });
  menu.append(el("button", { class: "btn small", type: "button", "aria-haspopup": "true", "aria-expanded": "false", onclick: function (event) {
    event.stopPropagation();
    pop.hidden = !pop.hidden;
    event.currentTarget.setAttribute("aria-expanded", pop.hidden ? "false" : "true");
  } }, ["Recent"]), pop);
}

(function wireConsole() {
  var button = $("open-query");
  button.append(icon("prompt", 16), el("span", { class: "name", text: "Query" }));
  $("open-access").append(icon("shield", 16), el("span", { class: "name", text: "Access" }));
  $("open-access").addEventListener("click", openAccess);
  $("open-history").append(icon("clock", 16), el("span", { class: "name", text: "History" }));
  $("open-history").addEventListener("click", function () { openHistory(); });
  stopped($("history-title"), "History");
  // The tape's counter opens the log it counts.
  $("counter").addEventListener("click", function () { openHistory(); });
  stopped($("access-title"), "Access");
  button.addEventListener("click", openQuery);
  $("run").append("Run", el("kbd", { text: MAC ? "⌘↵" : "Ctrl ↵" }));
  stopped($("console-title"), "Query");
  $("run").addEventListener("click", runQuery);
  var input = $("code-input");
  input.addEventListener("input", function (event) {
    codeChanged();
    var typed = event.data || "";
    if (/^[\w$.]$/.test(typed)) openComplete(false);
    else closeComplete();
  });
  input.addEventListener("scroll", function () { syncScroll(); closeComplete(); });
  input.addEventListener("blur", function () { setTimeout(closeComplete, 0); });
  input.addEventListener("click", closeComplete);
  input.addEventListener("keydown", function (event) {
    var open = !$("complete").hidden && con.items.length > 0;
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); runQuery(); return; }
    if (event.ctrlKey && (event.key === " " || event.code === "Space")) { event.preventDefault(); openComplete(true); return; }
    if (open && event.key === "ArrowDown") { event.preventDefault(); moveComplete(1); return; }
    if (open && event.key === "ArrowUp") { event.preventDefault(); moveComplete(-1); return; }
    if (open && (event.key === "Enter" || event.key === "Tab")) { event.preventDefault(); accept(con.active); return; }
    if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeComplete(); return; }
    if (event.key === "Tab" && !event.shiftKey) { event.preventDefault(); input.setRangeText("  ", input.selectionStart, input.selectionEnd, "end"); codeChanged(); }
  });
})();

// ---- Import and export -------------------------------------------------------
//
// tapedbRunner (src/studio/table-io.ts) writes and reads the files and plans
// the writes with the client's own code; this part fetches, downloads and runs.

/** Rows per transaction on import. A file up to this size imports whole or not at all. */
var IMPORT_CHUNK = 5000;

function download(name, text, type) {
  var url = URL.createObjectURL(new Blob([text], { type: type }));
  var link = el("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
}

function exportRows(scope, format) {
  var model = app.model;
  var picked = Object.keys(app.picked);
  var where = scope === "selected" ? { id: { $in: picked } } : scope === "view" ? whereClause() : undefined;
  var order = {};
  order[app.order.field] = app.order.dir;
  var doc = {};
  doc[model] = { $: { order: order } };
  if (where) doc[model].$.where = where;
  query(doc).then(function (result) {
    var rows = (result.data || {})[model] || [];
    var text = format === "csv" ? tapedbRunner.toCsv(app.schema, model, rows) : tapedbRunner.toJson(app.schema, model, rows);
    download(model + "." + format, text, format === "csv" ? "text/csv;charset=utf-8" : "application/json");
    toast("Exported " + rows.length + (rows.length === 1 ? " row" : " rows") + " to " + model + "." + format);
  }).catch(fail);
}

function exportMenu() {
  var wrap = $("export-menu");
  wrap.innerHTML = "";
  var picked = Object.keys(app.picked).length;
  var narrowed = app.filters.length > 0 || !!app.search;
  var scopes = [];
  if (picked) scopes.push(["selected", picked === 1 ? "The selected row" : "The " + picked + " selected rows"]);
  if (narrowed) scopes.push(["view", "Rows this search and filter show" + (app.total === null ? "" : " (" + app.total + ")")]);
  scopes.push(["all", "All rows" + (app.counts[app.model] === undefined ? "" : " (" + app.counts[app.model] + ")")]);
  var button = el("button", { class: "btn", type: "button", "aria-expanded": "false", text: "Export" });
  var pop = el("div", { class: "pop end", hidden: true });
  scopes.forEach(function (scope) {
    pop.append(el("div", { class: "pop-head label", text: scope[1] }));
    ["csv", "json"].forEach(function (format) {
      pop.append(el("button", { class: "pop-item", type: "button", onclick: function () {
        pop.hidden = true;
        button.setAttribute("aria-expanded", "false");
        exportRows(scope[0], format);
      } }, [format === "csv" ? "CSV" : "JSON", el("span", { class: "hint", text: app.model + "." + format })]));
    });
  });
  button.addEventListener("click", function (event) {
    event.stopPropagation();
    pop.hidden = !pop.hidden;
    button.setAttribute("aria-expanded", pop.hidden ? "false" : "true");
  });
  pop.addEventListener("click", function (event) { event.stopPropagation(); });
  wrap.append(button, pop);
}

/** How many of these ids are rows already, asked in chunks. */
function existing(model, ids) {
  var chunks = [];
  for (var i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500));
  return Promise.all(chunks.map(function (chunk) {
    var doc = {};
    doc[model] = { $: { where: { id: { $in: chunk } }, count: true, limit: 0 } };
    return query(doc).then(function (result) { return ((result.pageInfo || {})[model] || {}).count || 0; });
  })).then(function (counts) { return counts.reduce(function (a, b) { return a + b; }, 0); });
}

function importFile(file) {
  var model = app.model;
  file.text().then(function (text) {
    var planned;
    try {
      planned = tapedbRunner.planImport(app.schema, model, tapedbRunner.readTable(file.name, text));
    } catch (error) {
      openSheet(model, "Cannot import " + file.name, [el("div", { class: "notice warn" }, [el("span", { class: "label", text: "Not imported" }), error.message])], "Import", null);
      $("sheet-go").disabled = true;
      return;
    }
    return existing(model, planned.ids).then(function (found) { showImport(model, file.name, planned, found); });
  }).catch(fail);
}

function showImport(model, name, planned, found) {
  var total = planned.rows.length;
  var rowsText = function (n) { return n === 1 ? "1 row" : n + " rows"; };
  var lines = [];
  if (planned.creates) lines.push("Creates " + rowsText(planned.creates) + " without an id, with " + (planned.creates === 1 ? "a new id." : "new ids."));
  if (found) lines.push("Updates " + rowsText(found) + " whose id exists, with the file's values.");
  if (planned.upserts - found) lines.push("Creates " + rowsText(planned.upserts - found) + " with the ids in the file.");
  if (planned.ignored.length) lines.push("Leaves out " + planned.ignored.join(", ") + ": " + (planned.ignored.length === 1 ? "not a field" : "not fields") + " of " + model + ".");
  if (planned.system.length) lines.push("Keeps " + planned.system.join(", ") + " as the database sets them.");
  var chunks = Math.ceil(total / IMPORT_CHUNK);
  // With values to fix, only what to fix (and which columns are left out) matters.
  if (planned.errors.length) lines = planned.ignored.length ? [lines.filter(function (line) { return /^Leaves out/.test(line); })[0]] : [];
  else if (total) lines.push(chunks === 1 ? "Runs in one transaction: every row, or none." : "Runs as " + chunks + " transactions of up to " + IMPORT_CHUNK + " rows. If one fails, the ones before it stay.");
  var body = [el("p", { class: "hint", text: name })];
  if (planned.errors.length) {
    var shown = planned.errors.slice(0, 8);
    body.push(el("div", { class: "notice warn" }, [
      el("span", { class: "label", text: "Fix the file first" }),
      planned.errors.length === 1 ? "One value does not fit its field:" : planned.errors.length + " values do not fit their fields:",
      el("ul", { class: "impact" }, shown.map(function (e) { return el("li", { class: "refused", text: "Row " + e.row + ": " + e.message }); }).concat(planned.errors.length > shown.length ? [el("li", { text: "and " + (planned.errors.length - shown.length) + " more." })] : []))
    ]));
  }
  if (!planned.errors.length && total === 0) body.push(el("p", { text: "The file has no rows." }));
  if (lines.length) body.push(el("ul", { class: "impact" }, lines.map(function (line) { return el("li", { text: line }); })));
  var title = planned.errors.length ? "Cannot import " + name : "Import " + rowsText(total) + " into " + model;
  openSheet(model, title, body, "Import " + rowsText(total), null);
  var go = $("sheet-go");
  go.disabled = planned.errors.length > 0 || total === 0;
  sheetGo = function () {
    go.disabled = true;
    var done = 0;
    var next = function () {
      if (done >= total) return Promise.resolve();
      var ops = [];
      planned.rows.slice(done, done + IMPORT_CHUNK).forEach(function (rowOps) { ops = ops.concat(rowOps); });
      go.textContent = chunks > 1 ? "Importing " + Math.min(done + IMPORT_CHUNK, total) + " of " + total + "…" : "Importing…";
      return transact(ops).then(function () { done = Math.min(done + IMPORT_CHUNK, total); return next(); });
    };
    next().then(function () {
      closeSheet();
      toast("Imported " + rowsText(total) + " into " + model);
      reloadRows();
      refreshCounts();
    }).catch(function (error) {
      fail(done ? new Error("Imported " + rowsText(done) + ", then: " + error.message) : error);
      go.disabled = false;
      go.textContent = "Import " + rowsText(total - done);
      planned.rows = planned.rows.slice(done);
      total -= done;
      done = 0;
    });
  };
}

$("import").addEventListener("click", function () { $("import-file").value = ""; $("import-file").click(); });
$("import-file").addEventListener("change", function (event) {
  var file = event.target.files && event.target.files[0];
  if (file) importFile(file);
});

// ---- Tools: the views that are not a model -----------------------------------

function openTool(name) {
  if (!app.schema) return false;
  if (stagedCount() > 0) { toast("Save or discard your changes first.", true); return false; }
  closeDrawer();
  closeSheet();
  closeComplete();
  app.tool = name;
  app.model = "";
  renderModels();
  ["head", "tabs", "structure", "filters", "bulk", "panel"].forEach(function (id) { $(id).hidden = true; });
  $("console").hidden = name !== "query";
  $("access").hidden = name !== "access";
  $("history").hidden = name !== "history";
  return true;
}

function closeTool() {
  app.tool = "";
  closeComplete();
  $("console").hidden = true;
  $("access").hidden = true;
  $("history").hidden = true;
  $("panel").hidden = false;
}

// ---- Access: who may do what, and seeing the workspace as someone else ----

function roleName(level) { return ROLES[level] || "Role " + level; }

/** Nine ticks, one per role from Guest to Developer: lit from the lowest role allowed; the caller's is marked. */
function ladder(minimum) {
  var you = app.schema.caller ? app.schema.caller.role : -1;
  var node = el("span", { class: "ladder", title: ROLES.map(function (name, level) { return (level >= minimum ? "✓ " : "· ") + name; }).join("\n") });
  ROLES.forEach(function (name, level) {
    node.append(el("i", { class: (level >= minimum ? "on" : "") + (level === you ? " you" : "") }));
  });
  return node;
}

function scalarText(value) {
  return typeof value === "string" ? JSON.stringify(value) : value === null ? "null" : String(value);
}

/** An engine filter in words: ownerId = "alice" or open = true. */
function whereText(where) {
  var parts = [];
  Object.keys(where || {}).forEach(function (key) {
    var value = where[key];
    if (key === "$or") { parts.push("(" + value.map(whereText).join(" or ") + ")"); return; }
    if (key === "$and") { parts.push(value.map(whereText).join(" and ")); return; }
    if (key === "$not") { parts.push("not (" + whereText(value) + ")"); return; }
    if (key === "$link") {
      value.forEach(function (link) {
        var mode = link.mode === "parent" ? "" : link.mode + " ";
        parts.push(link.label + " has " + mode + "(" + whereText(link.where) + ")");
      });
      return;
    }
    if (value === null || typeof value !== "object") { parts.push(key + " = " + scalarText(value)); return; }
    var ops = { $ne: "≠", $gt: ">", $gte: "≥", $lt: "<", $lte: "≤" };
    Object.keys(value).forEach(function (op) {
      if (ops[op]) parts.push(key + " " + ops[op] + " " + scalarText(value[op]));
      else if (op === "$in") parts.push(key + " in [" + value[op].map(scalarText).join(", ") + "]");
      else if (op === "$nin") parts.push(key + " not in [" + value[op].map(scalarText).join(", ") + "]");
      else parts.push(key + " " + op + " " + JSON.stringify(value[op]));
    });
  });
  return parts.length ? parts.join(" and ") : "every row";
}

/** One cell of the access table: the rule, what it means for the caller, and the rule's code when the studio can read the schema file. */
function accessCell(decision, code, fallbackRole) {
  var you = app.schema.caller ? app.schema.caller.role : null;
  var cell = el("td", { class: "rule" });
  if (!decision) decision = { rule: "role", role: fallbackRole };
  if (decision.rule === "role") {
    var allowed = you !== null && you >= decision.role;
    cell.append(
      el("div", { class: "what" }, [ladder(decision.role), decision.role === 0 ? "Everyone" : roleName(decision.role) + " and up"]),
      el("div", { class: "you " + (allowed ? "yes" : "no") }, [icon(allowed ? "check" : "ring", 14), allowed ? "Allowed for " + whoText() : "Not for " + whoText()])
    );
  } else if (decision.rule === "filter") {
    var where = decision.where || [];
    cell.append(
      el("div", { class: "what" }, ["Rows the filter allows"]),
      el("div", { class: "you" }, [seesText(where)])
    );
  } else if (decision.rule === "attachedTo") {
    cell.append(el("div", { class: "what" }, ["Follows the " + decision.model + " row it belongs to"]),
      el("div", { class: "you" }, ["Read with the row; written and deleted by whoever may update it"]));
  } else {
    cell.append(el("div", { class: "what" }, ["A check in code"]), el("div", { class: "you" }, ["Decided for each row, with the caller and the row"]));
  }
  if (code) cell.append(el("code", { text: code }));
  else if (app.structure && app.structure.editable) cell.append(el("span", { class: "default label", text: "Default" }));
  return cell;
}

/** "You see rows where done = false", or "Member alice sees …" while viewing as someone. */
function seesText(where) {
  var subject = viewing() ? whoText() + " sees " : "You see ";
  if (where.length === 0) return subject + "no rows";
  var text = where.map(whereText);
  if (text.indexOf("every row") >= 0) return subject + "every row";
  return subject + "rows where " + text.join(", or ");
}

function whoText(capital) {
  var caller = app.schema.caller;
  if (!caller) return capital ? "You" : "you";
  return viewing() ? roleName(caller.role) + " " + caller.sub : capital ? "You" : "you";
}

function openAccess() {
  if (openTool("access")) renderAccess();
}

function renderAccess() {
  var box = $("access-body");
  box.innerHTML = "";
  var source = app.structure && app.structure.access;
  var defaults = { read: 2, create: 3, update: 3, delete: 4 };
  var actions = ["read", "create", "update", "delete"];
  var table = el("table", { class: "access-table" });
  table.append(el("thead", {}, [el("tr", {}, [el("th", {}, [el("span", { class: "label", text: "Model" })])].concat(actions.map(function (action) {
    return el("th", {}, [el("span", { class: "label", text: action.charAt(0).toUpperCase() + action.slice(1) })]);
  })))]));
  var body = el("tbody");
  app.schema.namespaces.forEach(function (n) {
    var code = source && source.models[n.apiName] || {};
    body.append(el("tr", {}, [el("th", { scope: "row" }, [el("button", { class: "model-link", type: "button", onclick: function () { selectModel(n.apiName); } }, [n.apiName])])].concat(actions.map(function (action) {
      return accessCell(n.access && n.access[action], code[action], defaults[action]);
    }))));
  });
  table.append(body);
  box.append(el("div", { class: "panel" }, [el("div", { class: "scroll" }, [table])]));

  var files = app.schema.files;
  if (files) {
    var fileActions = ["read", "write", "delete"];
    var fileDefaults = { read: 2, write: 3, delete: 3 };
    var fileCode = source && source.files || {};
    var fileTable = el("table", { class: "access-table" }, [
      el("thead", {}, [el("tr", {}, [el("th", {}, [el("span", { class: "label", text: "Files" })])].concat(fileActions.map(function (action) {
        return el("th", {}, [el("span", { class: "label", text: action.charAt(0).toUpperCase() + action.slice(1) })]);
      })).concat([el("th")]))]),
      el("tbody", {}, [el("tr", {}, [el("th", { scope: "row", text: "Every file" })].concat(fileActions.map(function (action) {
        return accessCell(files[action], fileCode[action], fileDefaults[action]);
      })).concat([el("td")]))])
    ]);
    box.append(el("div", { class: "panel" }, [el("div", { class: "scroll" }, [fileTable])]));
  }
}

/** True while the studio sees the workspace as someone other than its own sign-in. */
function viewing() { return !!(app.viewAs.role !== undefined || app.viewAs.sub); }

function renderWho() {
  var wrap = $("who-menu");
  wrap.innerHTML = "";
  var caller = app.schema && app.schema.caller;
  if (!caller) { wrap.hidden = true; return; }
  wrap.hidden = false;
  if (!viewing()) app.ownRole = caller.role;
  var button = el("button", { class: "who" + (viewing() ? " as" : ""), type: "button", "aria-expanded": "false", title: "See the workspace as another role" + (MODE === "local" ? " or user" : "") }, [
    el("span", { class: "label", text: viewing() ? "Viewing as" : "Signed in as" }),
    el("span", { class: "role", text: roleName(caller.role) }),
    el("span", { class: "sub mono", text: caller.sub })
  ]);
  var pop = el("div", { class: "pop end who-pop", hidden: true });
  var highest = MODE === "worker" ? (typeof app.ownRole === "number" ? app.ownRole : caller.role) : ROLES.length - 1;
  var select = listboxControl("view-role", ROLES.slice(0, highest + 1).map(function (name, level) {
    return [String(level), name];
  }), String(caller.role));
  var user = MODE === "local" ? el("input", { type: "text", "aria-label": "User id", placeholder: "dev-user", value: caller.sub === "dev-user" ? "" : caller.sub, spellcheck: "false" }) : null;
  pop.append(
    el("div", { class: "pop-head label", text: "See this workspace as" }),
    el("label", { class: "field" }, [el("span", { text: "Role" }), select]),
    user ? el("label", { class: "field" }, [el("span", { text: "User id" }), user]) : null,
    el("p", { class: "hint", text: MODE === "local"
      ? "Reads and writes run with that role and user id, through the access rules."
      : "Your own user, with your role or a lower one. Reads and writes run with it, through the access rules." }),
    el("div", { class: "actions" }, [
      viewing() ? el("button", { class: "btn small", type: "button", onclick: function () { setViewAs({}); } }, ["Back to me"]) : null,
      el("button", { class: "btn primary small", type: "button", onclick: function () {
        var role = Number(select.value);
        var sub = user ? user.value.trim() : "";
        var own = MODE === "local" ? role === 6 && (sub === "" || sub === "dev-user") : role === app.ownRole;
        setViewAs(own ? {} : MODE === "local" ? { role: role, sub: sub || undefined } : { role: role });
      } }, ["View"])
    ])
  );
  button.addEventListener("click", function (event) {
    event.stopPropagation();
    pop.hidden = !pop.hidden;
    button.setAttribute("aria-expanded", pop.hidden ? "false" : "true");
    if (!pop.hidden) select.focus();
  });
  pop.addEventListener("click", function (event) { event.stopPropagation(); });
  wrap.append(button, pop);
}

function setViewAs(next) {
  if (stagedCount() > 0) { toast("Save or discard your changes first.", true); return; }
  var applied = MODE === "local" ? api("/api/view-as", next) : Promise.resolve();
  applied.then(function () {
    app.viewAs = next;
    claims = {};
    openWorkspace(app.workspace);
  }).catch(fail);
}

// ---- History: the transaction log ------------------------------------------

var hist = { entries: [], next: null, model: "", open: {}, loading: false, problem: null, focus: null };

function openHistory(focusSeq) {
  if (!openTool("history")) return;
  hist.focus = typeof focusSeq === "number" ? focusSeq : null;
  if (hist.focus !== null) {
    hist.open[hist.focus] = true;
    hist.model = "";
  }
  loadHistory(false);
}

function loadHistory(older) {
  if (hist.loading) return;
  hist.loading = true;
  var params = { limit: 50 };
  if (hist.model) params.model = hist.model;
  // Focused on one transaction: start the page there, so it is first.
  if (older && hist.next !== null) params.before = hist.next;
  else if (!older && hist.focus !== null) params.before = hist.focus + 1;
  var workspace = app.workspace;
  api("/api/log", { workspaceId: workspace, params: params }).then(function (result) {
    if (workspace !== app.workspace) return;
    var data = result.data || { entries: [], next: null };
    hist.entries = older ? hist.entries.concat(data.entries) : data.entries;
    hist.next = data.next;
    hist.problem = null;
  }, function (error) {
    hist.problem = error;
  }).then(function () {
    hist.loading = false;
    if (app.tool === "history") renderHistory();
  });
}

/** New transactions landed: show them at the top, unless the page is focused on an older one. */
function refreshHistory() {
  if (app.tool !== "history" || hist.focus !== null || hist.loading) return;
  var known = hist.entries.length ? hist.entries[0].seq : 0;
  var params = { limit: 50 };
  if (hist.model) params.model = hist.model;
  api("/api/log", { workspaceId: app.workspace, params: params }).then(function (result) {
    var fresh = ((result.data || {}).entries || []).filter(function (entry) { return entry.seq > known; });
    if (fresh.length === 0) return;
    fresh.forEach(function (entry) { hist.marks = hist.marks || {}; hist.marks[entry.seq] = true; });
    hist.entries = fresh.concat(hist.entries);
    renderHistory();
  }).catch(function () {});
}

var OP_WORDS = { insert: ["created", "Create"], update: ["replaced", "Replace"], patch: ["updated", "Update"], upsert: ["created or updated", "Upsert"], merge: ["updated", "Update"], delete: ["deleted", "Delete"], link: ["linked", "Link"], unlink: ["unlinked", "Unlink"], patchIds: ["updated", "Update"], deleteIds: ["deleted", "Delete"] };

/** "task: 2 updated, 1 created  ·  column: 1 deleted" */
function entrySummary(entry) {
  return Object.keys(entry.counts || {}).map(function (model) {
    var words = {};
    Object.keys(entry.counts[model]).forEach(function (op) {
      var word = (OP_WORDS[op] || [op])[0];
      words[word] = (words[word] || 0) + entry.counts[model][op];
    });
    return model + ": " + Object.keys(words).map(function (word) { return words[word].toLocaleString() + " " + word; }).join(", ");
  }).join("   ");
}

function valueText(model, field, value) {
  if (value === null || value === undefined) return "null";
  var type = namespace(model) && namespace(model).attributes[field] ? typeOf(model, field) : "";
  if (type === "date" && typeof value === "number") return formatDate(value);
  if (typeof value === "string") return JSON.stringify(value.length > 80 ? value.slice(0, 80) + "…" : value);
  return JSON.stringify(value);
}

function rowLink(model, id) {
  return el("button", { class: "ref unnamed", type: "button", title: "Open " + model + " " + id, onclick: function () {
    if (namespace(model)) jumpTo(model, id);
  } }, [el("span", { text: shortId(id) })]);
}

function opLine(op) {
  var words = OP_WORDS[op.op] || [op.op, op.op];
  var line = el("li", { class: "op" });
  var head = el("div", { class: "op-head" }, [el("span", { class: "verb " + op.op, text: words[1] }), el("span", { class: "model", text: op.namespace })]);
  if (op.id) head.append(rowLink(op.namespace, op.id));
  if (op.ids) {
    head.append(el("span", { class: "count", text: op.count === 1 ? "1 row" : op.count + " rows" }));
    op.ids.forEach(function (id) { head.append(rowLink(op.namespace, id)); });
    if (op.count > op.ids.length) head.append(el("span", { class: "count", text: "and " + (op.count - op.ids.length) + " more" }));
  }
  if (op.link) head.append(el("span", { class: "count", text: op.link + " → " }), rowLink("", op.targetId || ""));
  line.append(head);
  var values = op.values || {};
  var fields = Object.keys(values);
  if (fields.length || (op.hidden && op.hidden.length)) {
    var list = el("dl", { class: "values" });
    fields.forEach(function (field) {
      list.append(el("dt", { text: field }), el("dd", { class: "mono", text: valueText(op.namespace, field, values[field]) }));
    });
    if (op.hidden && op.hidden.length) {
      list.append(el("dt", { text: op.hidden.join(", ") }), el("dd", { class: "hidden-values", text: "Not shown: personal, or decided per row by " + op.namespace + "'s read rule" }));
    }
    line.append(list);
    if (op.whole) line.append(el("p", { class: "note", text: "The whole row after this write." }));
  }
  return line;
}

function renderHistory() {
  var box = $("history-body");
  box.innerHTML = "";
  var filter = listboxControl("history-model", [["", "All models"]].concat(app.schema.namespaces.map(function (n) {
    return [n.apiName, n.apiName];
  })), hist.model, function (value) {
    hist.model = value;
    hist.focus = null;
    hist.next = null;
    loadHistory(false);
  });
  var bar = el("div", { class: "filters" }, [el("label", { class: "select" }, [filter])]);
  if (hist.focus !== null) bar.append(el("button", { class: "quiet label", type: "button", text: "Show the latest", onclick: function () { hist.focus = null; loadHistory(false); } }));
  box.append(bar);

  if (hist.problem) {
    var forbidden = hist.problem.status === 403;
    box.append(el("div", { class: "panel is-empty" }, [el("div", { class: "empty" }, [
      stopped(el("h2"), forbidden ? "The log is for admins and owners" : "The log could not be read"),
      el("p", { text: forbidden ? "It names who wrote what. Sign in as an admin or owner of this workspace to read it." : hist.problem.message })
    ])]));
    return;
  }
  if (!hist.entries.length && !hist.loading) {
    box.append(el("div", { class: "panel is-empty" }, [el("div", { class: "empty" }, [
      stopped(el("h2"), hist.model ? "No writes to " + hist.model : "No writes yet"),
      el("p", { text: "Transactions appear here as they land, newest first." })
    ])]));
    return;
  }
  var list = el("ol", { class: "log" });
  hist.entries.forEach(function (entry) {
    var open = !!hist.open[entry.seq];
    var item = el("li", { class: "entry" + (open ? " open" : "") + (hist.focus === entry.seq ? " focus" : "") });
    var who = entry.sub ? [el("span", { class: "who-wrote", text: entry.sub }), entry.role !== null ? el("span", { class: "label", text: roleName(entry.role) }) : null] : [];
    var toggle = el("button", { class: "entry-head", type: "button", "aria-expanded": open ? "true" : "false", onclick: function () {
      hist.open[entry.seq] = !hist.open[entry.seq];
      renderHistory();
    } }, [
      el("span", { class: "seq num", text: "tx_" + pad(entry.seq, 4) }),
      el("span", { class: "summary", text: entrySummary(entry) }),
      hist.marks && hist.marks[entry.seq] ? el("span", { class: "tag", text: "NEW" }) : null
    ].concat(who).concat([el("span", { class: "when num", title: formatDate(entry.at), text: ago(entry.at) })]));
    item.append(toggle);
    if (open) {
      var ops = el("ul", { class: "ops" }, entry.ops.map(opLine));
      item.append(ops);
      if (entry.more) item.append(el("p", { class: "note", text: entry.more + " more " + (entry.more === 1 ? "operation" : "operations") + " in this transaction." }));
    }
    list.append(item);
  });
  box.append(el("div", { class: "panel" }, [el("div", { class: "scroll" }, [list])]));
  if (hist.next !== null) {
    box.append(el("div", { class: "more" }, [el("button", { class: "btn small", type: "button", disabled: hist.loading || undefined, onclick: function () { loadHistory(true); } }, [hist.loading ? "Loading…" : "Load older"])]));
  }
  if (hist.marks) setTimeout(function () { hist.marks = null; }, 0);
  var focused = box.querySelector(".entry.focus");
  if (focused) focused.scrollIntoView({ block: "nearest" });
}

/** A row's recorded changes in its panel: who and when, each linking to its transaction. */
function rowHistory(model, id, into) {
  api("/api/history", { workspaceId: app.workspace, params: { model: model, id: id } }).then(function (result) {
    var entries = (result.data || []).slice().reverse();
    if (!entries.length) return;
    var box = el("div", { class: "related changes" }, [el("div", { class: "label", text: "Changes" })]);
    entries.slice(0, 12).forEach(function (entry) {
      var verb = { insert: "Created", update: "Updated", delete: "Deleted" }[entry.action] || entry.action;
      box.append(el("button", { type: "button", title: formatDate(entry.at), onclick: function () { closeDrawer(); openHistory(entry.seq); } }, [
        el("span", { class: "seq num", text: "tx_" + pad(entry.seq, 4) }),
        el("span", { text: verb + (entry.sub ? " by " + entry.sub : "") }),
        el("span", { class: "when num", text: ago(entry.at) })
      ]));
    });
    if (entries.length > 12) box.append(el("p", { class: "note", text: (entries.length - 12) + " earlier changes are in the history." }));
    into.append(box);
  }, function (error) {
    // Recording writers is opt-in; say how, once, where the changes would be.
    if (error.code === "audit_disabled") into.append(el("p", { class: "note", text: "Who changed this row is recorded with defineTapeDB({ audit: true })." }));
  });
}

function start() {
  // A reload starts as the studio's own sign-in, never as someone viewed before.
  if (MODE === "local") api("/api/view-as", {}).catch(function () {});
  var saved = "";
  try { saved = localStorage.getItem(CURRENT_KEY) || ""; } catch (e) {}
  var linked = new URLSearchParams(location.search).get("workspace");
  if (linked) saved = linked;
  loadWorkspaces().catch(function () { app.manual = true; return null; }).then(function (found) {
    renderWorkspaces();
    if (found === null) {
      if (MODE === "worker") app.workspaces = recentWorkspaces().map(function (id) { return { id: id, updatedAt: null }; });
      renderWorkspaces();
      if (saved) { openWorkspace(saved); return; }
      $("workspace-id").hidden = false;
      var make = el("button", { class: "btn", type: "button", onclick: function () { openWorkspace(uuid7()); } }, [icon("plus", 16), "Create a workspace"]);
      showEmpty("Open a workspace", "Paste the id of a workspace at the top, or create an empty one. Your sign-in decides what you can do in it.", make);
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
