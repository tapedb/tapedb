/**
 * What each model method sends: the engine query document and how its answer
 * becomes the method's result, or the transaction ops. Pure, so the client
 * and the studio's query editor run the same translation.
 */

import { id as newId } from "../client/id";
import type { AggregateGroup, QueryDocument, QueryPageInfo, QueryResult, TxOp } from "../client/types";
import type { ModelInfo, RelationInfo } from "./schema";
import { shapeFor, toEngineNode, toEngineWhere, type NodeArgs } from "./where";

/** Columns every row carries: readable and groupable, never writable. */
const SYSTEM_FIELDS = new Set(["createdAt", "updatedAt", "updatedSeq"]);

// ---- Writes ----------------------------------------------------------------

function inputValue(model: ModelInfo, field: string, value: unknown): unknown {
  return model.scalars[field]?.kind === "date" && value instanceof Date ? value.getTime() : value;
}

/** Splits write data into column values and the link ops for hasMany relations. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


interface SplitResult {
  values: Record<string, unknown>;
  /** Rows this one points at: inserted before it, so its key resolves. */
  before: TxOp[];
  /** Rows that point at this one, and link ops: applied after it exists. */
  after: TxOp[];
}

function splitData(
  graph: Record<string, ModelInfo>,
  model: ModelInfo,
  rowId: string,
  data: Record<string, unknown>,
  allowLinks: boolean
): SplitResult {
  const values: Record<string, unknown> = {};
  const before: TxOp[] = [];
  const after: TxOp[] = [];

  /** Expands a nested `create` into its own insert, recursively. */
  const nested = (relation: RelationInfo, input: Record<string, unknown>): string => {
    const target = graph[relation.target];
    const id = typeof input.id === "string" ? input.id : newId();
    const child = splitData(graph, target, id, input, true);
    const childValues = withDefaults(target, child.values);

    before.push(...child.before);
    before.push({ op: "insert", namespace: target.key, id, values: childValues });
    after.push(...child.after);
    return id;
  };

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || key === "id") continue;
    if (key in model.scalars) {
      values[key] = inputValue(model, key, value);
      continue;
    }
    if (model.filterable.has(key)) {
      // A foreign key written directly, e.g. columnId.
      values[key] = value;
      continue;
    }
    const relation = model.relations[key];
    if (!relation) {
      throw new Error(`"${model.key}" has no field "${key}".`);
    }
    if (relation.kind === "belongsTo") {
      const create = (value as { create?: unknown } | null)?.create;
      if (value === null || (value as { disconnect?: unknown }).disconnect === true) {
        values[relation.foreignKey!] = null;
      } else if (typeof (value as { connect?: unknown }).connect === "string") {
        values[relation.foreignKey!] = (value as { connect: string }).connect;
      } else if (isRecord(create)) {
        if (!allowLinks) {
          throw new Error(`"${model.key}.${key}": upsert cannot create related rows.`);
        }
        // The parent is inserted first, so this row's key points at a row
        // that exists by the time it is written.
        values[relation.foreignKey!] = nested(relation, create as Record<string, unknown>);
      } else {
        throw new Error(
          `"${model.key}.${key}" takes { connect: id }, { create: {...} }, { disconnect: true } or null.`
        );
      }
      continue;
    }
    if (!allowLinks) {
      throw new Error(`"${model.key}.${key}": connect children with create or update, not upsert.`);
    }
    const {
      connect = [],
      disconnect = [],
      create = [],
    } = value as { connect?: string[]; disconnect?: string[]; create?: Record<string, unknown>[] };
    for (const child of Array.isArray(create) ? create : [create]) {
      if (!isRecord(child)) {
        throw new Error(`"${model.key}.${key}.create" takes a row, or an array of rows.`);
      }
      // Children carry this row's key, so they are written after it exists.
      const childOps: TxOp[] = [];
      const target = graph[relation.target];
      const id = typeof child.id === "string" ? child.id : newId();
      const split = splitData(graph, target, id, child, true);
      const childValues = withDefaults(target, split.values);
      childValues[relation.foreignKey!] = rowId;
      childOps.push(...split.before, { op: "insert", namespace: target.key, id, values: childValues }, ...split.after);
      after.push(...childOps);
    }
    for (const targetId of connect) {
      after.push({ op: "link", namespace: model.key, id: rowId, link: relation.link, targetId });
    }
    for (const targetId of disconnect) {
      after.push({ op: "unlink", namespace: model.key, id: rowId, link: relation.link, targetId });
    }
  }

  return { values, before, after };
}

function withDefaults(model: ModelInfo, values: Record<string, unknown>): Record<string, unknown> {
  const filled = { ...values };
  for (const [field, scalar] of Object.entries(model.scalars)) {
    if (!(field in filled) && scalar.hasDefault) {
      filled[field] = inputValue(model, field, scalar.defaultValue);
    }
  }
  return filled;
}

function requireId(model: ModelInfo, where: { id?: unknown } | undefined): string {
  if (typeof where?.id !== "string" || where.id.length === 0) {
    throw new Error(`"${model.key}" writes address one row: pass where: { id }.`);
  }
  return where.id;
}

// ---- Aggregates ------------------------------------------------------------

function requireGroupKey(model: ModelInfo, field: unknown): string {
  if (typeof field !== "string" || !(SYSTEM_FIELDS.has(field) || model.filterable.has(field))) {
    throw new Error(`"${model.key}" cannot be grouped by "${String(field)}".`);
  }
  return field;
}

/** Fields named by one measure, checked against the model. */
function measureFields(
  model: ModelInfo,
  measure: string,
  value: unknown,
  accepts: (field: string) => boolean
): string[] {
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`"${model.key}.${measure}" takes an object of fields.`);
  }
  const fields: string[] = [];
  for (const [field, on] of Object.entries(value)) {
    if (on === undefined || on === false) continue;
    if (!accepts(field)) {
      throw new Error(`"${model.key}.${measure}" cannot measure "${field}".`);
    }
    fields.push(field);
  }
  return fields;
}

/**
 * Translates `_count` / `_sum` / `_avg` / `_min` / `_max` into the engine's
 * aggregate, and back from one engine group into the public shape.
 */
function aggregateMeasures(model: ModelInfo, args: Record<string, unknown>) {
  const kind = (field: string) => model.scalars[field]?.kind;
  const isRowField = (field: string) =>
    field === "id" || field === "createdAt" || field === "updatedAt" || field in model.scalars || model.filterable.has(field);
  const isNumber = (field: string) => kind(field) === "number";
  const isOrdered = (field: string) =>
    isRowField(field) && kind(field) !== "boolean" && kind(field) !== "json";

  const countArg = args._count;
  const countAll = countArg === true || (typeof countArg === "object" && countArg !== null && (countArg as { _all?: unknown })._all === true);
  const countOf =
    countArg === true || countArg === undefined || countArg === false
      ? []
      : measureFields(
          model,
          "_count",
          Object.fromEntries(Object.entries(countArg as object).filter(([field]) => field !== "_all")),
          isRowField
        );
  const sum = measureFields(model, "_sum", args._sum, isNumber);
  const avg = measureFields(model, "_avg", args._avg, isNumber);
  const min = measureFields(model, "_min", args._min, isOrdered);
  const max = measureFields(model, "_max", args._max, isOrdered);

  const engine: Record<string, unknown> = {};
  if (countAll) engine.count = true;
  if (countOf.length > 0) engine.countOf = countOf;
  if (sum.length > 0) engine.sum = sum;
  if (avg.length > 0) engine.avg = avg;
  if (min.length > 0) engine.min = min;
  if (max.length > 0) engine.max = max;

  const output = (group: AggregateGroup): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (countArg === true) {
      out._count = group.count ?? 0;
    } else if (typeof countArg === "object" && countArg !== null) {
      const counts: Record<string, number> = {};
      if (countAll) counts._all = group.count ?? 0;
      for (const field of countOf) counts[field] = group.countOf?.[field] ?? 0;
      out._count = counts;
    }
    if (args._sum !== undefined) out._sum = pick(sum, group.sum);
    if (args._avg !== undefined) out._avg = pick(avg, group.avg);
    if (args._min !== undefined) out._min = pick(min, group.min);
    if (args._max !== undefined) out._max = pick(max, group.max);
    return out;
  };
  return { engine, output };
}

function pick(fields: string[], values: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = values?.[field] ?? null;
  return out;
}


// ---- Plans -----------------------------------------------------------------

export type Project = (data: QueryResult, pageInfo: QueryPageInfo) => unknown;

export type Plan =
  /** A read: send `document`, then `project` the answer. `key` names the kind of query. */
  | { kind: "read"; key: "many" | "first" | "page" | "count" | "aggregate" | "groupBy"; document: QueryDocument; project: Project }
  /** A write of one row: `ops` in one transaction; `id` is the row's. */
  | { kind: "write"; ops: TxOp[]; id: string }
  /** updateMany / deleteMany: one op matching rows by a filter. */
  | { kind: "bulk"; op: TxOp };

export const READ_METHODS = ["findMany", "findFirst", "findUnique", "findPage", "count", "aggregate", "groupBy"] as const;
export const WRITE_METHODS = ["create", "update", "upsert", "delete", "updateMany", "deleteMany"] as const;

type Args = Record<string, unknown>;

/** The plan for `db.<model>.<method>(args)`. Throws on arguments the method rejects. */
export function plan(graph: Record<string, ModelInfo>, model: ModelInfo, method: string, input: unknown): Plan {
  const args = (input ?? {}) as Args;
  const document = (node: NodeArgs, extra: Args = {}): QueryDocument => ({
    [model.key]: toEngineNode(graph, model, node, extra) as QueryDocument[string],
  });
  const reader = (node: NodeArgs) => {
    const shape = shapeFor(graph, model, node);
    return (data: QueryResult) => {
      const list = (data[model.key] ?? []) as Record<string, unknown>[];
      return shape === null ? list : list.map(shape);
    };
  };

  switch (method) {
    case "findMany": {
      const rows = reader(args as NodeArgs);
      return { kind: "read", key: "many", document: document(args as NodeArgs), project: (data) => rows(data) };
    }
    case "findFirst": {
      const rows = reader(args as NodeArgs);
      return { kind: "read", key: "first", document: document({ ...(args as NodeArgs), take: 1 }), project: (data) => rows(data)[0] ?? null };
    }
    case "findUnique": {
      const rows = reader(args as NodeArgs);
      return {
        kind: "read",
        key: "first",
        document: document({
          where: { id: requireId(model, args.where as { id?: unknown }) },
          include: args.include as Args | undefined,
          select: args.select as Args | undefined,
          take: 1,
        }),
        project: (data) => rows(data)[0] ?? null,
      };
    }
    case "findPage": {
      const { after, ...rest } = args as NodeArgs & { after?: string | null };
      const rows = reader(rest);
      return {
        kind: "read",
        key: "page",
        document: document({ ...rest, orderBy: rest.orderBy ?? { id: "asc" }, take: rest.take ?? 50, ...(after ? { after } : {}) }),
        project: (data, pageInfo) => ({
          rows: rows(data),
          hasMore: pageInfo[model.key]?.hasMore ?? false,
          cursor: pageInfo[model.key]?.nextCursor ?? null,
        }),
      };
    }
    case "count":
      return {
        kind: "read",
        key: "count",
        document: document({ where: args.where }, { count: true, limit: 0 }),
        project: (_data, pageInfo) => pageInfo[model.key]?.count ?? 0,
      };
    case "aggregate": {
      const measures = aggregateMeasures(model, args);
      return {
        kind: "read",
        key: "aggregate",
        document: document({ where: args.where }, { limit: 0, aggregate: measures.engine }),
        project: (_data, pageInfo) => {
          const group = pageInfo[model.key]?.aggregate?.[0];
          return group === undefined ? null : measures.output(group);
        },
      };
    }
    case "groupBy": {
      const measures = aggregateMeasures(model, args);
      const by = args.by;
      if (!Array.isArray(by) || by.length === 0) {
        throw new Error(`"${model.key}.groupBy" needs a non-empty "by" array.`);
      }
      for (const field of by) requireGroupKey(model, field);
      const order: Record<string, "asc" | "desc"> = {};
      for (const [field, direction] of Object.entries((args.orderBy ?? {}) as Args)) {
        if (!by.includes(field)) {
          throw new Error(`"${model.key}.groupBy" can only order by a "by" field; "${field}" is not one.`);
        }
        if (direction !== "asc" && direction !== "desc") {
          throw new Error(`Order for "${model.key}.${field}" must be "asc" or "desc".`);
        }
        order[field] = direction;
      }
      const engine = {
        ...measures.engine,
        groupBy: by as string[],
        ...(Object.keys(order).length > 0 ? { order } : {}),
        ...(args.take !== undefined ? { limit: args.take } : {}),
      };
      return {
        kind: "read",
        key: "groupBy",
        document: document({ where: args.where }, { limit: 0, aggregate: engine }),
        project: (_data, pageInfo) =>
          (pageInfo[model.key]?.aggregate ?? []).map((group) => ({ ...group.key, ...measures.output(group) })),
      };
    }
    case "create": {
      const data = (args.data ?? {}) as Args;
      const rowId = typeof data.id === "string" ? data.id : newId();
      const { values, before, after } = splitData(graph, model, rowId, data, true);
      return {
        kind: "write",
        ops: [...before, { op: "insert", namespace: model.key, id: rowId, values: withDefaults(model, values) }, ...after],
        id: rowId,
      };
    }
    case "update": {
      const rowId = requireId(model, args.where as { id?: unknown });
      const { values, before, after } = splitData(graph, model, rowId, (args.data ?? {}) as Args, true);
      return { kind: "write", ops: [...before, { op: "patch", namespace: model.key, id: rowId, values }, ...after], id: rowId };
    }
    case "upsert": {
      const rowId = requireId(model, args.where as { id?: unknown });
      const created = splitData(graph, model, rowId, (args.create ?? {}) as Args, false);
      const updated = splitData(graph, model, rowId, (args.update ?? {}) as Args, false);
      return {
        kind: "write",
        ops: [{ op: "upsert", namespace: model.key, id: rowId, values: updated.values, create: withDefaults(model, created.values) }],
        id: rowId,
      };
    }
    case "delete": {
      const rowId = requireId(model, args.where as { id?: unknown });
      return { kind: "write", ops: [{ op: "delete", namespace: model.key, id: rowId }], id: rowId };
    }
    case "updateMany": {
      const { values, after } = splitData(graph, model, "", (args.data ?? {}) as Args, false);
      if (after.length > 0) {
        throw new Error(`"${model.key}.updateMany" cannot connect or disconnect relations.`);
      }
      return {
        kind: "bulk",
        op: { op: "patchMany", namespace: model.key, where: toEngineWhere(model, args.where as never, graph) as Args, values },
      };
    }
    case "deleteMany":
      return {
        kind: "bulk",
        op: { op: "deleteMany", namespace: model.key, where: toEngineWhere(model, args.where as never, graph) as Args },
      };
    default:
      throw new Error(`"${model.key}" has no method "${method}".`);
  }
}
