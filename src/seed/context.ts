/**
 * What a seeder writes through.
 *
 * The seeder brings the values; this brings the bookkeeping: ids, batching
 * through the real transaction path, parent references, uniqueness against the
 * declared `unique()` columns, and clearing in dependency order.
 *
 * Data goes over the engine's own routes, so claims, access rules, the tape and
 * the history all behave exactly as they do for the app. Nothing here reaches
 * around the engine.
 */

import type { Models, RelationInfo, Schema } from "../model/schema";
import { Random } from "./rng";

export interface SeedOp {
  op: "insert" | "delete";
  namespace: string;
  id: string;
  values?: Record<string, unknown>;
}

export interface SeedTransport {
  transact(ops: SeedOp[]): Promise<{ seq: number; applied: number }>;
  query(document: Record<string, unknown>): Promise<Record<string, unknown[]>>;
}

/** One model, as a seeder can introspect it. */
export interface SeedModel {
  key: string;
  table: string;
  fields: Record<
    string,
    {
      kind: string;
      optional: boolean;
      hasDefault: boolean;
      /** The declared default, as the client would send it. */
      defaultValue?: unknown;
      unique: boolean;
      personal: boolean;
    }
  >;
  relations: Record<string, RelationInfo>;
}

export interface SeedContextOptions<M extends Models> {
  schema: Schema<M>;
  transport: SeedTransport;
  seed: string;
  /** Restrict writes to these models; anything else is refused. */
  models?: readonly string[];
}

type Row = Record<string, unknown>;

const BATCH_OPS = 500;

export class SeedContext<M extends Models = Models> {
  /** The run's stream. Use `rngFor` for anything that must be stable per row. */
  readonly rng: Random;
  private readonly schema: Schema<M>;
  private readonly transport: SeedTransport;
  private readonly seed: string;
  private readonly allowed: Set<string> | null;
  private readonly writes = new Map<string, number>();
  private readonly uniques = new Map<string, Set<string>>();
  private readonly ids = new Map<string, string[]>();

  constructor(options: SeedContextOptions<M>) {
    this.schema = options.schema;
    this.transport = options.transport;
    this.seed = options.seed;
    this.rng = new Random(options.seed);
    this.allowed = options.models === undefined ? null : new Set(options.models);
  }

  /** A stream that depends only on `label`, not on what the run did first. */
  rngFor(label: string): Random {
    return new Random(`${this.seed}/${label}`);
  }

  /** The fields, flags and relations of one model. */
  model(key: string): SeedModel {
    const namespace = this.registryNamespace(key);
    const info = this.schema.graph[key];
    const fields: SeedModel["fields"] = {};
    for (const [name, attribute] of Object.entries(namespace.attributes)) {
      const scalar = info?.scalars[name];
      fields[name] = {
        kind: attribute.type,
        optional: attribute.optional === true,
        hasDefault: attribute.default !== undefined && attribute.default !== null,
        defaultValue: scalar?.hasDefault === true ? scalar.defaultValue : attribute.default,
        unique: attribute.unique === true,
        personal: attribute.personal !== undefined,
      };
    }
    return {
      key,
      table: namespace.table,
      fields,
      relations: (this.schema.graph[key]?.relations ?? {}) as Record<string, RelationInfo>,
    };
  }

  /** Every model the schema defines. */
  models(): string[] {
    return Object.keys(this.schema.graph);
  }

  /**
   * Writes rows, one transaction per batch, and answers the ids it wrote.
   *
   * Values are checked before they are sent: an unknown field, a missing
   * required field, or a personal field is refused here rather than by the
   * engine, because the message can say what to do about it.
   */
  async insert(key: string, rows: readonly Row[]): Promise<string[]> {
    const model = this.model(key);
    this.assertWritable(key);

    const prepared = rows.map((row, index) => this.prepare(key, model, row, index));
    for (let offset = 0; offset < prepared.length; offset += BATCH_OPS) {
      const batch = prepared.slice(offset, offset + BATCH_OPS);
      await this.transport.transact(
        batch.map(({ id, values }) => ({ op: "insert" as const, namespace: key, id, values }))
      );
    }

    const written = prepared.map(({ id }) => id);
    this.writes.set(key, (this.writes.get(key) ?? 0) + written.length);
    this.ids.delete(key);
    return written;
  }

  /** Builds `count` rows and writes them. */
  async create(
    key: string,
    count: number,
    build: (rng: Random, index: number) => Row
  ): Promise<string[]> {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`create("${key}") takes a whole count, not ${String(count)}.`);
    }
    const rows: Row[] = [];
    for (let index = 0; index < count; index += 1) {
      rows.push(build(this.rngFor(`${key}#${index}`), index));
    }
    return this.insert(key, rows);
  }

  /** The ids already in one model. */
  async listIds(key: string): Promise<string[]> {
    const known = this.ids.get(key);
    if (known !== undefined) return known;
    const data = await this.transport.query({ [key]: { $: { select: ["id"] } } });
    const rows = (data[key] ?? []) as Array<{ id?: unknown }>;
    const found = rows.map((row) => String(row.id));
    this.ids.set(key, found);
    return found;
  }

  /** One id from a list, for a foreign key. */
  ref(ids: readonly string[]): string {
    if (ids.length === 0) throw new Error("ref() was given no ids to choose from.");
    return this.rng.pick(ids);
  }

  /**
   * A value that satisfies a `unique()` column: the generator is retried until
   * it produces one this run has not used.
   */
  unique(key: string, field: string, generate: (rng: Random) => string): string {
    const slot = `${key}.${field}`;
    let used = this.uniques.get(slot);
    if (used === undefined) {
      used = new Set<string>();
      this.uniques.set(slot, used);
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = generate(this.rngFor(`${slot}#${attempt}`));
      if (!used.has(value)) {
        used.add(value);
        return value;
      }
    }
    throw new Error(
      `unique("${key}", "${field}") ran out of values after 100 attempts; widen the generator.`
    );
  }

  /**
   * Deletes every row of one model, or of every model children first, so
   * foreign keys never block the order.
   */
  async clear(key?: string): Promise<number> {
    const order = key === undefined ? this.deleteOrder() : [key];
    let removed = 0;
    for (const model of order) {
      this.assertWritable(model);
      const ids = await this.listIds(model);
      for (let offset = 0; offset < ids.length; offset += BATCH_OPS) {
        const batch = ids.slice(offset, offset + BATCH_OPS);
        await this.transport.transact(
          batch.map((id) => ({ op: "delete" as const, namespace: model, id }))
        );
        removed += batch.length;
      }
      this.ids.delete(model);
    }
    return removed;
  }

  /** Rows written per model in this run. */
  written(): Record<string, number> {
    return Object.fromEntries([...this.writes.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  private prepare(key: string, model: SeedModel, row: Row, index: number): { id: string; values: Row } {
    const values: Row = {};
    for (const [field, value] of Object.entries(row)) {
      if (field === "id") continue;
      const declared = model.fields[field];
      if (declared === undefined) {
        throw new Error(
          `"${key}.${field}" is not a field of that model. Fields: ${Object.keys(model.fields).join(", ")}.`
        );
      }
      if (declared.personal) {
        throw new Error(
          `"${key}.${field}" is a personal field. Seeded personal data has to go through the app's own write path, which owns the encryption key; a seeder cannot write it. Take the field out of the seed row.`
        );
      }
      values[field] = declared.kind === "date" && value instanceof Date ? value.getTime() : value;
    }

    // The engine wants every column named, so a declared default is filled here
    // rather than left to the insert.
    for (const [field, declared] of Object.entries(model.fields)) {
      if (field in values || !declared.hasDefault) continue;
      values[field] = declared.defaultValue;
    }

    const missing = Object.entries(model.fields)
      .filter(([field, declared]) => !declared.optional && !declared.hasDefault && !(field in values))
      .map(([field]) => field);
    if (missing.length > 0) {
      throw new Error(`"${key}" row ${index + 1} is missing required field(s): ${missing.join(", ")}.`);
    }

    const id = typeof row.id === "string" && row.id.length > 0
      ? row.id
      : this.rngFor(`${key}#${index}#id`).uuid();
    return { id, values };
  }

  private assertWritable(key: string): void {
    if (!(key in this.schema.graph)) {
      throw new Error(`There is no model "${key}". Models: ${this.models().join(", ")}.`);
    }
    if (this.allowed !== null && !this.allowed.has(key)) {
      throw new Error(`This run is restricted to ${[...this.allowed].join(", ")} and cannot write "${key}".`);
    }
  }

  private registryNamespace(key: string) {
    const found = this.schema.registry.namespaces.find((namespace) => namespace.apiName === key);
    if (found === undefined) throw new Error(`There is no model "${key}".`);
    return found;
  }

  /** Models ordered so children empty before their parents. */
  private deleteOrder(): string[] {
    const depth = new Map<string, number>(this.models().map((key) => [key, 0]));
    for (let pass = 0; pass < depth.size; pass += 1) {
      let moved = false;
      for (const link of this.schema.registry.links) {
        const child = link.reverse.namespace;
        const parent = link.forward.namespace;
        const childDepth = depth.get(child);
        const parentDepth = depth.get(parent);
        if (childDepth === undefined || parentDepth === undefined) continue;
        if (childDepth <= parentDepth) {
          depth.set(child, parentDepth + 1);
          moved = true;
        }
      }
      if (!moved) break;
    }
    return [...depth.entries()].sort(([, a], [, b]) => b - a).map(([key]) => key);
  }
}

/** Reaches a running Worker, the way `tapedb export` does. */
export function httpTransport(options: {
  url: string;
  workspace: string;
  token: string;
  fetch?: typeof fetch;
}): SeedTransport {
  const base = options.url.replace(/\/+$/, "");
  const send = options.fetch ?? fetch;
  const auth = { authorization: `Bearer ${options.token}`, "content-type": "application/json" };

  const call = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const response = await send(`${base}/engine/workspaces/${options.workspace}/${path}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = text === "" ? null : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      parsed = null;
    }
    if (!response.ok || parsed?.ok === false) {
      const error = (parsed?.error ?? {}) as { code?: string; message?: string };
      throw new Error(
        `${path} failed (${response.status}${error.code === undefined ? "" : ` ${error.code}`}): ${error.message ?? text.slice(0, 200)}`
      );
    }
    return parsed ?? {};
  };

  return {
    async transact(ops) {
      const body = await call("transact", { txId: crypto.randomUUID(), ops });
      const result = (body.result ?? {}) as { seq?: number; applied?: number };
      return { seq: result.seq ?? 0, applied: result.applied ?? ops.length };
    },
    async query(document) {
      const body = await call("query", { query: document });
      return (body.data ?? {}) as Record<string, unknown[]>;
    },
  };
}

/** Keeps queries live and swallows writes, for `--dry-run`. */
export function dryTransport(inner: SeedTransport, onOp: (ops: readonly SeedOp[]) => void): SeedTransport {
  return {
    query: (document) => inner.query(document),
    async transact(ops) {
      onOp(ops);
      return { seq: 0, applied: ops.length };
    },
  };
}
