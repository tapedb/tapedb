// The opt-in audit in workerd: who changed a row, through the Worker and the room.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@tapedb/tapedb";
import { BASE, s } from "./common.mjs";

const workspace = randomUUID();
const db = createClient({ schema: s, url: BASE, workspace });
const task = await db.task.create({ data: { title: "one" } });
await db.task.update({ where: { id: task.id }, data: { done: true } });
await db.task.delete({ where: { id: task.id } });

const history = await db.$history({ model: "task", id: task.id });
assert.deepEqual(history.map(({ sub, role, action }) => ({ sub, role, action })), [
  { sub: "dev-user", role: 6, action: "insert" },
  { sub: "dev-user", role: 6, action: "update" },
  { sub: "dev-user", role: 6, action: "delete" },
]);
assert.ok(history.every((entry, n) => n === 0 || entry.seq > history[n - 1].seq));
await assert.rejects(db.$history({ model: "task", id: "" }));
db.$close();
console.log("audit: ok");
