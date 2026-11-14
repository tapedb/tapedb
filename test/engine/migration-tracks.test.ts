/**
 * Engine and app migrations run on separate tracks.
 *
 * Deployed workspaces hold the checksum of 0001_baseline and of their app
 * migrations, so neither may change. Engine schema changes therefore arrive as
 * tapedb_NNNN migrations, applied after the baseline and before app SQL. The
 * first one renames the file index from $files to _files.
 */

import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import {
  configureMigrations,
  ENGINE_MIGRATIONS,
  WORKSPACE_MIGRATIONS,
} from "../../src/engine/migrations-bundle";
import { assertMigrationOrder, migrationChecksum } from "../../src/engine/migrations";
import { configureRegistry } from "../../src/engine/registry";
import { configurePermissions } from "../../src/engine/tx-permissions";
import { defineSchema } from "../../src/schema";
import type { Env } from "../../src/types";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { WorkspaceRoom } = await import("../../src/engine/workspace-room");

const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";
const schema = defineSchema({ entities: { notes: { body: { type: "string" } } } });
const baseline = schema.migrations[0];
const entities = schema.migrations.at(-1)!;

function storage(db: Database) {
  return {
    exec(query: string, ...params: unknown[]) {
      const trimmed = query.trim();
      if (/^(select|with|pragma)\b/i.test(trimmed) && !/=/.test(trimmed.split("\n")[0].replace(/'[^']*'/g, ""))) {
        const rows = db.query(query).all(...(params as never[]));
        return { toArray: () => rows, one: () => rows[0], rowsWritten: 0 };
      }
      if (trimmed.split(";").filter((part) => part.trim()).length > 1) db.exec(query);
      else db.prepare(query).run(...(params as never[]));
      return { toArray: () => [], one: () => undefined, rowsWritten: 0 };
    },
  };
}

async function boot(db: Database): Promise<void> {
  let ready: Promise<unknown> = Promise.resolve();
  const context = {
    id: { name: WORKSPACE },
    storage: {
      sql: storage(db),
      transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
      getAlarm: async () => null,
      setAlarm: async () => undefined,
    },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => {
      ready = fn();
      return ready;
    },
  };
  new WorkspaceRoom(context as unknown as DurableObjectState, { DATA: {} } as unknown as Env);
  await ready;
}

describe("migration tracks", () => {
  test("a bundle from an older tapedb gets the engine track inserted after the baseline", () => {
    configureMigrations([baseline, entities]);
    expect(WORKSPACE_MIGRATIONS.map((migration) => migration.id)).toEqual([
      "0001_baseline",
      ...ENGINE_MIGRATIONS.map((migration) => migration.id),
      "0002_entities",
    ]);
    expect(() => assertMigrationOrder()).not.toThrow();
  });

  test("the baseline's text is frozen", async () => {
    // Deployed workspaces hold this checksum. If it changes they refuse to
    // boot, so a change here is a breaking change, never a refactor.
    expect(await migrationChecksum(baseline.sql)).toBe(FROZEN_BASELINE_CHECKSUM);
  });

  test("ordering is checked per track", () => {
    const app = (id: string) => ({ id, sql: "" });
    expect(() => assertMigrationOrder([baseline, ...ENGINE_MIGRATIONS, app("0002_a"), app("0003_b")])).not.toThrow();
    expect(() => assertMigrationOrder([baseline, app("0003_b"), app("0002_a")])).toThrow(/must be sorted/);
    expect(() => assertMigrationOrder([baseline, app("0002_a"), ...ENGINE_MIGRATIONS])).toThrow(/before app migrations/);
    expect(() => assertMigrationOrder([app("0002_a")])).toThrow(/first workspace migration/);
    expect(() => configureMigrations([entities])).toThrow(/must include 0001_baseline/);
  });

  test("an existing workspace boots: its checksums still match and its files move", async () => {
    // A workspace deployed before the engine track: baseline and entities
    // applied and recorded, one file indexed under the old table name.
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE "_migrations" (id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
    for (const migration of [baseline, entities]) {
      db.exec(migration.sql);
      db.prepare(`INSERT INTO "_migrations" VALUES (?, ?, 0)`).run(migration.id, await migrationChecksum(migration.sql));
    }
    db.prepare(`INSERT INTO "$files" (id, path, r2_key, size, created_at, updated_at) VALUES ('f1', 'a.png', 'k', 3, 1, 1)`).run();

    db.prepare(`INSERT INTO "_tx_log" (seq,client_tx_id,ops,ops_hash,at,schema_version) VALUES (1,'existing-client','[]','existing-hash',1,'0002_entities')`).run();
    configureRegistry(schema.registry);
    configurePermissions(schema.permissions);
    configureMigrations(schema.migrations);
    await boot(db);
    expect(db.query(`SELECT id,seq,ops_hash FROM "_tx_receipts"`).all()).toEqual([{id:"existing-client",seq:1,ops_hash:"existing-hash"}]);

    expect(db.query(`SELECT path FROM "_files"`).all()).toEqual([{ path: "a.png" }]);
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = '$files'`).all()).toEqual([]);
    expect((db.query(`SELECT id FROM "_migrations" ORDER BY id`).all() as Array<{ id: string }>).map((row) => row.id)).toEqual([
      "0001_baseline",
      "0002_entities",
      ...ENGINE_MIGRATIONS.map(migration => migration.id),
    ]);
  });
});

const FROZEN_BASELINE_CHECKSUM = "6d95657093cca842cd069ef267651b7b3baf1b0f2cbf32a97e6426bedfe0485e";
