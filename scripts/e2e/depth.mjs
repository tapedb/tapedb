// Deep and wide filters against workerd: past SQLite's depth and length bounds, they are staged, not refused.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@tapedb/tapedb";
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
// 41 hops alternating column -> task -> column: each round trip lands on the
// same column, so the answer is the one-hop "columns with a task titled a".
let where = { title: "a" };
for (let hop = 0; hop < 41; hop += 1) where = hop % 2 === 0 ? { tasks: { some: where } } : { column: where };
assert.deepEqual((await db.column.findMany({ where, select: { name: true } })).map((row) => row.name), ["Todo"]);
// Every mode staged at depth: "boards with no column that has every task untitled 'z'"... composed six hops deep.
const modes = { columns: { every: { tasks: { none: { column: { board: { columns: { some: { tasks: { some: { title: "a" } } } } } } } } } } };
assert.deepEqual((await db.board.findMany({ where: modes, select: { name: true } })).map((row) => row.name), []);
// 4,000 branches: far past the statement length SQLite accepts in one go.
const titles = Array.from({ length: 4000 }, (_, index) => `missing-${index}`).concat(["a"]);
assert.deepEqual((await db.task.findMany({ where: { OR: titles.map((title) => ({ title })) }, select: { title: true } })), [{ title: "a" }]);
assert.equal((await db.task.findMany({ where: { AND: titles.map((title) => ({ NOT: { title } })) } })).length, 0);
assert.equal(await db.task.count({ where: { OR: titles.map((title) => ({ title })) } }), 1);
db.$close();
console.log("drive-depth: ok");
