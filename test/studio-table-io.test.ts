/** The studio's CSV and JSON import and export of a model's rows. */
import { expect, test } from "bun:test";

import { parseCsv, planImport, readTable, toCsv, toJson } from "../src/studio/table-io";
import type { SchemaDocument } from "../src/studio/graph";

const attr = (type: string, optional = false, fallback: unknown = null) => ({ type, optional, default: fallback, personal: null });
const schema: SchemaDocument = {
  namespaces: [
    { apiName: "column", attributes: { id: attr("string"), name: attr("string") } },
    {
      apiName: "task",
      attributes: {
        id: attr("string"),
        title: attr("string"),
        done: attr("boolean", false, false),
        points: attr("number", true),
        due: attr("date", true),
        meta: attr("json", true),
        columnId: attr("string", true),
        createdAt: attr("date"),
        updatedAt: attr("date"),
        updatedSeq: attr("number"),
      },
    },
  ],
  links: [
    {
      apiName: "task.column",
      forward: { namespace: "column", label: "tasks" },
      reverse: { namespace: "task", label: "column" },
      foreignKey: { namespace: "task", attribute: "columnId" },
    },
  ],
};

const rows = [
  { id: "t1", title: 'Say "hi", then\nleave', done: true, points: 3, due: Date.UTC(2026, 10, 17, 9, 30), meta: { tags: ["a"] }, columnId: "c1", createdAt: 0, updatedAt: 0, updatedSeq: 4 },
  { id: "t2", title: " padded ", done: false, points: null, due: null, meta: null, columnId: null, createdAt: 0, updatedAt: 0, updatedSeq: 5 },
];

test("CSV export quotes what needs it, writes ISO dates and leaves null empty", () => {
  const csv = toCsv(schema, "task", rows);
  expect(csv.startsWith("﻿id,title,done,points,due,meta,columnId,createdAt,updatedAt,updatedSeq\r\n")).toBe(true);
  expect(csv).toContain('t1,"Say ""hi"", then\nleave",true,3,2026-11-17T09:30:00.000Z,"{""tags"":[""a""]}",c1,');
  expect(csv).toContain('t2," padded ",false,,,,,1970-01-01T00:00:00.000Z');
});

test("what is exported imports back to the same values", () => {
  for (const [name, text] of [["task.csv", toCsv(schema, "task", rows)], ["task.json", toJson(schema, "task", rows)]] as const) {
    const planned = planImport(schema, "task", readTable(name, text));
    expect(planned.errors).toEqual([]);
    expect(planned.system).toEqual(["createdAt", "updatedAt", "updatedSeq"]);
    expect(planned.upserts).toBe(2);
    const [first, second] = planned.rows.map((ops) => ops[0] as { op: string; id: string; values: Record<string, unknown> });
    expect(first).toMatchObject({ op: "upsert", id: "t1" });
    expect(first.values).toEqual({ title: 'Say "hi", then\nleave', done: true, points: 3, due: Date.UTC(2026, 10, 17, 9, 30), meta: { tags: ["a"] }, columnId: "c1" });
    expect(second.values).toEqual({ title: " padded ", done: false, points: null, due: null, meta: null, columnId: null });
  }
});

test("CSV parsing: CRLF, quoted newlines and commas, blank last line", () => {
  expect(parseCsv('a,b\r\n"x, y","multi\nline"\r\n\r\n')).toEqual([["a", "b"], ["x, y", "multi\nline"]]);
  expect(() => parseCsv('a\n"open')).toThrow("Line 2: a quoted value is never closed.");
  expect(() => parseCsv('a\n"x"y')).toThrow("must end at a comma");
});

test("rows without an id are created, with defaults; every bad value is reported with its row", () => {
  const planned = planImport(schema, "task", readTable("task.csv", "title,done,points,due,colour\nNew,,,,red\nBad,maybe,many,soon,\n,true,1,,\n"));
  expect(planned.ignored).toEqual(["colour"]);
  expect(planned.creates).toBe(1);
  const insert = planned.rows[0][0] as { op: string; values: Record<string, unknown> };
  expect(insert.op).toBe("insert");
  expect(insert.values).toMatchObject({ title: "New", done: false, points: null });
  expect(planned.errors).toEqual([
    { row: 2, message: 'done is true or false, not "maybe".' },
    { row: 2, message: 'points is a number, not "many".' },
    { row: 2, message: 'due is a date (like 2026-11-17T09:30:00Z), not "soon".' },
    { row: 3, message: "title is required." },
  ]);
});

test("files that cannot be rows say why", () => {
  expect(() => readTable("t.json", '{"title":"x"}')).toThrow("must hold an array of rows");
  expect(() => readTable("t.json", "[1")).toThrow("is not valid JSON");
  expect(() => readTable("t.csv", "a,a\n1,2")).toThrow('the column "a" appears twice');
  expect(() => readTable("t.csv", "a,b\n1")).toThrow("row 1 has 1 values; the header has 2");
  expect(() => planImport(schema, "task", readTable("t.json", '[{"id":"x","title":"a"},{"id":"x","title":"b"}]'))).not.toThrow();
  expect(planImport(schema, "task", readTable("t.json", '[{"id":"x","title":"a"},{"id":"x","title":"b"}]')).errors).toEqual([{ row: 2, message: "id x is also on an earlier row." }]);
  expect(planImport(schema, "task", readTable("t.json", '[{"title":5}]')).errors).toEqual([{ row: 1, message: "title is text, not 5." }]);
});
