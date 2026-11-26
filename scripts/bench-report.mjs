// Merges benchmark result files (scripts/e2e.mjs --suite bench --out) into one
// file and prints a Markdown table per workload.
//   node scripts/bench-report.mjs <results.json>... [--merge <out.json>]
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const mergeIndex = args.indexOf("--merge");
const mergeOut = mergeIndex === -1 ? null : args[mergeIndex + 1];
const files = mergeIndex === -1 ? args : args.filter((_, index) => index !== mergeIndex && index !== mergeIndex + 1);
if (files.length === 0) {
  console.error("usage: node scripts/bench-report.mjs <results.json>... [--merge <out.json>]");
  process.exit(2);
}

const runs = files.map((file) => JSON.parse(readFileSync(file, "utf8")));
const head = runs[0];
for (const run of runs) {
  if (run.commit !== head.commit || run.target !== head.target) {
    throw new Error(`refusing to merge runs of different commits or targets: ${run.commit} ${run.target} vs ${head.commit} ${head.target}`);
  }
}
const measurements = runs.flatMap((run) => run.measurements);
if (mergeOut) {
  const merged = {
    ...head,
    startedAt: runs.map((run) => run.startedAt).sort()[0],
    finishedAt: runs.map((run) => run.finishedAt).sort().at(-1),
    config: Object.assign({}, ...runs.map((run) => run.config)),
    measurements,
  };
  writeFileSync(mergeOut, `${JSON.stringify(merged, null, 2)}\n`);
}

const cell = (value) => (value === null || value === undefined ? "–" : typeof value === "number" ? String(value) : String(value));
const latency = (summary) => (summary && "p50" in summary ? `${cell(summary.p50)} / ${cell(summary.p95)} / ${cell(summary.p99)}` : "–");
const params = (object) => Object.entries(object).map(([key, value]) => `${key} ${value}`).join(", ");

const out = [];
out.push(`tapedb ${head.tapedb} at ${head.commit?.slice(0, 7) ?? "?"}, ${head.target}, Node ${head.runner.node} on ${head.runner.platform}/${head.runner.arch} (${head.runner.cpus} CPUs, ${Math.round(head.runner.memoryBytes / 2 ** 30)} GiB), ${head.startedAt.slice(0, 10)}.`);
out.push("");

const byWorkload = new Map();
for (const m of measurements) {
  if (!byWorkload.has(m.workload)) byWorkload.set(m.workload, []);
  byWorkload.get(m.workload).push(m);
}

for (const [workload, list] of byWorkload) {
  out.push(`### ${workload}`, "");
  out.push("| Scenario | Parameters | Throughput | Latency ms p50 / p95 / p99 | Errors | Other |");
  out.push("| --- | --- | --- | --- | --- | --- |");
  for (const m of list) {
    const x = m.metrics;
    const throughput = x.txPerSecond ?? x.readsPerSecond ?? x.writesPerSecond;
    const lat = x.latencyMs ?? x.seenByAllDelayMs ?? x.allPeersDelayMs ?? x.socketToFirstDataMs ?? x.findManyMs ?? x.firstWriteMs ?? x.writeLatencyMs;
    const other = [];
    if (x.rowsPerSecond !== undefined && m.params.rows > 1) other.push(`${x.rowsPerSecond} rows/s`);
    if (x.seenByAllDelayMs && x.writeLatencyMs) other.push(`write ${latency(x.writeLatencyMs)}`);
    if (x.subscriptionsReadyMs !== undefined) other.push(`ready in ${x.subscriptionsReadyMs} ms`);
    if (x.writesNotSeenByAll) other.push(`${x.writesNotSeenByAll} writes not seen by all`);
    if (x.secondWriteMs) other.push(`second write ${latency(x.secondWriteMs)}`);
    if (x.findPage50Ms) other.push(`page ${latency(x.findPage50Ms)}, count ${latency(x.countMs)}`);
    if (x.partialFailure) other.push(`one bad token: AcrossError, ${x.partialFailure.partialRows} partial rows`);
    if (x.flushCaughtUpAfterMs !== undefined) other.push(`R2 caught up ${cell(x.flushCaughtUpAfterMs)} ms after the last write; peak ${x.maxUnflushedDuringLoad} unflushed`);
    if (x.p95ByWindowMs) other.push(`p95 per 5 s: ${x.p95ByWindowMs.join(", ")}`);
    if (x.databaseBytes) other.push(`${Math.round(x.databaseBytes / 1024)} KiB SQLite`);
    if (x.seedMs !== undefined) other.push(`seeded in ${x.seedMs} ms`);
    const errors = x.errorRate ? `${(x.errorRate * 100).toFixed(1)}% ${JSON.stringify(x.errors ?? {})}` : x.errorRate === 0 ? "0" : "–";
    out.push(`| ${m.scenario} | ${params(m.params)} | ${cell(throughput)} | ${latency(lat)} | ${errors} | ${other.join("; ")} |`);
  }
  out.push("");
}
console.log(out.join("\n"));
