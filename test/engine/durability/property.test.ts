import { useLegacyFixture } from "../../fixtures/registry";
useLegacyFixture();

/**
 * Recovery property test.
 *
 * Each seed generates a deterministic, pseudo-random transaction stream across
 * several namespaces, applies it through the real transaction pipeline, then
 * flushes and snapshots at a random point before writing more transactions.
 * A fresh database recovers from the fake R2 bucket and must match the source
 * row-for-row, including `updated_seq` and every foreign-key column.
 *
 * This is the fast "wipe a DO, rebuild from R2" drill that runs in CI. The
 * slower drill runs against a real Worker under `wrangler dev`.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../../../src/claims";
import { namespaceTables } from "../../fixtures/registry";
import { runTransaction } from "../../../src/engine/tx-pipeline";
import type {
  SqlExecutor as TxSqlExecutor,
  SqlRow as TxSqlRow,
} from "../../../src/engine/tx-sql";
import type { TxEnvelope, TxOp } from "../../../src/engine/tx-types";
import { flushPending } from "../../../src/engine/durability/flusher";
import { recoverWorkspace, type RecoverySqlExecutor } from "../../../src/engine/durability/recovery";
import { snapshotWorkspace } from "../../../src/engine/durability/snapshot";
import type { SqlExecutor as DurabilitySql, SqlValue } from "../../../src/engine/durability/sql";
import { FakeR2Bucket, openTestDb, TEST_WORKSPACE } from "../../fixtures/test-support";

const SEEDS = 16;
const CLAIM_ROLE = WORKSPACE_ROLE_LEVELS.MODERATOR;

const FOLDER_IDS = ["f0", "f1", "f2", "f3", "f4", "f5"];
const DOCUMENT_IDS = ["d0", "d1", "d2", "d3", "d4", "d5"];
const BLOCK_IDS = ["b0", "b1", "b2", "b3", "b4"];
const BOARD_IDS = ["kb0", "kb1"];
const COLUMN_IDS = ["kc0", "kc1", "kc2", "kc3"];
const TASK_IDS = ["kt0", "kt1", "kt2", "kt3"];
const FAVORITE_IDS = ["fav0", "fav1", "fav2", "fav3"];

interface Model {
  folders: Set<string>;
  documents: Set<string>;
  blocks: Set<string>;
  boards: Set<string>;
  columns: Set<string>;
  tasks: Set<string>;
  favorites: Set<string>;
}

interface Store {
  db: Database;
  sql: DurabilitySql;
}

/** Small, fast deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!;
}

function maybe<T>(rng: () => number, probability: number, value: T): T | null {
  return rng() < probability ? value : null;
}

function intBetween(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function cloneModel(model: Model): Model {
  return {
    folders: new Set(model.folders),
    documents: new Set(model.documents),
    blocks: new Set(model.blocks),
    boards: new Set(model.boards),
    columns: new Set(model.columns),
    tasks: new Set(model.tasks),
    favorites: new Set(model.favorites),
  };
}

function createStore(): Store {
  const { db, sql } = openTestDb();
  db.exec("PRAGMA foreign_keys = ON");
  return { db, sql };
}

function txExecutor(db: Database): TxSqlExecutor {
  return {
    exec(query, ...params) {
      return db.prepare(query).run(...(params as never[])).changes;
    },
    all<T extends TxSqlRow = TxSqlRow>(
      query: string,
      ...params: SqlValue[]
    ): T[] {
      return db.query(query).all(...(params as never[])) as T[];
    },
    one<T extends TxSqlRow = TxSqlRow>(
      query: string,
      ...params: SqlValue[]
    ): T | undefined {
      const row = db.query(query).get(...(params as never[]));
      return row === null ? undefined : (row as T);
    },
    transactionSync<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}

function recoveryExecutor(
  db: Database,
  sql: DurabilitySql
): RecoverySqlExecutor {
  return {
    exec<T extends Record<string, SqlValue>>(
      query: string,
      ...bindings: SqlValue[]
    ) {
      return sql.exec<T>(query, ...bindings);
    },
    transactionSync<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}

function claim(): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "property-user",
    workspaceId: TEST_WORKSPACE,
    role: CLAIM_ROLE,
    exp: now + 300,
    iat: now,
  };
}

function run(store: Store, envelope: TxEnvelope): number {
  return runTransaction(txExecutor(store.db), TEST_WORKSPACE, claim(), envelope)
    .seq;
}

/**
 * Seeds one row in every namespace the generator can touch, so later link and
 * unlink ops always have a valid folder/document pair.
 */
function seedOps(): TxOp[] {
  return [
    {
      op: "update",
      namespace: "folders",
      id: "f0",
      values: { name: "Seed folder" },
    },
    {
      op: "update",
      namespace: "documents",
      id: "d0",
      values: {
        title: "Seed document",
        content: "Seed body",
        folderId: "f0",
      },
    },
    {
      op: "update",
      namespace: "blocks",
      id: "b0",
      values: {
        type: "paragraph",
        content: "Seed block",
        order: 0,
        documentId: "d0",
      },
    },
    {
      op: "update",
      namespace: "kanbanBoards",
      id: "kb0",
      values: { name: "Seed board" },
    },
    {
      op: "update",
      namespace: "kanbanColumns",
      id: "kc0",
      values: { name: "Seed column", order: 0, boardId: "kb0" },
    },
    {
      op: "update",
      namespace: "kanbanTasks",
      id: "kt0",
      values: { title: "Seed task", order: 0, columnId: "kc0" },
    },
    {
      op: "update",
      namespace: "favorites",
      id: "fav0",
      values: { type: "document", targetId: "d0" },
    },
  ];
}

function seedModel(): Model {
  return {
    folders: new Set(["f0"]),
    documents: new Set(["d0"]),
    blocks: new Set(["b0"]),
    boards: new Set(["kb0"]),
    columns: new Set(["kc0"]),
    tasks: new Set(["kt0"]),
    favorites: new Set(["fav0"]),
  };
}

function folderInsert(rng: () => number, model: Model, id: string): TxOp {
  const values: Record<string, unknown> = {
    name: `folder-${id}-${intBetween(rng, 0, 999)}`,
  };
  const order = maybe(rng, 0.4, intBetween(rng, 0, 20));
  if (order !== null) values.order = order;

  const parents = [...model.folders].filter((candidate) => candidate !== id);
  if (parents.length > 0) {
    const parent = maybe(rng, 0.25, pick(rng, parents));
    if (parent !== null) values.parentId = parent;
  }

  return { op: "update", namespace: "folders", id, values };
}

function documentInsert(rng: () => number, model: Model, id: string): TxOp {
  const values: Record<string, unknown> = {
    title: `document-${id}-${intBetween(rng, 0, 999)}`,
    content: `body-${intBetween(rng, 0, 999)}`,
  };
  const folder = maybe(rng, 0.5, pick(rng, [...model.folders]));
  if (folder !== null) values.folderId = folder;
  const showTitle = maybe(rng, 0.3, rng() < 0.5);
  if (showTitle !== null) values.showTitleInDocument = showTitle;
  return { op: "update", namespace: "documents", id, values };
}

function blockInsert(rng: () => number, model: Model, id: string): TxOp {
  const values: Record<string, unknown> = {
    type: pick(rng, ["paragraph", "heading", "code"]),
    content: `block-${intBetween(rng, 0, 999)}`,
    order: intBetween(rng, 0, 50),
  };
  const document = maybe(rng, 0.5, pick(rng, [...model.documents]));
  if (document !== null) values.documentId = document;
  const checked = maybe(rng, 0.2, rng() < 0.5);
  if (checked !== null) values.checked = checked;
  return { op: "update", namespace: "blocks", id, values };
}

function boardInsert(rng: () => number, id: string): TxOp {
  return {
    op: "update",
    namespace: "kanbanBoards",
    id,
    values: { name: `board-${id}-${intBetween(rng, 0, 999)}` },
  };
}

function columnInsert(rng: () => number, model: Model, id: string): TxOp {
  const values: Record<string, unknown> = {
    name: `column-${id}-${intBetween(rng, 0, 999)}`,
    order: intBetween(rng, 0, 20),
  };
  const board = maybe(rng, 0.7, pick(rng, [...model.boards]));
  if (board !== null) values.boardId = board;
  return { op: "update", namespace: "kanbanColumns", id, values };
}

function taskInsert(rng: () => number, model: Model, id: string): TxOp {
  const values: Record<string, unknown> = {
    title: `task-${id}-${intBetween(rng, 0, 999)}`,
    order: intBetween(rng, 0, 50),
  };
  const column = maybe(rng, 0.7, pick(rng, [...model.columns]));
  if (column !== null) values.columnId = column;
  const tags = maybe(rng, 0.3, [`tag-${intBetween(rng, 0, 9)}`]);
  if (tags !== null) values.tags = tags;
  return { op: "update", namespace: "kanbanTasks", id, values };
}

function favoriteInsert(rng: () => number, model: Model, id: string): TxOp {
  return {
    op: "update",
    namespace: "favorites",
    id,
    values: {
      type: pick(rng, ["document", "task", "folder"]),
      targetId: pick(rng, [
        ...model.documents,
        ...model.tasks,
        ...model.folders,
      ]),
      order: intBetween(rng, 0, 20),
    },
  };
}

/** One deterministic op; `model` is updated as ops are produced. */
function randomOp(rng: () => number, model: Model, index: number): TxOp {
  const forced = index % 10;
  const kind = rng() < 0.45 ? forced : Math.floor(rng() * 10);

  switch (kind) {
    case 0: {
      const id = pick(rng, FOLDER_IDS);
      const existed = model.folders.has(id);
      model.folders.add(id);
      return existed && rng() < 0.4
        ? {
            op: "merge",
            namespace: "folders",
            id,
            values: { color: pick(rng, ["red", "green", "blue"]) },
          }
        : folderInsert(rng, model, id);
    }
    case 1: {
      const id = pick(rng, DOCUMENT_IDS);
      const existed = model.documents.has(id);
      model.documents.add(id);
      return existed && rng() < 0.4
        ? {
            op: "merge",
            namespace: "documents",
            id,
            values: { title: `merged-${intBetween(rng, 0, 99)}` },
          }
        : documentInsert(rng, model, id);
    }
    case 2: {
      const id = pick(rng, BLOCK_IDS);
      const existed = model.blocks.has(id);
      model.blocks.add(id);
      return existed && rng() < 0.4
        ? {
            op: "merge",
            namespace: "blocks",
            id,
            values: { content: `merged-block-${intBetween(rng, 0, 99)}` },
          }
        : blockInsert(rng, model, id);
    }
    case 3: {
      const id = pick(rng, BOARD_IDS);
      const existed = model.boards.has(id);
      model.boards.add(id);
      return existed && rng() < 0.4
        ? {
            op: "merge",
            namespace: "kanbanBoards",
            id,
            values: { description: `board-${intBetween(rng, 0, 99)}` },
          }
        : boardInsert(rng, id);
    }
    case 4: {
      const id = pick(rng, COLUMN_IDS);
      const existed = model.columns.has(id);
      model.columns.add(id);
      return existed && rng() < 0.4
        ? {
            op: "merge",
            namespace: "kanbanColumns",
            id,
            values: { limit: intBetween(rng, 1, 9) },
          }
        : columnInsert(rng, model, id);
    }
    case 5: {
      const id = pick(rng, TASK_IDS);
      const existed = model.tasks.has(id);
      model.tasks.add(id);
      return existed && rng() < 0.4
        ? {
            op: "merge",
            namespace: "kanbanTasks",
            id,
            values: { priority: pick(rng, ["low", "medium", "high"]) },
          }
        : taskInsert(rng, model, id);
    }
    case 6: {
      const id = pick(rng, FAVORITE_IDS);
      const existed = model.favorites.has(id);
      model.favorites.add(id);
      return existed && rng() < 0.4
        ? {
            op: "merge",
            namespace: "favorites",
            id,
            values: { order: intBetween(rng, 0, 50) },
          }
        : favoriteInsert(rng, model, id);
    }
    case 7: {
      // Link a block to a document when possible, otherwise a document to a
      // folder. Both directions are exercised across seeds.
      if (model.blocks.size > 0 && rng() < 0.4) {
        return {
          op: "link",
          namespace: "documents",
          id: pick(rng, [...model.documents]),
          link: "documentBlocks",
          targetId: pick(rng, [...model.blocks]),
        };
      }
      return {
        op: "link",
        namespace: "folders",
        id: pick(rng, [...model.folders]),
        link: "folderDocuments",
        targetId: pick(rng, [...model.documents]),
      };
    }
    case 8: {
      if (model.blocks.size > 0 && rng() < 0.4) {
        return {
          op: "unlink",
          namespace: "blocks",
          id: pick(rng, [...model.blocks]),
          link: "documentBlocks",
          targetId: pick(rng, [...model.documents]),
        };
      }
      return {
        op: "unlink",
        namespace: "documents",
        id: pick(rng, [...model.documents]),
        link: "folderDocuments",
        targetId: pick(rng, [...model.folders]),
      };
    }
    default: {
      if (model.favorites.size > 0 && rng() < 0.6) {
        const id = pick(rng, [...model.favorites]);
        model.favorites.delete(id);
        return { op: "delete", namespace: "favorites", id };
      }
      if (model.blocks.size > 0) {
        const id = pick(rng, [...model.blocks]);
        model.blocks.delete(id);
        return { op: "delete", namespace: "blocks", id };
      }
      if (model.favorites.size === 0) {
        // Deletes can exhaust both pools; recreate a favorite instead of
        // emitting an invalid delete.
        model.favorites.add("fav0");
        return favoriteInsert(rng, model, "fav0");
      }
      const id = pick(rng, [...model.favorites]);
      model.favorites.delete(id);
      return { op: "delete", namespace: "favorites", id };
    }
  }
}

interface GeneratedStream {
  envelopes: TxEnvelope[];
  midpoint: number;
  model: Model;
}

function generateStream(seed: number): GeneratedStream {
  const rng = mulberry32(seed * 2_654_435_761 + 1);
  const model = seedModel();
  const envelopes: TxEnvelope[] = [{ txId: `seed-${seed}`, ops: seedOps() }];

  const transactionCount = intBetween(rng, 12, 21);
  for (let txIndex = 1; txIndex < transactionCount; txIndex += 1) {
    const working = cloneModel(model);
    const ops: TxOp[] = [];
    const opCount = intBetween(rng, 1, 4);

    for (let opIndex = 0; opIndex < opCount; opIndex += 1) {
      ops.push(randomOp(rng, working, txIndex + opIndex));
    }

    // Commit the working copy only after every op was generated; ops that
    // throw are a test failure, not something to paper over.
    model.folders = working.folders;
    model.documents = working.documents;
    model.blocks = working.blocks;
    model.boards = working.boards;
    model.columns = working.columns;
    model.tasks = working.tasks;
    model.favorites = working.favorites;

    envelopes.push({ txId: `seed-${seed}-tx-${txIndex}`, ops });
  }

  const midpoint = intBetween(rng, 2, envelopes.length - 1);
  return { envelopes, midpoint, model };
}

function entityRows(db: Database): Record<string, Record<string, unknown>[]> {
  const result: Record<string, Record<string, unknown>[]> = {};

  for (const table of [...namespaceTables(), "_files"]) {
    result[table] = db
      .query(`SELECT * FROM "${table}" ORDER BY "id"`)
      .all() as Record<string, unknown>[];
  }

  return result;
}

function scalar(db: Database, query: string): unknown {
  const row = db.query(query).get() as Record<string, unknown> | null;
  return row === null ? undefined : Object.values(row)[0];
}

async function expectRecovered(
  seed: number,
  generated: GeneratedStream
): Promise<void> {
  const source = createStore();
  const bucket = new FakeR2Bucket();

  run(source, generated.envelopes[0]!);
  for (let index = 1; index < generated.midpoint; index += 1) {
    run(source, generated.envelopes[index]!);
  }

  const flushedBefore = await flushPending(
    bucket,
    source.sql,
    TEST_WORKSPACE,
    1_000_000 + seed
  );
  expect(flushedBefore.flushed).toBe(true);

  const snapshotted = await snapshotWorkspace(
    bucket,
    source.sql,
    TEST_WORKSPACE,
    1_000_100 + seed
  );
  expect(snapshotted.snapshotted).toBe(true);
  expect(snapshotted.baseSeq).toBe(generated.midpoint);

  for (
    let index = generated.midpoint;
    index < generated.envelopes.length;
    index += 1
  ) {
    run(source, generated.envelopes[index]!);
  }

  const flushedAfter = await flushPending(
    bucket,
    source.sql,
    TEST_WORKSPACE,
    1_000_200 + seed
  );
  expect(flushedAfter.flushed).toBe(true);

  const target = createStore();
  const result = await recoverWorkspace(
    bucket as unknown as R2Bucket,
    recoveryExecutor(target.db, target.sql),
    TEST_WORKSPACE,
    { now: 1_000_300 + seed }
  );

  expect(result).toMatchObject({
    recovered: true,
    baseSeq: generated.midpoint,
    logSeq: generated.envelopes.length,
  });
  expect(result.recovered ? result.replayed : 0).toBe(
    generated.envelopes.length - generated.midpoint
  );

  expect(entityRows(target.db)).toEqual(entityRows(source.db));

  expect(target.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(scalar(target.db, `SELECT high_water_seq FROM "_tx_state"`)).toBe(
    generated.envelopes.length
  );
  expect(scalar(target.db, `SELECT last_seq FROM "_flush_state"`)).toBe(
    generated.envelopes.length
  );
  expect(scalar(target.db, `SELECT base_seq FROM "_snapshot_state"`)).toBe(
    generated.midpoint
  );
  expect(
    target.db
      .query(`SELECT value FROM "_engine_meta" WHERE "key" = 'recovery_status'`)
      .get()
  ).toEqual({ value: "complete" });
}

describe("recovery property drill", () => {
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    test(`seed ${seed} rebuilds the exact source state`, async () => {
      const generated = generateStream(seed);
      await expectRecovered(seed, generated);
    });
  }
});
