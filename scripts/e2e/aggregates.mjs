// Drives a packed tapedb under `tapedb dev`: aggregate and groupBy, awaited and live.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "tapedb";
import { BASE, s, until } from "./common.mjs";

const db = createClient({ schema: s, url: BASE, workspace: randomUUID() });
const board = await db.board.create({ data: { name: "B" } });
const col = await db.column.create({ data: { name: "Todo", position: 3, board: { connect: board.id } } });
await db.column.create({ data: { name: "Done", position: 7, board: { connect: board.id } } });
await db.task.create({ data: { title: "a", column: { connect: col.id } } });
await db.task.create({ data: { title: "b", done: true } });

assert.deepEqual(await db.column.aggregate({ _count: true, _sum: { position: true }, _avg: { position: true }, _max: { name: true } }), {
  _count: 2,
  _sum: { position: 10 },
  _avg: { position: 5 },
  _max: { name: "Todo" },
});
assert.deepEqual(await db.task.groupBy({ by: ["done"], _count: true }), [
  { done: false, _count: 1 },
  { done: true, _count: 1 },
]);

const seen = [];
const stop = db.task.groupBy({ by: ["done"], _count: true }).subscribe((state) => {
  if (state.data) seen.push(JSON.stringify(state.data));
});
await until(() => seen.at(-1) === '[{"done":false,"_count":1},{"done":true,"_count":1}]', "initial", seen);
await db.task.create({ data: { title: "c", done: true } });
await until(() => seen.at(-1) === '[{"done":false,"_count":1},{"done":true,"_count":2}]', "live insert", seen);
stop();
db.$close();
console.log("drive-aggregates: ok");
