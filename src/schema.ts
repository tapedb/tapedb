/**
 * One schema, two artifacts.
 *
 * `defineSchema()` is the single source of truth. It produces:
 *
 *   - the server registry (namespaces + links) that the engine compiles
 *     queries and validates transactions against,
 *   - the SQL migrations that create those tables,
 *   - the client schema that resolves link labels.
 *
 * A deployment writes the entity map once; the CLI emits the migration bundle
 * from the same object, so the two can never drift.
 */

import { ENGINE_TABLES, toSnakeCase } from "./engine/registry";
import type {
  AttributeDefinition,
  LinkDefinition,
  NamespaceDefinition,
  RegistryDefinition,
} from "./engine/registry";
import {
  BASELINE_MIGRATION_ID,
  ENGINE_MIGRATIONS,
  type BundledWorkspaceMigration,
} from "./engine/migrations-bundle";
import { assertDecisionShape } from "./engine/permission-shape";
import type {
  PermissionConfig,
  PermissionOverrides,
} from "./engine/tx-permissions";
import type { WorkspaceRole } from "./claims";
import { i } from "./client/schema";
import type {
  LinkDefinition as ClientLinkDefinition,
  SchemaDefinition as ClientSchemaDefinition,
} from "./client/types";

export interface EntityConfig {
  [attribute: string]: AttributeDefinition;
}

export interface SchemaConfig {
  entities: Record<string, EntityConfig>;
  links?: readonly LinkDefinition[];
  /**
   * Per-namespace overrides; defaults are view=MEMBER, write=EDITOR,
   * delete=MODERATOR. Each action takes a role level or a rule function;
   * `view` also takes `{ where: (auth) => filter }`, which runs in SQL.
   */
  permissions?: PermissionOverrides;
  /** Table name per namespace, for mapping onto existing tables. Default: snake_case. */
  tables?: Record<string, string>;
}

export interface TapeDBSchema {
  registry: RegistryDefinition;
  permissions: PermissionConfig;
  migrations: BundledWorkspaceMigration[];
  clientSchema: ClientSchemaDefinition;
}

/**
 * Engine bookkeeping tables. Copied verbatim from the engine's baseline
 * migration: the transaction pipeline, flusher and recovery all depend on
 * these exact names and columns.
 *
 * FROZEN. Deployed workspaces recorded this text's checksum when they applied
 * 0001_baseline and refuse to boot if it changes. Engine schema changes go in
 * ENGINE_MIGRATIONS instead; that is why the file table is created here under
 * its old name and renamed by tapedb_0002_files_table.
 */
const ENGINE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS "_migrations" (
  id TEXT PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "_tx_log" (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  client_tx_id TEXT UNIQUE,
  ops TEXT NOT NULL,
  ops_hash TEXT NOT NULL,
  user_id TEXT,
  role INTEGER,
  at INTEGER NOT NULL,
  schema_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "_tx_state" (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  high_water_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "_flush_state" (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_seq INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  last_flush_at INTEGER,
  last_segment_from INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "_snapshot_state" (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  base_seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'idle',
  started_at INTEGER,
  completed_at INTEGER,
  manifest_key TEXT
);

CREATE TABLE IF NOT EXISTS "_engine_meta" (
  "key" TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "$files" (
  id TEXT PRIMARY KEY NOT NULL,
  path TEXT NOT NULL UNIQUE,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO "_tx_state" (id, high_water_seq) VALUES (1, 0);
INSERT OR IGNORE INTO "_flush_state" (id, last_seq, attempts, updated_at)
  VALUES (1, 0, 0, 0);
INSERT OR IGNORE INTO "_snapshot_state" (id, base_seq, status)
  VALUES (1, 0, 'idle');
INSERT OR IGNORE INTO "_engine_meta" ("key", value) VALUES
  ('engine_version', '1'),
  ('schema_version', '0001_baseline');
`;

const SQL_TYPE: Record<string, string> = {
  string: "TEXT",
  json: "TEXT",
  date: "INTEGER",
  any: "TEXT",
  number: "REAL",
  boolean: "INTEGER",
};

function entityDdl(
  namespace: NamespaceDefinition,
  attributes: EntityConfig
): string[] {
  const columns: string[] = [
    `"id" TEXT PRIMARY KEY NOT NULL`,
    `"created_at" INTEGER NOT NULL`,
    `"updated_at" INTEGER NOT NULL`,
    `"updated_seq" INTEGER NOT NULL DEFAULT 0`,
  ];

  for (const [name, attribute] of Object.entries(attributes)) {
    const column = toSnakeCase(name);
    let sql = `"${column}" ${SQL_TYPE[attribute.type] ?? "TEXT"}`;
    if (attribute.references) {
      const onDelete = attribute.references.onDelete ?? "SET NULL";
      sql += ` REFERENCES "${attribute.references.table}"("${attribute.references.column}") ON DELETE ${onDelete}`;
    }
    columns.push(sql);
  }

  const statements = [
    `CREATE TABLE IF NOT EXISTS "${namespace.table}" (\n  ${columns.join(",\n  ")}\n);`,
  ];

  for (const [name, attribute] of Object.entries(attributes)) {
    if (!attribute.indexed && !attribute.unique) continue;
    const column = toSnakeCase(name);
    const unique = attribute.unique ? "UNIQUE " : "";
    statements.push(
      `CREATE ${unique}INDEX IF NOT EXISTS "${namespace.table}_${column}_idx" ON "${namespace.table}" ("${column}");`
    );
  }

  return statements;
}

function clientLink(link: LinkDefinition): ClientLinkDefinition {
  return {
    forward: {
      on: link.foreignKey.attribute,
      has: link.forward.has,
      label: link.forward.label,
    },
    reverse: {
      on: link.foreignKey.attribute,
      has: link.reverse.has,
      label: link.reverse.label,
    },
  };
}

export function defineSchema(config: SchemaConfig): TapeDBSchema {
  for (const [namespace, actions] of Object.entries(config.permissions ?? {})) {
    if (!config.entities[namespace]) {
      throw new Error(
        `Permissions reference unknown namespace "${namespace}".`
      );
    }
    for (const [action, decision] of Object.entries(actions ?? {})) {
      assertDecisionShape(namespace, action, decision);
    }
  }

  const namespaces: NamespaceDefinition[] = Object.entries(config.entities).map(
    ([apiName, attributes]) => ({
      apiName,
      table: config.tables?.[apiName] ?? toSnakeCase(apiName),
      attributes,
    })
  );

  const links = config.links ?? [];

  for (const link of links) {
    // The foreign key lives on `link.foreignKey.namespace`; it points at the
    // other side of the link.
    const owner = namespaces.find(
      (namespace) => namespace.apiName === link.foreignKey.namespace
    );
    if (!owner) {
      throw new Error(
        `Link "${link.apiName}" points at unknown namespace "${link.foreignKey.namespace}".`
      );
    }
    const attribute = owner.attributes[link.foreignKey.attribute] as
      | AttributeDefinition
      | undefined;
    if (!attribute) {
      throw new Error(
        `Link "${link.apiName}" needs "${link.foreignKey.namespace}.${link.foreignKey.attribute}", which the schema does not define.`
      );
    }

    const target =
      link.forward.namespace === owner.apiName
        ? link.reverse.namespace
        : link.forward.namespace;

    attribute.references = {
      table: config.tables?.[target] ?? toSnakeCase(target),
      column: "id",
      onDelete: attribute.references?.onDelete ?? "SET NULL",
    };
  }

  const entityStatements: string[] = [];
  for (const namespace of namespaces) {
    entityStatements.push(
      ...entityDdl(namespace, config.entities[namespace.apiName] ?? {})
    );
  }

  const migrations: BundledWorkspaceMigration[] = [
    { id: BASELINE_MIGRATION_ID, sql: ENGINE_TABLE_DDL.trim() },
    ...ENGINE_MIGRATIONS,
    {
      id: "0002_entities",
      sql: entityStatements.join("\n\n"),
    },
  ];

  const clientEntities: Record<string, ReturnType<typeof i.entity>> = {};
  for (const [apiName, attributes] of Object.entries(config.entities)) {
    const mapped: Record<string, unknown> = {};
    for (const [name, attribute] of Object.entries(attributes)) {
      const builder = i[attribute.type] ?? i.any;
      let value = (builder as () => unknown)();
      const flags = value as {
        optional(): unknown;
        indexed(): unknown;
        unique(): unknown;
      };
      if (attribute.optional) value = flags.optional();
      if (attribute.indexed) value = (value as typeof flags).indexed();
      if (attribute.unique) value = (value as typeof flags).unique();
      mapped[name] = value;
    }
    clientEntities[apiName] = i.entity(mapped as never);
  }

  const clientLinks: Record<string, ClientLinkDefinition> = {};
  for (const link of links) clientLinks[link.apiName] = clientLink(link);

  return {
    registry: { namespaces, links },
    permissions: { overrides: config.permissions ?? {} },
    migrations,
    clientSchema: i.schema({ entities: clientEntities, links: clientLinks }),
  };
}

// The model API. `defineSchema` above stays as the engine-level compiler that
// `schema()` builds on.
export { t } from "./model/fields";
export type { DeleteBehaviour, ScalarKind } from "./model/fields";
export { schema, model, role, filter, check, Model } from "./model/schema";
export type {
  Access,
  AccessAuth,
  CheckContext,
  CreateData,
  Include,
  OrderBy,
  Row,
  Schema,
  UpdateData,
} from "./model/schema";
export type { Where, FieldFilter } from "./model/where";
