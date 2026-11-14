/**
 * Gate for phase 3: recovery across a schema change.
 *
 * A workspace is written under schema v1, snapshotted, written again, then
 * migrated: one field dropped, one renamed, one required field added with a
 * default. Its Durable Object is lost. Recovery must rebuild it under v2 from
 * a v1 snapshot and v1 log lines, without the workspace refusing to boot.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../../../src/claims";
import { flushPending } from "../../../src/engine/durability/flusher";
import { recoverWorkspace, type RecoverySqlExecutor } from "../../../src/engine/durability/recovery";
import { snapshotWorkspace } from "../../../src/engine/durability/snapshot";
import type { SqlValue } from "../../../src/engine/durability/sql";
import { configureMigrations, type BundledWorkspaceMigration } from "../../../src/engine/migrations-bundle";
import { configureRegistry } from "../../../src/engine/registry";
import { changesAfter } from "../../../src/engine/schema-evolution";
import { configurePermissions } from "../../../src/engine/tx-permissions";
import type { SqlRow, SqlExecutor as TxSql } from "../../../src/engine/tx-sql";
import { runTransaction } from "../../../src/engine/tx-pipeline";
import { model, schema, t } from "../../../src/schema";
import { createSqlExecutor, FakeR2Bucket, TEST_WORKSPACE } from "../../fixtures/test-support";

const NOW = 1_700_000_000_000;

const v1 = schema({
  task: model({ title: t.string(), legacy: t.string().optional(), oldName: t.string().optional() }),
});
const v2Models = schema({
  task: model({ title: t.string(), newName: t.string().optional(), priority: t.number().default(3) }),
});

const evolve: BundledWorkspaceMigration = {
  id: "0003_evolve",
  sql: [
    `ALTER TABLE "task" DROP COLUMN "legacy";`,
    `ALTER TABLE "task" RENAME COLUMN "old_name" TO "new_name";`,
    `ALTER TABLE "task" ADD COLUMN "priority" REAL DEFAULT 3;`,
  ].join("\n"),
  changes: [
    { kind: "dropField", model: "task", table: "task", field: "legacy", column: "legacy" },
    { kind: "renameField", model: "task", table: "task", from: "oldName", to: "newName", fromColumn: "old_name", toColumn: "new_name" },
  ],
};
const v2Bundle = [...v1.migrations, evolve];

function useSchema(registry: typeof v1, migrations: BundledWorkspaceMigration[]) {
  configureRegistry(registry.registry);
  configureMigrations(migrations);
  configurePermissions(registry.permissions);
}

function open(migrations: BundledWorkspaceMigration[]) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) db.exec(migration.sql);
  const tx: TxSql = {
    exec: (q: string, ...p: SqlValue[]) => db.query(q).run(...(p as never[])).changes,
    all: <T extends SqlRow = SqlRow>(q: string, ...p: SqlValue[]) => db.query(q).all(...(p as never[])) as T[],
    one: <T extends SqlRow = SqlRow>(q: string, ...p: SqlValue[]) =>
      (db.query(q).get(...(p as never[])) ?? undefined) as T | undefined,
    transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
  };
  const durable = createSqlExecutor(db);
  const recovery: RecoverySqlExecutor = {
    exec: (q, ...b) => durable.exec(q, ...b),
    transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
  };
  return { db, tx, durable, recovery };
}

const claim: RoleClaim = {
  sub: "u1",
  workspaceId: TEST_WORKSPACE,
  role: WORKSPACE_ROLE_LEVELS.OWNER,
  exp: Math.floor(Date.now() / 1000) + 600,
  iat: Math.floor(Date.now() / 1000),
};

async function writtenUnderV1(): Promise<FakeR2Bucket> {
  useSchema(v1, v1.migrations);
  const source = open([...v1.migrations]);
  const write = (ops: unknown[]) => runTransaction(source.tx, TEST_WORKSPACE, claim, { txId: crypto.randomUUID(), ops });

  write([{ op: "insert", namespace: "task", id: "a", values: { title: "A", legacy: "gone", oldName: "a-old" } }]);
  const bucket = new FakeR2Bucket();
  await flushPending(bucket, source.durable, TEST_WORKSPACE, NOW);
  await snapshotWorkspace(bucket, source.durable, TEST_WORKSPACE, NOW); // a is in the snapshot

  write([{ op: "insert", namespace: "task", id: "b", values: { title: "B", legacy: "gone too", oldName: "b-old" } }]);
  write([{ op: "patch", namespace: "task", id: "a", values: { oldName: "a-renamed", legacy: "still gone" } }]);
  await flushPending(bucket, source.durable, TEST_WORKSPACE, NOW + 10); // b and the patch are only in segments
  return bucket;
}

describe("recovery across a schema change", () => {
  test("a v1 snapshot and v1 log lines restore under v2", async () => {
    const bucket = await writtenUnderV1();

    useSchema(v2Models, v2Bundle);
    const target = open(v2Bundle);
    await recoverWorkspace(bucket as unknown as R2Bucket, target.recovery, TEST_WORKSPACE, { now: NOW + 20 });

    expect(target.db.query(`SELECT id, title, new_name, priority FROM "task" ORDER BY id`).all()).toEqual([
      { id: "a", title: "A", new_name: "a-renamed", priority: 3 },
      { id: "b", title: "B", new_name: "b-old", priority: 3 },
    ]);
  });

  test("without the declared changes, recovery fails closed", async () => {
    const bucket = await writtenUnderV1();

    // Same SQL, no declarations: the old column is unknown, so nothing guesses.
    useSchema(v2Models, [...v1.migrations, { id: evolve.id, sql: evolve.sql }]);
    const target = open(v2Bundle);
    await expect(
      recoverWorkspace(bucket as unknown as R2Bucket, target.recovery, TEST_WORKSPACE, { now: NOW + 20 })
    ).rejects.toThrow(/unknown column|Unknown attribute/);
  });

  test("a line written after the migration is read as it is", () => {
    useSchema(v2Models, v2Bundle);
    expect(changesAfter("0001_baseline")).toHaveLength(2);
    expect(changesAfter("0003_evolve")).toEqual([]);
  });
});
