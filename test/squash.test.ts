/**
 * `tapedb migrate squash`: fold a run of migrations into the first one.
 *
 * The tests apply the squashed run to a real SQLite database and compare it with
 * one built from the original run, because the point of the fold is that a
 * deployment ends up in the same shape either way.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { migrateCheck, migrateDev, readMigrations } from "../src/cli/migrate";
import { migrateSquash } from "../src/cli/squash";
import { applyMigrationWithoutCascades } from "../src/engine/migrations";
import { model, schema, t } from "../src/schema";

const dirs: string[] = [];
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "tapedb-squash-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function apply(db: Database, migration: { id: string; sql: string }): Promise<void> {
  await applyMigrationWithoutCascades(
    {
      run: (statements) => db.exec(statements),
      all: (query) => db.query(query).all() as Array<Record<string, unknown>>,
      transaction: (fn) => db.transaction(fn)(),
      settle: async () => {},
    },
    { id: migration.id, sql: migration.sql },
    () => {}
  );
}

const task = (extra: Record<string, unknown> = {}) =>
  model({ title: t.string(), ...extra } as never);

const v1 = schema({ task: task() });
const v2 = schema({ task: task({ done: t.boolean().default(false) }) });
const v3 = schema({ task: task({ done: t.boolean().default(false), dueAt: t.date().optional() }) });
const v4 = schema({
  task: task({ done: t.boolean().default(false), dueAt: t.date().optional() }),
  tag: model({ name: t.string() }),
});

/** Four migrations: the initial one, then three small ones. */
function fourMigrations(root: string): void {
  migrateDev(root, v1, "init");
  migrateDev(root, v2, "add_done");
  migrateDev(root, v3, "add_due_at");
  migrateDev(root, v4, "add_tag");
}

function columns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
    .map((row) => row.name)
    .sort();
}

test("a run folds into its first migration and the schema still matches", async () => {
  const root = project();
  fourMigrations(root);
  const before = readMigrations(root);
  expect(before.map((m) => m.id.slice(0, 4))).toEqual(["0002", "0003", "0004", "0005"]);

  const original = new Database(":memory:");
  for (const migration of before) await apply(original, migration);

  const result = migrateSquash(root, { since: "0003" });
  expect(result.status).toBe("squashed");
  if (result.status !== "squashed") return;

  expect(result.into.startsWith("0003")).toBe(true);
  expect(result.folded).toHaveLength(3);
  expect(result.removed).toHaveLength(2);

  const after = readMigrations(root);
  expect(after.map((m) => m.id.slice(0, 4))).toEqual(["0002", "0003"]);

  // The kept id now carries the net change of all three.
  const squashedSql = readFileSync(join(root, "tapedb", "migrations", `${result.into}.sql`), "utf8");
  expect(squashedSql).toContain('ADD COLUMN "done"');
  expect(squashedSql).toContain('ADD COLUMN "due_at"');
  expect(squashedSql).toContain('CREATE TABLE IF NOT EXISTS "tag"');

  // A database built from the fold is the same shape as one built from the run.
  const folded = new Database(":memory:");
  for (const migration of after) await apply(folded, migration);
  expect(columns(folded, "task")).toEqual(columns(original, "task"));
  expect(columns(folded, "tag")).toEqual(columns(original, "tag"));

  const check = migrateCheck(root, v4);
  expect(check.ok).toBe(true);

  // Removed files and their history are gone, so nothing refers to them.
  for (const id of result.removed) {
    expect(existsSync(join(root, "tapedb", "migrations", `${id}.sql`))).toBe(false);
    expect(existsSync(join(root, "tapedb", "snapshots", `${id}.json`))).toBe(false);
  }
});

test("a database that already applied the run stays consistent", async () => {
  const root = project();
  fourMigrations(root);
  const before = readMigrations(root);

  // A development database that ran the whole run, as it was.
  const dev = new Database(":memory:");
  for (const migration of before) await apply(dev, migration);

  const result = migrateSquash(root, { since: "0003" });
  expect(result.status).toBe("squashed");
  if (result.status !== "squashed") return;

  // The id it already applied is unchanged, which is why nothing re-runs: the
  // kept migration took the whole net change and kept its name.
  expect(before.map((m) => m.id)).toContain(result.into);
  expect(readMigrations(root).map((m) => m.id)).toContain(result.into);
  expect(columns(dev, "task")).toContain("due_at");
  expect(columns(dev, "tag")).toContain("name");
});

test("a run with a statement that touched rows is refused", () => {
  const root = project();
  fourMigrations(root);
  const target = join(root, "tapedb", "migrations", "0004_add_due_at.sql");
  writeFileSync(target, `${readFileSync(target, "utf8")}UPDATE "task" SET "title" = 'backfilled';\n`);

  const result = migrateSquash(root, { since: "0003" });
  expect(result.status).toBe("refused");
  if (result.status !== "refused") return;
  expect(result.reasons.join("\n")).toContain("UPDATE");
  expect(result.reasons.join("\n")).toContain("0004_add_due_at");
});

test("it refuses without a boundary, and when the run is one migration", () => {
  const root = project();
  fourMigrations(root);

  const unbounded = migrateSquash(root, {});
  expect(unbounded.status).toBe("refused");

  const missing = migrateSquash(root, { since: "0099" });
  expect(missing.status).toBe("refused");

  const single = migrateSquash(root, { since: "0005" });
  expect(single.status).toBe("refused");
  if (single.status === "refused") expect(single.reasons[0]).toContain("folding one changes nothing");
});

test("a run that cancels out is removed rather than left empty", () => {
  const root = project();
  migrateDev(root, v1, "init");
  migrateDev(root, v2, "add_done");
  migrateDev(root, v1, "drop_done_again", { acceptDataLoss: true });

  const result = migrateSquash(root, { since: "0003" });
  expect(result.status).toBe("cancelled");
  // 0002 stays: it is the schema creation the run started from.
  expect(readMigrations(root).map((m) => m.id.slice(0, 4))).toEqual(["0002"]);
  expect(migrateCheck(root, v1).ok).toBe(true);
});

test("--dry-run reports the fold and writes nothing", () => {
  const root = project();
  fourMigrations(root);
  const before = readMigrations(root);

  const dry = migrateSquash(root, { since: "0004", dryRun: true });
  expect(dry.status).toBe("would-squash");
  expect(readMigrations(root)).toEqual(before);

  const real = migrateSquash(root, { since: "0003" });
  expect(real.status).toBe("squashed");
  if (real.status !== "squashed") return;
  expect(real.folded).toHaveLength(3);
  expect(readMigrations(root)).toHaveLength(2);
  expect(migrateCheck(root, v4).ok).toBe(true);
});
