/**
 * Durability soak.
 *
 * The suite's property drill is small and fast: a few hundred ops, one
 * snapshot, one restore. This is the slow one. It runs generations of
 * traffic through the real pipeline, flushing and snapshotting as it goes,
 * then wipes the database and rebuilds it from R2 — and carries the rebuilt
 * database forward as the source for the next generation, so a restore has to
 * survive being restored again.
 *
 * Every generation checks the whole workspace row for row, the sequence
 * state, the file index, and that a recent retry is still deduped. It also
 * reports timings, so a change that makes recovery scale badly shows up as a
 * number rather than as a feeling.
 *
 *   bun scripts/soak.ts [--generations 8] [--ops 1500] [--seed 1]
 */

import { Database } from "bun:sqlite";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { flushPending } from "../src/engine/durability/flusher";
import { recoverWorkspace, type RecoverySqlExecutor } from "../src/engine/durability/recovery";
import {
  snapshotWorkspace,
  DEDUPE_HORIZON_SEQ,
  SNAPSHOT_SEQ_THRESHOLD,
} from "../src/engine/durability/snapshot";
import type { SqlValue } from "../src/engine/durability/sql";
import { recordFileEntry, forgetFileEntry } from "../src/engine/file-index";
import { configureMigrations } from "../src/engine/migrations-bundle";
import { configureRegistry, namespaceTables } from "../src/engine/registry";
import { configurePermissions } from "../src/engine/tx-permissions";
import { runTransaction } from "../src/engine/tx-pipeline";
import type { SqlExecutor, SqlRow } from "../src/engine/tx-sql";
import { model, schema, t } from "../src/schema";
import { createSqlExecutor, FakeR2Bucket, TEST_WORKSPACE } from "../test/fixtures/test-support";

// ---- arguments --------------------------------------------------------------

function flag(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
}
const GENERATIONS = flag("generations", 8);
const OPS_PER_GENERATION = flag("ops", 1500);
let seed = flag("seed", 1);

function random(): number {
  // xorshift32: deterministic, so a failure can be replayed with --seed.
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0x100000000;
}
const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
const chance = (probability: number): boolean => random() < probability;

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
    done: t.boolean().default(false),
    weight: t.number().optional(),
    meta: t.json().optional(),
    column: t.belongsTo("column").optional(),
  }),
});

configureRegistry(app.registry);
configureMigrations(app.migrations);
configurePermissions(app.permissions);

const claim: RoleClaim = {
  sub: "soak",
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

// ---- traffic ----------------------------------------------------------------

const boards: string[] = [];
const columns: string[] = [];
const tasks: string[] = [];
const paths: string[] = [];
let counter = 0;
const nextId = (prefix: string) => `${prefix}${(counter += 1)}`;

/** One transaction of one to four ops, drawn from everything the engine takes. */
function writeOnce(store: Store): { clientTxId: string; ops: Record<string, unknown>[] } | null {
  const ops: Record<string, unknown>[] = [];
  const roll = random();

  if (roll < 0.1 || boards.length === 0) {
    const id = nextId("b");
    boards.push(id);
    ops.push({ op: "insert", namespace: "board", id, values: { name: `board ${id}`, archived: false } });
  } else if (roll < 0.25 || columns.length === 0) {
    const id = nextId("c");
    columns.push(id);
    ops.push({
      op: "insert",
      namespace: "column",
      id,
      values: { name: `column ${id}`, position: Math.floor(random() * 50), boardId: pick(boards) },
    });
  } else if (roll < 0.55) {
    const id = nextId("t");
    tasks.push(id);
    ops.push({
      op: "insert",
      namespace: "task",
      id,
      values: {
        title: `task ${id}`,
        done: false,
        ...(chance(0.5) ? { weight: Math.round(random() * 1000) / 10 } : {}),
        ...(chance(0.3) ? { meta: { tags: [`t${Math.floor(random() * 9)}`] } } : {}),
        ...(chance(0.8) && columns.length > 0 ? { columnId: pick(columns) } : {}),
      },
    });
  } else if (roll < 0.72 && tasks.length > 0) {
    ops.push({
      op: "patch",
      namespace: "task",
      id: pick(tasks),
      values: chance(0.5) ? { done: chance(0.5) } : { title: `retitled ${counter}` },
    });
  } else if (roll < 0.8) {
    const id = chance(0.5) && tasks.length > 0 ? pick(tasks) : nextId("t");
    if (!tasks.includes(id)) tasks.push(id);
    ops.push({
      op: "upsert",
      namespace: "task",
      id,
      values: { title: `upserted ${counter}` },
      create: { title: `created ${counter}`, done: false },
    });
  } else if (roll < 0.86 && tasks.length > 0 && columns.length > 0) {
    ops.push({
      op: chance(0.7) ? "link" : "unlink",
      namespace: "column",
      id: pick(columns),
      link: "column.tasks",
      targetId: pick(tasks),
    });
  } else if (roll < 0.93 && tasks.length > 2) {
    const id = pick(tasks);
    tasks.splice(tasks.indexOf(id), 1);
    ops.push({ op: "delete", namespace: "task", id });
  } else if (roll < 0.97) {
    // Files go through their own logged path, not a transaction.
    const path = `files/${nextId("f")}.bin`;
    paths.push(path);
    recordFileEntry(store.tx, { path, key: `k/${path}`, size: Math.floor(random() * 5000), contentType: "application/octet-stream" });
    return null;
  } else if (paths.length > 0) {
    const path = pick(paths);
    paths.splice(paths.indexOf(path), 1);
    forgetFileEntry(store.tx, path);
    return null;
  } else {
    const id = pick(boards);
    ops.push({ op: "patch", namespace: "board", id, values: { archived: chance(0.5) } });
  }

  // A cascade can take a task away under us; a link to a missing row is a
  // legitimate refusal, not a bug, so a failed transaction is just skipped.
  const clientTxId = `soak-${counter}`;
  try {
    runTransaction(store.tx, TEST_WORKSPACE, claim, { txId: `tx-${counter}`, clientTxId, ops });
    return { clientTxId, ops };
  } catch {
    return null;
  }
}

// ---- checks -----------------------------------------------------------------

const TABLES = [...namespaceTables(), "_files"];

function dump(db: Database): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    out[table] = db.query(`SELECT * FROM "${table}" ORDER BY "id"`).all();
  }
  return out;
}

function scalar(db: Database, query: string): unknown {
  const row = db.query(query).get() as Record<string, unknown> | null;
  return row === null ? undefined : Object.values(row)[0];
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`\nFAILED: ${message}  (replay with --seed ${process.argv[process.argv.indexOf("--seed") + 1] ?? 1})`);
    process.exit(1);
  }
}

function rows(db: Database): number {
  return TABLES.reduce((total, table) => total + Number(scalar(db, `SELECT COUNT(*) FROM "${table}"`) ?? 0), 0);
}

// ---- the drill --------------------------------------------------------------

const bucket = new FakeR2Bucket();
let store = open();
let lastWrite: { clientTxId: string; ops: Record<string, unknown>[] } | null = null;
const timings: Array<Record<string, number>> = [];

console.log(
  `soak: ${GENERATIONS} generations x ${OPS_PER_GENERATION} ops, snapshot every ${SNAPSHOT_SEQ_THRESHOLD} seq, dedupe horizon ${DEDUPE_HORIZON_SEQ}\n`
);

for (let generation = 1; generation <= GENERATIONS; generation += 1) {
  const startedAt = performance.now();

  for (let index = 0; index < OPS_PER_GENERATION; index += 1) {
    const result = writeOnce(store);
    if (result) lastWrite = result;
    // Durability runs on an alarm in production; here it runs inline at the
    // same thresholds, several times per generation.
    if (index % 250 === 249) {
      await flushPending(bucket, store.durable, TEST_WORKSPACE, Date.now());
      if (chance(0.5)) await snapshotWorkspace(bucket, store.durable, TEST_WORKSPACE, Date.now());
    }
  }
  const wroteAt = performance.now();

  await flushPending(bucket, store.durable, TEST_WORKSPACE, Date.now());
  await snapshotWorkspace(bucket, store.durable, TEST_WORKSPACE, Date.now());
  const publishedAt = performance.now();

  const before = dump(store.db);
  const highWater = scalar(store.db, `SELECT high_water_seq FROM "_tx_state"`);
  const sourceRows = rows(store.db);

  // Wipe: a Durable Object that lost its SQLite entirely.
  const target = open();
  const recovery = await recoverWorkspace(bucket as unknown as R2Bucket, target.recovery, TEST_WORKSPACE, {});
  const recoveredAt = performance.now();

  assert(recovery.recovered === true, `generation ${generation}: recovery refused (${JSON.stringify(recovery)})`);
  assert(
    JSON.stringify(dump(target.db)) === JSON.stringify(before),
    `generation ${generation}: restored rows differ from the source`
  );
  assert(
    scalar(target.db, `SELECT high_water_seq FROM "_tx_state"`) === highWater,
    `generation ${generation}: high water mark differs`
  );

  // A retry from inside the horizon must still be recognised: the same key
  // with the same ops, which is what a client that never saw the ack sends.
  if (lastWrite !== null) {
    const retry = runTransaction(target.tx, TEST_WORKSPACE, claim, {
      txId: "retry",
      clientTxId: lastWrite.clientTxId,
      basisSeq: Number(highWater) - 1,
      ops: lastWrite.ops,
    });
    assert(retry.applied === 0, `generation ${generation}: a retry inside the horizon was applied again`);
  }

  // Recovering a second time over the restored database must change nothing.
  const forced = dump(target.db);
  await recoverWorkspace(bucket as unknown as R2Bucket, target.recovery, TEST_WORKSPACE, { force: true });
  assert(
    JSON.stringify(dump(target.db)) === JSON.stringify(forced),
    `generation ${generation}: a forced second recovery changed the database`
  );

  const objects = [...bucket.objects.keys()];
  timings.push({
    generation,
    rows: sourceRows,
    seq: Number(highWater),
    writeMs: Math.round(wroteAt - startedAt),
    publishMs: Math.round(publishedAt - wroteAt),
    recoverMs: Math.round(recoveredAt - publishedAt),
    segments: objects.filter((key) => key.includes("/log/")).length,
    chunks: objects.filter((key) => key.includes("/snapshots/")).length,
    r2KiB: Math.round([...bucket.objects.values()].reduce((total, object) => total + object.body.byteLength, 0) / 1024),
  });
  console.log(
    `  gen ${String(generation).padStart(2)}  rows ${String(sourceRows).padStart(5)}  seq ${String(highWater).padStart(5)}  ` +
      `write ${String(timings.at(-1)!.writeMs).padStart(5)}ms  publish ${String(timings.at(-1)!.publishMs).padStart(4)}ms  ` +
      `recover ${String(timings.at(-1)!.recoverMs).padStart(4)}ms  segments ${String(timings.at(-1)!.segments).padStart(3)}  ` +
      `R2 ${String(timings.at(-1)!.r2KiB).padStart(5)}KiB`
  );

  // Carry the restored database forward: the next generation writes on top of
  // a workspace that is itself the product of a recovery.
  store = target;
}

const last = timings.at(-1)!;
const first = timings[0];
console.log(
  `\nok. ${last.rows} rows, seq ${last.seq}, ${last.segments} segments, ${last.r2KiB} KiB in R2.\n` +
    `recovery ${first.recoverMs}ms -> ${last.recoverMs}ms as the workspace grew ${first.rows} -> ${last.rows} rows.`
);
