import { BASELINE_MIGRATION_ID, isEngineMigration } from "./migrations-bundle";
import {
  WORKSPACE_MIGRATIONS,
  type BundledWorkspaceMigration,
} from "./migrations-bundle";

export const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "_migrations" (
  id TEXT PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)
`;

export interface AppliedMigration {
  id: string;
  checksum: string;
}

export function migrationIds(
  migrations: ReadonlyArray<BundledWorkspaceMigration> = WORKSPACE_MIGRATIONS
): string[] {
  return migrations.map((migration) => migration.id);
}

export function pendingMigrations(
  applied: ReadonlySet<string>,
  migrations: ReadonlyArray<BundledWorkspaceMigration> = WORKSPACE_MIGRATIONS
): BundledWorkspaceMigration[] {
  return migrations.filter((migration) => !applied.has(migration.id));
}

export function assertMigrationOrder(
  migrations: ReadonlyArray<BundledWorkspaceMigration> = WORKSPACE_MIGRATIONS
): void {
  if (migrations.length === 0) {
    throw new Error("No workspace migrations are bundled.");
  }

  if (migrations[0].id !== BASELINE_MIGRATION_ID) {
    throw new Error(`The first workspace migration must be ${BASELINE_MIGRATION_ID}.`);
  }

  // Each track is sorted on its own; the engine track comes first.
  const seen = new Set<string>();
  const previous = { engine: "", app: "" };
  let appStarted = false;
  for (const migration of migrations) {
    if (!/^(tapedb_)?\d{4}_[a-z0-9_]+$/.test(migration.id)) {
      throw new Error(`Invalid workspace migration id "${migration.id}".`);
    }
    if (seen.has(migration.id)) {
      throw new Error(`Duplicate workspace migration id "${migration.id}".`);
    }
    const track = isEngineMigration(migration.id) ? "engine" : "app";
    if (track === "engine" && appStarted) {
      throw new Error(`Engine migration "${migration.id}" must come before app migrations.`);
    }
    if (track === "app") appStarted = true;
    if (previous[track] && migration.id <= previous[track]) {
      throw new Error(
        `Workspace migrations must be sorted; "${migration.id}" follows "${previous[track]}".`
      );
    }
    seen.add(migration.id);
    previous[track] = migration.id;
  }
}

export function latestMigrationId(
  migrations: ReadonlyArray<BundledWorkspaceMigration> = WORKSPACE_MIGRATIONS
): string | null {
  return migrations.length > 0 ? migrations[migrations.length - 1].id : null;
}

export async function migrationChecksum(sql: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(sql)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * What applying a migration needs from the database it runs on. `settle`
 * resolves once no transaction is open: SQLite ignores a foreign-key pragma
 * inside one, and a Durable Object holds an implicit one after any write
 * until its writes are synced.
 */
export interface MigrationHost {
  /** Runs one or more statements. */
  run(statements: string): void;
  /** Runs one statement and returns its rows. */
  all(query: string): Array<Record<string, unknown>>;
  transaction(fn: () => void): void;
  settle(): Promise<void>;
}

function foreignKeysOn(host: MigrationHost): boolean {
  return Number(host.all("PRAGMA foreign_keys")[0]?.foreign_keys) === 1;
}

/**
 * Applies one migration the way SQLite documents for schema changes: foreign
 * keys off around the transaction, `foreign_key_check` before it commits,
 * foreign keys back on after.
 *
 * Off is what lets a migration rebuild a table other tables reference. With
 * foreign keys on, dropping the old copy of the table would run every
 * child's ON DELETE action, cascading deletes into child rows or nulling
 * their keys, before the rebuilt table took its place. The check is what
 * keeps that safe: a migration that would leave a row pointing at nothing
 * rolls back, and the object refuses to boot rather than serve it.
 *
 * Throws, without serving with enforcement off, if foreign keys cannot be
 * switched back on.
 */
export async function applyMigrationWithoutCascades(
  host: MigrationHost,
  migration: BundledWorkspaceMigration,
  record: () => void
): Promise<void> {
  await host.settle();
  host.run("PRAGMA foreign_keys = OFF");
  if (foreignKeysOn(host)) {
    throw new Error(
      `Workspace migration ${migration.id} was not applied: foreign keys could not be switched off around it, so a table rebuild could cascade.`
    );
  }

  try {
    host.transaction(() => {
      host.run(migration.sql);
      record();
      const violations = host.all("PRAGMA foreign_key_check");
      if (violations.length > 0) {
        const first = violations[0];
        throw new Error(
          `Workspace migration ${migration.id} was not applied: it leaves ${violations.length} row(s) pointing at rows that do not exist (first: "${String(first.table)}" row ${String(first.rowid)} -> "${String(first.parent)}").`
        );
      }
    });
  } finally {
    await host.settle();
    host.run("PRAGMA foreign_keys = ON");
  }

  if (!foreignKeysOn(host)) {
    throw new Error("Foreign keys could not be switched back on after a migration; refusing to serve without them.");
  }
}
