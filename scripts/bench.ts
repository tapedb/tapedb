/**
 * Engine benchmarks, local.
 *
 * Runs the real pipeline — `runTransaction`, `executeQuery`, the flusher, the
 * snapshotter, recovery — over bun's SQLite, and reports throughput and exact
 * latency quantiles for each scenario.
 *
 * **What this does not measure.** bun's SQLite is not a Durable Object's. It
 * allows 32,766 bound parameters against 100 and an expression depth of 1,000
 * against 100, there is no network between the caller and the database, R2 is
 * a `Map` in this process, and nothing here pays for the Workers runtime, the
 * socket, or an eviction. These numbers therefore bound the engine's own cost
 * and show how it scales with the data; they say nothing about what a
 * deployment serves. For that, run the load scenario against workerd or a
 * deployed Worker — `node scripts/e2e.mjs --only load`, with `BENCH_JSON` set
 * to record it — which is reported separately for exactly this reason.
 *
 * No targets are asserted. A benchmark that fails a threshold invented here
 * would be measuring this machine, so the output is numbers and the judgement
 * is yours. `BENCHMARKS.md` records a run and what it implies.
 *
 *   bun scripts/bench.ts
 *   bun scripts/bench.ts --rows 50000 --iterations 500
 *   bun scripts/bench.ts --only queries,durability --json bench.json
 */

import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem, platform, arch, release } from "node:os";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { flushPending } from "../src/engine/durability/flusher";
import { recoverWorkspace, type RecoverySqlExecutor } from "../src/engine/durability/recovery";
import { snapshotWorkspace } from "../src/engine/durability/snapshot";
import type { SqlValue } from "../src/engine/durability/sql";
import { defaultDeploymentConfig } from "../src/engine/config";
import { configureMigrations } from "../src/engine/migrations-bundle";
import { configureRegistry } from "../src/engine/registry";
import { compileQuery } from "../src/engine/query-compile";
import { executeCompiledQueryWithPageInfo, executeQuery, viewAccess } from "../src/engine/query-execute";
import { analyzeQuery, resolveQueries, runQuery } from "../src/engine/sql-query";
import { configurePermissions } from "../src/engine/tx-permissions";
import { runTransaction } from "../src/engine/tx-pipeline";
import type { SqlExecutor, SqlRow } from "../src/engine/tx-sql";
import { prepareSql } from "../src/model/queries";
import { model, role, schema, sqlQuery, t } from "../src/schema";
import { quantile, round } from "./bench-stats";
import { createSqlExecutor, FakeR2Bucket, TEST_WORKSPACE } from "../test/fixtures/test-support";

// ---- arguments --------------------------------------------------------------

function num(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} needs a positive number.`);
  return value;
}
function str(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

/** Rows the query scenarios read against. The dataset is built once and reused. */
const ROWS = num("rows", 20_000);
/** Samples per measurement. More is steadier and slower. */
const ITERATIONS = num("iterations", 200);
const JSON_OUT = str("json");
const ONLY = str("only")?.split(",").map((part) => part.trim()).filter(Boolean) ?? null;
const wanted = (group: string) => ONLY === null || ONLY.includes(group);

let seed = num("seed", 1);
function random(): number {
  // xorshift32, so a run is reproducible from its seed.
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0x100000000;
}

// ---- schema -----------------------------------------------------------------

const app = schema({
  board: model({ name: t.string(), archived: t.boolean().default(false), columns: t.hasMany("column") }),
  column: model({
    name: t.string(),
    position: t.number().default(0).index(),
    board: t.belongsTo("board", { onDelete: "cascade" }),
    tasks: t.hasMany("task"),
  }),
  task: model({
    title: t.string(),
    // `done` is indexed and `note` is not, which is the pair the query
    // scenarios compare: the same shape of filter with and without an index.
    done: t.boolean().default(false).index(),
    note: t.string().optional(),
    weight: t.number().optional(),
    column: t.belongsTo("column").optional(),
  }),
}, {
  queries: {
    openPerColumn: sqlQuery({
      params: { boardId: t.string() },
      returns: { name: t.string(), open: t.number() },
      sql: `WITH open AS (SELECT column_id, count(*) AS n FROM task WHERE done = 0 GROUP BY column_id)
            SELECT c.name, coalesce(o.n, 0) AS open FROM "column" c LEFT JOIN open o ON o.column_id = c.id
            WHERE c.board_id = :boardId ORDER BY c.position`,
    }),
  },
});

/** The deployment these benchmarks represent; the write paths require one. */
const config = defaultDeploymentConfig();

configureRegistry(app.registry);
configureMigrations(app.migrations);
configurePermissions(app.permissions);

const claim: RoleClaim = {
  sub: "bench",
  workspaceId: TEST_WORKSPACE,
  role: WORKSPACE_ROLE_LEVELS.OWNER,
  exp: Math.floor(Date.now() / 1000) + 86_400,
  iat: Math.floor(Date.now() / 1000),
};

interface Store {
  db: Database;
  tx: SqlExecutor;
  durable: ReturnType<typeof createSqlExecutor>;
  recovery: RecoverySqlExecutor;
}

function open(): Store {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of app.migrations) db.exec(migration.sql);
  const durable = createSqlExecutor(db);
  const tx: SqlExecutor = {
    exec: (query: string, ...params: SqlValue[]) => db.query(query).run(...(params as never[])).changes,
    all: <T extends SqlRow = SqlRow>(query: string, ...params: SqlValue[]) =>
      db.query(query).all(...(params as never[])) as T[],
    one: <T extends SqlRow = SqlRow>(query: string, ...params: SqlValue[]) =>
      (db.query(query).get(...(params as never[])) ?? undefined) as T | undefined,
    transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
  };
  return {
    db,
    tx,
    durable,
    recovery: {
      exec: (query, ...bindings) => durable.exec(query, ...bindings),
      transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
    },
  };
}

// ---- measurement ------------------------------------------------------------

interface Result {
  group: string;
  name: string;
  /** What one iteration did, for reading a per-op figure off a per-batch time. */
  unit: string;
  iterations: number;
  opsPerIteration: number;
  errors: number;
  totalMs: number;
  /** Iterations per second, and operations per second where a batch holds many. */
  iterationsPerSecond: number;
  operationsPerSecond: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Set where the scenario grew the database; bytes after minus bytes before. */
  storageGrowthBytes?: number;
  notes?: string;
}

const results: Result[] = [];



interface MeasureOptions {
  group: string;
  name: string;
  unit?: string;
  /** Operations one iteration performs, so a batch reports a per-op rate too. */
  opsPerIteration?: number;
  iterations?: number;
  /** Untimed iterations first, to let SQLite prepare and the JIT settle. */
  warmup?: number;
  bytes?: () => number;
  notes?: string;
}

async function measure(options: MeasureOptions, body: (iteration: number) => unknown): Promise<Result> {
  const iterations = options.iterations ?? ITERATIONS;
  const opsPerIteration = options.opsPerIteration ?? 1;
  const warmup = options.warmup ?? Math.min(5, Math.max(1, Math.floor(iterations / 20)));

  for (let i = 0; i < warmup; i += 1) await body(-1 - i);

  const before = options.bytes?.() ?? null;
  const samples: number[] = [];
  let errors = 0;
  const startedAt = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const at = performance.now();
    try {
      await body(i);
    } catch {
      // Counted rather than thrown: an error rate is one of the figures asked
      // for, and a scenario that cannot complete is more useful reported than
      // as a stack trace that stops every later scenario.
      errors += 1;
    }
    samples.push(performance.now() - at);
  }
  const totalMs = performance.now() - startedAt;
  const after = options.bytes?.() ?? null;

  // A scenario where every iteration failed has no latency to report, only a
  // bug. Reporting quantiles for it would read as a result.
  if (errors === iterations && iterations > 0) {
    throw new Error(`${options.group}/${options.name}: every iteration failed; the scenario is broken, not slow.`);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const result: Result = {
    group: options.group,
    name: options.name,
    unit: options.unit ?? "operation",
    iterations,
    opsPerIteration,
    errors,
    totalMs: round(totalMs),
    iterationsPerSecond: round((iterations / totalMs) * 1000),
    operationsPerSecond: round(((iterations * opsPerIteration) / totalMs) * 1000),
    meanMs: round(samples.reduce((total, value) => total + value, 0) / Math.max(1, samples.length)),
    p50Ms: round(quantile(sorted, 0.5)),
    p95Ms: round(quantile(sorted, 0.95)),
    p99Ms: round(quantile(sorted, 0.99)),
    maxMs: round(sorted.at(-1) ?? 0),
    ...(before !== null && after !== null ? { storageGrowthBytes: after - before } : {}),
    ...(options.notes ? { notes: options.notes } : {}),
  };
  results.push(result);
  report(result);
  return result;
}

function report(result: Result): void {
  const perOp = result.opsPerIteration > 1 ? `  ${String(Math.round(result.operationsPerSecond)).padStart(7)} ops/s` : "".padStart(16);
  console.log(
    `  ${result.name.padEnd(42)} ` +
      `p50 ${String(result.p50Ms).padStart(8)}ms  p95 ${String(result.p95Ms).padStart(8)}ms  p99 ${String(result.p99Ms).padStart(8)}ms` +
      perOp +
      (result.errors > 0 ? `  errors ${result.errors}` : "")
  );
}

function databaseBytes(db: Database): number {
  const pages = db.query(`PRAGMA page_count`).get() as { page_count: number } | null;
  const size = db.query(`PRAGMA page_size`).get() as { page_size: number } | null;
  return (pages?.page_count ?? 0) * (size?.page_size ?? 0);
}

// ---- dataset ----------------------------------------------------------------

let txCounter = 0;
const nextTx = () => `bench-${(txCounter += 1)}`;

function write(store: Store, ops: Record<string, unknown>[]): void {
  runTransaction(store.tx, TEST_WORKSPACE, claim, { txId: nextTx(), ops }, config);
}

interface Dataset {
  store: Store;
  boards: string[];
  columns: string[];
  tasks: string[];
}

/**
 * One board per 500 tasks, ten columns each, so relation queries have
 * something to traverse and `openPerColumn` has a board worth grouping.
 */
function build(rows: number): Dataset {
  const store = open();
  const boards: string[] = [];
  const columns: string[] = [];
  const tasks: string[] = [];
  const boardCount = Math.max(1, Math.round(rows / 500));

  for (let b = 0; b < boardCount; b += 1) {
    const boardId = `b${b}`;
    boards.push(boardId);
    const ops: Record<string, unknown>[] = [
      { op: "insert", namespace: "board", id: boardId, values: { name: `board ${b}`, archived: b % 7 === 0 } },
    ];
    for (let c = 0; c < 10; c += 1) {
      const columnId = `c${b}-${c}`;
      columns.push(columnId);
      ops.push({ op: "insert", namespace: "column", id: columnId, values: { name: `column ${c}`, position: c, boardId } });
    }
    write(store, ops);
  }

  // Tasks in batches of 500, which is also what a seeding script would do.
  let written = 0;
  while (written < rows) {
    const batch = Math.min(500, rows - written);
    const ops: Record<string, unknown>[] = [];
    for (let i = 0; i < batch; i += 1) {
      const id = `t${written + i}`;
      tasks.push(id);
      ops.push({
        op: "insert",
        namespace: "task",
        id,
        values: {
          title: `task ${written + i}`,
          done: random() < 0.3,
          note: random() < 0.5 ? `note ${Math.floor(random() * 1_000_000)}` : null,
          weight: Math.floor(random() * 100),
          columnId: columns[Math.floor(random() * columns.length)],
        },
      });
    }
    write(store, ops);
    written += batch;
  }

  return { store, boards, columns, tasks };
}

// ---- environment ------------------------------------------------------------

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const environment = {
  at: new Date().toISOString(),
  tapedbVersion: (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version,
  commit: gitCommit(),
  runtime: `bun ${Bun.version}`,
  platform: `${platform()} ${release()} ${arch()}`,
  cpu: cpus()[0]?.model ?? "unknown",
  cores: cpus().length,
  totalMemoryBytes: totalmem(),
  dataset: { rows: ROWS, iterations: ITERATIONS, seed: num("seed", 1) },
  /**
   * Stated in the machine-readable output as well as the prose, because a
   * number read out of a JSON file loses its context first.
   */
  measures: "the engine's own cost over bun's SQLite, in process, with R2 in memory",
  doesNotMeasure: "a Durable Object's SQLite limits, the Workers runtime, the socket, the network, R2 latency, eviction or cold start",
};

// ---- scenarios --------------------------------------------------------------

console.log(`tapedb bench ${environment.tapedbVersion}${environment.commit ? ` (${environment.commit})` : ""}`);
console.log(`  ${environment.runtime} on ${environment.cpu} x${environment.cores}, ${environment.platform}`);
console.log(`  ${ROWS} rows, ${ITERATIONS} iterations per measurement, seed ${environment.dataset.seed}`);
console.log(`  local engine only: ${environment.doesNotMeasure}\n`);

const buildStartedAt = performance.now();
const data = build(ROWS);
const buildMs = Math.round(performance.now() - buildStartedAt);
const datasetBytes = databaseBytes(data.store.db);
console.log(
  `dataset: ${ROWS} tasks, ${data.boards.length} boards, ${data.columns.length} columns in ${buildMs}ms` +
    `  (${(datasetBytes / 1024 / 1024).toFixed(1)} MiB, ${Math.round(datasetBytes / Math.max(1, ROWS))} bytes/task)\n`
);

if (wanted("writes")) {
  console.log("writes");
  const store = data.store;
  let n = 0;

  await measure(
    { group: "writes", name: "insert, one row per transaction", bytes: () => databaseBytes(store.db) },
    () => write(store, [{ op: "insert", namespace: "task", id: `w1-${(n += 1)}`, values: { title: "one", done: false } }])
  );

  for (const batch of [10, 100, 1000]) {
    await measure(
      {
        group: "writes",
        name: `insert, ${batch} rows per transaction`,
        unit: "transaction",
        opsPerIteration: batch,
        iterations: Math.max(10, Math.round(ITERATIONS / Math.sqrt(batch))),
        bytes: () => databaseBytes(store.db),
      },
      () =>
        write(
          store,
          Array.from({ length: batch }, () => ({
            op: "insert",
            namespace: "task",
            id: `w${batch}-${(n += 1)}`,
            values: { title: "batched", done: false },
          }))
        )
    );
  }

  await measure({ group: "writes", name: "update, one row per transaction" }, (i) =>
    write(store, [
      { op: "update", namespace: "task", id: data.tasks[Math.abs(i) % data.tasks.length], values: { weight: Math.abs(i) % 100 } },
    ])
  );

  // A bulk op resolves its own match set inside the transaction, so this is
  // the cost of the filter plus the rows it touches, not of one row.
  await measure(
    {
      group: "writes",
      name: "patchMany over an indexed filter",
      unit: "transaction",
      iterations: Math.max(10, Math.round(ITERATIONS / 10)),
      notes: "the engine bounds a bulk op at 1000 rows per transaction",
    },
    () => write(store, [{ op: "patchMany", namespace: "task", where: { done: true }, values: { weight: 1 } }])
  );

  await measure(
    {
      group: "writes",
      name: "insert with a replayed clientTxId (deduped)",
      notes: "the receipt path: no rows move",
    },
    () =>
      runTransaction(store.tx, TEST_WORKSPACE, claim, {
        txId: nextTx(),
        clientTxId: "bench-replay",
        ops: [{ op: "insert", namespace: "task", id: "replayed", values: { title: "replay", done: false } }],
      }, config)
  );
  console.log("");
}

if (wanted("queries")) {
  console.log("queries");
  const store = data.store;
  const read = (document: Record<string, unknown>) => executeQuery(store.tx, claim, { query: document });

  await measure({ group: "queries", name: "findUnique by id" }, (i) =>
    read({ task: { $: { where: { id: data.tasks[Math.abs(i) % data.tasks.length] }, limit: 1 } } })
  );

  await measure({ group: "queries", name: "findMany, limit 50, no filter" }, () =>
    read({ task: { $: { limit: 50 } } })
  );

  await measure({ group: "queries", name: "filter on an indexed field (done)" }, () =>
    read({ task: { $: { where: { done: true }, limit: 50 } } })
  );

  await measure({ group: "queries", name: "filter on an unindexed field (note)" }, (i) =>
    read({ task: { $: { where: { note: `note ${Math.abs(i)}` }, limit: 50 } } })
  );

  await measure({ group: "queries", name: "order by an indexed field, limit 50" }, () =>
    read({ column: { $: { order: { position: "asc" }, limit: 50 } } })
  );

  await measure({ group: "queries", name: "include one level (column -> tasks)" }, (i) =>
    read({ column: { $: { where: { id: data.columns[Math.abs(i) % data.columns.length] }, limit: 1 }, tasks: { $: { limit: 20 } } } })
  );

  await measure({ group: "queries", name: "include two levels (board -> columns -> tasks)" }, (i) =>
    read({ board: { $: { where: { id: data.boards[Math.abs(i) % data.boards.length] }, limit: 1 }, columns: { $: { limit: 10 }, tasks: { $: { limit: 10 } } } } })
  );

  // The engine's own relation-filter form; the model layer compiles
  // `{ column: { board: { archived: false } } }` into this.
  await measure({ group: "queries", name: "relation filter, one link (task -> column)" }, () =>
    read({
      task: {
        $: {
          where: { $link: [{ label: "column", mode: "parent", where: { position: { $lt: 5 } } }] },
          limit: 50,
        },
      },
    })
  );

  await measure({ group: "queries", name: "relation filter, two links (task -> column -> board)" }, () =>
    read({
      task: {
        $: {
          where: {
            $link: [
              {
                label: "column",
                mode: "parent",
                where: { $link: [{ label: "board", mode: "parent", where: { archived: false } }] },
              },
            ],
          },
          limit: 50,
        },
      },
    })
  );

  await measure({ group: "queries", name: "count, whole model" }, () =>
    read({ task: { $: { aggregate: { count: true } } } })
  );

  await measure({ group: "queries", name: "aggregate sum, avg and min over an indexed filter" }, () =>
    read({ task: { $: { where: { done: false }, aggregate: { count: true, sum: ["weight"], avg: ["weight"], min: ["weight"] } } } })
  );

  await measure({ group: "queries", name: "aggregate grouped by an indexed field" }, () =>
    read({ task: { $: { aggregate: { groupBy: ["done"], count: true, avg: ["weight"] } } } })
  );

  // Pagination: walk pages rather than re-reading page one, so the figure is
  // the cost of a cursor step at depth, which is what a client actually pays.
  const pageSize = 50;
  let cursor: string | null = null;
  await measure(
    { group: "queries", name: `paginate by cursor, ${pageSize} per page`, unit: "page", opsPerIteration: pageSize },
    () => {
      const compiled = compileQuery(
        { task: { $: { order: { id: "asc" }, limit: pageSize, ...(cursor === null ? {} : { after: cursor }) } } },
        viewAccess(claim)
      );
      const { pageInfo } = executeCompiledQueryWithPageInfo(store.tx, compiled, claim);
      cursor = pageInfo.task?.nextCursor ?? null;
    }
  );

  const sqlStorage = {
    query: (text: string, params: Record<string, SqlValue>) => {
      const statement = store.db.query(text);
      const rows = statement.all(params as never) as Array<Record<string, unknown>>;
      return { columns: statement.columnNames, rows: rows.map((row) => Object.values(row)) };
    },
    transactionSync: <T>(fn: () => T) => store.db.transaction(fn)(),
  } as unknown as Parameters<typeof analyzeQuery>[0];
  // The engine runs a prepared query, not the schema's declaration: the same
  // resolution the Worker does when it is defined.
  const resolved = resolveQueries(
    (app as { queries?: Parameters<typeof resolveQueries>[0] }).queries,
    (name) => role(name as Parameters<typeof role>[0]).level,
    prepareSql
  );
  const named = resolved.openPerColumn;
  const analysis = analyzeQuery(sqlStorage, named);
  await measure({ group: "queries", name: "named SQL query (CTE + left join)" }, (i) =>
    runQuery(sqlStorage, analysis, named, claim, { boardId: data.boards[Math.abs(i) % data.boards.length] })
  );
  console.log("");
}

if (wanted("realtime")) {
  console.log("realtime (invalidation cost, not propagation)");
  const store = data.store;
  // What a write costs the room: every live query whose model it touched is
  // compiled and re-run. The socket, the diff and the wire are not here —
  // the load scenario measures those end to end.
  for (const count of [1, 10, 100]) {
    const documents = Array.from({ length: count }, (_, i) => ({
      task: { $: { where: { columnId: data.columns[i % data.columns.length] }, limit: 50 } },
    }));
    const compiled = documents.map((document) => compileQuery(document, viewAccess(claim)));
    await measure(
      {
        group: "realtime",
        name: `re-run ${count} live queries after a write`,
        unit: "invalidation pass",
        opsPerIteration: count,
        iterations: Math.max(10, Math.round(ITERATIONS / Math.max(1, count / 10))),
      },
      () => {
        for (const query of compiled) executeCompiledQueryWithPageInfo(store.tx, query, claim);
      }
    );
  }
  console.log("");
}

if (wanted("durability")) {
  console.log("durability");
  // A fresh workspace per scenario: a flush measured after another scenario's
  // flush would be measuring an empty queue.
  for (const pending of [100, 1_000, 10_000]) {
    const bucket = new FakeR2Bucket() as unknown as R2Bucket;
    const store = open();
    for (let i = 0; i < pending; i += 1) {
      write(store, [{ op: "insert", namespace: "task", id: `f${i}`, values: { title: `t${i}`, done: false } }]);
    }
    await measure(
      {
        group: "durability",
        name: `flush ${pending} pending transactions to R2`,
        unit: "flush pass",
        iterations: 1,
        warmup: 0,
        notes: "R2 is in memory here; a real bucket adds its own latency per object",
      },
      async () => {
        for (;;) {
          const result = await flushPending(bucket, store.durable, TEST_WORKSPACE, Date.now());
          if (!result.flushed) break;
        }
      }
    );
    store.db.close();
  }

  for (const rows of [1_000, 10_000]) {
    const bucket = new FakeR2Bucket() as unknown as R2Bucket;
    const source = build(rows);
    for (;;) {
      const result = await flushPending(bucket, source.store.durable, TEST_WORKSPACE, Date.now());
      if (!result.flushed) break;
    }
    await measure(
      { group: "durability", name: `snapshot a ${rows}-row workspace`, unit: "snapshot", iterations: 1, warmup: 0 },
      () => snapshotWorkspace(bucket, source.store.durable, TEST_WORKSPACE, Date.now())
    );

    // Cold start: a Durable Object that lost its SQLite entirely.
    await measure(
      {
        group: "durability",
        name: `recover a ${rows}-row workspace from R2`,
        unit: "recovery",
        iterations: 1,
        warmup: 0,
        notes: "from a snapshot plus the log after it",
      },
      async () => {
        const target = open();
        const recovery = await recoverWorkspace(bucket, target.recovery, TEST_WORKSPACE, {});
        if (!recovery.recovered) throw new Error(`recovery refused: ${JSON.stringify(recovery)}`);
        target.db.close();
      }
    );

    // The same restore with no snapshot to start from: the log is replayed
    // from the beginning, which is the slow path worth knowing the shape of.
    const logOnly = new FakeR2Bucket() as unknown as R2Bucket;
    const plain = build(rows);
    for (;;) {
      const result = await flushPending(logOnly, plain.store.durable, TEST_WORKSPACE, Date.now());
      if (!result.flushed) break;
    }
    await measure(
      {
        group: "durability",
        name: `recover a ${rows}-row workspace by replaying the log`,
        unit: "recovery",
        iterations: 1,
        warmup: 0,
        notes: "no snapshot: every transaction is applied again",
      },
      async () => {
        const target = open();
        const recovery = await recoverWorkspace(logOnly, target.recovery, TEST_WORKSPACE, {});
        if (!recovery.recovered) throw new Error(`recovery refused: ${JSON.stringify(recovery)}`);
        target.db.close();
      }
    );
    source.store.db.close();
    plain.store.db.close();
  }
  console.log("");
}

if (wanted("storage")) {
  console.log("storage");
  for (const rows of [1_000, 10_000]) {
    const set = build(rows);
    const bytes = databaseBytes(set.store.db);
    const tasks = Number(
      (set.store.db.query(`SELECT COUNT(*) AS n FROM task`).get() as { n: number } | null)?.n ?? 0
    );
    results.push({
      group: "storage",
      name: `${rows}-row workspace on disk`,
      unit: "workspace",
      iterations: 1,
      opsPerIteration: 1,
      errors: 0,
      totalMs: 0,
      iterationsPerSecond: 0,
      operationsPerSecond: 0,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      storageGrowthBytes: bytes,
      notes: `${Math.round(bytes / Math.max(1, tasks))} bytes per task, including the transaction log and engine tables`,
    });
    console.log(
      `  ${`${rows}-row workspace`.padEnd(42)} ${(bytes / 1024 / 1024).toFixed(2)} MiB  ` +
        `${Math.round(bytes / Math.max(1, tasks))} bytes/task (log and engine tables included)`
    );
    set.store.db.close();
  }
  console.log("");
}

// ---- output -----------------------------------------------------------------

if (JSON_OUT) {
  writeFileSync(JSON_OUT, `${JSON.stringify({ environment, results }, null, 2)}\n`);
  console.log(`wrote ${JSON_OUT} (${results.length} measurements)`);
}

const failed = results.filter((result) => result.errors > 0);
if (failed.length > 0) {
  console.log(`\n${failed.length} scenario(s) reported errors:`);
  for (const result of failed) console.log(`  ${result.name}: ${result.errors}/${result.iterations}`);
}
console.log(
  `\n${results.length} measurements. These are engine costs over bun's SQLite, not a deployment's:` +
    `\nrun \`node scripts/e2e.mjs --only load\` for what a Worker and a socket serve.`
);
