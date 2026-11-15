/**
 * `db.$across(ids)`: reads over several workspaces, each asked with its own
 * claim through the real engine, merged on the client.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { MemoryOutbox } from "../src/client/outbox";
import { configureMigrations } from "../src/engine/migrations-bundle";
import { executeQueryWithPageInfo } from "../src/engine/query-execute";
import { configureRegistry } from "../src/engine/registry";
import { configurePermissions } from "../src/engine/tx-permissions";
import type { SqlExecutor, SqlRow, SqlValue } from "../src/engine/tx-sql";
import { runTransaction } from "../src/engine/tx-pipeline";
import { TxError } from "../src/engine/tx-types";
import { AcrossError, acrossModel } from "../src/model/across";
import { createClient, type LiveState } from "../src/model/client";
import { model, schema, t } from "../src/schema";

const A = "6f1c2f3e-6b1a-4c9a-9a6f-00000000000a";
const B = "6f1c2f3e-6b1a-4c9a-9a6f-00000000000b";
const C = "6f1c2f3e-6b1a-4c9a-9a6f-00000000000c";

const appSchema = schema({
  task: model({ title: t.string(), points: t.number().optional(), done: t.boolean().default(false) }),
});

let databases: Map<string, SqlExecutor>;
let tokensSeen: string[];
let failing: Set<string>;

function executor(db: Database): SqlExecutor {
  return {
    exec: (q: string, ...p: SqlValue[]) => db.query(q).run(...(p as never[])).changes,
    all: <T extends SqlRow = SqlRow>(q: string, ...p: SqlValue[]) => db.query(q).all(...(p as never[])) as T[],
    one: <T extends SqlRow = SqlRow>(q: string, ...p: SqlValue[]) => (db.query(q).get(...(p as never[])) ?? undefined) as T | undefined,
    transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
  };
}

function claim(workspaceId: string): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "alice", workspaceId, role: WORKSPACE_ROLE_LEVELS.EDITOR, exp: now + 600, iat: now };
}

/** One engine per workspace, chosen by the URL; the token must name that workspace. */
async function engine(url: string, init: { method: string; headers: Record<string, string>; body?: string }) {
  const workspaceId = /\/workspaces\/([^/]+)\//.exec(url)?.[1] ?? "";
  tokensSeen.push(`${workspaceId}:${init.headers.authorization}`);
  if (init.headers.authorization !== `Bearer token-${workspaceId}`) {
    return Response.json({ ok: false, error: { code: "claim_invalid", message: "wrong workspace" } }, { status: 401 });
  }
  if (failing.has(workspaceId)) {
    return Response.json({ ok: false, error: { code: "workspace_recovering", message: "restoring" } }, { status: 409 });
  }
  const sql = databases.get(workspaceId)!;
  const body = init.body === undefined ? undefined : JSON.parse(init.body);
  try {
    if (url.endsWith("/transact")) return Response.json({ ok: true, result: runTransaction(sql, workspaceId, claim(workspaceId), body) });
    if (url.endsWith("/query")) {
      const { data, pageInfo } = executeQueryWithPageInfo(sql, claim(workspaceId), body);
      return Response.json({ ok: true, data, pageInfo });
    }
  } catch (error) {
    if (error instanceof TxError) return Response.json({ ok: false, error: error.toJSON() }, { status: 400 });
    throw error;
  }
  return Response.json({ ok: false, error: { code: "no_route", message: url } }, { status: 404 });
}

function client() {
  return createClient(
    { schema: appSchema, url: "http://engine.test", workspace: A, getToken: async () => `token-${A}` },
    { fetch: engine as never, outbox: new MemoryOutbox(), createWebSocket: () => { throw new Error("no socket in this test"); } }
  );
}
const tokens = { getToken: async (workspaceId: string) => `token-${workspaceId}` };

async function seed(workspaceId: string, titles: Array<string | [string, number | null]>) {
  const db = createClient(
    { schema: appSchema, url: "http://engine.test", workspace: workspaceId, getToken: async () => `token-${workspaceId}` },
    { fetch: engine as never, outbox: new MemoryOutbox(), createWebSocket: () => { throw new Error("no socket"); } }
  );
  await db.$transaction(
    titles.map((entry) => {
      const [title, points] = typeof entry === "string" ? [entry, null] : entry;
      return db.task.create({ data: { title, ...(points === null ? {} : { points }) } });
    })
  );
}

beforeEach(() => {
  configureRegistry(appSchema.registry);
  configureMigrations(appSchema.migrations);
  configurePermissions(appSchema.permissions);
  databases = new Map();
  for (const id of [A, B, C]) {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of appSchema.migrations) db.exec(migration.sql);
    databases.set(id, executor(db));
  }
  tokensSeen = [];
  failing = new Set();
});

describe("$across", () => {
  test("findMany merges every workspace in order, each asked with its own claim", async () => {
    await seed(A, ["apple", "melon", "zucchini"]);
    await seed(B, ["banana", "kiwi"]);
    await seed(C, ["cherry", "lime", "yam"]);
    const db = client();
    tokensSeen = [];

    const rows = await db.$across([A, B, C], tokens).task.findMany({ orderBy: { title: "asc" } });
    expect(rows.map((row) => row.title)).toEqual(["apple", "banana", "cherry", "kiwi", "lime", "melon", "yam", "zucchini"]);
    expect(rows.find((row) => row.title === "kiwi")?.workspaceId).toBe(B);
    expect(new Set(tokensSeen)).toEqual(new Set([`${A}:Bearer token-${A}`, `${B}:Bearer token-${B}`, `${C}:Bearer token-${C}`]));

    const desc = await db.$across([A, B, C], tokens).task.findMany({ orderBy: { title: "desc" }, take: 3 });
    expect(desc.map((row) => row.title)).toEqual(["zucchini", "yam", "melon"]);

    const first = await db.$across([B, C], tokens).task.findFirst({ orderBy: { title: "desc" } });
    expect(first?.title).toBe("yam");
    expect(first?.workspaceId).toBe(C);
  });

  test("orders like SQLite: nulls first, numbers, text by its UTF-8 bytes", async () => {
    // UTF-16 puts the emoji (D83D) before U+FFFF; UTF-8 bytes put it after.
    await seed(A, [["￿", 3], ["b", null]]);
    await seed(B, [["😀", 1], ["a", 2]]);
    const db = client();
    const byTitle = await db.$across([A, B], tokens).task.findMany({ orderBy: { title: "asc" } });
    expect(byTitle.map((row) => row.title)).toEqual(["a", "b", "￿", "😀"]);
    const byPoints = await db.$across([A, B], tokens).task.findMany({ orderBy: { points: "asc" } });
    expect(byPoints.map((row) => row.points ?? null)).toEqual([null, 1, 2, 3]);
  });

  test("with select, the order field is read for the merge and not returned", async () => {
    await seed(A, [["a", 3]]);
    await seed(B, [["b", 1]]);
    const rows = await client().$across([A, B], tokens).task.findMany({ select: { title: true }, orderBy: { points: "asc" } });
    expect(rows).toEqual([
      { title: "b", workspaceId: B },
      { title: "a", workspaceId: A },
    ]);
  });

  test("findPage walks every row of every workspace once, in order", async () => {
    await seed(A, Array.from({ length: 7 }, (_, n) => `a${n}`));
    await seed(B, ["a3x", "b0"]);
    await seed(C, Array.from({ length: 11 }, (_, n) => `c${String(n).padStart(2, "0")}`));
    const db = client();
    const all = (await db.$across([A, B, C], tokens).task.findMany({ orderBy: { title: "asc" } })).map((row) => row.title);
    expect(all).toHaveLength(20);

    for (const take of [1, 3, 4, 20, 50]) {
      const seen: string[] = [];
      let after: string | null = null;
      for (let pages = 0; ; pages += 1) {
        expect(pages).toBeLessThan(40);
        const page = await db.$across([A, B, C], tokens).task.findPage({ orderBy: { title: "asc" }, take, after });
        expect(page.rows.length).toBeLessThanOrEqual(take);
        seen.push(...page.rows.map((row) => row.title));
        if (!page.hasMore) {
          expect(page.cursor).toBeNull();
          break;
        }
        after = page.cursor;
      }
      expect(seen).toEqual(all);
    }
  });

  test("count sums the workspaces", async () => {
    await seed(A, ["a", "b"]);
    await seed(B, ["c"]);
    await seed(C, []);
    expect(await client().$across([A, B, C], tokens).task.count()).toBe(3);
    expect(await client().$across([A, B, C], tokens).task.count({ where: { title: "c" } })).toBe(1);
  });

  test("a workspace that fails rejects with AcrossError, the others' rows in partial", async () => {
    await seed(A, ["a"]);
    await seed(B, ["b"]);
    failing.add(B);
    const error = await client().$across([A, B], tokens).task.findMany().then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(AcrossError);
    const across = error as AcrossError<Array<{ title: string }>>;
    expect(Object.keys(across.errors)).toEqual([B]);
    expect(across.partial.map((row) => row.title)).toEqual(["a"]);
  });

  test("needs a token per workspace when the client has its own getToken", () => {
    expect(() => client().$across([A, B])).toThrow(/getToken\(workspaceId\)/);
    expect(() => client().$across([])).toThrow(/at least one/);
  });

  test("a cursor from elsewhere is refused", async () => {
    await expect(Promise.resolve(client().$across([A, B], tokens).task.findPage({ after: "not-a-cursor" }))).rejects.toThrow(/\$across/);
  });
});

describe("$across live", () => {
  /** A workspace query whose state the test sets. */
  function liveModel(name: string, initial: LiveState<Record<string, unknown>[]>) {
    let listener: ((state: LiveState<Record<string, unknown>[]>) => void) | null = null;
    let state = initial;
    const query = {
      key: name,
      then: (resolve: (rows: unknown) => unknown) => Promise.resolve(state.data).then(resolve),
      subscribe(next: (state: LiveState<Record<string, unknown>[]>) => void) {
        listener = next;
        next(state);
        return () => {
          listener = null;
        };
      },
      snapshot: () => state,
    };
    return {
      model: { findMany: () => query, findPage: () => Promise.resolve({ rows: [], hasMore: false, cursor: null }), count: () => query },
      set(next: LiveState<Record<string, unknown>[]>) {
        state = next;
        listener?.(next);
      },
      get open() {
        return listener !== null;
      },
    };
  }

  test("merges live states, keeps answering workspaces' rows, and names the failing ones", () => {
    const a = liveModel("a", { data: [{ id: "1", title: "b" }], isLoading: false, error: null });
    const b = liveModel("b", { data: undefined, isLoading: true, error: null });
    const across = acrossModel([
      { workspaceId: A, model: a.model as never },
      { workspaceId: B, model: b.model as never },
    ]);
    const states: Array<{ titles: unknown; isLoading: boolean; errors: string[] }> = [];
    const stop = across.findMany({ orderBy: { title: "asc" } }).subscribe((state) =>
      states.push({ titles: state.data?.map((row) => row.title), isLoading: state.isLoading, errors: Object.keys(state.errors) })
    );
    expect(states.at(-1)).toEqual({ titles: ["b"], isLoading: true, errors: [] });

    b.set({ data: [{ id: "2", title: "a" }], isLoading: false, error: null });
    expect(states.at(-1)).toEqual({ titles: ["a", "b"], isLoading: false, errors: [] });

    b.set({ data: undefined, isLoading: false, error: { code: "permission_denied", message: "no" } as never });
    expect(states.at(-1)).toEqual({ titles: ["b"], isLoading: false, errors: [B] });

    stop();
    expect(a.open || b.open).toBe(false);
  });

  test("a query made again returns the same snapshot until something changes (useLive)", () => {
    const a = liveModel("a2", { data: [{ id: "1", title: "b" }], isLoading: false, error: null });
    const b = liveModel("b2", { data: [{ id: "2", title: "a" }], isLoading: false, error: null });
    const make = () =>
      acrossModel([
        { workspaceId: A, model: a.model as never },
        { workspaceId: B, model: b.model as never },
      ]).findMany({ orderBy: { title: "asc" } });
    const first = make().snapshot();
    expect(make().snapshot()).toBe(first);
    expect(make().key).toBe(make().key);
    b.set({ data: [{ id: "2", title: "c" }], isLoading: false, error: null });
    const changed = make().snapshot();
    expect(changed).not.toBe(first);
    expect(changed.data?.map((row) => row.title)).toEqual(["b", "c"]);
  });
});
