// Workspace diagnostics in workerd: counters move with traffic, a live
// subscription's update is timed, the runtime reports SQLite's size, and the
// answer carries no row values.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BASE, until } from "./common.mjs";

const workspace = randomUUID();
const { token } = await (await fetch(`${BASE}/_tapedb/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: workspace }) })).json();
const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
const room = `${BASE}/engine/workspaces/${workspace}`;
const send = (body) => fetch(`${room}/transact`, { method: "POST", headers, body: JSON.stringify(body) }).then((r) => r.json());
const diagnostics = async () => {
  const response = await fetch(`${room}/diagnostics`, { headers });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.data;
};

const before = await diagnostics();
assert.equal(before.workspaceId, workspace);
assert.equal(typeof before.stored.storage.databaseBytes, "number", "workerd reports SQLite's size");
assert.ok(before.stored.storage.databaseBytes > 0);

// A live subscriber, so a write's update is timed end to end.
const socket = new WebSocket(`${room.replace(/^http/, "ws")}/websocket`, ["tapedb", `tapedb.claim.${token}`]);
const messages = [];
socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
await until(() => messages.some((m) => m.type === "session:ready"), "session ready", messages);
socket.send(JSON.stringify({ type: "query:subscribe", id: "s1", query: { task: {} } }));
await until(() => messages.some((m) => m.type === "query:data" && m.id === "s1"), "first result", messages);

for (let n = 0; n < 5; n += 1) {
  const result = await send({ txId: `t${n}`, ops: [{ op: "insert", namespace: "task", id: `t${n}`, values: { title: `diag-secret-${n}`, done: false } }] });
  assert.equal(result.ok, true, JSON.stringify(result));
}
const refused = await send({ txId: "dup", ops: [{ op: "insert", namespace: "task", id: "t0", values: { title: "dup", done: false } }] });
assert.equal(refused.ok, false);
await until(() => messages.filter((m) => m.id === "s1" && (m.type === "query:diff" || m.type === "query:data")).length >= 2, "live update", messages);

// `until` polls a synchronous predicate; the live pass is recorded once its
// updates are sent, which the frames above have already shown.
let after = await diagnostics();
for (let n = 0; n < 40 && after.measured.latency.subscriptionUpdate.count === 0; n += 1) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  after = await diagnostics();
}
assert.ok(after.measured.latency.subscriptionUpdate.count > 0, "the live update was timed");
socket.close();

assert.equal(after.measured.transactions.committed - before.measured.transactions.committed, 5);
assert.equal(after.measured.transactions.rejected - before.measured.transactions.rejected, 1);
assert.ok(after.measured.realtime.subscribes >= 1);
assert.ok(after.measured.realtime.updatesSent >= 1);
assert.ok(after.stored.connections.sockets >= 1);
assert.ok(after.stored.durability.seq >= 5);
assert.ok(["ok", "degraded", "failing"].includes(after.health.status));
assert.ok(!JSON.stringify(after).includes("diag-secret"), "no row values");
console.log(`drive-diagnostics: ok (health ${after.health.status}, ${after.stored.storage.databaseBytes} bytes, live p50 ${after.measured.latency.subscriptionUpdate.p50Ms} ms)`);
