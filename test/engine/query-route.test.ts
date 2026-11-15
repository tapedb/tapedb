import { useLegacyFixture } from "../fixtures/registry";
useLegacyFixture();

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../../src/claims";
import { encodeTrustedRoleClaim } from "../../src/verify";
import type { Env } from "../../src/types";

class MockDurableObject<EnvShape> {
  protected ctx: DurableObjectState;
  protected env: EnvShape;

  constructor(ctx: DurableObjectState, env: EnvShape) {
    this.ctx = ctx;
    this.env = env;
  }
}

mock.module("cloudflare:workers", () => ({
  DurableObject: MockDurableObject,
}));

const { WorkspaceRoom } = await import("../../src/engine/workspace-room");

const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";
const MIGRATIONS_DIR = resolve(
  import.meta.dir,
  "../fixtures/migrations/"
);

const SCHEMA = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"))
  .join("\n");

interface SqlCursor<T> {
  toArray(): T[];
  one(): T;
  rowsWritten: number;
}

function createSqlStorage(db: Database) {
  return {
    exec<T extends Record<string, unknown>>(
      query: string,
      ...params: unknown[]
    ): SqlCursor<T> {
      const trimmed = query.trim();
      const lower = trimmed.toLowerCase();
      const isRead =
        /^(select|with|explain)\b/i.test(trimmed) ||
        (lower.startsWith("pragma") && !lower.includes("="));

      if (isRead) {
        const rows = db.query(query).all(...(params as never[])) as T[];
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length === 0) throw new Error("Query returned no rows.");
            return rows[0];
          },
          rowsWritten: 0,
        };
      }

      const statements = trimmed.split(";").filter((part) => part.trim());
      let changes = 0;
      if (statements.length > 1) {
        db.exec(query);
      } else {
        changes = db.prepare(query).run(...(params as never[])).changes;
      }

      return {
        toArray: () => [],
        one: () => {
          throw new Error("Statement returned no rows.");
        },
        rowsWritten: changes,
      };
    },
  };
}

class FakeContext {
  ready: Promise<unknown> = Promise.resolve();
  alarm: number | null = null;
  readonly storage: {
    sql: ReturnType<typeof createSqlStorage>;
    transactionSync<T>(fn: () => T): T;
    getAlarm(): Promise<number | null>;
    setAlarm(at: number): Promise<void>;
  };

  readonly id: { name: string };

  constructor(db: Database, name: string) {
    this.id = { name };
    this.storage = {
      sql: createSqlStorage(db),
      transactionSync: <T>(fn: () => T): T => db.transaction(fn)(),
      getAlarm: async () => this.alarm,
      setAlarm: async (at: number) => {
        this.alarm = at;
      },
    };
  }

  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    const promise = fn();
    this.ready = promise;
    return promise;
  }
}

function claim(role: number): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "user-1",
    workspaceId: WORKSPACE,
    role: role as RoleClaim["role"],
    exp: now + 60,
    iat: now,
  };
}

describe("WorkspaceRoom query route", () => {
  let db: Database;
  let context: FakeContext;
  let room: InstanceType<typeof WorkspaceRoom>;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.exec(SCHEMA);
    db.prepare(
      `INSERT INTO "kanban_boards"
        (id, name, created_at, updated_at, updated_seq)
       VALUES (?, ?, ?, ?, ?)`
    ).run("board1", "Board", 1, 1, 0);

    context = new FakeContext(db, WORKSPACE);
    room = new WorkspaceRoom(
      context as unknown as DurableObjectState,
      { DATA: { get: async () => null } } as unknown as Env
    );
    await context.ready;
  });

  function request(
    body: unknown,
    role: number | null = WORKSPACE_ROLE_LEVELS.MEMBER,
    method = "POST",
    path = "/query"
  ): Request {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (role !== null) {
      headers["x-tapedb-claims"] = encodeTrustedRoleClaim(claim(role));
    }
    return new Request(`http://test${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
  }

  test("returns query data for a MEMBER claim", async () => {
    const response = await room.fetch(
      request({
        query: {
          kanbanBoards: {
            $: { where: { name: "Board" } },
          },
        },
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { kanbanBoards: Array<{ id: string; name: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.data.kanbanBoards).toHaveLength(1);
    expect(body.data.kanbanBoards[0]?.id).toBe("board1");
  });

  test("maps permission failures to 403", async () => {
    const response = await room.fetch(
      request({ query: { kanbanBoards: {} } }, WORKSPACE_ROLE_LEVELS.GUEST)
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("permission_denied");

    const missing = await room.fetch(
      request({ query: { kanbanBoards: {} } }, null)
    );
    expect(missing.status).toBe(403);
  });

  test("maps invalid queries to 400", async () => {
    const unknown = await room.fetch(request({ query: { nope: {} } }));
    expect(unknown.status).toBe(400);
    expect(
      ((await unknown.json()) as { error: { code: string } }).error.code
    ).toBe("unknown_namespace");

    const malformed = await room.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tapedb-claims": encodeTrustedRoleClaim(
            claim(WORKSPACE_ROLE_LEVELS.MEMBER)
          ),
        },
        body: "{not json",
      })
    );
    expect(malformed.status).toBe(400);
    expect(
      ((await malformed.json()) as { error: { code: string } }).error.code
    ).toBe("invalid_envelope");
  });

  test("rejects non-POST methods without touching /transact or /status", async () => {
    const response = await room.fetch(request({}, undefined, "GET"));
    expect(response.status).toBe(405);

    const status = await room.fetch(
      new Request("http://test/status", {
        method: "GET",
        headers: { "x-tapedb-claims": encodeTrustedRoleClaim(claim(WORKSPACE_ROLE_LEVELS.MEMBER)) },
      })
    );
    expect(status.status).toBe(200);
    expect(((await status.json()) as { ok: boolean }).ok).toBe(true);

    // Without a verified claim the room does not describe itself either.
    const anonymous = await room.fetch(new Request("http://test/status", { method: "GET" }));
    expect(anonymous.status).toBe(403);
  });
});
