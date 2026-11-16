// Unlimited findMany, and a live page loaded past 1000 rows that stays live, in workerd.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@tapedb/tapedb";
import { BASE, s, until } from "./common.mjs";
const db = createClient({ schema: s, url: BASE, workspace: randomUUID() });
for (let start = 0; start < 2500; start += 250) {
  await db.$transaction(Array.from({ length: 250 }, (_, n) => db.task.create({ data: { title: `t${String(start + n).padStart(4, "0")}` } })));
}
assert.equal((await db.task.findMany()).length, 2500);
assert.equal((await db.task.findMany({ take: 2200, orderBy: { title: "desc" } })).length, 2200);

const page = db.task.findPage({ orderBy: { title: "asc" }, take: 600, select: { title: true } });
let last;
const stop = page.subscribe((st) => { last = st.data; });
await until(() => last?.rows.length === 600, "first page", []);
assert.equal(await page.loadMore(), true);
await until(() => last?.rows.length === 1200, "second page", []);
assert.equal(await page.loadMore(), true);
await until(() => last?.rows.length === 1800, "third page", []);
// A row past the old 1000-row window changes; the live window still covers it.
const target = (await db.task.findFirst({ where: { title: "t1500" } })).id;
await db.task.update({ where: { id: target }, data: { title: "t1500-renamed" } });
await until(() => last?.rows.some((row) => row.title === "t1500-renamed"), "diff past 1000", []);
stop(); db.$close();
console.log("drive-wide: ok");
