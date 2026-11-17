/**
 * The studio's structure editor: reads the project's models from
 * `tapedb.schema.ts`, previews an edit (the code diff and the migration SQL),
 * and applies it the way `tapedb migrate dev` would.
 *
 * Nothing is written until an edit has been previewed and the schema file is
 * still what the preview read. An edit that does not load is reported, never
 * written.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadSchemaSource } from "./load-schema";
import { diffSnapshots, expandRebuilds, migrateCheck, migrateDev, readSnapshot, snapshotOf } from "./migrate";
import { editSchemaSource, lineDiff, parseSchemaSource, readField, SchemaEditError, type DiffLine, type FieldSpec, type SchemaEdit } from "./schema-edit";

export interface StructureField {
  name: string;
  /** The field as written in the schema file. */
  code: string;
  /** The field as the studio can edit it; null when written some other way. */
  spec: FieldSpec | null;
}

export type Structure =
  | {
      editable: true;
      file: string;
      models: Array<{ name: string; fields: StructureField[] }>;
      /** Changes in the schema file with no migration yet, from `migrate check`. */
      pending: string[];
    }
  | { editable: false; reason: string };

export type Preview =
  | {
      ok: true;
      diff: DiffLine[];
      sql: string[];
      /** What the migration discards. */
      destructive: string[];
      migration: string;
      /** The schema file the preview read; apply refuses if it changed since. */
      base: string;
    }
  | { ok: false; error: string };

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function schemaFile(root: string): string {
  return join(root, "tapedb.schema.ts");
}

export async function readStructure(root: string): Promise<Structure> {
  const file = schemaFile(root);
  if (!existsSync(file)) return { editable: false, reason: `No tapedb.schema.ts in ${root}.` };
  const source = readFileSync(file, "utf8");
  try {
    const parsed = parseSchemaSource(source);
    const models = parsed.models.map((model) => ({
      name: model.name,
      fields: model.fields.entries.map((entry) => {
        const code = source.slice(entry.valueStart, entry.valueEnd);
        return { name: entry.key, code, spec: readField(code) };
      }),
    }));
    let pending: string[] = [];
    try {
      const check = migrateCheck(root, await loadSchemaSource(root, file, source));
      pending = check.ok ? [] : check.problems;
    } catch (error) {
      pending = [error instanceof Error ? error.message : String(error)];
    }
    return { editable: true, file, models, pending };
  } catch (error) {
    if (error instanceof SchemaEditError) return { editable: false, reason: error.message };
    throw error;
  }
}

async function plan(root: string, edit: SchemaEdit) {
  const file = schemaFile(root);
  const before = readFileSync(file, "utf8");
  const result = editSchemaSource(before, edit);
  const schema = await loadSchemaSource(root, file, result.source);
  return { file, before, result, schema };
}

export async function previewEdit(root: string, edit: SchemaEdit): Promise<Preview> {
  try {
    const { before, result, schema } = await plan(root, edit);
    const previous = readSnapshot(root);
    const next = snapshotOf(schema);
    let sql: string[];
    let destructive: string[] = [];
    if (previous === null) {
      sql = [schema.migrations.at(-1)!.sql];
    } else {
      const steps = diffSnapshots(previous, next, { renames: result.renames, acceptDataLoss: true });
      if (steps.refused.length > 0) return { ok: false, error: steps.refused.join(" ") };
      expandRebuilds(steps, next);
      sql = steps.statements;
      destructive = steps.destructive;
    }
    return { ok: true, diff: lineDiff(before, result.source), sql, destructive, migration: result.name, base: hash(before) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type Applied = { ok: true; migration: string | null } | { ok: false; error: string };

export async function applyEdit(root: string, edit: SchemaEdit, base: string): Promise<Applied> {
  try {
    const { file, before, result, schema } = await plan(root, edit);
    if (hash(before) !== base) return { ok: false, error: "tapedb.schema.ts changed since this preview. Review the change again." };
    writeFileSync(file, result.source);
    const written = migrateDev(root, schema, result.name, { renames: result.renames, acceptDataLoss: true });
    if (written.status === "refused") {
      writeFileSync(file, before);
      return { ok: false, error: written.reasons.join(" ") };
    }
    return { ok: true, migration: written.status === "created" ? written.id : null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
