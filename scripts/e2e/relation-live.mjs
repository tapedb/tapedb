// A live query filtered through a relation re-runs when the related row changes.
import { randomUUID } from "node:crypto";
import { createClient } from "@tapedb/tapedb";
import { BASE, s, until } from "./common.mjs";

const db = createClient({ schema: s, url: BASE, workspace: randomUUID() });
const board = await db.board.create({ data: { name: "B" } });
const col = await db.column.create({ data: { name: "Todo", board: { connect: board.id } } });
await db.task.create({ data: { title: "a", column: { connect: col.id } } });
const seen = [];
const stop = db.task.findMany({ where: { column: { name: "Todo" } }, select: { title: true } }).subscribe((st) => {
  if (st.data) seen.push(JSON.stringify(st.data));
});
await until(() => seen.at(-1) === '[{"title":"a"}]', "initial", seen);
await db.column.update({ where: { id: col.id }, data: { name: "Doing" } });
await until(() => seen.at(-1) === "[]", "relation change", seen);
const agg = [];
const stopAgg = db.task.aggregate({ where: { column: { name: "Done" } }, _count: true }).subscribe((st) => st.data && agg.push(st.data._count));
await until(() => agg.at(-1) === 0, "agg initial", agg);
await db.column.update({ where: { id: col.id }, data: { name: "Done" } });
await until(() => agg.at(-1) === 1, "agg relation change", agg);
stop(); stopAgg(); db.$close();
console.log("drive-relation-live: ok");
