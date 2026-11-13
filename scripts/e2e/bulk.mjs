// updateMany / deleteMany over more rows than one batch, against workerd.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "tapedb";
import { BASE, s } from "./common.mjs";
const db = createClient({ schema: s, url: BASE, workspace: randomUUID() });
const total = 2500;
for (let start = 0; start < total; start += 250) {
  await db.$transaction(Array.from({ length: 250 }, (_, n) => db.task.create({ data: { title: `t${start + n}` } })));
}
assert.equal(await db.task.count(), total);
assert.deepEqual(await db.task.updateMany({ where: { done: false }, data: { done: true } }), { count: total });
assert.equal(await db.task.count({ where: { done: true } }), total);
assert.deepEqual(await db.task.updateMany({ where: {}, data: { title: "same" } }), { count: total });
assert.deepEqual(await db.task.deleteMany({ where: { title: "same" } }), { count: total });
assert.equal(await db.task.count(), 0);
db.$close();
console.log("drive-bulk: ok");
