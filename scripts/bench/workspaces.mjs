// Many workspaces: first-touch cost, independent writers in parallel, and
// $across reads (merged client-side) over growing workspace counts.
//   MANY_WORKSPACES (50 × SCALE); ACROSS_COUNTS (10,100); ACROSS_ROWS (20) rows each;
//   ACROSS_READS (10) reads per count.
import { randomUUID } from "node:crypto";
import { createClient } from "@tapedb/tapedb";
import { BASE, s } from "./common.mjs";
import { call, emit, env, envList, pool, scaled, summarize, taskOps, tokenFor } from "./lib.mjs";

const MANY = env("MANY_WORKSPACES", scaled(50));
const ACROSS = envList("ACROSS_COUNTS", [10, 100]);
const ROWS = env("ACROSS_ROWS", 20);
const READS = env("ACROSS_READS", 10);

// ---- First touch: a new workspace's first write creates its Durable Object,
// runs its migrations and checks R2 for a recovery.
const fresh = [];
for (let n = 0; n < MANY; n += 1) fresh.push({ id: randomUUID(), token: null });
for (const ws of fresh) ws.token = await tokenFor(ws.id);
const first = await pool(MANY, 8, (index) => call(fresh[index], "/transact", { txId: "first", ops: taskOps("first", 1) }));
const second = await pool(MANY, 8, (index) => call(fresh[index], "/transact", { txId: "second", ops: taskOps("second", 1) }));
emit("workspaces", "first-touch", { workspaces: MANY, concurrency: 8 }, {
  firstWriteMs: summarize(first.latencies),
  secondWriteMs: summarize(second.latencies),
  errorRate: first.errorRate,
});

// ---- Independent writers: the same total writes spread over N workspaces.
for (const spread of [1, 8, 32]) {
  const targets = fresh.slice(0, Math.min(spread, fresh.length));
  const total = 400;
  const run = await pool(total, 16, (index) => {
    const ws = targets[index % targets.length];
    return call(ws, "/transact", { txId: `spread-${spread}-${index}`, ops: taskOps(`s${spread}-${index}`, 1) });
  });
  emit("workspaces", "parallel-writers", { workspaces: targets.length, writes: total, concurrency: 16 }, {
    txPerSecond: run.throughput,
    latencyMs: summarize(run.latencies),
    errorRate: run.errorRate,
  });
}

// ---- $across: one request per workspace, merged in the client.
for (const count of ACROSS) {
  const ids = Array.from({ length: count }, () => randomUUID());
  for (let start = 0; start < ids.length; start += 16) {
    await Promise.all(ids.slice(start, start + 16).map(async (id) => {
      const one = createClient({ schema: s, url: BASE, workspace: id });
      await one.$transaction(Array.from({ length: ROWS }, (_, n) => one.task.create({ data: { title: `${id.slice(0, 8)}-${String(n).padStart(3, "0")}` } })));
      one.$close();
    }));
  }
  const db = createClient({ schema: s, url: BASE, workspace: ids[0] });
  const across = db.$across(ids);
  const timings = { findMany: [], page: [], count: [] };
  let rows = 0;
  for (let n = 0; n < READS; n += 1) {
    let t0 = performance.now();
    rows = (await across.task.findMany({ orderBy: { title: "asc" } })).length;
    timings.findMany.push(performance.now() - t0);
    t0 = performance.now();
    await across.task.findPage({ orderBy: { title: "asc" }, take: 50 });
    timings.page.push(performance.now() - t0);
    t0 = performance.now();
    await across.task.count();
    timings.count.push(performance.now() - t0);
  }
  const heapBefore = process.memoryUsage().heapUsed;
  const all = await across.task.findMany({ orderBy: { title: "asc" } });
  const heapAfter = process.memoryUsage().heapUsed;

  // Partial failure: one workspace's token is refused. A separate root
  // client: $across keeps one client per workspace, and a client first made
  // without getToken keeps using the development claim route.
  const brokenRoot = createClient({ schema: s, url: BASE, workspace: ids[0], getToken: () => tokenFor(ids[0]) });
  const broken = brokenRoot.$across(ids, { getToken: async (id) => (id === ids[ids.length - 1] ? "not-a-token" : tokenFor(id)) });
  let partial = null;
  const t0 = performance.now();
  try {
    await broken.task.findMany({ orderBy: { title: "asc" } });
  } catch (error) {
    partial = { failedWorkspaces: Object.keys(error.errors ?? {}).length, partialRows: error.partial?.length ?? null, code: error.name };
  }
  const partialMs = performance.now() - t0;
  brokenRoot.$close();
  db.$close();

  emit("workspaces", "across", { workspaces: count, rowsPerWorkspace: ROWS, reads: READS }, {
    rows,
    findManyMs: summarize(timings.findMany),
    findPage50Ms: summarize(timings.page),
    countMs: summarize(timings.count),
    clientHeapGrowthBytes: all.length > 0 ? Math.max(0, heapAfter - heapBefore) : null,
    partialFailure: partial,
    partialFailureMs: Math.round(partialMs),
  });
}
