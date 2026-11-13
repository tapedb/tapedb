/**
 * Registry mapping InstantDB-style API names to workspace SQLite tables.
 *
 * The registry is the runtime contract shared by query compilation, envelope
 * validation, permissions and durability. It is *not* a hardcoded schema: the
 * consumer defines one schema with `defineSchema()` and the Worker hands the
 * resulting registry to `configureRegistry()` before any request is served.
 *
 * Both `NAMESPACES` and `LINKS` are mutated in place rather than reassigned, so
 * modules that imported the binding at load time observe the configured values.
 * A deployment serves exactly one schema, so this configuration is per Worker
 * instance, not per request.
 */

export type AttributeType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "json"
  | "any";

export type DeleteRule = "CASCADE" | "SET NULL" | "RESTRICT";

export interface AttributeReference {
  table: string;
  column: string;
  onDelete?: DeleteRule;
}

export interface AttributeDefinition {
  type: AttributeType;
  optional?: boolean;
  indexed?: boolean;
  unique?: boolean;
  references?: AttributeReference;
}

export interface NamespaceDefinition {
  apiName: string;
  table: string;
  attributes: Record<string, AttributeDefinition>;
}

export interface OneToManyLink {
  apiName: string;
  kind: "one-to-many";
  forward: { namespace: string; label: string; has: "many" };
  reverse: { namespace: string; label: string; has: "one" };
  foreignKey: { namespace: string; attribute: string };
}

export interface OneToOneLink {
  apiName: string;
  kind: "one-to-one";
  forward: { namespace: string; label: string; has: "one" };
  reverse: { namespace: string; label: string; has: "one" };
  foreignKey: { namespace: string; attribute: string; unique: true };
}

export type LinkDefinition = OneToManyLink | OneToOneLink;

/**
 * Engine-owned tables. `_files` holds file metadata; the rest hold migration
 * state, the transaction log, flush and snapshot bookkeeping, and engine
 * metadata.
 */
export const ENGINE_TABLES = {
  migrations: "_migrations",
  txLog: "_tx_log",
  txState: "_tx_state",
  flushState: "_flush_state",
  snapshotState: "_snapshot_state",
  engineMeta: "_engine_meta",
  files: "_files",
} as const;

/** Configured namespaces, keyed by API name. Mutated by `configureRegistry`. */
export const NAMESPACES: Record<string, NamespaceDefinition> = {};

/** Configured links, keyed by API name. Mutated by `configureRegistry`. */
export const LINKS: Record<string, LinkDefinition> = {};

export type NamespaceApiName = string;
export type LinkApiName = string;

export interface RegistryDefinition {
  namespaces: readonly NamespaceDefinition[];
  links: readonly LinkDefinition[];
}

let configured = false;
let generation = 0;

/**
 * Bumped every time the registry is configured. Derived indexes (such as the
 * link-label map in the query compiler) compare against this so they rebuild
 * after the deployment schema is installed, which happens after module load.
 */
export function registryGeneration(): number {
  return generation;
}

/**
 * Installs the deployment schema. Called once per Worker instance, from the
 * Durable Object constructor, before any request is handled.
 */
export function configureRegistry(registry: RegistryDefinition): void {
  for (const key of Object.keys(NAMESPACES)) delete NAMESPACES[key];
  for (const key of Object.keys(LINKS)) delete LINKS[key];

  for (const namespace of registry.namespaces) {
    NAMESPACES[namespace.apiName] = namespace;
  }
  for (const link of registry.links) {
    LINKS[link.apiName] = link;
  }
  configured = true;
  generation += 1;
}

/** True once a schema has been installed. Request handling asserts this. */
export function registryConfigured(): boolean {
  return configured;
}

export function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

export function columnFor(
  namespace: NamespaceDefinition,
  attribute: string
): string | undefined {
  return namespace.attributes[attribute] ? toSnakeCase(attribute) : undefined;
}

export function findNamespace(
  apiName: string
): NamespaceDefinition | undefined {
  return NAMESPACES[apiName];
}

export function tableFor(apiName: string): string | undefined {
  return findNamespace(apiName)?.table;
}

export function namespaceTables(): string[] {
  return Object.values(NAMESPACES).map((namespace) => namespace.table);
}

export function allWorkspaceTables(): string[] {
  return [...Object.values(ENGINE_TABLES), ...namespaceTables()];
}
