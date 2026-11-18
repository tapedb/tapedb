import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { AuthSqlStore } from "../src/auth/sql-store";
import type { AuthTables } from "../src/auth/types";
import type { SqlExecutor } from "../src/engine/tx-sql";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  const sql: SqlExecutor = {
    exec: (query, ...params) => db.query(query).run(...params).changes,
    all: (query, ...params) => db.query(query).all(...params) as never,
    one: (query, ...params) => db.query(query).get(...params) as never,
    transactionSync: (fn) => db.transaction(fn)(),
  };
  return { sql, store: new AuthSqlStore(sql) };
}
const tables: AuthTables = {
  verification: {
    fields: {
      id: { type: "string", required: true },
      identifier: { type: "string", unique: true },
      value: { type: "string" },
      attempts: { type: "number" },
    },
  },
};
test("consumption deletes exactly one matching token; later consumers get null", async () => {
  const { store } = fixture();
  await store.configure(tables);
  await store.execute({
    action: "create",
    model: "verification",
    data: { id: "one", identifier: "email", value: "token" },
  });
  const results = await Promise.all(
    Array.from({ length: 32 }, () =>
      store.execute({
        action: "consumeOne",
        model: "verification",
        where: [{ field: "identifier", operator: "eq", value: "email" }],
      }),
    ),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await store.execute({ action: "count", model: "verification" })).toBe(
    0,
  );
});
test("counter increments do not lose updates", async () => {
  const { store } = fixture();
  await store.configure(tables);
  await store.execute({
    action: "create",
    model: "verification",
    data: { id: "one", attempts: 0 },
  });
  await Promise.all(
    Array.from({ length: 32 }, () =>
      store.execute({
        action: "incrementOne",
        model: "verification",
        where: [{ field: "id", operator: "eq", value: "one" }],
        increment: { attempts: 1 },
      }),
    ),
  );
  expect(
    await store.execute({ action: "findOne", model: "verification" }),
  ).toMatchObject({ attempts: 32 });
});
test("schema metadata restores after eviction without reconfiguring the adapter", async () => {
  const { store, sql } = fixture();
  await store.configure(tables);
  await store.execute({
    action: "create",
    model: "verification",
    data: { id: "one", value: "secret" },
  });
  const restored = new AuthSqlStore(sql);
  expect(
    await restored.execute({ action: "findOne", model: "verification" }),
  ).toMatchObject({ value: "secret" });
});
test("a renamed field requires migration and preserves the original row", async () => {
  const { store } = fixture();
  await store.configure(tables);
  await store.execute({
    action: "create",
    model: "verification",
    data: { id: "one", value: "secret" },
  });
  await expect(
    store.configure({
      verification: {
        fields: {
          id: { type: "string", required: true },
          renamed: { type: "string" },
        },
      },
    }),
  ).rejects.toThrow("explicit migration");
  expect(
    await store.execute({ action: "findOne", model: "verification" }),
  ).toMatchObject({ value: "secret" });
});
test("optional plugin fields can be added while keeping existing rows", async () => {
  const { store } = fixture();
  await store.configure(tables);
  await store.execute({
    action: "create",
    model: "verification",
    data: { id: "one", value: "secret" },
  });
  await store.configure({
    verification: {
      fields: { ...tables.verification.fields, extra: { type: "string" } },
    },
  });
  expect(
    await store.execute({ action: "findOne", model: "verification" }),
  ).toMatchObject({ value: "secret", extra: null });
});
test("an added required field fails atomically", async () => {
  const { store } = fixture();
  await store.configure(tables);
  await expect(
    store.configure({
      verification: {
        fields: {
          ...tables.verification.fields,
          extra: { type: "string", required: true },
        },
      },
    }),
  ).rejects.toThrow("explicit migration");
  expect(await store.execute({ action: "count", model: "verification" })).toBe(
    0,
  );
});
test("SQL metacharacters in values never become statements", async () => {
  const { store } = fixture();
  await store.configure(tables);
  const input = "x'); DROP TABLE _auth_verification; --";
  await store.execute({
    action: "create",
    model: "verification",
    data: { id: "one", value: input },
  });
  expect(
    await store.execute({
      action: "findOne",
      model: "verification",
      where: [{ field: "value", operator: "eq", value: input }],
    }),
  ).toMatchObject({ id: "one", value: input });
  await expect(
    store.execute({
      action: "findMany",
      model: "verification",
      select: ["id; DROP TABLE _auth_verification"],
    }),
  ).rejects.toThrow("Unknown auth field");
});
test("unsupported actions cannot execute as updates", async () => {
  const { store } = fixture();
  await store.configure(tables);
  await expect(
    store.execute({
      action: "unexpected" as never,
      model: "verification",
      data: { value: "oops" },
    }),
  ).rejects.toThrow("Unknown auth action");
});
