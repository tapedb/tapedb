/**
 * `tapedb migrate squash`: fold a run of migrations into the first one.
 *
 * Working in small migrations is useful; shipping twenty of them to a deployment
 * is noise. The fold re-derives the SQL from the snapshots at each end of the
 * run rather than concatenating the files, so the result is the net change.
 *
 * That has one consequence worth stating plainly: a statement that touched rows
 * (an UPDATE, a backfill, an INSERT) has no place in a re-derived DDL diff, so a
 * run that contains one is refused instead of being silently dropped.
 *
 * The first migration of the run keeps its id and its place, because a
 * development database has already applied that id. Everything after it in the
 * run disappears, which leaves such a database consistent: its applied ids that
 * no longer exist are ignored, and the id it did apply now carries the whole
 * net change.
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CHANGES_PREFIX,
  diffSnapshots,
  expandRebuilds,
  migrationsDir,
  readHistory,
  readMigrations,
  readSnapshot,
  renderBundle,
  type MigrationFile,
  type SchemaSnapshot,
} from "./migrate";

const EMPTY: SchemaSnapshot = { version: 1, models: {} };

const DDL = /^(CREATE|ALTER|DROP)\b/i;

/**
 * A rebuilt table copies its own rows: the generated migration creates
 * `<table>__rebuild`, inserts a selection of the old rows into it, drops the
 * original and renames. Those inserts are part of a schema change, not a
 * backfill, so they fold like the DDL around them. Anything writing to a real
 * table is data work and cannot be re-derived.
 */
function isRebuildCopy(statement: string): boolean {
  return /^INSERT\s+INTO\s+"[A-Za-z0-9_]+__rebuild"/i.test(statement);
}

export interface SquashOptions {
  /** The first migration to fold, by id or by its number. Everything from it to the end is folded. */
  since?: string;
  /** Rename the folded migration, since the run it replaces may have had no name worth keeping. */
  name?: string;
  acceptDataLoss?: boolean;
  dryRun?: boolean;
}

export type SquashResult =
  | { status: "squashed"; into: string; folded: string[]; statements: number; removed: string[] }
  | { status: "would-squash"; into: string; folded: string[]; statements: number }
  | { status: "cancelled"; folded: string[] }
  | { status: "refused"; reasons: string[] };

function slugOf(name: string): string {
  const value = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (value === "") throw new Error(`Migration name "${name}" has no letters or digits.`);
  return value;
}

function statementsOf(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function historyPath(root: string, id: string): string {
  return join(root, "tapedb", "snapshots", `${id}.json`);
}

function writeHistory(root: string, id: string, snapshot: SchemaSnapshot): void {
  writeFileSync(historyPath(root, id), `${JSON.stringify(snapshot, null, 2)}\n`);
}

function removeHistory(root: string, id: string): void {
  rmSync(historyPath(root, id), { force: true });
}

export function migrateSquash(root: string, options: SquashOptions): SquashResult {
  const migrations = readMigrations(root);
  if (migrations.length < 2) {
    return { status: "refused", reasons: ["There are fewer than two migrations; nothing to fold."] };
  }

  let start: number;
  if (options.since !== undefined) {
    start = migrations.findIndex(
      (migration) => migration.id === options.since || migration.id.startsWith(`${options.since}`)
    );
    if (start === -1) {
      return {
        status: "refused",
        reasons: [`No migration "${options.since}". Known: ${migrations.map((m) => m.id).join(", ")}.`],
      };
    }
  } else {
    return {
      status: "refused",
      reasons: ["Say which run to fold: --since <id> is the first migration of the run, and everything after it folds with it."],
    };
  }

  const folded = migrations.slice(start);
  if (folded.length < 2) {
    return { status: "refused", reasons: [`That run is ${folded.length} migration; folding one changes nothing.`] };
  }

  // A migrated statement with no schema effect cannot be re-derived from the
  // snapshots, so it would vanish. Refuse instead.
  const dataStatements: string[] = [];
  for (const migration of folded) {
    for (const statement of statementsOf(migration.sql)) {
      if (!DDL.test(statement) && !isRebuildCopy(statement)) {
        dataStatements.push(`${migration.id}: ${statement.split("\n")[0]}`);
      }
    }
  }
  if (dataStatements.length > 0) {
    return {
      status: "refused",
      reasons: [
        "These statements are not schema changes, so a re-derived fold would lose them:",
        ...dataStatements,
      ],
    };
  }

  const before = start === 0 ? EMPTY : readHistory(root, migrations[start - 1]!.id);
  if (before === null) {
    return {
      status: "refused",
      reasons: [`No snapshot for ${migrations[start - 1]!.id}, so there is no record of the schema the run started from.`],
    };
  }

  const after = readHistory(root, folded.at(-1)!.id) ?? readSnapshot(root);
  if (after === null) {
    return {
      status: "refused",
      reasons: [`No snapshot for ${folded.at(-1)!.id} and no tapedb/schema.snapshot.json.`],
    };
  }

  const plan = diffSnapshots(before, after, { acceptDataLoss: options.acceptDataLoss === true });
  if (plan.refused.length > 0) return { status: "refused", reasons: plan.refused };
  // A net change that adds a constraint or changes a type cannot be done in
  // place, so the fold has to emit the same rebuild migrate dev would.
  expandRebuilds(plan, after);

  const renamed = options.name === undefined ? null : `${folded[0]!.id.slice(0, 4)}_${slugOf(options.name)}`;
  const into = renamed ?? folded[0]!.id;

  // A run that adds a column and later drops it has no net change, so there is
  // nothing to apply. Keeping an empty migration would only carry the noise
  // forward, so the files go instead and no database is affected.
  if (plan.statements.length === 0 && plan.changes.length === 0) {
    if (options.dryRun === true) return { status: "cancelled", folded: folded.map((m) => m.id) };
    for (const migration of folded) {
      rmSync(join(migrationsDir(root), `${migration.id}.sql`), { force: true });
      removeHistory(root, migration.id);
    }
    writeFileSync(join(root, "tapedb", "migrations.gen.ts"), renderBundle(migrations.slice(0, start)));
    return { status: "cancelled", folded: folded.map((m) => m.id) };
  }

  if (options.dryRun === true) {
    return { status: "would-squash", into, folded: folded.map((m) => m.id), statements: plan.statements.length };
  }

  const header = plan.changes.length > 0 ? `${CHANGES_PREFIX}${JSON.stringify(plan.changes)}\n` : "";
  const squashed: MigrationFile = {
    id: into,
    sql: `${header}${plan.statements.join("\n")}\n`,
    changes: plan.changes,
  };

  const removed = folded.slice(1).map((migration) => migration.id);
  if (renamed !== null && renamed !== folded[0]!.id) {
    rmSync(join(migrationsDir(root), `${folded[0]!.id}.sql`), { force: true });
    removeHistory(root, folded[0]!.id);
  }
  writeFileSync(join(migrationsDir(root), `${into}.sql`), squashed.sql);
  writeHistory(root, into, after);
  for (const id of removed) {
    rmSync(join(migrationsDir(root), `${id}.sql`), { force: true });
    removeHistory(root, id);
  }
  writeFileSync(join(root, "tapedb", "migrations.gen.ts"), renderBundle([...migrations.slice(0, start), squashed]));

  return { status: "squashed", into, folded: folded.map((m) => m.id), statements: plan.statements.length, removed };
}
