// How long writes stay only in the Durable Object before they reach R2,
// under a sustained write load, read from the workspace's own `/metrics`.
//   DURABILITY_WRITES (2000 × SCALE); DURABILITY_CONCURRENCY (8);
//   DURABILITY_WAIT_SECONDS (120): how long to wait for the flush to catch up.
//
// Cold-start recovery is measured by the drills (scripts/e2e.mjs --drill),
// which wipe every Durable Object and time the restore; R2 failures cannot be
// injected from a client, so the room tests cover them.
import { call, metrics, emit, env, pool, scaled, sleep, summarize, taskOps, workspace } from "./lib.mjs";

const WRITES = env("DURABILITY_WRITES", scaled(2_000));
const CONCURRENCY = env("DURABILITY_CONCURRENCY", 8);
const WAIT_MS = env("DURABILITY_WAIT_SECONDS", 120) * 1000;

const ws = await workspace();
const lags = [];
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const d = await metrics(ws);
    if (d) lags.push({ unflushed: d.gauges.durability.pendingSeq, oldestAgeMs: d.gauges.durability.oldestPendingAt == null ? 0 : Date.now() - d.gauges.durability.oldestPendingAt });
    await sleep(1_000);
  }
})();

const run = await pool(WRITES, CONCURRENCY, (index) => call(ws, "/transact", { txId: `d-${index}`, ops: taskOps(`d-${index}`, 1) }));
const writesDone = performance.now();
sampling = false;
await sampler;

let flushed = null;
let last = null;
for (const deadline = performance.now() + WAIT_MS; performance.now() < deadline; ) {
  last = await metrics(ws);
  if (last && last.gauges.durability.pendingSeq === 0) {
    flushed = performance.now() - writesDone;
    break;
  }
  await sleep(1_000);
}

emit("durability", "flush-under-load", { writes: WRITES, concurrency: CONCURRENCY }, {
  txPerSecond: run.throughput,
  writeLatencyMs: summarize(run.latencies),
  errorRate: run.errorRate,
  maxUnflushedDuringLoad: Math.max(0, ...lags.map((sample) => sample.unflushed)),
  maxOldestUnflushedAgeMs: Math.max(0, ...lags.map((sample) => sample.oldestAgeMs)),
  // null: not caught up within DURABILITY_WAIT_SECONDS.
  flushCaughtUpAfterMs: flushed === null ? null : Math.round(flushed),
  flushMs: last?.metrics.latency.timers.flush ?? null,
  flushFailures: last?.metrics.counters["durability.flushFailures"] ?? null,
  health: last?.health?.status ?? null,
  txLogRows: last?.gauges.txLogRows ?? null,
  databaseBytes: last?.gauges.storageBytes ?? null,
});
