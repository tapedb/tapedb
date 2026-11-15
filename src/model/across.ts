/**
 * `db.$across(workspaceIds)`: reads over several workspaces.
 *
 * Each workspace is its own database with its own claim, so the client asks
 * each one with that workspace's token and merges the answers. There is no
 * server-side fan-out: the Worker would need a claim for every workspace.
 * Writes stay per workspace (one writer each, one serializable log each).
 */

import type { QueryError } from "../client/types";
import type { LiveState, Page } from "./client";

/** The reads `$across` offers for one model. */
export interface AcrossModelClient<R> {
  /** Every workspace's rows, merged in `orderBy` order and cut to `take`. */
  findMany(args?: AcrossFindArgs): AcrossQuery<Array<R & { workspaceId: string }>>;
  /** The first row in `orderBy` order across the workspaces. */
  findFirst(args?: AcrossFindArgs): AcrossQuery<(R & { workspaceId: string }) | null>;
  /** One page in a stable order; `cursor` holds a position per workspace. */
  findPage(args?: AcrossFindArgs & { after?: string | null }): PromiseLike<Page<R & { workspaceId: string }>>;
  /** The number of matching rows over all the workspaces. */
  count(args?: { where?: unknown }): AcrossQuery<number>;
}

export interface AcrossFindArgs {
  where?: unknown;
  orderBy?: unknown;
  take?: number;
  include?: unknown;
  select?: unknown;
}

/** Live state over several workspaces. `data` holds what the answering workspaces returned. */
export interface AcrossLiveState<T> extends LiveState<T> {
  /** The workspaces whose query failed, with their error. */
  errors: Record<string, QueryError>;
}

/** A failed workspace in a one-off read: the others' result is in `partial`. */
export class AcrossError<T = unknown> extends Error {
  constructor(
    readonly errors: Record<string, unknown>,
    readonly partial: T
  ) {
    super(
      `${Object.keys(errors).length} of the workspaces failed: ` +
        Object.entries(errors)
          .map(([workspaceId, error]) => `${workspaceId}: ${error instanceof Error ? error.message : String(error)}`)
          .join("; ")
    );
    this.name = "AcrossError";
  }
}

export interface AcrossQuery<T> extends PromiseLike<T> {
  /** Identifies the query: the workspaces and each workspace's query. */
  readonly key: string;
  /** Live results. The listener runs now, then on every change in any workspace. */
  subscribe(listener: (state: AcrossLiveState<T>) => void): () => void;
  /** The current live state; referentially stable while nothing changed (`useLive`). */
  snapshot(): AcrossLiveState<T>;
}

// ---- What a workspace client gives us ---------------------------------------

interface SingleQuery<T> extends PromiseLike<T> {
  readonly key: string;
  subscribe(listener: (state: LiveState<T>) => void): () => void;
  snapshot(): LiveState<T>;
}

interface SingleModel {
  findMany(args?: unknown): SingleQuery<Record<string, unknown>[]>;
  findPage(args?: unknown): PromiseLike<Page<Record<string, unknown>>>;
  count(args?: unknown): SingleQuery<number>;
}

export type WorkspaceClients = Array<{ workspaceId: string; model: SingleModel }>;

// ---- Ordering ---------------------------------------------------------------

type Order = Array<[string, "asc" | "desc"]>;

function orderOf(orderBy: unknown): Order {
  if (orderBy === undefined) return [];
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  const order: Order = [];
  for (const entry of list as Record<string, "asc" | "desc">[]) {
    for (const [field, direction] of Object.entries(entry)) order.push([field, direction]);
  }
  return order;
}

const utf8 = new TextEncoder();

/** SQLite's order: NULL, then numbers, then text by bytes. */
function compareValues(a: unknown, b: unknown): number {
  const rank = (value: unknown) => (value === null || value === undefined ? 0 : typeof value === "string" ? 2 : 1);
  const scalar = (value: unknown) =>
    value instanceof Date ? value.getTime() : typeof value === "boolean" ? Number(value) : value;
  const left = scalar(a);
  const right = scalar(b);
  const byRank = rank(left) - rank(right);
  if (byRank !== 0) return byRank;
  if (rank(left) === 0) return 0;
  if (typeof left === "number" && typeof right === "number") return left - right;
  const x = utf8.encode(String(left));
  const y = utf8.encode(String(right));
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

function comparator(order: Order) {
  return (a: Record<string, unknown>, b: Record<string, unknown>) => {
    for (const [field, direction] of order) {
      const compared = compareValues(a[field], b[field]);
      if (compared !== 0) return direction === "asc" ? compared : -compared;
    }
    return 0;
  };
}

/**
 * Merges lists that are each already in `order`. Ties keep the earlier
 * workspace first. Returns the merged rows and how many each list gave.
 */
function merge(
  lists: Array<{ workspaceId: string; rows: Record<string, unknown>[] }>,
  order: Order,
  take: number | undefined
): { rows: Array<Record<string, unknown> & { workspaceId: string }>; used: number[] } {
  const compare = comparator(order);
  const used = lists.map(() => 0);
  const rows: Array<Record<string, unknown> & { workspaceId: string }> = [];
  for (;;) {
    if (take !== undefined && rows.length >= take) break;
    let best = -1;
    for (let index = 0; index < lists.length; index += 1) {
      if (used[index] >= lists[index].rows.length) continue;
      if (best === -1) {
        best = index;
        continue;
      }
      if (order.length > 0 && compare(lists[index].rows[used[index]], lists[best].rows[used[best]]) < 0) best = index;
    }
    if (best === -1) break;
    rows.push({ ...lists[best].rows[used[best]], workspaceId: lists[best].workspaceId });
    used[best] += 1;
  }
  return { rows, used };
}

// ---- Selecting the fields the merge orders by ------------------------------

/** With `select`, the order fields are read too and removed again afterwards. */
function withOrderFields(args: AcrossFindArgs, order: Order): { args: AcrossFindArgs; extra: string[] } {
  if (args.select === undefined || args.select === null || typeof args.select !== "object") return { args, extra: [] };
  const select = args.select as Record<string, unknown>;
  const extra = order.map(([field]) => field).filter((field) => !select[field]);
  if (extra.length === 0) return { args, extra };
  return { args: { ...args, select: { ...select, ...Object.fromEntries(extra.map((field) => [field, true])) } }, extra };
}

function strip<R extends Record<string, unknown>>(rows: R[], extra: string[]): R[] {
  if (extra.length === 0) return rows;
  return rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    for (const field of extra) delete copy[field];
    return copy as R;
  });
}

// ---- Fan-out ----------------------------------------------------------------

async function settle<T>(
  clients: WorkspaceClients,
  read: (model: SingleModel, index: number) => PromiseLike<T>
): Promise<{ values: Array<T | undefined>; errors: Record<string, unknown> }> {
  const settled = await Promise.allSettled(clients.map(({ model }, index) => Promise.resolve(read(model, index))));
  const errors: Record<string, unknown> = {};
  const values = settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    errors[clients[index].workspaceId] = result.reason;
    return undefined;
  });
  return { values, errors };
}

/** The latest view of each live `$across` query, by key; the oldest leave first. */
const snapshots = new Map<string, { states: unknown[]; view: unknown }>();
const SNAPSHOTS_KEPT = 1000;

function acrossQuery<S, T>(
  clients: WorkspaceClients,
  open: (model: SingleModel) => SingleQuery<S>,
  combine: (parts: Array<S | undefined>) => T
): AcrossQuery<T> {
  // One query per workspace, made once: a live subscription and its
  // snapshots belong to the same objects.
  const queries = clients.map(({ model }) => open(model));
  const key = `across:${JSON.stringify(clients.map(({ workspaceId }, index) => [workspaceId, queries[index].key]))}`;

  const snapshot = (): AcrossLiveState<T> => {
    const states = queries.map((query) => query.snapshot());
    // Keyed by the query, not this object: a component re-creates the query
    // every render, and `useSyncExternalStore` needs the same view back.
    const cached = snapshots.get(key) as { states: Array<LiveState<S>>; view: AcrossLiveState<T> } | undefined;
    if (cached && cached.states.length === states.length && cached.states.every((state, index) => state === states[index])) {
      return cached.view;
    }
    const errors: Record<string, QueryError> = {};
    states.forEach((state, index) => {
      if (state.error) errors[clients[index].workspaceId] = state.error;
    });
    const loading = states.some((state) => state.isLoading && !state.error);
    const anyData = states.some((state) => state.data !== undefined);
    const view: AcrossLiveState<T> = {
      data: anyData || !loading ? combine(states.map((state) => state.data)) : undefined,
      isLoading: loading,
      error: Object.values(errors)[0] ?? null,
      errors,
    };
    snapshots.delete(key);
    snapshots.set(key, { states, view });
    if (snapshots.size > SNAPSHOTS_KEPT) snapshots.delete(snapshots.keys().next().value as string);
    return view;
  };

  return {
    key,
    then(onFulfilled, onRejected) {
      return settle(clients, (_model, index) => queries[index])
        .then(({ values, errors }) => {
          const result = combine(values);
          if (Object.keys(errors).length > 0) throw new AcrossError(errors, result);
          return result;
        })
        .then(onFulfilled, onRejected);
    },
    subscribe(listener) {
      let ready = false;
      const stops = queries.map((query) =>
        query.subscribe(() => {
          if (ready) listener(snapshot());
        })
      );
      ready = true;
      listener(snapshot());
      return () => {
        for (const stop of stops) stop();
      };
    },
    snapshot,
  };
}

// ---- Page cursors -----------------------------------------------------------

/** A position per workspace: a workspace cursor, `null` at the start, `true` when done. */
type Positions = Record<string, string | null | true>;

function encodePositions(positions: Positions): string {
  const json = JSON.stringify(positions);
  const bytes = utf8.encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodePositions(cursor: string): Positions {
  try {
    const base64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Positions;
  } catch {
    throw new Error("This cursor is not from $across(...).findPage.");
  }
}

// ---- The client ---------------------------------------------------------------

export function acrossModel(clients: WorkspaceClients): AcrossModelClient<Record<string, unknown>> {
  const findMany = (args: AcrossFindArgs = {}) => {
    const order = orderOf(args.orderBy);
    const { args: read, extra } = withOrderFields(args, order);
    return acrossQuery(
      clients,
      (model) => model.findMany(read),
      (parts) =>
        strip(
          merge(
            parts.map((rows, index) => ({ workspaceId: clients[index].workspaceId, rows: rows ?? [] })),
            order,
            args.take
          ).rows,
          extra
        )
    );
  };

  return {
    findMany,
    findFirst(args = {}) {
      const many = findMany({ ...args, take: 1 });
      const first = () => {
        const from = many.snapshot() as AcrossLiveState<unknown[]>;
        const key = `first:${many.key}`;
        const cached = snapshots.get(key);
        if (cached?.states[0] === from) return cached.view as AcrossLiveState<(Record<string, unknown> & { workspaceId: string }) | null>;
        const view = { ...from, data: from.data === undefined ? undefined : (from.data[0] ?? null) };
        snapshots.delete(key);
        snapshots.set(key, { states: [from], view });
        return view as AcrossLiveState<(Record<string, unknown> & { workspaceId: string }) | null>;
      };
      return {
        then: (onFulfilled, onRejected) =>
          many.then(
            (rows) => rows[0] ?? null,
            (error: unknown) => {
              if (error instanceof AcrossError) throw new AcrossError(error.errors, (error.partial as unknown[])[0] ?? null);
              throw error;
            }
          ).then(onFulfilled, onRejected),
        key: `first:${many.key}`,
        subscribe: (listener) => many.subscribe(() => listener(first())),
        snapshot: () => first(),
      };
    },

    findPage(args = {}) {
      const { after, ...rest } = args;
      const take = rest.take ?? 50;
      const orderBy = rest.orderBy ?? { id: "asc" };
      const order = orderOf(orderBy);
      const { args: read, extra } = withOrderFields({ ...rest, orderBy, take }, order);
      return {
        then(onFulfilled, onRejected) {
          const run = async () => {
            const positions: Positions = after ? decodePositions(after) : {};
            const open = clients.filter(({ workspaceId }) => positions[workspaceId] !== true);
            const fetched = await settle(open, (model, index) => {
              const position = positions[open[index].workspaceId];
              return model.findPage({ ...read, ...(typeof position === "string" ? { after: position } : {}) });
            });
            const pages = fetched.values;
            const merged = merge(
              open.map(({ workspaceId }, index) => ({ workspaceId, rows: pages[index]?.rows ?? [] })),
              order,
              take
            );
            // Each workspace moves past the rows this page used from it. A
            // page used in part gets the cursor after its last used row.
            const next: Positions = { ...positions };
            await Promise.all(
              open.map(async ({ workspaceId, model }, index) => {
                const page = pages[index];
                if (page === undefined) return;
                const used = merged.used[index];
                if (used === page.rows.length) {
                  next[workspaceId] = page.hasMore && page.cursor !== null ? page.cursor : true;
                } else if (used > 0) {
                  const position = positions[workspaceId];
                  const partial = await model.findPage({
                    ...read,
                    take: used,
                    ...(typeof position === "string" ? { after: position } : {}),
                  });
                  next[workspaceId] = partial.cursor ?? true;
                }
              })
            );
            const hasMore = clients.some(({ workspaceId }) => next[workspaceId] !== true);
            const page = {
              rows: strip(merged.rows, extra),
              hasMore,
              cursor: hasMore ? encodePositions(next) : null,
            };
            if (Object.keys(fetched.errors).length > 0) throw new AcrossError(fetched.errors, page);
            return page;
          };
          return run().then(onFulfilled, onRejected);
        },
      } as PromiseLike<Page<Record<string, unknown> & { workspaceId: string }>>;
    },

    count(args = {}) {
      return acrossQuery(
        clients,
        (model) => model.count(args),
        (parts) => parts.reduce<number>((sum, part) => sum + (part ?? 0), 0)
      );
    },
  };
}
