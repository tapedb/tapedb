/**
 * The studio's structure editor, end to end against a project on disk: read
 * the models, preview an edit, apply it as a schema change and a migration.
 * And the guard that keeps other sites away from the studio's routes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SCHEMA_FILE, run } from "../src/cli/index";
import { startStudio } from "../src/cli/studio";

const src = resolve(import.meta.dir, "../src/schema");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A project as `tapedb init` leaves it: the starter schema and its first migration. */
async function project(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "tapedb-structure-"));
  roots.push(root);
  writeFileSync(join(root, "tapedb.schema.ts"), SCHEMA_FILE.replace('"@tapedb/tapedb/schema"', JSON.stringify(src)));
  expect(await run(["migrate", "dev", "--dir", root, "--name", "init"])).toBe(0);
  return root;
}

async function studio(root?: string) {
  const server = await startStudio({ url: "http://127.0.0.1:1", workspace: "", port: 0, ...(root ? { project: root } : {}) });
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${server.url}${path}`, body === undefined ? { headers } : { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { server, call };
}

describe("structure", () => {
  test("reads the models and fields as written, and what the studio can edit", async () => {
    const root = await project();
    const { server, call } = await studio(root);
    try {
      const structure = await (await call("/api/structure")).json();
      expect(structure.editable).toBe(true);
      expect(structure.pending).toEqual([]);
      expect(structure.models.map((m: { name: string }) => m.name)).toEqual(["board", "column", "task"]);
      const task = structure.models[2];
      expect(task.fields).toEqual([
        { name: "title", code: "t.string()", spec: { type: "string" } },
        { name: "done", code: "t.boolean().default(false)", spec: { type: "boolean", default: false } },
        { name: "column", code: 't.belongsTo("column").optional()', spec: { type: "belongsTo", target: "column", optional: true } },
      ]);
    } finally { server.close(); }
  });

  test("deleting a model: preview first, nothing written; apply writes the schema and a migration", async () => {
    const root = await project();
    const before = readFileSync(join(root, "tapedb.schema.ts"), "utf8");
    const { server, call } = await studio(root);
    try {
      const edit = { kind: "deleteModel", model: "task" };
      const preview = await (await call("/api/structure/preview", { edit })).json();
      expect(preview.ok).toBe(true);
      expect(preview.sql.join("\n")).toContain('DROP TABLE IF EXISTS "task"');
      expect(preview.destructive.length).toBeGreaterThan(0);
      expect(preview.diff.filter((l: { kind: string }) => l.kind === "-").map((l: { text: string }) => l.text.trim())).toContain("task: model({");
      expect(readFileSync(join(root, "tapedb.schema.ts"), "utf8")).toBe(before);

      const applied = await (await call("/api/structure/apply", { edit, base: preview.base })).json();
      expect(applied).toEqual({ ok: true, migration: "0003_drop_task" });
      expect(readFileSync(join(root, "tapedb.schema.ts"), "utf8")).not.toContain("task");
      expect(readFileSync(join(root, "tapedb", "migrations", "0003_drop_task.sql"), "utf8")).toContain('DROP TABLE IF EXISTS "task"');
      expect(await run(["migrate", "check", "--dir", root])).toBe(0);
    } finally { server.close(); }
  });

  test("an apply against a schema file changed since the preview is refused", async () => {
    const root = await project();
    const { server, call } = await studio(root);
    try {
      const edit = { kind: "addField", model: "task", field: "due", spec: { type: "date", optional: true } };
      const preview = await (await call("/api/structure/preview", { edit })).json();
      writeFileSync(join(root, "tapedb.schema.ts"), readFileSync(join(root, "tapedb.schema.ts"), "utf8") + "\n// edited\n");
      const applied = await (await call("/api/structure/apply", { edit, base: preview.base })).json();
      expect(applied.ok).toBe(false);
      expect(applied.error).toContain("changed since this preview");
      expect(readdirSync(join(root, "tapedb", "migrations"))).toEqual(["0002_entities.sql"]);
    } finally { server.close(); }
  });

  test("an edit that does not load is reported and never written", async () => {
    const root = await project();
    const before = readFileSync(join(root, "tapedb.schema.ts"), "utf8");
    const { server, call } = await studio(root);
    try {
      const preview = await (await call("/api/structure/preview", { edit: { kind: "addField", model: "task", field: "owner", spec: { type: "belongsTo", target: "nobody" } } })).json();
      expect(preview.ok).toBe(false);
      expect(preview.error).toContain("nobody");
      const applied = await (await call("/api/structure/apply", { edit: { kind: "addField", model: "task", field: "owner", spec: { type: "belongsTo", target: "nobody" } }, base: "x" })).json();
      expect(applied.ok).toBe(false);
      expect(readFileSync(join(root, "tapedb.schema.ts"), "utf8")).toBe(before);
      expect(existsSync(join(root, "tapedb", "migrations", "0003_add_task_owner.sql"))).toBe(false);
    } finally { server.close(); }
  });

  test("without a project folder, the structure is read-only", async () => {
    const { server, call } = await studio();
    try {
      expect((await (await call("/api/structure")).json()).editable).toBe(false);
      expect((await call("/api/structure/preview", { edit: { kind: "deleteModel", model: "task" } })).status).toBe(400);
    } finally { server.close(); }
  });
});

describe("only the studio's own page", () => {
  test("another site's origin, another host name, or a non-JSON write are refused", async () => {
    const root = await project();
    const before = readFileSync(join(root, "tapedb.schema.ts"), "utf8");
    const { server, call } = await studio(root);
    try {
      const edit = { kind: "deleteModel", model: "task" };
      expect((await call("/api/structure/preview", { edit }, { origin: "https://evil.example" })).status).toBe(403);
      expect((await call("/api/structure", undefined, { origin: "https://evil.example" })).status).toBe(403);
      const port = new URL(server.url).port;
      const rebound = await fetch(`${server.url}/api/structure`, { headers: { host: `evil.example:${port}` } });
      expect(rebound.status).toBe(403);
      const plain = await fetch(`${server.url}/api/structure/apply`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ edit, base: "x" }) });
      expect(plain.status).toBe(415);
      // The studio's own origin, by either name, is fine.
      expect((await call("/api/structure", undefined, { origin: `http://localhost:${port}` })).status).toBe(200);
      expect(readFileSync(join(root, "tapedb.schema.ts"), "utf8")).toBe(before);
    } finally { server.close(); }
  });
});
