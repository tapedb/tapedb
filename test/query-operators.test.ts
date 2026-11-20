/**
 * `isNull`, `like` and `ilike`.
 *
 * Before these existed a nullable column could only be tested with `{ due: null }`
 * — which the engine reads as `IS NULL` — and there was no way at all to ask
 * "is it set", nor to match text by shape. `startsWith`/`contains` helpers do
 * not exist either, so pattern matching needed a raw query.
 *
 * The parts worth pinning here are the ones whose meaning is easy to get wrong:
 *
 *   - `isNull: false` is `IS NOT NULL`, not a comparison with anything;
 *   - `like` is case-sensitive and `ilike` is not, which is why `like` compiles
 *     to `GLOB` (SQLite's `LIKE` folds ASCII case, even over blobs);
 *   - `%` and `_` are wildcards, `\%` and `\_` are not, and a stray backslash is
 *     refused instead of guessed at;
 *   - a pattern on a non-text column is an error, not a cast;
 *   - both compose with `$or`/`$not`, with relation modes, and reach a live
 *     subscription unchanged.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { MemoryOutbox } from "../src/client/outbox";
import { configureMigrations } from "../src/engine/migrations-bundle";
import { compileQuery } from "../src/engine/query-compile";
import {
  executeCompiledQueryWithPageInfo,
  executeQueryWithPageInfo,
} from "../src/engine/query-execute";
import { configureRegistry } from "../src/engine/registry";
import { configurePermissions } from "../src/engine/tx-permissions";
import type { SqlExecutor, SqlRow, SqlValue } from "../src/engine/tx-sql";
import { runTransaction } from "../src/engine/tx-pipeline";
import { createClient } from "../src/model/client";
import { toEngineWhere } from "../src/model/where";
import { model, schema, t } from "../src/schema";
import { defaultDeploymentConfig } from "../src/engine/config";

/** These tests run the unconfigured engine: audit off, role file rules, no webhooks. */
const engineConfig = defaultDeploymentConfig();

const WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";

const appSchema = schema({
  author: model({ name: t.string(), tasks: t.hasMany("task") }),
  task: model({
    title: t.string(),
    stage: t.string().optional(),
    due: t.date().optional(),
    points: t.number().optional(),
    author: t.belongsTo("author").optional(),
  }),
});

let sql: SqlExecutor;

function claim(role: WorkspaceRole = WORKSPACE_ROLE_LEVELS.OWNER, sub = "alice"): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return { sub, workspaceId: WORKSPACE, role, exp: now + 600, iat: now };
}

type WorkspaceRole = (typeof WORKSPACE_ROLE_LEVELS)[keyof typeof WORKSPACE_ROLE_LEVELS];

/**
 * Five rows that separate the cases: two spellings of "replay" for case
 * sensitivity, a literal `%` next to a `%` that must stay a wildcard, an
 * `a_b` for the single-character wildcard, and nulls in both `stage` and `due`.
 */
function seed(): void {
  runTransaction(sql, WORKSPACE, claim(), {
    txId: "seed",
    ops: [
      { op: "insert", namespace: "author", id: "a1", values: { name: "Ada Lovelace" } },
      { op: "insert", namespace: "author", id: "a2", values: { name: "Grace Hopper" } },
      {
        op: "insert",
        namespace: "task",
        id: "t1",
        values: { title: "Replay the log", stage: "todo", due: null, points: 1, authorId: "a1" },
      },
      {
        op: "insert",
        namespace: "task",
        id: "t2",
        values: { title: "replay the tape", stage: "done", due: 1_800_000_000_000, points: 2, authorId: "a2" },
      },
      {
        op: "insert",
        namespace: "task",
        id: "t3",
        values: { title: "50% off today", stage: null, due: 1_800_000_001_000, points: 3, authorId: "a1" },
      },
      {
        op: "insert",
        namespace: "task",
        id: "t4",
        values: { title: "50x off today", stage: null, due: null, points: 4, authorId: null },
      },
      {
        op: "insert",
        namespace: "task",
        id: "t5",
        values: { title: "a_b c", stage: "todo", due: null, points: 5, authorId: "a2" },
      },
    ],
  }, engineConfig);
}

/** The public API: `createClient` against a fetch that calls the engine. */
function engineFetch() {
  return async (url: string, init: { method: string; body?: string }) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    try {
      if (url.endsWith("/transact")) {
        const result = runTransaction(sql, WORKSPACE, claim(), body, engineConfig);
        return Response.json({ ok: true, result });
      }
      if (url.endsWith("/query")) {
        const { data, pageInfo } = executeQueryWithPageInfo(sql, claim(WORKSPACE_ROLE_LEVELS.MEMBER), body);
        return Response.json({ ok: true, data, pageInfo });
      }
    } catch (error) {
      const candidate = error as { code?: string; toJSON?: () => unknown; message?: string };
      const status =
        candidate.code === "permission_denied"
          ? 403
          : candidate.code === "storage_error"
            ? 500
            : candidate.code === "invalid_op" || candidate.code === "invalid_value"
              ? 400
              : 409;
      return Response.json(
        { ok: false, error: candidate.toJSON?.() ?? { code: "error", message: candidate.message } },
        { status }
      );
    }
    return Response.json({ ok: false, error: { code: "no_route", message: url } }, { status: 404 });
  };
}

function client() {
  return createClient(
    {
      schema: appSchema,
      url: "http://engine.test",
      workspace: WORKSPACE,
      getToken: async () => "token",
    },
    {
      fetch: engineFetch(),
      outbox: new MemoryOutbox(),
      createWebSocket: () => {
        throw new Error("no socket in this test");
      },
    }
  );
}

/** Titles through the public API, in title order. */
async function titles(where: unknown): Promise<string[]> {
  const db = client();
  const rows = await db.task.findMany({
    where: where as never,
    orderBy: { title: "asc" },
  });
  return rows.map((row) => row.title);
}

/** Titles through the engine's own document, for its `$` operators. */
function engineTitles(where: unknown): string[] {
  const { data } = executeCompiledQueryWithPageInfo(
    sql,
    compileQuery({ task: { $: { where, order: { title: "asc" } } } }),
    claim(WORKSPACE_ROLE_LEVELS.MEMBER)
  );
  return (data.task as Array<{ title: string }>).map((row) => row.title);
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? "no_code";
  }
  throw new Error("expected the call to throw");
}

beforeEach(() => {
  configureRegistry(appSchema.registry);
  configureMigrations(appSchema.migrations);
  configurePermissions(appSchema.permissions);
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of appSchema.migrations) db.exec(migration.sql);
  sql = {
    exec: (q: string, ...p: SqlValue[]) => db.query(q).run(...(p as never[])).changes,
    all: <T extends SqlRow = SqlRow>(q: string, ...p: SqlValue[]) =>
      db.query(q).all(...(p as never[])) as T[],
    one: <T extends SqlRow = SqlRow>(q: string, ...p: SqlValue[]) =>
      (db.query(q).get(...(p as never[])) ?? undefined) as T | undefined,
    transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
  };
  seed();
});

describe("isNull", () => {
  test("splits a nullable field into unset and set rows", async () => {
    expect(await titles({ due: { isNull: true } })).toEqual([
      "50x off today",
      "Replay the log",
      "a_b c",
    ]);
    expect(await titles({ due: { isNull: false } })).toEqual(["50% off today", "replay the tape"]);
  });

  test("reads the same rows as an equality with null, and covers every nullable field", async () => {
    expect(await titles({ due: { isNull: true } })).toEqual(await titles({ due: null }));
    expect(await titles({ stage: { isNull: true } })).toEqual(["50% off today", "50x off today"]);
    expect(await titles({ stage: { isNull: false } })).toEqual([
      "Replay the log",
      "a_b c",
      "replay the tape",
    ]);
  });

  test("also works on a relation's foreign key, which is a field like any other", async () => {
    expect(await titles({ authorId: { isNull: true } })).toEqual(["50x off today"]);
  });
});

describe("like and ilike", () => {
  test("% matches any run and _ matches one character", async () => {
    expect(await titles({ title: { like: "Replay%" } })).toEqual(["Replay the log"]);
    expect(await titles({ title: { like: "%the%" } })).toEqual(["Replay the log", "replay the tape"]);
    expect(await titles({ title: { like: "a_b c" } })).toEqual(["a_b c"]);
    // `_` is one character, not a literal underscore.
    expect(await titles({ title: { like: "a_b%" } })).toEqual(["a_b c"]);
    expect(await titles({ title: { like: "a_%" } })).toEqual(["a_b c"]);
  });

  test("an escaped % and _ are literal, an unescaped one is not", async () => {
    // "50% off%" reads as "50", anything, " off", anything: it catches the row
    // whose title has no percent sign at all.
    expect(await titles({ title: { like: "50% off%" } })).toEqual([
      "50% off today",
      "50x off today",
    ]);
    expect(await titles({ title: { like: "50\\% off%" } })).toEqual(["50% off today"]);
    expect(await titles({ title: { like: "50\\_b%" } })).toEqual([]);
    expect(await titles({ title: { like: "a\\_b c" } })).toEqual(["a_b c"]);
  });

  test("like is case-sensitive and ilike is not", async () => {
    expect(await titles({ title: { like: "replay%" } })).toEqual(["replay the tape"]);
    expect(await titles({ title: { ilike: "REPLAY%" } })).toEqual([
      "Replay the log",
      "replay the tape",
    ]);
    expect(await titles({ title: { ilike: "50% OFF%" } })).toEqual([
      "50% off today",
      "50x off today",
    ]);
    // ilike honours the escapes too: the % is literal, so only the real one matches.
    expect(await titles({ title: { ilike: "50\\% OFF%" } })).toEqual(["50% off today"]);
  });

  test("a pattern that matches nothing returns nothing, not everything", async () => {
    expect(await titles({ title: { like: "nothing%" } })).toEqual([]);
    expect(await titles({ title: { ilike: "%zzz%" } })).toEqual([]);
  });

  test("refuses a pattern on a field that is not text", async () => {
    // The engine's own document, so the code is visible.
    expect(codeOf(() => compileQuery({ task: { $: { where: { points: { $like: "1%" } } } } }))).toBe(
      "invalid_value"
    );
    expect(codeOf(() => compileQuery({ task: { $: { where: { due: { $ilike: "2026%" } } } } }))).toBe(
      "invalid_value"
    );
    const message = (() => {
      try {
        compileQuery({ task: { $: { where: { points: { $like: "1%" } } } } });
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    })();
    expect(message).toContain("matches text");

    // And through the public API, where it is the engine that refuses it.
    const db = client();
    await expect(
      db.task.findMany({ where: { points: { like: "1%" } } as never }).then()
    ).rejects.toThrow(/matches text/);
  });

  test("refuses a malformed pattern instead of guessing at it", () => {
    expect(codeOf(() => compileQuery({ task: { $: { where: { title: { $like: "a\\b" } } } } }))).toBe(
      "invalid_value"
    );
    // A trailing backslash escapes nothing.
    expect(codeOf(() => compileQuery({ task: { $: { where: { title: { $like: "a\\" } } } } }))).toBe(
      "invalid_value"
    );
    // A literal backslash is written as one escaped backslash pair.
    expect(engineTitles({ title: { $like: "a\\\\b%" } })).toEqual([]);
  });

  test("refuses a non-boolean isNull and a non-string pattern", () => {
    expect(codeOf(() => compileQuery({ task: { $: { where: { stage: { $isNull: "yes" } } } } }))).toBe(
      "invalid_value"
    );
    expect(codeOf(() => compileQuery({ task: { $: { where: { title: { $like: 5 } } } } }))).toBe(
      "invalid_value"
    );
  });
});

describe("composition", () => {
  test("composes under $or and $not", async () => {
    expect(
      await titles({ OR: [{ stage: { isNull: true } }, { title: { like: "replay%" } }] })
    ).toEqual(["50% off today", "50x off today", "replay the tape"]);

    // "not (stage is set)" is "stage is unset": NOT of an IS NOT NULL.
    expect(await titles({ NOT: { stage: { isNull: false } } })).toEqual([
      "50% off today",
      "50x off today",
    ]);

    expect(await titles({ AND: [{ stage: "todo" }, { title: { like: "%log" } }] })).toEqual([
      "Replay the log",
    ]);

    // Two conditions on one field AND together.
    expect(await titles({ title: { like: "replay%", ilike: "%TAPE" } })).toEqual(["replay the tape"]);
  });

  test("composes with relation modes", async () => {
    const db = client();
    const names = async (where: object) =>
      (await db.author.findMany({ where: where as never, orderBy: { name: "asc" } })).map(
        (author) => author.name
      );

    expect(await names({ tasks: { some: { title: { like: "Replay%" } } } })).toEqual(["Ada Lovelace"]);
    expect(await names({ tasks: { none: { title: { like: "%off%" } } } })).toEqual(["Grace Hopper"]);
    // Ada has one task with no stage, so "every task has a stage" is false for
    // her and true for Grace, whose two tasks both set one.
    expect(await names({ tasks: { every: { stage: { isNull: false } } } })).toEqual(["Grace Hopper"]);
    expect(await names({ tasks: { some: { stage: { isNull: true } } } })).toEqual(["Ada Lovelace"]);
  });

  test("refuses a field operator on a relation, where it would be buried in a link filter", () => {
    const graph = appSchema.graph;
    // `{ author: null }` is the way to ask for a missing parent; `isNull` on the
    // link itself has no meaning and must not become one by accident.
    expect(() => toEngineWhere(graph.task, { author: { isNull: true } } as never, graph)).toThrow(
      /is a relation/
    );
    expect(() => toEngineWhere(graph.author, { tasks: { like: "x" } } as never, graph)).toThrow(
      /is a relation/
    );
    expect(toEngineWhere(graph.task, { author: null } as never, graph)).toEqual({ authorId: null });
  });
});

describe("live queries", () => {
  class FakeSocket {
    sent: Array<Record<string, unknown>> = [];
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    close() {}
    push(message: unknown) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
    send(data: string) {
      const message = JSON.parse(data) as Record<string, unknown>;
      this.sent.push(message);
      if (message.type !== "query:subscribe") return;
      // Answer the way the room would: run the document it received against the
      // same engine. A subscription that reaches the socket with the operator
      // intact therefore comes back filtered by it.
      const { data: rows, pageInfo } = executeQueryWithPageInfo(sql, claim(WORKSPACE_ROLE_LEVELS.MEMBER), {
        query: message.query,
      });
      queueMicrotask(() => this.push({ type: "query:data", id: message.id, seq: 1, data: rows, pageInfo }));
    }
  }

  function live() {
    const socket = new FakeSocket();
    const db = createClient(
      {
        schema: appSchema,
        url: "http://engine.test",
        workspace: WORKSPACE,
        getToken: async () => "token",
      },
      {
        fetch: engineFetch(),
        outbox: new MemoryOutbox(),
        createWebSocket: () => socket,
      }
    );
    return { db, socket };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  async function open(socket: FakeSocket): Promise<void> {
    // A subscription registers asynchronously; opening the socket before it
    // lands would leave nothing to send.
    await tick();
    socket.onopen?.({});
    socket.push({ type: "session:ready", workspaceId: WORKSPACE, connections: 1 });
    await tick();
  }

  /** Waits for the first state that carries rows. */
  async function rowsOf(seen: string[][], from = 0): Promise<string[] | undefined> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (seen.length > from) return seen.at(-1);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return seen.at(-1);
  }

  test("a live query carries isNull, like and ilike to the socket", async () => {
    const { db, socket } = live();
    const seen: string[][] = [];

    db.task
      .findMany({ where: { due: { isNull: true } }, orderBy: { title: "asc" } })
      .subscribe((state) => {
        const rows = state.data as Array<{ title: string }> | undefined;
        if (rows !== undefined) seen.push(rows.map((row) => row.title));
      });
    await open(socket);

    const subscribe = socket.sent.find((message) => message.type === "query:subscribe")!;
    expect(subscribe.query).toEqual({
      task: { $: { where: { due: { $isNull: true } }, order: { title: "asc" } } },
    });
    expect(await rowsOf(seen)).toEqual(["50x off today", "Replay the log", "a_b c"]);

    // The same round trip for a pattern, including the escape.
    const before = socket.sent.length;
    const mark = seen.length;
    db.task
      .findMany({ where: { title: { ilike: "50\\% OFF%" } }, orderBy: { title: "asc" } })
      .subscribe((state) => {
        const rows = state.data as Array<{ title: string }> | undefined;
        if (rows !== undefined) seen.push(rows.map((row) => row.title));
      });
    await tick();
    const pattern = socket.sent
      .slice(before)
      .find((message) => message.type === "query:subscribe")!;
    expect(pattern.query).toEqual({
      task: { $: { where: { title: { $ilike: "50\\% OFF%" } }, order: { title: "asc" } } },
    });
    expect(await rowsOf(seen, mark)).toEqual(["50% off today"]);
  });
});
