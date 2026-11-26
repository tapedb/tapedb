// Query profiles in workerd: rows read come from the Durable Object's own
// cursor, an indexed filter uses its index, an unindexed one is a full scan
// naming the column, live re-runs are recorded as live, and no value leaks.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@tapedb/tapedb";
import { BASE, s } from "./common.mjs";

const workspace = randomUUID();
const db = createClient({ schema: s, url: BASE, workspace });
const board = await db.board.create({ data: { name: "Profile" } });
const columns = await db.$transaction(
  Array.from({ length: 5 }, (_, n) => db.column.create({ data: { name: `c${n}`, position: n, board: { connect: board.id } } }))
);
await db.$transaction(Array.from({ length: 200 }, (_, n) => db.task.create({ data: { title: `task-${n}`, column: { connect: columns[n % 5].id } } })));

for (let n = 0; n < 3; n += 1) {
  await db.column.findMany({ where: { position: n } });
  await db.task.findMany({ where: { title: `needle-${n}` } });
}
const seen = [];
const stop = db.task.findMany({ where: { done: true } }).subscribe((state) => state.data && seen.push(state.data.length));
for (let wait = 0; seen.length === 0 && wait < 100; wait += 1) await new Promise((r) => setTimeout(r, 50));
await db.task.create({ data: { title: "after", done: true } });
for (let wait = 0; seen.length < 2 && wait < 100; wait += 1) await new Promise((r) => setTimeout(r, 50));
stop();

const profile = await db.$queryProfile({ sort: "count", limit: 50 });
const byPosition = profile.statements.find((st) => /"position" = \?/.test(st.sql));
const byTitle = profile.statements.find((st) => /"title" = \?/.test(st.sql));
const live = profile.statements.find((st) => st.sources.includes("live") && /"done" = \?/.test(st.sql));

assert.ok(byPosition, `no statement filtering on position: ${JSON.stringify(profile.statements.map((st) => st.sql))}`);
assert.deepEqual(byPosition.fullScans, []);
assert.ok(byPosition.indexes.length > 0, "the indexed filter used an index");
assert.equal(typeof byPosition.rowsRead, "number", "workerd counts rows read");

assert.ok(byTitle);
assert.deepEqual(byTitle.fullScans, ["task"]);
assert.deepEqual(byTitle.indexCandidates, [{ table: "task", columns: ["title"] }]);
assert.ok(byTitle.rowsRead >= 3 * 200, `a full scan reads every row each time: ${byTitle.rowsRead}`);

assert.ok(live, "the live re-run is recorded as live");
// The re-run after the write is a live read; the client's first answer may
// come over HTTP instead, so only the re-run is required here.
assert.ok(live.count >= 1, "the live re-run is recorded");

const text = JSON.stringify(profile);
for (const leak of ["needle-0", "task-1", "Profile", "dev-user"]) assert.ok(!text.includes(leak), `profile leaked ${leak}`);

assert.equal(await db.$queryProfile({ reset: true }), null);
assert.equal((await db.$queryProfile()).recorded, 0);
db.$close();
console.log(`query-profile: ok (title scan read ${byTitle.rowsRead} rows over ${byTitle.count} runs; position search read ${byPosition.rowsRead})`);
