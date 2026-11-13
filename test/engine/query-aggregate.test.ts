/**
 * The in-memory fold, used under function read rules, must agree with the
 * SQL statement it stands in for: same groups, same order, same values,
 * nulls and mixed types included.
 */

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import {
  AggregateFold,
  buildAggregateSql,
  compileAggregate,
  groupsFromSql,
} from "../../src/engine/query-aggregate";
import type { NamespaceDefinition } from "../../src/engine/registry";
import type { SqlValue } from "../../src/engine/tx-sql";

const namespace = {
  apiName: "items",
  table: "items",
  attributes: {
    kind: { type: "string", optional: true },
    size: { type: "number", optional: true },
    flag: { type: "boolean", optional: true },
    at: { type: "date", optional: true },
  },
} as unknown as NamespaceDefinition;

const raw = (_type: unknown, value: SqlValue | undefined) => value ?? null;

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

test("the fold matches SQL over random rows", () => {
  for (let round = 0; round < 25; round += 1) {
    const random = seeded(round + 1);
    const db = new Database(":memory:");
    db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, kind TEXT, size REAL, flag INTEGER, at INTEGER)');
    const rows: Array<Record<string, SqlValue>> = [];
    const count = Math.floor(random() * 60);
    for (let n = 0; n < count; n += 1) {
      const row = {
        id: `r${n}`,
        kind: random() < 0.2 ? null : ["a", "b", "c", "B"][Math.floor(random() * 4)],
        size: random() < 0.2 ? null : Math.round(random() * 200 - 100) / 4,
        flag: random() < 0.2 ? null : random() < 0.5 ? 1 : 0,
        at: random() < 0.3 ? null : Math.floor(random() * 1000),
      };
      rows.push(row);
      db.query("INSERT INTO items VALUES (?, ?, ?, ?, ?)").run(row.id, row.kind, row.size, row.flag, row.at);
    }

    const shapes = [
      { count: true, sum: ["size"], avg: ["size"], min: ["kind", "size", "at"], max: ["kind", "size", "at"], countOf: ["at", "kind"] },
      { groupBy: ["kind"], count: true, sum: ["size"], min: ["at"] },
      { groupBy: ["flag", "kind"], order: { kind: "desc" as const }, avg: ["size"], max: ["kind"] },
      { groupBy: ["kind"], limit: 2, count: true },
    ];
    for (const shape of shapes) {
      const aggregate = compileAggregate(namespace, shape);
      const statement = buildAggregateSql("items", aggregate, []);
      const fromSql = groupsFromSql(aggregate, db.query(statement.sql).all(...(statement.params as never[])) as never, raw);

      const fold = new AggregateFold(aggregate);
      for (const row of rows) fold.add(row);
      const fromFold = fold.groups(raw);

      const close = (groups: typeof fromSql) =>
        JSON.parse(JSON.stringify(groups, (_key, value) => (typeof value === "number" ? Math.round(value * 1e9) / 1e9 : value)));
      expect(close(fromFold)).toEqual(close(fromSql));
    }
  }
});
