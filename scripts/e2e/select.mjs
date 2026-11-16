// select over HTTP and live.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@tapedb/tapedb";
import { BASE, s, until } from "./common.mjs";

const db = createClient({ schema: s, url: BASE, workspace: randomUUID() });
const board = await db.board.create({ data: { name: "B" } });
const col = await db.column.create({ data: { name: "Todo", board: { connect: board.id } } });
await db.task.create({ data: { title: "one", column: { connect: col.id } } });

const rows = await db.column.findMany({ select: { name: true, tasks: { select: { title: true } } } });
assert.deepEqual(rows, [{ name: "Todo", tasks: [{ title: "one" }] }]);

const page = await db.task.findPage({ select: { title: true }, take: 1 });
assert.deepEqual(page.rows, [{ title: "one" }]);

// Live: the push after a write carries only the selected field.
const seen = [];
const stop = db.task.findMany({ select: { title: true } }).subscribe((state) => {
  if (state.data) seen.push(JSON.stringify(state.data));
});
await until(() => seen.includes('[{"title":"one"}]'), "initial live data");
await db.task.create({ data: { title: "two" } });
await until(() => seen.at(-1) === '[{"title":"one"},{"title":"two"}]', "live insert");
stop();
db.$close();
console.log("drive-select: ok");
