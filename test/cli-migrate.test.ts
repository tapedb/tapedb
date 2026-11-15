/**
 * `tapedb migrate`: generated migrations take a live database, with its rows,
 * to exactly the shape a fresh database gets from the new schema.
 *
 * Every test applies the files the CLI wrote, in order, the way a Durable
 * Object does on wake, then compares column lists and indexes with a database
 * built from scratch. A diff that forgets a column, an index or a default
 * fails there, not in production.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { migrateCheck, migrateDev, migrateRollback, readMigrations } from "../src/cli/migrate";
import { run } from "../src/cli/index";
import { applyMigrationWithoutCascades, migrationChecksum } from "../src/engine/migrations";
import { model, schema, t } from "../src/schema";

const dirs: string[] = [];
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "tapedb-migrate-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Applies one migration with the runner a Durable Object uses. */
function apply(db: Database, migration: { id: string; sql: string }): Promise<void> {
  return applyMigrationWithoutCascades(
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

/** A database as a Durable Object has it: baseline, engine track, then each app migration in order. */
async function applied(root: string, base = schema({ x: model({ y: t.string() }) })): Promise<Database> {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of base.migrations.slice(0, -1)) db.exec(migration.sql);
  for (const migration of readMigrations(root)) await apply(db, migration);
  return db;
}

function fresh(definition: ReturnType<typeof schema>): Database {
  const db = new Database(":memory:");
  for (const migration of definition.migrations) db.exec(migration.sql);
  return db;
}

function shape(db: Database, table: string) {
  const columns = (db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string; dflt_value: unknown }>)
    .map(({ name, type, dflt_value }) => ({ name, type, dflt_value }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const indexes = (db.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`).all(table) as Array<{ name: string }>).map((row) => row.name);
  return { columns, indexes };
}

const v1 = schema({
  board: model({ name: t.string(), columns: t.hasMany("column") }),
  column: model({ name: t.string(), board: t.belongsTo("board", { onDelete: "cascade" }) }),
  note: model({ body: t.string(), score: t.number().optional() }),
});

describe("migrate dev", () => {
  test("the first migration is byte-identical to the SQL deployed workspaces hold", async () => {
    const root = project();
    const result = migrateDev(root, v1, "entities");
    expect(result).toMatchObject({ status: "created", id: "0002_entities" });

    // The count the CLI prints is of SQL statements, not of lines: a
    // CREATE TABLE spans many lines and is one statement.
    const written = readMigrations(root)[0].sql;
    const semicolons = written.split(";").filter((part) => part.trim()).length;
    expect(result.status === "created" ? result.statements : -1).toBe(semicolons);
    expect(written.split("\n").length).toBeGreaterThan(semicolons);

    const [first] = readMigrations(root);
    expect(await migrationChecksum(first.sql)).toBe(await migrationChecksum(v1.migrations.at(-1)!.sql));
    expect(migrateCheck(root, v1)).toEqual({ ok: true, problems: [] });
    expect(migrateDev(root, v1, "again")).toEqual({ status: "unchanged" });
  });

  test("added fields, indexes, defaults and models reach the fresh shape, keeping rows", async () => {
    const root = project();
    migrateDev(root, v1, "entities");
    const db = (await applied(root));
    db.exec(`INSERT INTO "board" (id, name, created_at, updated_at) VALUES ('b1', 'Board', 1, 1)`);

    const v2 = schema({
      board: model({
        name: t.string(),
        archived: t.boolean().default(false),
        slug: t.string().optional().unique(),
        columns: t.hasMany("column"),
      }),
      column: model({ name: t.string().index(), board: t.belongsTo("board", { onDelete: "cascade" }) }),
      note: model({ body: t.string(), score: t.number().optional() }),
      tag: model({ label: t.string() }),
    });
    expect(migrateDev(root, v2, "board flags")).toMatchObject({ status: "created", id: "0003_board_flags" });

    const migrated = (await applied(root));
    migrated.exec(`INSERT INTO "board" (id, name, created_at, updated_at) VALUES ('b1', 'Board', 1, 1)`);
    for (const table of ["board", "column", "note", "tag"]) {
      expect(shape(migrated, table)).toEqual(shape(fresh(v2), table));
    }
    expect(migrated.query(`SELECT archived FROM "board"`).get()).toEqual({ archived: 0 });
    expect(migrateCheck(root, v2).ok).toBe(true);
  });

  test("a required field with no default is refused", () => {
    const root = project();
    migrateDev(root, v1, "entities");
    const v2 = schema({ ...v1.models, note: model({ body: t.string(), score: t.number().optional(), owner: t.string() }) });
    const result = migrateDev(root, v2, "owner");
    expect(result.status).toBe("refused");
    expect(JSON.stringify(result)).toContain("required with no default");
    expect(readMigrations(root)).toHaveLength(1);
  });

  test("a drop needs --accept-data-loss, and is declared for recovery", async () => {
    const root = project();
    migrateDev(root, v1, "entities");
    const v2 = schema({ ...v1.models, note: model({ body: t.string() }) });

    expect(migrateDev(root, v2, "drop score").status).toBe("refused");
    expect(migrateDev(root, v2, "drop score", { acceptDataLoss: true })).toMatchObject({
      status: "created",
      changes: [{ kind: "dropField", model: "note", table: "note", field: "score", column: "score" }],
    });
    expect(readMigrations(root).at(-1)!.changes).toEqual([
      { kind: "dropField", model: "note", table: "note", field: "score", column: "score" },
    ]);
    expect(shape((await applied(root)), "note")).toEqual(shape(fresh(v2), "note"));
  });

  test("a rename keeps the values and is declared", async () => {
    const root = project();
    migrateDev(root, v1, "entities");
    const before = (await applied(root));
    const v2 = schema({ ...v1.models, note: model({ text: t.string(), score: t.number().optional() }) });

    // Without --rename this reads as a drop plus an add, which loses data.
    expect(migrateDev(root, v2, "rename").status).toBe("refused");
    const result = migrateDev(root, v2, "rename body", { renames: ["note.body=text"] });
    expect(result).toMatchObject({ status: "created", changes: [{ kind: "renameField", from: "body", to: "text" }] });

    before.exec(`INSERT INTO "note" (id, body, created_at, updated_at) VALUES ('n1', 'keep me', 1, 1)`);
    before.exec(readMigrations(root).at(-1)!.sql);
    expect(before.query(`SELECT text FROM "note"`).get()).toEqual({ text: "keep me" });
    expect(shape(before, "note")).toEqual(shape(fresh(v2), "note"));
  });

  test("a type change rebuilds a leaf table", async () => {
    const root = project();
    migrateDev(root, v1, "entities");
    const db = (await applied(root));
    db.exec(`INSERT INTO "note" (id, body, score, created_at, updated_at) VALUES ('n1', 'x', 4, 1, 1)`);

    const leaf = schema({ ...v1.models, note: model({ body: t.string(), score: t.string().optional() }) });
    expect(migrateDev(root, leaf, "score text").status).toBe("refused"); // converting loses data
    expect(migrateDev(root, leaf, "score text", { acceptDataLoss: true })).toMatchObject({
      status: "created",
      changes: [{ kind: "retypeField", model: "note", field: "score" }],
    });
    await apply(db, readMigrations(root).at(-1)!);
    expect(db.query(`SELECT id, score FROM "note"`).all()).toEqual([{ id: "n1", score: "4.0" }]);
    expect(shape(db, "note")).toEqual(shape(fresh(leaf), "note"));
  });

  test("rebuilding a referenced table keeps every child row and its key", async () => {
    const root = project();
    migrateDev(root, v1, "entities");
    const db = await applied(root);
    db.exec(`INSERT INTO "board" (id, name, created_at, updated_at) VALUES ('b1', 'Roadmap', 1, 1)`);
    db.exec(`INSERT INTO "column" (id, name, board_id, created_at, updated_at) VALUES ('c1', 'Todo', 'b1', 1, 1)`);

    // A new default changes the column definition, so the board table is
    // rebuilt while "column" references it with ON DELETE CASCADE.
    const next = schema({
      ...v1.models,
      board: model({ name: t.string().default("untitled"), columns: t.hasMany("column") }),
    });
    expect(migrateDev(root, next, "board default")).toMatchObject({ status: "created" });
    const migration = readMigrations(root).at(-1)!;
    expect(migration.sql).toContain('DROP TABLE "board"');

    // The negative control: the same SQL with foreign keys on, as migrations
    // used to run, cascades the drop into the child table.
    const naive = new Database(db.serialize());
    naive.exec("PRAGMA foreign_keys = ON");
    naive.transaction(() => naive.exec(migration.sql))();
    expect(naive.query(`SELECT COUNT(*) AS n FROM "column"`).get()).toEqual({ n: 0 });

    await apply(db, migration);
    expect(db.query(`SELECT id, board_id FROM "column"`).all()).toEqual([{ id: "c1", board_id: "b1" }]);
    expect(shape(db, "board")).toEqual(shape(fresh(next), "board"));
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

    // Enforcement is back: the cascade still runs on an ordinary delete.
    db.exec(`DELETE FROM "board" WHERE id = 'b1'`);
    expect(db.query(`SELECT COUNT(*) AS n FROM "column"`).get()).toEqual({ n: 0 });
  });

  test("a migration that would orphan rows is rolled back", async () => {
    const root = project();
    migrateDev(root, v1, "entities");
    const db = await applied(root);
    db.exec(`INSERT INTO "board" (id, name, created_at, updated_at) VALUES ('b1', 'Roadmap', 1, 1)`);
    db.exec(`INSERT INTO "column" (id, name, board_id, created_at, updated_at) VALUES ('c1', 'Todo', 'b1', 1, 1)`);

    await expect(
      apply(db, { id: "0009_bad", sql: `DELETE FROM "board"; CREATE TABLE "left_behind" (id TEXT);` })
    ).rejects.toThrow(/leaves 1 row\(s\) pointing at rows that do not exist/);
    expect(db.query(`SELECT COUNT(*) AS n FROM "board"`).get()).toEqual({ n: 1 });
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'left_behind'`).all()).toEqual([]);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });
});

describe("migrate rollback", () => {
  const v2 = schema({
    ...v1.models,
    note: model({ body: t.string(), score: t.number().optional(), pinned: t.boolean().default(false).index() }),
    tag: model({ label: t.string() }),
  });

  test("undoes added fields and models: the database is v1 again, its rows kept", async () => {
    const root = project();
    migrateDev(root, v1, "entities");
    migrateDev(root, v2, "pins and tags");
    const db = await applied(root);
    db.exec(`INSERT INTO "note" (id, body, pinned, created_at, updated_at) VALUES ('n1', 'keep', 1, 1, 1)`);

    // Undoing an addition discards what was written to it since.
    const refused = migrateRollback(root);
    expect(refused.status).toBe("refused");
    expect(JSON.stringify(refused)).toContain("--accept-data-loss");
    expect(readMigrations(root)).toHaveLength(2);

    const result = migrateRollback(root, { acceptDataLoss: true });
    expect(result).toMatchObject({ status: "created", id: "0004_rollback_to_0002", to: "0002_entities" });
    expect(result.status === "created" ? result.schemaEdits : []).toEqual(['remove "note.pinned"', 'remove model "tag"']);
    await apply(db, readMigrations(root).at(-1)!);
    for (const table of ["board", "column", "note"]) expect(shape(db, table)).toEqual(shape(fresh(v1), table));
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'tag'`).all()).toEqual([]);
    expect(db.query(`SELECT id, body FROM "note"`).all()).toEqual([{ id: "n1", body: "keep" }]);

    // The schema code changed back: everything agrees again.
    expect(migrateCheck(root, v1)).toEqual({ ok: true, problems: [] });
    // And forward once more is an ordinary migration.
    expect(migrateDev(root, v2, "pins again")).toMatchObject({ status: "created", id: "0005_pins_again" });
  });

  test("undoes renames across several migrations, values kept", async () => {
    const root = project();
    migrateDev(root, v1, "entities");
    const db = await applied(root);
    db.exec(`INSERT INTO "note" (id, body, created_at, updated_at) VALUES ('n1', 'keep me', 1, 1)`);

    const text = schema({ ...v1.models, note: model({ text: t.string(), score: t.number().optional() }) });
    migrateDev(root, text, "body to text", { renames: ["note.body=text"] });
    const { note, ...others } = text.models;
    const memo = schema({ ...others, memo: model({ content: t.string(), score: t.number().optional() }) });
    migrateDev(root, memo, "note to memo", { renames: ["note=memo", "memo.text=content"] });
    for (const migration of readMigrations(root).slice(1)) await apply(db, migration);
    expect(db.query(`SELECT content FROM "memo"`).get()).toEqual({ content: "keep me" });
    void note;

    const result = migrateRollback(root, { to: "0002_entities" });
    expect(result).toMatchObject({
      status: "created",
      changes: expect.arrayContaining([expect.objectContaining({ kind: "renameModel", from: "memo", to: "note" })]),
    });
    expect(result.status === "created" ? result.schemaEdits : []).toEqual(
      expect.arrayContaining(['rename model "memo" back to "note"', 'rename "note.content" back to "body"'])
    );
    await apply(db, readMigrations(root).at(-1)!);
    expect(db.query(`SELECT body FROM "note"`).get()).toEqual({ body: "keep me" });
    expect(shape(db, "note")).toEqual(shape(fresh(v1), "note"));
    expect(migrateCheck(root, v1).ok).toBe(true);
  });

  test("restores a type and an index change", async () => {
    const root = project();
    migrateDev(root, v1, "entities");
    const changed = schema({ ...v1.models, note: model({ body: t.string().index(), score: t.string().optional() }) });
    migrateDev(root, changed, "score text", { acceptDataLoss: true });
    const db = await applied(root);
    db.exec(`INSERT INTO "note" (id, body, score, created_at, updated_at) VALUES ('n1', 'x', '7', 1, 1)`);

    expect(migrateRollback(root, { acceptDataLoss: true })).toMatchObject({ status: "created" });
    await apply(db, readMigrations(root).at(-1)!);
    expect(shape(db, "note")).toEqual(shape(fresh(v1), "note"));
    expect(db.query(`SELECT score FROM "note"`).get()).toEqual({ score: 7 });
  });

  test("refuses to undo a drop: the values are gone", () => {
    const root = project();
    migrateDev(root, v1, "entities");
    migrateDev(root, schema({ ...v1.models, note: model({ body: t.string() }) }), "drop score", { acceptDataLoss: true });
    const result = migrateRollback(root, { acceptDataLoss: true });
    expect(result.status).toBe("refused");
    expect(JSON.stringify(result)).toContain('dropped \\"note.score\\"');
    expect(readMigrations(root)).toHaveLength(2);
  });

  test("refuses with nothing before, an unknown target, or an unrecorded schema", () => {
    const root = project();
    migrateDev(root, v1, "entities");
    expect(JSON.stringify(migrateRollback(root))).toContain("nothing before it");
    migrateDev(root, v2, "pins and tags");
    expect(JSON.stringify(migrateRollback(root, { to: "0009_nope" }))).toContain("There is no migration");
    rmSync(join(root, "tapedb", "snapshots"), { recursive: true });
    expect(JSON.stringify(migrateRollback(root, { acceptDataLoss: true }))).toContain("predates rollback");
  });
});

describe("migrate check", () => {
  test("fails on unmigrated schema changes and on a stale bundle", () => {
    const root = project();
    migrateDev(root, v1, "entities");
    const v2 = schema({ ...v1.models, note: model({ body: t.string(), score: t.number().optional(), pinned: t.boolean().optional() }) });
    expect(migrateCheck(root, v2).problems.join()).toContain("changes with no migration");

    writeFileSync(join(root, "tapedb", "migrations.gen.ts"), "// edited\n");
    expect(migrateCheck(root, v1).problems.join()).toContain("out of date");
  });
});

describe("CLI", () => {
  test("recognises its entry point through a symlink, as npx runs it via node_modules/.bin", async () => {
    const { symlinkSync } = await import("node:fs");
    const { pathToFileURL } = await import("node:url");
    const { isEntryPoint } = await import("../src/cli/index");
    const root = project();
    const real = join(root, "cli.js");
    writeFileSync(real, "");
    const link = join(root, "tapedb");
    symlinkSync(real, link);

    // Node gives argv[1] as typed (the link) and import.meta.url resolved.
    expect(isEntryPoint(link, pathToFileURL(real).href)).toBe(true);
    // The old check compared them unresolved and so never ran under npx.
    expect(pathToFileURL(link).href === pathToFileURL(real).href).toBe(false);
    expect(isEntryPoint(join(root, "other.js"), pathToFileURL(real).href)).toBe(false);
  });

  const src = resolve(import.meta.dir, "../src/schema");

  function withSchema(root: string, body: string) {
    writeFileSync(join(root, "tapedb.schema.ts"), `import { model, schema, t } from ${JSON.stringify(src)};\nexport default schema(${body});\n`);
  }

  test("migrate dev and check run from a project directory", async () => {
    const root = project();
    withSchema(root, `{ note: model({ body: t.string() }) }`);
    expect(await run(["migrate", "dev", "--dir", root])).toBe(0);
    expect(await run(["migrate", "check", "--dir", root])).toBe(0);
    expect(readFileSync(join(root, "tapedb", "migrations.gen.ts"), "utf8")).toContain('"0002_entities"');

    withSchema(root, `{ note: model({ body: t.string(), at: t.date().optional() }) }`);
    expect(await run(["migrate", "check", "--dir", root])).toBe(1);
    expect(await run(["migrate", "dev", "--dir", root])).toBe(1); // no --name
    expect(await run(["migrate", "dev", "--dir", root, "--name", "add at"])).toBe(0);
    expect(readMigrations(root).map((migration) => migration.id)).toEqual(["0002_entities", "0003_add_at"]);

    expect(await run(["migrate", "rollback", "--dir", root])).toBe(1); // drops "at": needs --accept-data-loss
    expect(await run(["migrate", "rollback", "--dir", root, "--accept-data-loss"])).toBe(0);
    expect(await run(["migrate", "check", "--dir", root])).toBe(1); // the schema still has "at"
    withSchema(root, `{ note: model({ body: t.string() }) }`);
    expect(await run(["migrate", "check", "--dir", root])).toBe(0);
    expect(readMigrations(root).map((migration) => migration.id)).toEqual(["0002_entities", "0003_add_at", "0004_rollback_to_0002"]);
  });

  test("deploy refuses unless ENVIRONMENT is production and migrations are current", async () => {
    const root = project();
    withSchema(root, `{ note: model({ body: t.string() }) }`);
    const config = (vars: Record<string, string>) =>
      writeFileSync(join(root, "wrangler.jsonc"), `{\n  // comment with a url https://example.com\n  "name": "app",\n  "vars": ${JSON.stringify(vars)},\n}\n`);

    config({ ENVIRONMENT: "development" });
    expect(await run(["deploy", "--dir", root])).toBe(1);

    config({ ENVIRONMENT: "production", TAPEDB_DEV_CLAIMS: "true" });
    expect(await run(["deploy", "--dir", root])).toBe(1);

    config({ ENVIRONMENT: "production" });
    expect(await run(["deploy", "--dir", root])).toBe(1); // no migrations yet
  });
});
