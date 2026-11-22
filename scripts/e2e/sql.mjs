// Named SQL queries in workerd: SQLite's plan (EXPLAIN, sqlite_schema, pragmas) and the rolled-back run.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@tapedb/tapedb";
import { BASE, s } from "./common.mjs";

const db = createClient({ schema: s, url: BASE, workspace: randomUUID() });
const board = await db.board.create({ data: { name: "B" } });
const todo = await db.column.create({ data: { name: "Todo", position: 1, board: { connect: board.id } } });
await db.column.create({ data: { name: "Done", position: 2, board: { connect: board.id } } });
await db.task.create({ data: { title: "one", column: { connect: todo.id } } });
await db.task.create({ data: { title: "two", column: { connect: todo.id } } });
await db.person.create({ data: { name: "Ada" } });

assert.deepEqual(await db.$query("columnStats", { boardId: board.id }), [{ name: "Todo", open: 2 }, { name: "Done", open: 0 }]);
assert.deepEqual(await db.$query("countdown", { upto: 4 }), [{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }]);
assert.deepEqual(await db.$query("people"), [{ n: 1 }]);

// Refusals (writes, engine tables, personal fields) fail `migrate check` and
// deploy, so the schema here holds none; test/sql-query.test.ts covers them.
await assert.rejects(db.$query("columnStats", { boardId: 7 }), (error) => error.code === "invalid_query_params");

// The rows are still all there: nothing a query does lasts.
assert.equal(await db.task.count(), 2);
db.$close();
console.log("drive-sql: ok");
