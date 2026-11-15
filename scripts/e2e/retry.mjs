// A retried write (same clientTxId) is answered with its original sequence, in workerd.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BASE } from "./common.mjs";
const base = BASE;
const workspace = randomUUID();
const { token } = await (await fetch(`${base}/_tapedb/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: workspace }) })).json();
const send = (body) => fetch(`${base}/engine/workspaces/${workspace}/transact`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).then((r) => r.json());
const ops = [{ op: "insert", namespace: "task", id: "t1", values: { title: "once", done: false } }];
const first = await send({ txId: "a", clientTxId: "c-1", ops });
assert.equal(first.ok, true, JSON.stringify(first));
const retry = await send({ txId: "b", clientTxId: "c-1", ops });
assert.deepEqual([retry.result.seq, retry.result.applied], [first.result.seq, 0]);
// An older client's basisSeq is ignored, not refused.
const legacy = await send({ txId: "c", clientTxId: "c-1", basisSeq: 0, ops });
assert.deepEqual([legacy.result.seq, legacy.result.applied], [first.result.seq, 0]);
// Inside the retry window, a retry carrying its first attempt's time dedupes.
const recent = await send({ txId: "d", clientTxId: "c-1", issuedAt: Date.now() - 60_000, ops });
assert.deepEqual([recent.result.seq, recent.result.applied], [first.result.seq, 0]);
// An unacknowledged first attempt may arrive after 400 days, and its retry
// still returns the original sequence without attempting the insert again.
const old = { txId: "e", clientTxId: "c-old", issuedAt: Date.now() - 400 * 86_400_000, ops: [{ op: "insert", namespace: "task", id: "t2", values: { title: "late", done: false } }] };
const late = await send(old);
assert.equal(late.ok, true, JSON.stringify(late));
assert.equal(late.result.applied, 1);
const lateRetry = await send({ ...old, txId: "f" });
assert.deepEqual([lateRetry.result.seq, lateRetry.result.applied], [late.result.seq, 0]);
const conflict = await send({ ...old, txId: "g", ops: [{ ...old.ops[0], values: { title: "changed", done: false } }] });
assert.equal(conflict.error.code, "conflict");
console.log("drive-retry: ok");
