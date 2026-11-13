/**
 * Pure query-cache transforms: server diffs and optimistic transaction steps.
 *
 * The engine sends entity-level diffs where `added`/`updated` carry complete
 * entities (including nested link data). Optimistic writes are applied to a
 * cloned result so a rejected transaction can restore the cache snapshot.
 */

import { findLinkByApiName } from "./schema";
import { cloneJson } from "./stable";
import type {
  QueryEntity,
  QueryResult,
  SchemaDefinition,
  TxLinkOp,
  TxOp,
  TxUnlinkOp,
} from "./types";

export interface NamespaceDiff {
  namespace: string;
  added: unknown[];
  updated: unknown[];
  removed: string[];
}

function entityId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function asEntity(value: unknown): QueryEntity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entity = value as QueryEntity;
  return entityId(entity) === undefined ? undefined : entity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Applies one `query:diff` message. Order of unchanged entities is preserved;
 * new entities are appended in the order the server sent them.
 */
export function applyQueryDiff(
  data: QueryResult,
  diff: NamespaceDiff
): QueryResult {
  const previous = Array.isArray(data[diff.namespace])
    ? data[diff.namespace]
    : [];

  const byId = new Map<string, QueryEntity>();
  for (const entity of previous) {
    const id = entityId(entity);
    if (id !== undefined) byId.set(id, entity);
  }

  for (const removedId of diff.removed) byId.delete(removedId);

  const order: string[] = [];
  const seen = new Set<string>();
  for (const entity of previous) {
    const id = entityId(entity);
    if (id === undefined || !byId.has(id) || seen.has(id)) continue;
    order.push(id);
    seen.add(id);
  }

  for (const value of [...diff.added, ...diff.updated]) {
    const entity = asEntity(value);
    if (!entity) continue;
    const id = entityId(entity)!;
    byId.set(id, entity);
    if (!seen.has(id)) {
      order.push(id);
      seen.add(id);
    }
  }

  const next = order
    .map((id) => byId.get(id))
    .filter((entity): entity is QueryEntity => entity !== undefined);

  return { ...data, [diff.namespace]: next };
}

/** Applies every optimistic op to a clone of `data`. */
export function applyOptimisticOps(
  data: QueryResult,
  ops: readonly TxOp[],
  schema: SchemaDefinition | undefined
): QueryResult {
  let next = cloneJson(data);

  // A newly created entity arrives as `update` followed by `link`. The board
  // query has no top-level `boards`, so the update has nowhere to land and
  // the link would create a value-less child. Collect the pending values first
  // so a link can materialise the child with them.
  const pendingValues = new Map<string, Record<string, unknown>>();
  for (const op of ops) {
    if (op.op === "link" || op.op === "unlink" || op.op === "delete") continue;
    pendingValues.set(op.id, {
      ...(pendingValues.get(op.id) ?? {}),
      ...(op.op === "upsert" ? op.create : {}),
      ...op.values,
    });
  }

  for (const op of ops) {
    next = applyOptimisticOp(next, op, schema, pendingValues);
  }
  return next;
}

export function applyOptimisticOp(
  data: QueryResult,
  op: TxOp,
  schema: SchemaDefinition | undefined,
  pendingValues?: ReadonlyMap<string, Record<string, unknown>>
): QueryResult {
  switch (op.op) {
    case "insert":
    case "patch":
    case "update":
    case "merge":
      applyValues(data, op.namespace, op.id, op.values);
      return data;
    case "upsert":
      // The cache decides the same way the engine will: a row it already
      // holds gets `values`, an unknown one is created from `create`.
      applyValues(
        data,
        op.namespace,
        op.id,
        findEntity(data, op.id) === undefined ? op.create : op.values
      );
      return data;
    case "delete":
      removeEntity(data, op.namespace, op.id);
      return data;
    case "link":
      applyLink(data, op, schema, true, pendingValues);
      return data;
    case "unlink":
      applyLink(data, op, schema, false, pendingValues);
      return data;
  }
}

function applyValues(
  data: QueryResult,
  namespace: string,
  id: string,
  values: Record<string, unknown>
): void {
  const entities = data[namespace];
  if (Array.isArray(entities)) {
    const index = entities.findIndex((entity) => entityId(entity) === id);
    if (index >= 0) {
      entities[index] = { ...entities[index], ...values, id };
    } else {
      entities.push({ id, ...values });
    }
  }

  updateOccurrences(data, id, values);
}

function removeEntity(data: QueryResult, namespace: string, id: string): void {
  const entities = data[namespace];
  if (Array.isArray(entities)) {
    data[namespace] = entities.filter((entity) => entityId(entity) !== id);
  }
  removeOccurrences(data, id);
}

/** Applies link/unlink to every cached occurrence of the child and parent. */
function applyLink(
  data: QueryResult,
  op: TxLinkOp | TxUnlinkOp,
  schema: SchemaDefinition | undefined,
  linked: boolean,
  pendingValues?: ReadonlyMap<string, Record<string, unknown>>
): void {
  const definition = findLinkByApiName(schema, op.link);
  if (!definition) return;

  const { forward, reverse } = definition;

  let parentId: string;
  let childId: string;
  if (op.namespace === forward.on) {
    parentId = op.id;
    childId = op.targetId;
  } else if (op.namespace === reverse.on) {
    parentId = op.targetId;
    childId = op.id;
  } else {
    return;
  }

  // Schema links do not carry the physical FK attribute. The engine derives it
  // from the reverse label (`board` -> `boardId`), so the optimistic cache uses
  // the same convention.
  const foreignKeyAttribute = `${reverse.label}Id`;
  const foreignKeyValue = linked ? parentId : null;
  // Values from a pending `update`/`merge` on the same entity: a link is what
  // materialises a newly created child, so it has to carry them.
  const values = pendingValues?.get(childId) ?? {};

  updateOccurrences(data, childId, {
    ...values,
    [foreignKeyAttribute]: foreignKeyValue,
  });

  const childEntities = data[reverse.on];
  if (Array.isArray(childEntities)) {
    const exists = childEntities.some((entity) => entityId(entity) === childId);
    if (!exists) {
      childEntities.push({
        id: childId,
        ...values,
        [foreignKeyAttribute]: foreignKeyValue,
      });
    }
  }

  // Snapshot the child before detaching: for a move its only home is the old
  // parent's list, so it would otherwise be rebuilt from the FK alone and lose
  // every other attribute until the server pushes.
  const child =
    findEntity(data, childId) ??
    ({
      id: childId,
      ...values,
      [foreignKeyAttribute]: foreignKeyValue,
    } as QueryEntity);

  // Moving a child to another parent must also detach it from the previous one,
  // otherwise the card renders under both parents until the server pushes.
  // The parent entities are nested (board -> columns), so walk the tree.
  if (linked && forward.has === "many") {
    detachFromLabel(data, forward.label, childId);
  }

  for (const parent of findEntities(data, parentId)) {
    if (forward.has === "many") {
      const current = parent[forward.label];
      const list = Array.isArray(current)
        ? current.filter((entity) => entityId(entity) !== childId)
        : [];
      if (linked) list.push({ ...child });
      parent[forward.label] = list;
    } else {
      parent[forward.label] = linked ? { ...child } : null;
    }
  }
}

/** Removes `childId` from every array stored under `label`, at any depth. */
function detachFromLabel(node: unknown, label: string, childId: string): void {
  if (Array.isArray(node)) {
    for (const item of node) detachFromLabel(item, label, childId);
    return;
  }
  if (!isRecord(node)) return;

  for (const [key, value] of Object.entries(node)) {
    if (key === label && Array.isArray(value)) {
      node[key] = value.filter((entry) => entityId(entry) !== childId);
      continue;
    }
    if (typeof value === "object" && value !== null) {
      detachFromLabel(value, label, childId);
    }
  }
}

/** Mutates every entity object with `id`, at any nesting level. */
function updateOccurrences(
  node: unknown,
  id: string,
  values: Record<string, unknown>
): void {
  if (Array.isArray(node)) {
    for (const item of node) updateOccurrences(item, id, values);
    return;
  }
  if (!isRecord(node)) return;

  if (node.id === id) Object.assign(node, values);

  for (const [key, value] of Object.entries(node)) {
    if (key === "id") continue;
    if (typeof value === "object" && value !== null) {
      updateOccurrences(value, id, values);
    }
  }
}

/** Removes every entity object with `id` from arrays, at any nesting level. */
function removeOccurrences(node: unknown, id: string): void {
  if (Array.isArray(node)) {
    for (let index = node.length - 1; index >= 0; index -= 1) {
      if (entityId(node[index]) === id) {
        node.splice(index, 1);
      } else {
        removeOccurrences(node[index], id);
      }
    }
    return;
  }
  if (!isRecord(node)) return;

  for (const [key, value] of Object.entries(node)) {
    if (key === "id") continue;
    if (isRecord(value) && entityId(value) === id) {
      // A nested one-to-one link to the deleted entity loses its target.
      node[key] = null;
      continue;
    }
    if (typeof value === "object" && value !== null) {
      removeOccurrences(value, id);
    }
  }
}

function findEntity(data: QueryResult, id: string): QueryEntity | undefined {
  const found = findEntities(data, id);
  return found[0];
}

function findEntities(data: QueryResult, id: string): QueryEntity[] {
  const found: QueryEntity[] = [];
  collectEntities(data, id, found, new Set());
  return found;
}

function collectEntities(
  node: unknown,
  id: string,
  found: QueryEntity[],
  visited: Set<unknown>
): void {
  if (typeof node !== "object" || node === null) return;
  if (visited.has(node)) return;
  visited.add(node);

  if (Array.isArray(node)) {
    for (const item of node) collectEntities(item, id, found, visited);
    return;
  }

  const record = node as QueryEntity;
  if (record.id === id) found.push(record);
  for (const value of Object.values(record)) {
    if (typeof value === "object" && value !== null) {
      collectEntities(value, id, found, visited);
    }
  }
}
