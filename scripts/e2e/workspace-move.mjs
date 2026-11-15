import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BASE } from "./common.mjs";
const workspace = randomUUID();
const claim = await fetch(`${BASE}/_tapedb/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: workspace }) });
const { token } = await claim.json();
const call = (path, body, method = body === undefined ? "GET" : "POST") => fetch(`${BASE}/engine/workspaces/${workspace}/${path}`, {
  method, headers: { authorization: `Bearer ${token}`, "content-type": typeof body === "string" ? "text/plain" : "application/json" },
  ...(body === undefined ? {} : { body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body) }),
});
const tx = { txId: "before", clientTxId: "moved-receipt", ops: [{ op: "insert", namespace: "task", id: "move-task", values: { title: "Moved", done: false } }] };
assert.equal((await call("transact", tx)).status, 200);
assert.equal((await call("files/move.txt", "moved file", "PUT")).status, 201);
const large = new Uint8Array(9 * 1024 * 1024).fill(73);
assert.equal((await call("files/large.bin", large, "PUT")).status, 201);
assert.equal((await call("transact", { txId: "personal", ops: [{ op: "insert", namespace: "person", id: "moved-person", values: { name: "Encrypted move" } }] })).status, 200);
const before = await (await call("export")).text();
let response;
for (let i = 0; i < 100; i++) {
  response = await call("move", { to: process.env.TAPEDB_MOVE_TO ?? (BASE.includes("staging-eu") ? "eu" : "none") });
  if (response.status !== 503) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.equal(response.status, 200, await response.clone().text());
assert.equal(await (await call("files/move.txt")).text(), "moved file");
const copied = new Uint8Array(await (await call("files/large.bin")).arrayBuffer());
assert.equal(copied.byteLength, large.byteLength); assert(copied.every(byte => byte === 73));
const records = text => text.trim().split("\n").map(line => JSON.parse(line)).filter(line => line.type === "row" || line.type === "file");
assert.deepEqual(records(await (await call("export")).text()), records(before));
assert.equal((await (await call("transact", { ...tx, txId: "retry" })).json()).result.applied, 0);
assert.equal((await call("move", { to: BASE.includes("staging-eu") ? "eu" : "none" })).status, 200);
assert.equal((await call("subjects/moved-person", undefined, "DELETE")).status, 200);
const erasedPerson = await (await call("query", { query: { person: {} } })).json();
assert.equal(erasedPerson.data.person[0].name, null);
assert.deepEqual(erasedPerson.data.person[0].$erased, ["name"]);
assert.equal((await call("", undefined, "DELETE")).status, 200);
console.log("workspace move: data, files, retry receipts and erasure passed");
