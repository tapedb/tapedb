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
import type { BundledWorkspaceMigration } from "./engine/migrations-bundle";
import type {
  PermissionAction,
  PermissionConfig,
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
  /** Per-namespace role overrides; defaults are view=MEMBER, write=EDITOR. */
  permissions?: Record<string, Partial<Record<PermissionAction, WorkspaceRole>>>;
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

CREATE TABLE IF NOT EXISTS "${ENGINE_TABLES.files}" (
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
  const namespaces: NamespaceDefinition[] = Object.entries(config.entities).map(
    ([apiName, attributes]) => ({
      apiName,
      table: toSnakeCase(apiName),
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
      table: toSnakeCase(target),
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
    { id: "0001_baseline", sql: ENGINE_TABLE_DDL.trim() },
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
