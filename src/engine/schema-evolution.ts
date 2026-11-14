/**
 * Reading old data through later schema changes.
 *
 * Recovery restores a snapshot and replays log lines that were written under
 * whatever schema was current at the time. If a migration since then dropped
 * or renamed a field, an old line still names it, and replaying it against
 * today's registry would fail and leave the workspace unable to boot.
 *
 * Migrations therefore declare what they changed, and recovery projects old
 * rows and ops through every change made after they were written. Only
 * declared changes are tolerated: an attribute or column that no migration
 * accounts for is still an error, so corrupted or foreign data fails closed.
 */

import {
  BASELINE_MIGRATION_ID,
  isEngineMigration,
  WORKSPACE_MIGRATIONS,
} from "./migrations-bundle";

export type SchemaChange =
  | { kind: "dropModel"; model: string; table: string }
  | { kind: "renameModel"; from: string; to: string; fromTable: string; toTable: string }
  /** `table` is the model's table as of this migration. */
  | { kind: "dropField"; model: string; table: string; field: string; column: string }
  | {
      kind: "renameField";
      model: string;
      table: string;
      from: string;
      to: string;
      fromColumn: string;
      toColumn: string;
    }
  /** The field's type changed; an old value that no longer fits is dropped. */
  | { kind: "retypeField"; model: string; field: string };

/** App-track changes made after `version`, oldest first. */
export function changesAfter(version: string | null | undefined): SchemaChange[] {
  const after =
    version === undefined || version === null || version === "unknown" || isEngineMigration(version)
      ? BASELINE_MIGRATION_ID
      : version;
  return WORKSPACE_MIGRATIONS.filter(
    (migration) => !isEngineMigration(migration.id) && migration.id > after
  ).flatMap((migration) => migration.changes ?? []);
}

/** Where an old model name lives now, or null when it was dropped. */
export function evolveModel(model: string, changes: readonly SchemaChange[]): string | null {
  let current = model;
  for (const change of changes) {
    if (change.kind === "renameModel" && change.from === current) current = change.to;
    else if (change.kind === "dropModel" && change.model === current) return null;
  }
  return current;
}

export interface EvolvedField {
  field: string;
  /** True when a later migration changed its type. */
  retyped: boolean;
}

/** Where an old field lives now, or null when it was dropped. */
export function evolveField(
  model: string,
  field: string,
  changes: readonly SchemaChange[]
): EvolvedField | null {
  let currentModel = model;
  let current = field;
  let retyped = false;
  for (const change of changes) {
    switch (change.kind) {
      case "renameModel":
        if (change.from === currentModel) currentModel = change.to;
        break;
      case "dropModel":
        if (change.model === currentModel) return null;
        break;
      case "renameField":
        if (change.model === currentModel && change.from === current) current = change.to;
        break;
      case "dropField":
        if (change.model === currentModel && change.field === current) return null;
        break;
      case "retypeField":
        if (change.model === currentModel && change.field === current) retyped = true;
        break;
    }
  }
  return { field: current, retyped };
}

/** Where an old table lives now, or null when it was dropped. */
export function evolveTable(table: string, changes: readonly SchemaChange[]): string | null {
  let current = table;
  for (const change of changes) {
    if (change.kind === "renameModel" && change.fromTable === current) current = change.toTable;
    else if (change.kind === "dropModel" && change.table === current) return null;
  }
  return current;
}

/** Where an old column lives now, or null when it was dropped. */
export function evolveColumn(
  table: string,
  column: string,
  changes: readonly SchemaChange[]
): string | null {
  let currentTable = table;
  let current = column;
  for (const change of changes) {
    switch (change.kind) {
      case "renameModel":
        if (change.fromTable === currentTable) currentTable = change.toTable;
        break;
      case "dropModel":
        if (change.table === currentTable) return null;
        break;
      case "renameField":
        if (change.table === currentTable && change.fromColumn === current) current = change.toColumn;
        break;
      case "dropField":
        if (change.table === currentTable && change.column === current) return null;
        break;
    }
  }
  return current;
}

