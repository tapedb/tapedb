import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { editSchemaSource, lineDiff, readField, renderField, SchemaEditError, type FieldSpec } from "../src/cli/schema-edit";
import { SCHEMA_FILE } from "../src/cli/index";
import { schema as buildSchema, model, t, role, check } from "../src/schema";

/** What `tapedb init` writes. */
const STARTER = SCHEMA_FILE;
/** The repository's example: access rules chained on models, blank lines between them. */
const EXAMPLE = readFileSync("examples/starter/tapedb.schema.ts", "utf8");

/** Evaluates a schema source the way a project would load it, with the real builders. */
function load(source: string) {
  const body = source
    .replace(/^import[^\n]*\n/gm, "")
    .replace(/export default /, "return ");
  return new Function("schema", "model", "t", "role", "check", body)(buildSchema, model, t, role, check) as ReturnType<typeof buildSchema>;
}

const namespaces = (source: string) => load(source).registry.namespaces.map((n: { apiName: string }) => n.apiName);

describe("models", () => {
  test("delete removes the model and every relation pointing at it, and nothing else", () => {
    const { source, name } = editSchemaSource(STARTER, { kind: "deleteModel", model: "task" });
    expect(namespaces(source)).toEqual(["board", "column"]);
    expect(source).not.toContain("task");
    expect(source).not.toContain("tasks:");
    expect(name).toBe("drop_task");
    // Only removed lines: every line left is a line of the original, in order.
    expect(lineDiff(STARTER, source).every((line) => line.kind !== "+")).toBe(true);
  });

  test("in the example, a model with chained access rules goes whole, and no double blank line is left", () => {
    const { source } = editSchemaSource(EXAMPLE, { kind: "deleteModel", model: "board" });
    expect(namespaces(source)).toEqual(["column", "task"]);
    expect(source).not.toContain(".access(");
    expect(source).not.toContain("\n\n\n");
    expect(lineDiff(EXAMPLE, source).every((line) => line.kind !== "+")).toBe(true);
    const added = editSchemaSource(EXAMPLE, { kind: "addField", model: "board", field: "color", spec: { type: "string", optional: true } }).source;
    expect(added).toContain("    columns: t.hasMany(\"column\"),\n    color: t.string().optional(),\n  }).access({");
    expect(namespaces(added)).toEqual(["board", "column", "task"]);
  });

  test("delete of a model in the middle keeps the others loadable", () => {
    const { source } = editSchemaSource(STARTER, { kind: "deleteModel", model: "column" });
    expect(namespaces(source)).toEqual(["board", "task"]);
  });

  test("add appends in the file's own indentation", () => {
    const { source } = editSchemaSource(STARTER, {
      kind: "addModel",
      model: "label",
      fields: [{ name: "name", spec: { type: "string" } }, { name: "color", spec: { type: "string", optional: true } }],
    });
    expect(source).toContain('  label: model({\n    name: t.string(),\n    color: t.string().optional(),\n  }),\n});');
    expect(namespaces(source)).toContain("label");
  });

  test("rename rewrites the key and the relations that name it, and declares the rename", () => {
    const { source, renames } = editSchemaSource(STARTER, { kind: "renameModel", from: "task", to: "card" });
    expect(namespaces(source)).toEqual(["board", "column", "card"]);
    expect(source).toContain('tasks: t.hasMany("card")');
    expect(renames).toEqual(["task=card"]);
  });

  test("refuses a name taken or invalid", () => {
    expect(() => editSchemaSource(STARTER, { kind: "addModel", model: "task", fields: [] })).toThrow(SchemaEditError);
    expect(() => editSchemaSource(STARTER, { kind: "addModel", model: "9lives", fields: [] })).toThrow(SchemaEditError);
    expect(() => editSchemaSource(STARTER, { kind: "renameModel", from: "task", to: "board" })).toThrow(SchemaEditError);
    expect(() => editSchemaSource(STARTER, { kind: "deleteModel", model: "nope" })).toThrow(SchemaEditError);
  });
});

describe("fields", () => {
  test("add, change, rename and delete", () => {
    let source = editSchemaSource(STARTER, { kind: "addField", model: "task", field: "priority", spec: { type: "number", default: 0, index: true } }).source;
    expect(source).toContain("    priority: t.number().default(0).index(),\n  }),");
    source = editSchemaSource(source, { kind: "changeField", model: "task", field: "priority", spec: { type: "number", optional: true } }).source;
    expect(source).toContain("priority: t.number().optional(),");
    const renamed = editSchemaSource(source, { kind: "renameField", model: "task", from: "priority", to: "rank" });
    expect(renamed.renames).toEqual(["task.priority=rank"]);
    source = editSchemaSource(renamed.source, { kind: "deleteField", model: "task", field: "rank" }).source;
    expect(source).toBe(STARTER);
  });

  test("renaming a relation renames its stored key", () => {
    const { renames, source } = editSchemaSource(STARTER, { kind: "renameField", model: "task", from: "column", to: "lane" });
    expect(renames).toEqual(["task.columnId=laneId"]);
    expect(source).toContain('lane: t.belongsTo("column").optional(),');
  });
});

describe("code the studio did not write", () => {
  const OWN = `// my schema
import { model, schema, t } from "@tapedb/tapedb/schema";
const shared = { createdBy: t.string().optional() };

export default schema(
  {
    /* boards hold columns */
    board: model({ name: t.string(), note: t.string().default("a, b) {c}") }),
    "task": model({
      title: t.string(), // the title
      board: t.belongsTo('board', { onDelete: "cascade" }),
    }),
  },
  {
    permissions: {
      task: { view: "MEMBER" },
      board: { view: "MEMBER" },
    },
  }
);
`;

  test("reads quoted keys, strings with brackets and comments; edits leave the rest byte for byte", () => {
    const { source } = editSchemaSource(OWN, { kind: "deleteModel", model: "board" });
    expect(source).toContain("// my schema");
    expect(source).toContain("/* boards hold columns */");
    expect(source).toContain("title: t.string(), // the title");
    expect(source).not.toContain("belongsTo('board'");
    expect(source).not.toContain('board: { view: "MEMBER" }');
    expect(source).toContain('task: { view: "MEMBER" }');
    expect(source).toContain("const shared = { createdBy: t.string().optional() };");
  });

  test("an inline model gets the field inline", () => {
    const { source } = editSchemaSource(OWN, { kind: "addField", model: "board", field: "color", spec: { type: "string", optional: true } });
    expect(source).toContain('board: model({ name: t.string(), note: t.string().default("a, b) {c}"), color: t.string().optional() })');
  });

  test("a model built some other way is refused, not guessed at", () => {
    expect(() => editSchemaSource(`export default schema({ ...models });`, { kind: "deleteModel", model: "x" })).toThrow(SchemaEditError);
    expect(() => editSchemaSource(`export default schema({ x: makeModel() });`, { kind: "deleteModel", model: "x" })).toThrow(SchemaEditError);
    expect(() => editSchemaSource(`export default build();`, { kind: "deleteModel", model: "x" })).toThrow(SchemaEditError);
  });
});

test("field specs survive a round trip through code", () => {
  const specs: FieldSpec[] = [
    { type: "string" },
    { type: "string", optional: true, default: "a, b", unique: true },
    { type: "number", default: -1.5, index: true },
    { type: "boolean", default: false },
    { type: "date", optional: true },
    { type: "json" },
    { type: "belongsTo", target: "board" },
    { type: "belongsTo", target: "board", optional: true, onDelete: "cascade" },
    { type: "hasMany", target: "task" },
  ];
  for (const spec of specs) expect(readField(renderField(spec))).toEqual(spec);
  expect(readField('t.string().personal({ subject: "self" })')).toBeNull();
});

test("the preview diff shows only what changed, with context", () => {
  const { source } = editSchemaSource(STARTER, { kind: "deleteField", model: "task", field: "done" });
  const diff = lineDiff(STARTER, source);
  expect(diff.filter((l) => l.kind !== " ")).toEqual([{ kind: "-", text: "    done: t.boolean().default(false),", old: expect.any(Number) }]);
  expect(diff.some((l) => l.text === "…")).toBe(true);
});
