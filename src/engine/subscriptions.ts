/**
 * Live-query invalidation and diffing.
 *
 * The workspace DO keeps one subscription per client query. After a commit we
 * derive the namespaces a transaction touched, re-run only the subscriptions
 * whose compiled query references one of them, and push the smallest update
 * that is safe.
 *
 * Diffs are per top-level namespace and entity-level: an `updated` entity is
 * the full new entity, including any nested linked data that changed. This is
 * deliberate — nested arrays/objects do not have a stable identity contract,
 * so diffing them field by field would be guesswork.
 *
 * `removed` is a list of entity ids; `added` and `updated` carry full entities.
 */

import type { CompiledNode, CompiledQuery } from "./query-compile";
import type { QueryResult } from "./query-types";
import {
  findNamespace,
  LINKS,
  NAMESPACES,
  type LinkDefinition,
} from "./registry";
import { stableStringify } from "./tx-hash";

/** One flush per namespace every 50ms gives the plan's ~20 re-runs/second. */
export const DEFAULT_INVALIDATION_DEBOUNCE_MS = 50;

/**
 * Minimal shape accepted by `touchedNamespaces`. Validated ops expose `kind`,
 * while raw wire ops expose `op`; both are accepted so the room can derive
 * invalidation from the envelope it already parsed.
 */
export interface TouchableOp {
  namespace?: unknown;
  kind?: unknown;
  op?: unknown;
  link?: unknown;
  childNamespace?: unknown;
}

export interface EntityDiff {
  added: unknown[];
  /** Full replacement entities; nested changes are entity-level. */
  updated: unknown[];
  /** Ids that disappeared from the result. */
  removed: string[];
}

export interface NamespaceDiff extends EntityDiff {
  namespace: string;
}

/**
 * Namespaces whose content a transaction touched.
 *
 * `update`/`merge`/`delete` touch their own namespace. `link`/`unlink` write
 * the child's foreign key, so they touch both the op namespace and the
 * namespace that owns the FK.
 */
/**
 * Namespaces the database rewrites when rows of `namespace` are deleted.
 *
 * A `CASCADE` removes child rows and a `SET NULL` clears their foreign key, so
 * a subscriber to the child namespace sees its data change even though no op
 * ever named it. Resolved transitively: folders -> documents -> blocks.
 */
export function dependentNamespaces(namespace: string): Set<string> {
  const dependents = new Set<string>();
  const queue = [namespace];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const target = findNamespace(current);
    if (!target) continue;

    for (const [apiName, definition] of Object.entries(NAMESPACES)) {
      if (apiName === current || dependents.has(apiName)) continue;

      const references = Object.values(definition.attributes).some(
        (attribute) =>
          attribute.references?.table === target.table &&
          attribute.references.onDelete !== "RESTRICT"
      );
      if (!references) continue;

      dependents.add(apiName);
      queue.push(apiName);
    }
  }

  return dependents;
}

export function touchedNamespaces(ops: readonly TouchableOp[]): Set<string> {
  const touched = new Set<string>();

  for (const op of ops) {
    if (typeof op.namespace === "string" && op.namespace.length > 0) {
      touched.add(op.namespace);
    }

    const kind = typeof op.kind === "string" ? op.kind : op.op;

    // Deleting a row rewrites FK-dependent rows, so their namespaces must be
    // invalidated too or subscribers keep stale children forever.
    if (kind === "delete" && typeof op.namespace === "string") {
      for (const dependent of dependentNamespaces(op.namespace)) {
        touched.add(dependent);
      }
    }

    if (kind !== "link" && kind !== "unlink") continue;

    if (typeof op.childNamespace === "string" && op.childNamespace.length > 0) {
      touched.add(op.childNamespace);
    }

    if (typeof op.link === "string") {
      const link = (LINKS as Record<string, LinkDefinition>)[op.link];
      if (link) touched.add(link.foreignKey.namespace);
    }
  }

  return touched;
}

/** Reads `ops` from a validated transaction envelope. */
export function touchedNamespacesFromEnvelope(envelope: unknown): Set<string> {
  if (!isRecord(envelope) || !Array.isArray(envelope.ops)) {
    return new Set();
  }

  return touchedNamespaces(envelope.ops.filter(isRecord));
}

/**
 * True when any node of the compiled query — top-level or nested traversal —
 * requests one of the touched namespaces.
 */
export function queryMatchesTouched(
  compiled: CompiledQuery,
  touched: ReadonlySet<string>
): boolean {
  if (touched.size === 0) return false;

  const visit = (node: CompiledNode): boolean =>
    touched.has(node.namespace) ||
    node.children.some((child) => visit(child.node));

  return compiled.nodes.some(visit);
}

/** True when the compiled query references `namespace` at any depth. */
export function queryReferencesNamespace(
  compiled: CompiledQuery,
  namespace: string
): boolean {
  const visit = (node: CompiledNode): boolean =>
    node.namespace === namespace ||
    node.children.some((child) => visit(child.node));

  return compiled.nodes.some(visit);
}

/**
 * Compares two entity lists by id.
 *
 * Returns `null` when the payload is not a list of uniquely identified
 * entities; callers then send a full `query:data` payload instead of a diff.
 */
export function diffEntityList(
  previous: unknown,
  next: unknown
): EntityDiff | null {
  const previousById = indexEntities(previous);
  const nextById = indexEntities(next);
  if (previousById === null || nextById === null) return null;

  const added: unknown[] = [];
  const updated: unknown[] = [];
  const removed: string[] = [];

  for (const [id, entity] of nextById) {
    const before = previousById.get(id);
    if (before === undefined) {
      added.push(entity);
      continue;
    }
    if (stableStringify(before) !== stableStringify(entity)) {
      updated.push(entity);
    }
  }

  for (const id of previousById.keys()) {
    if (!nextById.has(id)) removed.push(id);
  }

  return { added, updated, removed };
}

/**
 * Diffs every top-level namespace in a query result.
 *
 * Returns `null` when a namespace is missing from either side or when its
 * value cannot be indexed by entity id, so the caller falls back to full data.
 * Returns an empty array when both results are identical.
 */
export function diffQueryResults(
  previous: QueryResult,
  next: QueryResult
): NamespaceDiff[] | null {
  const namespaces = new Set([...Object.keys(previous), ...Object.keys(next)]);

  const diffs: NamespaceDiff[] = [];

  for (const namespace of namespaces) {
    const before = previous[namespace];
    const after = next[namespace];
    // A query's top-level namespace set is fixed. A difference means the
    // result shape changed underneath us; do not risk a partial diff.
    if (before === undefined || after === undefined) return null;

    const diff = diffEntityList(before, after);
    if (diff === null) return null;

    if (diff.added.length + diff.updated.length + diff.removed.length > 0) {
      diffs.push({ namespace, ...diff });
    }
  }

  return diffs;
}

function indexEntities(value: unknown): Map<string, unknown> | null {
  if (!Array.isArray(value)) return null;

  const entities = new Map<string, unknown>();
  for (const entity of value) {
    if (!isRecord(entity)) return null;

    const id = entity.id;
    if (typeof id !== "string" || id.length === 0) return null;
    // Duplicate ids make "updated" ambiguous, so refuse to diff.
    if (entities.has(id)) return null;

    entities.set(id, entity);
  }

  return entities;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
