/**
 * `tapedb add` edits the user's schema and Worker as text: one entry in an
 * `extensions` array and the missing imports, and nothing else.
 */
import { expect, test } from "bun:test";
import { SchemaEditError } from "../src/cli/schema-edit";
import { SCHEMA_FILE } from "../src/cli/index";
import { addImports, wireSchemaExtension, wireWorkerExtension } from "../src/cli/wire-extension";

const IMPORT = 'import { content } from "./cms.content";';

test("the schema init writes gains a second argument, and a second run changes nothing", () => {
  const once = wireSchemaExtension(SCHEMA_FILE, "content", [IMPORT])!;
  expect(once).toContain('import { model, schema, t } from "@tapedb/tapedb/schema";\nimport { content } from "./cms.content";\n');
  expect(once).toMatch(/\}\),\n\}, \{ extensions: \[content\] \}\);\n$/);
  expect(once.replace(`${IMPORT}\n`, "").replace(", { extensions: [content] }", "")).toBe(SCHEMA_FILE);
  expect(wireSchemaExtension(once, "content", [IMPORT])).toBeNull();
});

test("existing schema options and extensions are kept; a new extension goes last", () => {
  const src = `import { schema } from "@tapedb/tapedb/schema";
// schema( in a comment is not the call
export default schema(models, {
  files, // the app's rules
  extensions: [search],
});
`;
  const next = wireSchemaExtension(src, "content", [IMPORT])!;
  expect(next).toContain("  extensions: [search, content],\n");
  expect(next).toContain("  files, // the app's rules\n");
  expect(wireSchemaExtension(next, "content", [IMPORT])).toBeNull();

  const oneLine = wireSchemaExtension('export default schema(models, { files });\n', "content", [])!;
  expect(oneLine).toBe("export default schema(models, { files, extensions: [content] });\n");
});

test("the Worker init writes gains extensions after its last option, at its indentation", () => {
  const src = `import { defineTapeDB } from "@tapedb/tapedb/worker";

import schema from "./tapedb.schema";

const tapedb = defineTapeDB({
  schema,
  migrations,
  // a comment
  studio,
});
`;
  const next = wireWorkerExtension(src, "cms({ content })", ['import { cms } from "@tapedb/cms/worker";', IMPORT])!;
  expect(next).toBe(`import { defineTapeDB } from "@tapedb/tapedb/worker";

import schema from "./tapedb.schema";
import { cms } from "@tapedb/cms/worker";
import { content } from "./cms.content";

const tapedb = defineTapeDB({
  schema,
  migrations,
  // a comment
  studio,
  extensions: [cms({ content })],
});
`);
  expect(wireWorkerExtension(next, "cms({ content })", [])).toBeNull();
  // Written differently (spacing), it is still the same entry.
  expect(wireWorkerExtension(next.replace("cms({ content })", "cms({content})"), "cms({ content })", [])).toBeNull();
  expect(wireWorkerExtension("const t = defineTapeDB({ schema, migrations, auth, authPage, studio, audit: true });", "x()", [])).toBe(
    "const t = defineTapeDB({ schema, migrations, auth, authPage, studio, audit: true, extensions: [x()] });",
  );
});

test("code it cannot be sure of is reported, not guessed at", () => {
  expect(() => wireWorkerExtension("defineTapeDB(options);", "x()", [])).toThrow(SchemaEditError);
  expect(() => wireWorkerExtension("defineTapeDB({ extensions });", "x()", [])).toThrow("shorthand");
  expect(() => wireWorkerExtension("defineTapeDB({ extensions: list.concat(a) });", "x()", [])).toThrow("not written as [ ... ]");
  expect(() => wireSchemaExtension("schema(models, options)", "content", [])).toThrow("built elsewhere");
  expect(() => wireSchemaExtension("const x = 1;", "content", [])).toThrow("No schema(");
});

test("imports go after a multi-line import, and present ones are not repeated", () => {
  const src = 'import {\n  a,\n  b,\n} from "x";\n\nconst y = 1;\n';
  expect(addImports(src, ['import { c } from "c";'])).toBe('import {\n  a,\n  b,\n} from "x";\nimport { c } from "c";\n\nconst y = 1;\n');
  expect(addImports(src, ['import { c } from "c";'.replace("c", "c")]).split('import { c }').length).toBe(2);
  expect(addImports("const y = 1;\n", ['import "z";'])).toBe('import "z";\nconst y = 1;\n');
});
