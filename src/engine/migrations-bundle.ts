/**
 * Workspace migrations, in two tracks.
 *
 * The engine track belongs to tapedb: `0001_baseline` (its bookkeeping tables,
 * frozen because deployed workspaces hold its checksum) and every
 * `tapedb_NNNN_*` migration after it. The app track belongs to the deployment:
 * its `NNNN_*` migrations, generated from its schema. Engine migrations run
 * first, so app SQL can rely on the engine's tables as they are now.
 *
 * The configured list is mutated in place by `configureMigrations()` so
 * `migrations.ts` can keep its default-argument shape.
 */

import type { SchemaChange } from "./schema-evolution";

export interface BundledWorkspaceMigration {
  id: string;
  sql: string;
  /**
   * What this migration changed, for reading data written before it. Not part
   * of the checksum: only the SQL changes a workspace.
   */
  changes?: SchemaChange[];
}

export const BASELINE_MIGRATION_ID = "0001_baseline";
export const ENGINE_MIGRATION_PREFIX = "tapedb_";

/** Engine schema changes after the baseline, oldest first. Never edit one; add the next. */
export const ENGINE_MIGRATIONS: readonly BundledWorkspaceMigration[] = [
  {
    id: "tapedb_0002_files_table",
    sql: 'ALTER TABLE "$files" RENAME TO "_files";',
  },
  {
    id: "tapedb_0003_tx_receipts",
    sql: `CREATE TABLE "_tx_receipts" (
      id TEXT PRIMARY KEY NOT NULL,
      seq INTEGER NOT NULL,
      ops_hash TEXT NOT NULL
    );
    INSERT INTO "_tx_receipts" (id, seq, ops_hash)
      SELECT client_tx_id, seq, ops_hash FROM "_tx_log" WHERE client_tx_id IS NOT NULL;`,
  },
  {
    // Receipts expire with the history retention, so each records when its
    // write was applied. Existing ones take their log row's time, or now.
    id: "tapedb_0004_receipt_time",
    sql: `ALTER TABLE "_tx_receipts" ADD COLUMN at INTEGER NOT NULL DEFAULT 0;
    UPDATE "_tx_receipts" SET at = COALESCE(
      (SELECT l.at FROM "_tx_log" l WHERE l.seq = "_tx_receipts".seq),
      CAST(strftime('%s', 'now') AS INTEGER) * 1000
    );`,
  },
  {
    // A log entry larger than a row holds keeps its ops in parts: part 0 in
    // _tx_log.ops, the rest here (see tx-log.ts).
    id: "tapedb_0005_log_parts",
    sql: `CREATE TABLE "_tx_log_parts" (
      seq INTEGER NOT NULL,
      part INTEGER NOT NULL,
      ops TEXT NOT NULL,
      PRIMARY KEY (seq, part)
    ) WITHOUT ROWID;`,
  },
  {
    // Who uploaded a file: the claim subject, for file access rules.
    id: "tapedb_0006_file_uploader",
    sql: `ALTER TABLE "_files" ADD COLUMN uploaded_by TEXT;`,
  },
  {
    // Socket state past the attachment's 16 KiB, and messages arriving in
    // parts (see socket-state.ts). Ephemeral: never logged or snapshotted.
    id: "tapedb_0007_socket_state",
    sql: `CREATE TABLE "_socket_state" (
      client_id TEXT NOT NULL,
      part INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (client_id, part)
    ) WITHOUT ROWID;
    CREATE TABLE "_socket_parts" (
      client_id TEXT NOT NULL,
      id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (client_id, id, idx)
    ) WITHOUT ROWID;`,
  },
  {
    // Old engines may have deleted receipts. Preserve known keys and set a
    // fixed safety boundary for unknown pre-upgrade requests in used rooms.
    id: "tapedb_0008_permanent_receipts",
    sql: `ALTER TABLE "_tx_receipts" RENAME TO "_tx_receipts_old";
    CREATE TABLE "_tx_receipts" (
      id TEXT PRIMARY KEY NOT NULL,
      seq INTEGER NOT NULL,
      ops_hash TEXT,
      at INTEGER NOT NULL
    );
    INSERT INTO "_tx_receipts" SELECT id, seq, ops_hash, at FROM "_tx_receipts_old";
    DROP TABLE "_tx_receipts_old";
    CREATE INDEX "_tx_receipts_hash_age" ON "_tx_receipts" (at) WHERE ops_hash IS NOT NULL;
    INSERT OR REPLACE INTO "_engine_meta" ("key", value)
      SELECT 'receipts_since', CAST(MAX(
        COALESCE((SELECT CAST(value AS INTEGER) FROM "_engine_meta" WHERE "key" = 'receipts_since'), 0),
        CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
      ) AS TEXT) WHERE EXISTS (SELECT 1 FROM "_tx_state" WHERE high_water_seq > 0);`,
  },
  {
    // Recent topic messages, for clients rejoining after a reconnect.
    // Ephemeral like the sockets: never logged, snapshotted or exported.
    id: "tapedb_0009_topic_buffer",
    sql: `CREATE TABLE "_topic_buffer" (
      topic TEXT NOT NULL,
      seq INTEGER NOT NULL,
      at INTEGER NOT NULL,
      frame TEXT NOT NULL,
      PRIMARY KEY (topic, seq)
    ) WITHOUT ROWID;
    CREATE TABLE "_topic_seq" (
      topic TEXT PRIMARY KEY NOT NULL,
      seq INTEGER NOT NULL
    ) WITHOUT ROWID;`,
  },
];

/** Configured migrations, applied in order on Durable Object boot. */
export const WORKSPACE_MIGRATIONS: BundledWorkspaceMigration[] = [];

export function isEngineMigration(id: string): boolean {
  return id === BASELINE_MIGRATION_ID || id.startsWith(ENGINE_MIGRATION_PREFIX);
}

/**
 * Installs the deployment's migrations. Engine migrations are always the
 * package's own: a deployment bundle that carries copies of them (as one
 * generated by an older tapedb does) is normalised, so the engine track can
 * grow without regenerating every app's bundle.
 */
export function configureMigrations(
  migrations: readonly BundledWorkspaceMigration[]
): void {
  const baseline = migrations.find((migration) => migration.id === BASELINE_MIGRATION_ID);
  if (!baseline) {
    throw new Error(`Migrations must include ${BASELINE_MIGRATION_ID}.`);
  }
  const app = migrations.filter((migration) => !isEngineMigration(migration.id));

  WORKSPACE_MIGRATIONS.length = 0;
  WORKSPACE_MIGRATIONS.push(baseline, ...ENGINE_MIGRATIONS, ...app);
}
