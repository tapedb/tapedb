// Read latency through the client over a populated workspace: lookups,
// filters, relations, pagination, named SQL and aggregates, at two sizes.
//   QUERY_ROWS (1000,10000 × SCALE) tasks; QUERY_COUNT (100) reads per
//   scenario; QUERY_CONCURRENCY (4).
import { randomUUID } from "node:crypto";
import { createClient } from "@tapedb/tapedb";
import { BASE, s } from "./common.mjs";
import { metrics, emit, env, envList, pool, scaled, summarize, tokenFor } from "./lib.mjs";

const SIZES = envList("QUERY_ROWS", [scaled(1_000), scaled(10_000)]);
const COUNT = env("QUERY_COUNT", 100);
const CONCURRENCY = env("QUERY_CONCURRENCY", 4);

const timed = async (query) => {
  const started = performance.now();
  try {
    await query();
    return { ok: true, ms: performance.now() - started };
  } catch (error) {
    return { ok: false, status: error?.status ?? 0, body: { error: { code: error?.code ?? "client_error" } } };
  }
};

for (const rows of SIZES) {
  const id = randomUUID();
  const db = createClient({ schema: s, url: BASE, workspace: id });
  const board = await db.board.create({ data: { name: "Bench" } });
  const columns = await db.$transaction(
    Array.from({ length: 20 }, (_, index) => db.column.create({ data: { name: `Column ${index}`, position: index, board: { connect: board.id } } }))
  );
  const seedStarted = performance.now();
  const ids = [];
  for (let start = 0; start < rows; start += 250) {
    const created = await db.$transaction(
      Array.from({ length: Math.min(250, rows - start) }, (_, n) => {
        const index = start + n;
        return db.task.create({ data: { title: `task-${String(index).padStart(6, "0")}`, done: index % 3 === 0, column: { connect: columns[index % 20].id } } });
      })
    );
    for (const row of created) ids.push(row.id);
  }
  const seedMs = performance.now() - seedStarted;
  const stored = (await metrics({ id, token: await tokenFor(id) }))?.gauges;

  const scenarios = {
    "id-lookup": (i) => db.task.findFirst({ where: { id: ids[(i * 7919) % ids.length] } }),
    "indexed-filter": (i) => db.column.findMany({ where: { position: i % 20 } }),
    "non-indexed-filter": (i) => db.task.findMany({ where: { title: `task-${String((i * 7919) % rows).padStart(6, "0")}` } }),
    "filter-take-100": () => db.task.findMany({ where: { done: true }, take: 100 }),
    "relation-include": (i) => db.column.findMany({ where: { position: i % 20 }, include: { tasks: true } }),
    "relation-filter": () => db.task.findMany({ where: { column: { position: { lt: 2 } } }, take: 100 }),
    "page-50": () => db.task.findPage({ orderBy: { title: "asc" }, take: 50 }),
    "count": () => db.task.count({ where: { done: false } }),
    "aggregate": () => db.task.aggregate({ _count: true }),
    "named-sql": () => db.$query("columnStats", { boardId: board.id }),
    "full-read": () => db.task.findMany(),
  };

  for (const [scenario, query] of Object.entries(scenarios)) {
    // The full read returns every row; run it fewer times.
    const count = scenario === "full-read" ? Math.max(5, Math.round(COUNT / 10)) : COUNT;
    const run = await pool(count, CONCURRENCY, (i) => timed(() => query(i)));
    emit("queries", scenario, { rows, reads: count, concurrency: CONCURRENCY }, {
      readsPerSecond: run.throughput,
      latencyMs: summarize(run.latencies),
      errorRate: run.errorRate,
      errors: run.errors,
    });
  }
  emit("queries", "dataset", { rows }, { seedMs: Math.round(seedMs), databaseBytes: stored?.storageBytes ?? null, txLogRows: stored?.txLogRows ?? null });
  db.$close();
}
