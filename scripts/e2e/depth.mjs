// Deep relation filters and includes against workerd; SQLite's bound surfaces as a 400.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "tapedb";
import { BASE, s } from "./common.mjs";
const db = createClient({ schema: s, url: BASE, workspace: randomUUID() });
const board = await db.board.create({ data: { name: "B" } });
const todo = await db.column.create({ data: { name: "Todo", board: { connect: board.id } } });
await db.column.create({ data: { name: "Done", board: { connect: board.id } } });
await db.task.create({ data: { title: "a", column: { connect: todo.id } } });
const hits = await db.task.findMany({ where: { column: { board: { columns: { some: { name: "Done" } } } } }, select: { title: true } });
assert.deepEqual(hits, [{ title: "a" }]);
const deep = await db.board.findMany({ select: { columns: { where: { name: "Todo" }, select: { tasks: { select: { column: { select: { board: { select: { name: true } } } } } } } } } });
assert.equal(deep[0].columns[0].tasks[0].column.board.name, "B");
let where = { title: "a" };
for (let hop = 0; hop < 41; hop += 1) where = hop % 2 === 0 ? { tasks: { some: where } } : { column: where };
await assert.rejects(db.column.findMany({ where }), (error) => error.code === "invalid_op" && error.status === 400);
db.$close();
console.log("drive-depth: ok");
