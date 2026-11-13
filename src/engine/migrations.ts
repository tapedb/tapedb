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
