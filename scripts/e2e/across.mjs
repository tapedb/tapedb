// Reads over several workspaces in workerd: merged, paged and live.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@tapedb/tapedb";
import { BASE, s, until } from "./common.mjs";

const ids = [randomUUID(), randomUUID(), randomUUID()];
const titles = [["a0", "c1", "e2"], ["b0", "d1"], ["a5", "f0", "f1", "f2"]];
for (const [index, workspace] of ids.entries()) {
  const one = createClient({ schema: s, url: BASE, workspace });
  await one.$transaction(titles[index].map((title) => one.task.create({ data: { title } })));
  one.$close();
}
const all = titles.flat().sort();

const db = createClient({ schema: s, url: BASE, workspace: ids[0] });
const across = db.$across(ids);
const rows = await across.task.findMany({ orderBy: { title: "asc" } });
assert.deepEqual(rows.map((row) => row.title), all);
assert.equal(rows.find((row) => row.title === "d1").workspaceId, ids[1]);
assert.equal(await across.task.count(), all.length);

const paged = [];
for (let after = null, pages = 0; ; pages += 1) {
  assert.ok(pages < 20);
  const page = await across.task.findPage({ orderBy: { title: "asc" }, take: 2, after });
  paged.push(...page.rows.map((row) => row.title));
  if (!page.hasMore) break;
  after = page.cursor;
}
assert.deepEqual(paged, all);

// Live: one socket per workspace, merged as each changes.
const seen = [];
const stop = across.task.findMany({ orderBy: { title: "asc" }, select: { title: true } }).subscribe((state) => {
  if (state.data) seen.push(state.data.map((row) => row.title).join(","));
});
await until(() => seen.at(-1) === all.join(","), "initial", seen);
const other = createClient({ schema: s, url: BASE, workspace: ids[1] });
await other.task.create({ data: { title: "a1" } });
await until(() => seen.at(-1) === [...all, "a1"].sort().join(","), "a write in one workspace", seen);
stop();
other.$close();
db.$close();
console.log("across: ok");
