/**
 * `insert` and `patch`: the strict halves of today's upsert.
 *
 * An ORM's `create` must fail on an existing id and its `update` on a missing
 * row; an upsert silently does the other thing. These ops carry that
 * strictness through the log, and replay relaxes it, because a replayed op
 * already succeeded once.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim, type WorkspaceRole } from "../src/claims";
import { configureMigrations } from "../src/engine/migrations-bundle";
import { configurePermissions, type PermissionOverrides } from "../src/engine/tx-permissions";
import { configureRegistry } from "../src/engine/registry";
import { applyOps } from "../src/engine/tx-apply";
import type { SqlExecutor, SqlRow, SqlValue } from "../src/engine/tx-sql";
import { runTransaction } from "../src/engine/tx-pipeline";
import { validateEnvelope } from "../src/engine/tx-validate";
import { defineSchema } from "../src/schema";

const WORKSPACE_ID = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";

function setup(permissions: PermissionOverrides = {}): SqlExecutor {
  const schema = defineSchema({
    entities: { tasks: { title: { type: "string" }, done: { type: "boolean", optional: true } } },
    permissions,
  });
  configureRegistry(schema.registry);
  configureMigrations(schema.migrations);
  configurePermissions(schema.permissions);
  const db = new Database(":memory:");
  for (const migration of schema.migrations) db.exec(migration.sql);
  return {
    exec: (q: string, ...p: SqlValue[]) => db.query(q).run(...(p as never[])).changes,
    all: <T extends SqlRow = SqlRow>(q: string, ...p: SqlValue[]) => db.query(q).all(...(p as never[])) as T[],
    one: <T extends SqlRow = SqlRow>(q: string, ...p: SqlValue[]) =>
      (db.query(q).get(...(p as never[])) ?? undefined) as T | undefined,
    transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
  };
}

function claim(role: WorkspaceRole = WORKSPACE_ROLE_LEVELS.EDITOR): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "u1", workspaceId: WORKSPACE_ID, role, exp: now + 600, iat: now };
}

function write(sql: SqlExecutor, ops: unknown[], role?: WorkspaceRole) {
  return runTransaction(sql, WORKSPACE_ID, claim(role), { txId: crypto.randomUUID(), ops });
}

function row(sql: SqlExecutor, id: string) {
  return sql.one<{ title: string; done: number | null }>(`SELECT "title", "done" FROM "tasks" WHERE "id" = ?`, id);
}

function seq(sql: SqlExecutor): number {
  return sql.one<{ s: number }>(`SELECT high_water_seq AS s FROM "_tx_state"`)?.s ?? 0;
}

describe("insert", () => {
  test("creates a row, and refuses an id that exists without burning a sequence", () => {
    const sql = setup();
    write(sql, [{ op: "insert", namespace: "tasks", id: "t1", values: { title: "First" } }]);
    const before = seq(sql);

    expect(() =>
      write(sql, [{ op: "insert", namespace: "tasks", id: "t1", values: { title: "Clobber" } }])
    ).toThrow(/already exists/);
    expect(row(sql, "t1")?.title).toBe("First");
    expect(seq(sql)).toBe(before);
  });

  test("is gated by the create decision, not update", () => {
    const sql = setup({ tasks: { create: WORKSPACE_ROLE_LEVELS.MODERATOR } });
    expect(() =>
      write(sql, [{ op: "insert", namespace: "tasks", id: "t1", values: { title: "x" } }])
    ).toThrow(/not allowed to create/);
    write(sql, [{ op: "insert", namespace: "tasks", id: "t1", values: { title: "x" } }], WORKSPACE_ROLE_LEVELS.MODERATOR);
    expect(row(sql, "t1")?.title).toBe("x");
  });
});

describe("patch", () => {
  test("refuses a missing row instead of creating it", () => {
    const sql = setup();
    expect(() =>
      write(sql, [{ op: "patch", namespace: "tasks", id: "ghost", values: { title: "typo" } }])
    ).toThrow(/No "tasks" row with id "ghost"/);
    expect(row(sql, "ghost")).toBeUndefined();

    // Negative control: the upsert creates exactly the row patch refused.
    write(sql, [{ op: "update", namespace: "tasks", id: "ghost", values: { title: "typo" } }]);
    expect(row(sql, "ghost")?.title).toBe("typo");
  });

  test("writes only the named fields of an existing row", () => {
    const sql = setup();
    write(sql, [{ op: "insert", namespace: "tasks", id: "t1", values: { title: "Keep", done: false } }]);
    write(sql, [{ op: "patch", namespace: "tasks", id: "t1", values: { done: true } }]);
    expect(row(sql, "t1")).toEqual({ title: "Keep", done: 1 });
  });

  test("a failed patch rolls back the whole transaction", () => {
    const sql = setup();
    expect(() =>
      write(sql, [
        { op: "insert", namespace: "tasks", id: "t1", values: { title: "A" } },
        { op: "patch", namespace: "tasks", id: "missing", values: { title: "B" } },
      ])
    ).toThrow();
    expect(row(sql, "t1")).toBeUndefined();
  });
});

describe("replay", () => {
  test("re-applies an insert over its own row and skips a patch of a vanished one", () => {
    const sql = setup();
    write(sql, [{ op: "insert", namespace: "tasks", id: "t1", values: { title: "A" } }]);
    const tx = validateEnvelope({
      txId: "r",
      ops: [
        { op: "insert", namespace: "tasks", id: "t1", values: { title: "A" } },
        { op: "patch", namespace: "tasks", id: "gone", values: { title: "B" } },
      ],
    });

    expect(() => applyOps({ sql, seq: 9, now: 1, replay: true }, tx.ops)).not.toThrow();
    expect(() => applyOps({ sql, seq: 9, now: 1 }, tx.ops)).toThrow(/already exists/);
  });
});
