// Write throughput and latency against one workspace's single writer.
//   WRITE_COUNT (400 × SCALE) writes per scenario; WRITE_CONCURRENCY (1,4,16);
//   WRITE_BATCH (1,10,100) rows per transaction; SUSTAIN_SECONDS (20 × SCALE).
import { call, metrics, emit, env, envList, pool, scaled, sleep, summarize, taskOps, workspace } from "./lib.mjs";

const COUNT = env("WRITE_COUNT", scaled(400));
const CONCURRENCY = envList("WRITE_CONCURRENCY", [1, 4, 16]);
const BATCH = envList("WRITE_BATCH", [1, 10, 100]);
const SUSTAIN_MS = env("SUSTAIN_SECONDS", scaled(20)) * 1000;

const insert = (ws, prefix, rows) => (index) =>
  call(ws, "/transact", { txId: `${prefix}-${index}`, ops: taskOps(`${prefix}-${index}`, rows) });

// Concurrency × transaction size, single-row inserts and multi-row batches.
for (const rows of BATCH) {
  for (const concurrency of CONCURRENCY) {
    const ws = await workspace();
    const before = await metrics(ws);
    const count = Math.max(concurrency, Math.round(COUNT / Math.sqrt(rows)));
    const run = await pool(count, concurrency, insert(ws, `w${rows}c${concurrency}`, rows));
    const after = await metrics(ws);
    emit("writes", rows === 1 ? (concurrency === 1 ? "sequential" : "concurrent") : "multi-row", { rows, concurrency, transactions: count }, {
      txPerSecond: run.throughput,
      rowsPerSecond: Math.round(run.throughput * rows * 10) / 10,
      latencyMs: summarize(run.latencies),
      errorRate: run.errorRate,
      errors: run.errors,
      serverTransactionMs: after?.metrics.latency.timers.transaction ?? null,
      databaseBytesGrowth: before?.gauges.storageBytes != null && after?.gauges.storageBytes != null
        ? after.gauges.storageBytes - before.gauges.storageBytes
        : null,
    });
  }
}

// Updates of one row: every write contends for the same record.
{
  const ws = await workspace();
  await call(ws, "/transact", { txId: "hot-seed", ops: taskOps("hot", 1) });
  const concurrency = Math.max(...CONCURRENCY);
  const run = await pool(COUNT, concurrency, (index) =>
    call(ws, "/transact", { txId: `hot-${index}`, ops: [{ op: "update", namespace: "task", id: "hot-0", values: { title: `hot ${index}` } }] })
  );
  emit("writes", "hot-row", { concurrency, transactions: COUNT }, { txPerSecond: run.throughput, latencyMs: summarize(run.latencies), errorRate: run.errorRate, errors: run.errors });
}

// Bursty: idle, then everything at once; repeated.
{
  const ws = await workspace();
  const bursts = 5;
  const size = Math.max(10, Math.round(COUNT / bursts));
  const latencies = [];
  const errors = {};
  let failed = 0;
  for (let burst = 0; burst < bursts; burst += 1) {
    await sleep(1_000);
    const run = await pool(size, size, insert(ws, `burst${burst}`, 1));
    latencies.push(...run.latencies);
    for (const [code, n] of Object.entries(run.errors)) errors[code] = (errors[code] ?? 0) + n;
    failed += Object.values(run.errors).reduce((a, b) => a + b, 0);
  }
  emit("writes", "bursty", { bursts, burstSize: size }, { latencyMs: summarize(latencies), errorRate: failed / (bursts * size), errors });
}

// Sustained: a steady concurrency for a fixed time, latency per window, to show drift.
{
  const ws = await workspace();
  const concurrency = 8;
  const windows = [];
  const deadline = performance.now() + SUSTAIN_MS;
  let current = { started: performance.now(), latencies: [], failed: 0 };
  let index = 0;
  const worker = async () => {
    while (performance.now() < deadline) {
      const result = await insert(ws, "sustain", 1)(index++).catch(() => ({ ok: false }));
      if (result.ok) current.latencies.push(result.ms);
      else current.failed += 1;
      if (performance.now() - current.started >= 5_000) {
        windows.push(current);
        current = { started: performance.now(), latencies: [], failed: 0 };
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (current.latencies.length > 0) windows.push(current);
  const all = windows.flatMap((window) => window.latencies);
  const after = await metrics(ws);
  emit("writes", "sustained", { concurrency, seconds: SUSTAIN_MS / 1000 }, {
    txPerSecond: Math.round((all.length / (SUSTAIN_MS / 1000)) * 10) / 10,
    latencyMs: summarize(all),
    p95ByWindowMs: windows.map((window) => summarize(window.latencies).p95),
    errorRate: windows.reduce((sum, window) => sum + window.failed, 0) / Math.max(1, all.length),
    unflushedAtEnd: after?.gauges.durability.pendingSeq ?? null,
    txLogRows: after?.gauges.txLogRows ?? null,
    databaseBytes: after?.gauges.storageBytes ?? null,
  });
}
