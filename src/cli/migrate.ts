/**
 * `tapedb migrate`: committed migrations from schema diffs.
 *
 * The schema as of the last migration is kept in `tapedb/schema.snapshot.json`.
 * `migrate dev` compares the current schema with it, writes the SQL that gets
 * one to the other as the next numbered file, updates the snapshot, and
 * regenerates `tapedb/migrations.gen.ts`, the bundle the Worker imports.
 *
 * Each migration also declares what it changed (dropped, renamed, retyped
 * fields and models) in a `-- tapedb:changes` line, so recovery can read data
 * written before it. The declarations are part of the committed file, and the
 * checksum, like the SQL.
 *
 * The schema after each migration is kept too, in `tapedb/snapshots/<id>.json`,
 * so `migrate rollback` can write the migration that takes the database back
 * to an earlier one.
 *
 * The very first migration is the full CREATE script for the schema, under
 * the id `0002_entities`: exactly what `defineSchema` has always generated, so
 * workspaces deployed before migrations were files keep a matching checksum.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AttributeDefinition, NamespaceDefinition } from "../engine/registry";
import type { SchemaChange } from "../engine/schema-evolution";
import { entityDdl, SQL_TYPE, sqlLiteral, type TapeDBSchema } from "../schema";

export const FIRST_MIGRATION_ID = "0002_entities";
const CHANGES_PREFIX = "-- tapedb:changes ";

export interface SnapshotAttribute {
  type: AttributeDefinition["type"];
  optional: boolean;
  indexed: boolean;
  unique: boolean;
  default?: string | number | null;
  references?: { table: string; column: string; onDelete: string };
}

export interface SchemaSnapshot {
  version: 1;
  /** Keyed by model (namespace) name. */
  models: Record<string, { table: string; attributes: Record<string, SnapshotAttribute> }>;
}

export function snapshotOf(schema: TapeDBSchema): SchemaSnapshot {
  const models: SchemaSnapshot["models"] = {};
  for (const namespace of schema.registry.namespaces) {
    const attributes: Record<string, SnapshotAttribute> = {};
    for (const [name, attribute] of Object.entries(namespace.attributes)) {
      attributes[name] = {
        type: attribute.type,
        optional: attribute.optional === true,
        indexed: attribute.indexed === true,
        unique: attribute.unique === true,
        ...(attribute.default === undefined ? {} : { default: attribute.default }),
        ...(attribute.references
          ? {
              references: {
                table: attribute.references.table,
                column: attribute.references.column,
                onDelete: attribute.references.onDelete ?? "SET NULL",
              },
            }
          : {}),
      };
    }
    models[namespace.apiName] = { table: namespace.table, attributes };
  }
  return { version: 1, models };
}

// ---- Diff -------------------------------------------------------------------

export interface DiffOptions {
  /** "old=new" for a model, "model.old=new" for a field. */
  renames?: string[];
  acceptDataLoss?: boolean;
}

export interface MigrationPlan {
  statements: string[];
  changes: SchemaChange[];
  /** Steps that discard data; refused unless acceptDataLoss. */
  destructive: string[];
  /** Steps that cannot be done; the plan must not be written. */
  refused: string[];
}

function column(attribute: string): string {
  return attribute.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function indexName(table: string, columnName: string): string {
  return `${table}_${columnName}_idx`;
}

function columnDefinition(name: string, attribute: SnapshotAttribute): string {
  let sql = `"${column(name)}" ${SQL_TYPE[attribute.type] ?? "TEXT"}`;
  if (attribute.default !== undefined) sql += ` DEFAULT ${sqlLiteral(attribute.default)}`;
  if (attribute.references) {
    sql += ` REFERENCES "${attribute.references.table}"("${attribute.references.column}") ON DELETE ${attribute.references.onDelete}`;
  }
  return sql;
}

function createTable(model: string, table: string, attributes: Record<string, SnapshotAttribute>): string[] {
  const namespace: NamespaceDefinition = { apiName: model, table, attributes: {} };
  const entity: Record<string, AttributeDefinition> = {};
  for (const [name, attribute] of Object.entries(attributes)) {
    entity[name] = {
      type: attribute.type,
      optional: attribute.optional,
      indexed: attribute.indexed,
      unique: attribute.unique,
      ...(attribute.default === undefined ? {} : { default: attribute.default }),
      ...(attribute.references
        ? {
            references: {
              table: attribute.references.table,
              column: attribute.references.column,
              onDelete: attribute.references.onDelete as "CASCADE" | "SET NULL" | "RESTRICT",
            },
          }
        : {}),
    };
  }
  return entityDdl(namespace, entity);
}

function indexStatements(table: string, name: string, before: SnapshotAttribute | undefined, after: SnapshotAttribute | undefined): string[] {
  const index = indexName(table, column(name));
  const had = before !== undefined && (before.indexed || before.unique);
  const has = after !== undefined && (after.indexed || after.unique);
  const same = had && has && before!.unique === after!.unique;
  if (same || (!had && !has)) return [];
  const statements: string[] = [];
  if (had) statements.push(`DROP INDEX IF EXISTS "${index}";`);
  if (has) {
    statements.push(
      `CREATE ${after!.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${index}" ON "${table}" ("${column(name)}");`
    );
  }
  return statements;
}

function parseRenames(renames: string[]): {
  models: Map<string, string>;
  fields: Map<string, Map<string, string>>;
} {
  const models = new Map<string, string>();
  const fields = new Map<string, Map<string, string>>();
  for (const entry of renames) {
    const match = /^([A-Za-z][A-Za-z0-9]*)(?:\.([A-Za-z][A-Za-z0-9]*))?=([A-Za-z][A-Za-z0-9]*)$/.exec(entry);
    if (!match) throw new Error(`--rename "${entry}" must be old=new or model.old=new.`);
    const [, first, second, target] = match;
    if (second === undefined) models.set(first, target);
    else {
      const map = fields.get(first) ?? new Map<string, string>();
      map.set(second, target);
      fields.set(first, map);
    }
  }
  return { models, fields };
}

/** Plans the SQL and declarations that take `before` to `after`. */
export function diffSnapshots(
  before: SchemaSnapshot,
  after: SchemaSnapshot,
  options: DiffOptions = {}
): MigrationPlan {
  const plan: MigrationPlan = { statements: [], changes: [], destructive: [], refused: [] };
  const renames = parseRenames(options.renames ?? []);

  // Models: renames first, so field diffs compare the right pair.
  const pairs: Array<[string | null, string | null]> = [];
  const matchedOld = new Set<string>();
  for (const name of Object.keys(after.models)) {
    const previous = [...renames.models.entries()].find(([, to]) => to === name)?.[0];
    if (previous !== undefined) {
      if (!(previous in before.models)) plan.refused.push(`--rename ${previous}=${name}: there is no model "${previous}".`);
      else {
        pairs.push([previous, name]);
        matchedOld.add(previous);
      }
    } else if (name in before.models) {
      pairs.push([name, name]);
      matchedOld.add(name);
    } else {
      pairs.push([null, name]);
    }
  }
  for (const name of Object.keys(before.models)) {
    if (!matchedOld.has(name)) pairs.push([name, null]);
  }

  for (const [oldName, newName] of pairs) {
    if (oldName === null) {
      const model = after.models[newName!];
      plan.statements.push(...createTable(newName!, model.table, model.attributes));
      continue;
    }
    const oldModel = before.models[oldName];
    if (newName === null) {
      plan.destructive.push(`drop model "${oldName}" and every row in "${oldModel.table}"`);
      plan.statements.push(`DROP TABLE IF EXISTS "${oldModel.table}";`);
      plan.changes.push({ kind: "dropModel", model: oldName, table: oldModel.table });
      continue;
    }
    const newModel = after.models[newName];
    if (oldName !== newName || oldModel.table !== newModel.table) {
      if (oldModel.table !== newModel.table) {
        plan.statements.push(`ALTER TABLE "${oldModel.table}" RENAME TO "${newModel.table}";`);
      }
      plan.changes.push({ kind: "renameModel", from: oldName, to: newName, fromTable: oldModel.table, toTable: newModel.table });
    }
    diffFields(plan, newName, newModel.table, oldModel.attributes, newModel.attributes, renames.fields.get(newName) ?? renames.fields.get(oldName) ?? new Map());
  }

  if (plan.destructive.length > 0 && !options.acceptDataLoss) {
    plan.refused.push(
      `This migration would ${plan.destructive.join("; ")}. Re-run with --accept-data-loss if that is intended, or --rename old=new if it is a rename.`
    );
  }
  return plan;
}

function diffFields(
  plan: MigrationPlan,
  model: string,
  table: string,
  before: Record<string, SnapshotAttribute>,
  after: Record<string, SnapshotAttribute>,
  renames: Map<string, string>
): void {
  const handled = new Set<string>();
  for (const [from, to] of renames) {
    if (!(from in before)) {
      plan.refused.push(`--rename ${model}.${from}=${to}: "${model}" has no field "${from}".`);
      continue;
    }
    if (!(to in after)) {
      plan.refused.push(`--rename ${model}.${from}=${to}: the schema has no field "${model}.${to}".`);
      continue;
    }
    plan.statements.push(...indexStatements(table, from, before[from], undefined));
    plan.statements.push(`ALTER TABLE "${table}" RENAME COLUMN "${column(from)}" TO "${column(to)}";`);
    plan.statements.push(...indexStatements(table, to, undefined, after[to]));
    plan.changes.push({ kind: "renameField", model, table, from, to, fromColumn: column(from), toColumn: column(to) });
    handled.add(from);
    handled.add(to);
    compareField(plan, model, table, to, { ...before[from] }, after[to], true);
  }

  for (const [name, attribute] of Object.entries(after)) {
    if (handled.has(name)) continue;
    if (!(name in before)) {
      if (!attribute.optional && attribute.default === undefined) {
        plan.refused.push(
          `"${model}.${name}" is new and required with no default, so existing rows would have no value. Give it .default(...) or make it .optional().`
        );
        continue;
      }
      plan.statements.push(`ALTER TABLE "${table}" ADD COLUMN ${columnDefinition(name, attribute)};`);
      plan.statements.push(...indexStatements(table, name, undefined, attribute));
      continue;
    }
    compareField(plan, model, table, name, before[name], attribute, false);
  }

  for (const [name, attribute] of Object.entries(before)) {
    if (handled.has(name) || name in after) continue;
    plan.destructive.push(`drop "${model}.${name}" and its values`);
    plan.statements.push(...indexStatements(table, name, attribute, undefined));
    plan.statements.push(`ALTER TABLE "${table}" DROP COLUMN "${column(name)}";`);
    plan.changes.push({ kind: "dropField", model, table, field: name, column: column(name) });
  }
}

function compareField(
  plan: MigrationPlan,
  model: string,
  table: string,
  name: string,
  before: SnapshotAttribute,
  after: SnapshotAttribute,
  renamed: boolean
): void {
  // A renamed field's index was dropped and recreated with the rename.
  if (!renamed) plan.statements.push(...indexStatements(table, name, before, after));

  const sqlTypeChanged = (SQL_TYPE[before.type] ?? "TEXT") !== (SQL_TYPE[after.type] ?? "TEXT");
  const referencesChanged =
    JSON.stringify(before.references ?? null) !== JSON.stringify(after.references ?? null);
  const defaultChanged = JSON.stringify(before.default ?? null) !== JSON.stringify(after.default ?? null);

  if (before.type !== after.type) {
    plan.changes.push({ kind: "retypeField", model, field: name });
  }
  if (sqlTypeChanged || referencesChanged || defaultChanged) {
    if (sqlTypeChanged) plan.destructive.push(`convert "${model}.${name}" from ${before.type} to ${after.type}; values that do not convert are lost`);
    plan.statements.push(`-- rebuild "${table}" for "${model}.${name}"`);
    plan.statements.push(`${REBUILD_MARKER}${table}:${name}`);
  }
}

/** Placeholder replaced once the whole table's final shape is known. */
const REBUILD_MARKER = "-- tapedb:rebuild ";

/** Expands rebuild markers into the create-copy-drop-rename sequence for each table. */
function expandRebuilds(plan: MigrationPlan, after: SchemaSnapshot): void {
  const tables = new Set<string>();
  plan.statements = plan.statements.filter((statement) => {
    if (!statement.startsWith(REBUILD_MARKER)) return true;
    tables.add(statement.slice(REBUILD_MARKER.length).split(":")[0]);
    return false;
  });
  for (const table of tables) {
    const [model, definition] = Object.entries(after.models).find(([, entry]) => entry.table === table)!;
    const temporary = `${table}__rebuild`;
    const columns = ["id", "created_at", "updated_at", "updated_seq", ...Object.keys(definition.attributes).map(column)];
    const selected = ["id", "created_at", "updated_at", "updated_seq", ...Object.entries(definition.attributes).map(
      ([name, attribute]) => `CAST("${column(name)}" AS ${SQL_TYPE[attribute.type] ?? "TEXT"})`
    )];
    const create = createTable(model, temporary, definition.attributes).map((statement) =>
      statement.replace(new RegExp(`"${temporary}_`, "g"), `"${table}_`)
    );
    plan.statements.push(
      create[0],
      `INSERT INTO "${temporary}" (${columns.map((name) => `"${name}"`).join(", ")}) SELECT ${selected.join(", ")} FROM "${table}";`,
      `DROP TABLE "${table}";`,
      `ALTER TABLE "${temporary}" RENAME TO "${table}";`,
      ...create.slice(1).map((statement) => statement.replace(`ON "${temporary}"`, `ON "${table}"`))
    );
  }
}

// ---- Files -------------------------------------------------------------------

export interface MigrationFile {
  id: string;
  sql: string;
  changes: SchemaChange[];
}

export function migrationsDir(root: string): string {
  return join(root, "tapedb", "migrations");
}

function snapshotPath(root: string): string {
  return join(root, "tapedb", "schema.snapshot.json");
}

function historyPath(root: string, id: string): string {
  return join(root, "tapedb", "snapshots", `${id}.json`);
}

function writeHistory(root: string, id: string, snapshot: SchemaSnapshot): void {
  mkdirSync(join(root, "tapedb", "snapshots"), { recursive: true });
  writeFileSync(historyPath(root, id), `${JSON.stringify(snapshot, null, 2)}\n`);
}

/** The schema as it was after migration `id`, when it was recorded. */
export function readHistory(root: string, id: string): SchemaSnapshot | null {
  const path = historyPath(root, id);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SchemaSnapshot) : null;
}

function bundlePath(root: string): string {
  return join(root, "tapedb", "migrations.gen.ts");
}

export function readMigrations(root: string): MigrationFile[] {
  const dir = migrationsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), "utf8");
      const header = sql.split("\n").find((line) => line.startsWith(CHANGES_PREFIX));
      return {
        id: file.replace(/\.sql$/, ""),
        sql,
        changes: header ? (JSON.parse(header.slice(CHANGES_PREFIX.length)) as SchemaChange[]) : [],
      };
    });
}

export function readSnapshot(root: string): SchemaSnapshot | null {
  const path = snapshotPath(root);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SchemaSnapshot) : null;
}

/** The bundle the Worker imports: every app migration, inlined. */
export function renderBundle(migrations: MigrationFile[]): string {
  const entries = migrations
    .map(
      (migration) =>
        `  {\n    id: ${JSON.stringify(migration.id)},\n    sql: ${JSON.stringify(migration.sql)},${
          migration.changes.length > 0 ? `\n    changes: ${JSON.stringify(migration.changes)},` : ""
        }\n  },`
    )
    .join("\n");
  return `// Generated by \`tapedb migrate\`. Do not edit; edit the schema and run it again.
import type { AppMigration } from "@tapedb/tapedb/worker";

export const migrations: AppMigration[] = [
${entries}
];
`;
}

function slug(name: string): string {
  const value = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!value) throw new Error(`Migration name "${name}" has no letters or digits.`);
  return value;
}

export type DevResult =
  | { status: "created"; id: string; statements: number; changes: SchemaChange[] }
  | { status: "unchanged" }
  | { status: "refused"; reasons: string[] };

/** `tapedb migrate dev`: diff, write the migration, the snapshot and the bundle. */
export function migrateDev(
  root: string,
  schema: TapeDBSchema,
  name: string,
  options: DiffOptions = {}
): DevResult {
  const next = snapshotOf(schema);
  const previous = readSnapshot(root);
  const existing = readMigrations(root);
  mkdirSync(migrationsDir(root), { recursive: true });
  // A project from before the history was kept: the snapshot is the schema
  // after its last migration.
  const last = existing.at(-1);
  if (previous !== null && last && readHistory(root, last.id) === null) writeHistory(root, last.id, previous);

  let file: MigrationFile;
  if (previous === null) {
    if (existing.length > 0) {
      return { status: "refused", reasons: ["tapedb/migrations has files but no schema.snapshot.json. Restore the snapshot from version control."] };
    }
    // The first migration is byte-for-byte what defineSchema always
    // generated: deployed workspaces hold its checksum.
    file = { id: FIRST_MIGRATION_ID, sql: schema.migrations.at(-1)!.sql, changes: [] };
  } else {
    const plan = diffSnapshots(previous, next, options);
    if (plan.refused.length > 0) return { status: "refused", reasons: plan.refused };
    expandRebuilds(plan, next);
    if (plan.statements.length === 0 && plan.changes.length === 0) {
      writeFileSync(snapshotPath(root), `${JSON.stringify(next, null, 2)}\n`);
      writeFileSync(bundlePath(root), renderBundle(existing));
      return { status: "unchanged" };
    }
    const number = Math.max(2, ...existing.map((migration) => Number(migration.id.slice(0, 4)))) + 1;
    const id = `${String(number).padStart(4, "0")}_${slug(name)}`;
    const header = plan.changes.length > 0 ? `${CHANGES_PREFIX}${JSON.stringify(plan.changes)}\n` : "";
    file = { id, sql: `${header}${plan.statements.join("\n")}\n`, changes: plan.changes };
  }

  writeFileSync(join(migrationsDir(root), `${file.id}.sql`), file.sql);
  writeFileSync(snapshotPath(root), `${JSON.stringify(next, null, 2)}\n`);
  writeHistory(root, file.id, next);
  writeFileSync(bundlePath(root), renderBundle([...existing, file]));
  return {
    status: "created",
    id: file.id,
    statements: countStatements(file.sql),
    changes: file.changes,
  };
}

// ---- Rollback ------------------------------------------------------------------

export type RollbackResult =
  | { status: "created"; id: string; to: string; statements: number; changes: SchemaChange[]; schemaEdits: string[] }
  | { status: "refused"; reasons: string[] };

/**
 * The renames that take the current names back to the names at `target`:
 * each migration's renames after it, followed forward from the target names.
 */
function renamesBack(target: SchemaSnapshot, undone: MigrationFile[]): string[] {
  const models = new Map(Object.keys(target.models).map((name) => [name, name]));
  const fields = new Map<string, { model: string; field: string; current: string }>();
  for (const [name, entry] of Object.entries(target.models)) {
    for (const field of Object.keys(entry.attributes)) fields.set(`${name}.${field}`, { model: name, field, current: field });
  }
  for (const migration of undone) {
    for (const change of migration.changes) {
      if (change.kind === "renameModel") {
        for (const [original, current] of models) if (current === change.from) models.set(original, change.to);
      } else if (change.kind === "renameField") {
        for (const entry of fields.values()) {
          if (models.get(entry.model) === change.model && entry.current === change.from) entry.current = change.to;
        }
      }
    }
  }
  const renames: string[] = [];
  for (const [original, current] of models) if (original !== current) renames.push(`${current}=${original}`);
  for (const entry of fields.values()) {
    if (entry.current !== entry.field) renames.push(`${models.get(entry.model)}.${entry.current}=${entry.field}`);
  }
  return renames;
}

/** What the schema code has to change to match `target`, in words. */
function schemaEdits(current: SchemaSnapshot, target: SchemaSnapshot, renames: string[]): string[] {
  const modelBack = new Map<string, string>();
  const fieldBack = new Map<string, string>();
  for (const rename of renames) {
    const [from, to] = rename.split("=");
    if (from.includes(".")) fieldBack.set(from, to);
    else modelBack.set(from, to);
  }
  const describe = (attribute: SnapshotAttribute) =>
    [attribute.type, attribute.optional ? "optional" : "", attribute.unique ? "unique" : attribute.indexed ? "indexed" : "",
      attribute.default === undefined ? "" : `default ${JSON.stringify(attribute.default)}`].filter(Boolean).join(", ");
  const edits: string[] = [];
  const matched = new Set<string>();
  for (const [name, entry] of Object.entries(target.models)) {
    const was = [...modelBack.entries()].find(([, original]) => original === name)?.[0] ?? name;
    const now = current.models[was];
    if (!now) {
      edits.push(`add model "${name}"`);
      continue;
    }
    matched.add(was);
    if (was !== name) edits.push(`rename model "${was}" back to "${name}"`);
    const kept = new Set<string>();
    for (const [field, attribute] of Object.entries(entry.attributes)) {
      const from = [...fieldBack.entries()].find(([key, original]) => key.startsWith(`${was}.`) && original === field)?.[0].split(".")[1] ?? field;
      if (!(from in now.attributes)) {
        edits.push(`add "${name}.${field}" (${describe(attribute)})`);
        continue;
      }
      kept.add(from);
      if (from !== field) edits.push(`rename "${name}.${from}" back to "${field}"`);
      if (JSON.stringify(now.attributes[from]) !== JSON.stringify(attribute)) edits.push(`make "${name}.${field}" ${describe(attribute)} again`);
    }
    for (const field of Object.keys(now.attributes)) if (!kept.has(field)) edits.push(`remove "${name}.${field}"`);
  }
  for (const name of Object.keys(current.models)) if (!matched.has(name)) edits.push(`remove model "${name}"`);
  return edits;
}

/**
 * `tapedb migrate rollback [--to <id>]`: writes the migration that takes the
 * database back to the schema after `<id>` (by default, the one before the
 * last). It is a new forward migration, applied like any other.
 *
 * Refused when a migration being undone dropped data: those values are gone,
 * so the earlier schema cannot be restored. Undoing an addition discards the
 * values written since, and needs --accept-data-loss like any drop.
 */
export function migrateRollback(root: string, options: { to?: string; acceptDataLoss?: boolean } = {}): RollbackResult {
  const existing = readMigrations(root);
  const current = readSnapshot(root);
  if (current === null || existing.length === 0) return { status: "refused", reasons: ["There are no migrations to roll back."] };
  const targetIndex = options.to === undefined ? existing.length - 2 : existing.findIndex((migration) => migration.id === options.to);
  if (options.to !== undefined && targetIndex === -1) {
    return { status: "refused", reasons: [`There is no migration "${options.to}".`] };
  }
  if (targetIndex < 0) return { status: "refused", reasons: [`${existing[0].id} creates the schema; there is nothing before it to go back to.`] };
  if (targetIndex === existing.length - 1) return { status: "refused", reasons: [`${options.to} is the last migration already.`] };
  const target = existing[targetIndex];
  const before = readHistory(root, target.id);
  if (before === null) {
    return {
      status: "refused",
      reasons: [
        `The schema after ${target.id} was not recorded (tapedb/snapshots/${target.id}.json): it predates rollback. Change the schema back and run \`tapedb migrate dev\`.`,
      ],
    };
  }
  const undone = existing.slice(targetIndex + 1);
  const dropped = undone.flatMap((migration) =>
    migration.changes
      .filter((change) => change.kind === "dropField" || change.kind === "dropModel")
      .map((change) =>
        change.kind === "dropField"
          ? `${migration.id} dropped "${change.model}.${change.field}"`
          : `${migration.id} dropped model "${change.model}"`
      )
  );
  if (dropped.length > 0) {
    return {
      status: "refused",
      reasons: [`${dropped.join("; ")}: those values are gone, so the schema after ${target.id} cannot be restored.`],
    };
  }

  const renames = renamesBack(before, undone);
  const plan = diffSnapshots(current, before, { renames, acceptDataLoss: options.acceptDataLoss });
  if (plan.refused.length > 0) return { status: "refused", reasons: plan.refused };
  expandRebuilds(plan, before);
  const number = Math.max(...existing.map((migration) => Number(migration.id.slice(0, 4)))) + 1;
  const id = `${String(number).padStart(4, "0")}_rollback_to_${target.id.slice(0, 4)}`;
  const header = plan.changes.length > 0 ? `${CHANGES_PREFIX}${JSON.stringify(plan.changes)}\n` : "";
  const file: MigrationFile = { id, sql: `${header}${plan.statements.join("\n")}\n`, changes: plan.changes };
  if (readHistory(root, existing.at(-1)!.id) === null) writeHistory(root, existing.at(-1)!.id, current);
  writeFileSync(join(migrationsDir(root), `${id}.sql`), file.sql);
  writeFileSync(snapshotPath(root), `${JSON.stringify(before, null, 2)}\n`);
  writeHistory(root, id, before);
  writeFileSync(bundlePath(root), renderBundle([...existing, file]));
  return {
    status: "created",
    id,
    to: target.id,
    statements: countStatements(file.sql),
    changes: plan.changes,
    schemaEdits: schemaEdits(current, before, renames),
  };
}

function countStatements(sql: string): number {
  return sql
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n")
    .split(";")
    .filter((statement) => statement.trim()).length;
}

export interface CheckResult {
  ok: boolean;
  problems: string[];
}

/** `tapedb migrate check`: the schema, the snapshot and the bundle all agree. */
export function migrateCheck(root: string, schema: TapeDBSchema): CheckResult {
  const problems: string[] = [];
  const previous = readSnapshot(root);
  if (previous === null) {
    problems.push("No migrations yet. Run `npx tapedb-cli migrate dev --name init`.");
    return { ok: false, problems };
  }
  const plan = diffSnapshots(previous, snapshotOf(schema), { acceptDataLoss: true });
  if (plan.statements.length > 0 || plan.changes.length > 0 || plan.refused.length > 0) {
    problems.push("The schema has changes with no migration. Run `npx tapedb-cli migrate dev --name <what changed>`.");
  }
  const bundle = existsSync(bundlePath(root)) ? readFileSync(bundlePath(root), "utf8") : "";
  if (bundle !== renderBundle(readMigrations(root))) {
    problems.push("tapedb/migrations.gen.ts is out of date with tapedb/migrations. Run `npx tapedb-cli migrate dev` to regenerate it.");
  }
  return { ok: problems.length === 0, problems };
}
