// Workspace metrics in workerd: the counters follow work done through the real
// Worker, the room and a real socket, and the durability gauges move as the
// flusher actually reaches R2.
//
// This is here rather than only in `bun test` because the gauges read a
// Durable Object's own `databaseSize` and its live socket list, and because
// `pendingSeq` falling back to zero depends on the alarm that bun's harness
// does not run.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@tapedb/tapedb";
import { BASE, s, until } from "./common.mjs";

const workspace = randomUUID();
const db = createClient({ schema: s, url: BASE, workspace });

// Nothing has happened yet, but the document must already be well formed:
// a dashboard reads this before the first write.
const empty = await db.$metrics();
assert.equal(empty.metrics.restartsCounters, true);
assert.equal(empty.metrics.latency.estimated, true);
assert.ok(empty.metrics.latency.bucketsMs.length > 0);
assert.equal(empty.metrics.counters["transactions.committed"], 0);
assert.equal(empty.metrics.latency.timers.transaction.count, 0);
assert.equal(empty.metrics.latency.timers.transaction.p99Ms, null, "an unmeasured timer reports null, not 0ms");
assert.equal(empty.gauges.sockets, 0);
assert.ok(empty.gauges.storageBytes > 0, "a migrated workspace has a database");

// Writes, a read, a named SQL query and a live query: one of each path.
const board = await db.board.create({ data: { name: "LEAKCHECK-BOARD-NAME" } });
const column = await db.column.create({ data: { name: "todo", board: { connect: board.id } } });
for (let n = 0; n < 5; n += 1) {
  await db.task.create({ data: { title: `t${n}`, column: { connect: column.id } } });
}
assert.equal(await db.task.count(), 5);
await db.$query("columnStats", { boardId: board.id });

const seen = [];
const stopLive = db.task.findMany().subscribe((st) => st.data && seen.push(st.data.length));
await until(() => seen.length > 0, "the live query to arrive", seen);
await db.task.create({ data: { title: "live", column: { connect: column.id } } });
await until(() => seen.at(-1) === 6, "the live query to see the new row", seen);

// The client applies its own write to its live state at once, so `seen` says
// nothing about the server having pushed anything. Wait for the counter.
let pushed = 0;
for (const deadline = Date.now() + (process.env.TAPEDB_URL ? 20_000 : 10_000); Date.now() < deadline; ) {
  pushed = (await db.$metrics()).metrics.counters["subscriptions.updates"];
  if (pushed >= 1) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.ok(pushed >= 1, "the room never recorded a subscription update");

const busy = await db.$metrics();
// Eight writes: a board, a column and six tasks.
assert.equal(busy.metrics.counters["transactions.committed"], 8);
assert.equal(busy.metrics.counters["transactions.refused"], 0);
assert.ok(busy.metrics.counters["queries.served"] > 0);
assert.equal(busy.metrics.counters["sql.served"], 1);
assert.equal(busy.metrics.counters["sockets.accepted"], 1);
assert.equal(busy.metrics.counters["subscriptions.opened"], 1);
assert.equal(busy.gauges.sockets, 1);
assert.equal(busy.gauges.subscriptions, 1);

// Timers recorded real durations, and the exact statistics agree with the
// estimate's own bound.
const tx = busy.metrics.latency.timers.transaction;
assert.equal(tx.count, 8);
assert.ok(tx.maxMs >= 0 && tx.sumMs >= tx.maxMs);
assert.ok(tx.meanMs !== null && tx.meanMs <= tx.maxMs);
assert.ok(tx.p99Ms !== null && tx.p99Ms >= 0);
assert.equal(tx.buckets.reduce((total, n) => total + n, 0), tx.count, "every sample is in a bucket");

// Refusal counting is covered in test/workspace-metrics.test.ts, where a
// refusal can be made to reach the engine. Here the client validates the
// schema before sending, so a bad query never becomes a request.

// Durability: the log is ahead of R2 until the alarm runs, then it is not.
const pending = await db.$metrics();
assert.ok(pending.gauges.txLogRows >= 8);
await db.$flush();
// Polled by hand: `until` does not await its predicate, so an async one would
// hand it a promise and pass on the first tick.
let drained = null;
// A deployed Worker flushes on an alarm 30 s after the write
// (DURABILITY_ALARM_DELAY_MS), so a 30 s wait races it.
for (const deadline = Date.now() + (process.env.TAPEDB_URL ? 90_000 : 15_000); Date.now() < deadline; ) {
  const now = await db.$metrics();
  if (now.gauges.durability.pendingSeq === 0 && now.gauges.durability.lastFlushAt !== null) {
    drained = now;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.ok(drained, "the log never reached R2");

const flushed = await db.$metrics();
assert.equal(flushed.gauges.durability.pendingSeq, 0);
assert.equal(flushed.gauges.durability.flushedSeq, flushed.gauges.durability.seq);
assert.equal(flushed.gauges.durability.lastFlushError, null);
assert.ok(flushed.gauges.durability.lastFlushAgeMs >= 0);
assert.ok(flushed.metrics.counters["durability.flushes"] >= 1);
assert.equal(flushed.metrics.counters["durability.flushFailures"], 0);
assert.ok(flushed.metrics.latency.timers.flush.count >= 1, "the flush was timed");

// Closing the socket closes its live query with it, so opened cannot drift
// permanently ahead of closed.
stopLive();
db.$close();
const after = await createClient({ schema: s, url: BASE, workspace }).$metrics();
assert.ok(after.gauges.subscriptions <= 1);

// Nothing in the document names a row, a subject or a claim.
const serialized = JSON.stringify(after);
for (const leak of ["LEAKCHECK-BOARD-NAME", "todo", "dev-user"]) {
  assert.ok(!serialized.includes(leak), `metrics leaked ${leak}`);
}

console.log("metrics: ok");
