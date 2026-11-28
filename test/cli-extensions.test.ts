/**
 * Extensions in the CLI: `tapedb add`, the build that dev and deploy run, and
 * `tapedb <extension> <command>`, against a project with a fake extension
 * package installed in its node_modules.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli/index";
import { buildExtensions, extensionProject, listedExtensions } from "../src/cli/extensions";

const dirs: string[] = [];
const cwd = process.cwd();
afterEach(() => {
  process.chdir(cwd);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project with `fake-ext` installed (not yet listed) and a wrangler config with comments. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "tapedb-ext-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", devDependencies: { "fake-ext": "1.0.0" } }, null, 2));
  writeFileSync(join(root, "wrangler.jsonc"), '{\n  // the app\n  "name": "my-app",\n  "main": "src/index.ts",\n  "r2_buckets": [{ "binding": "DATA", "bucket_name": "my-app-data" }]\n}\n');
  writeFileSync(join(root, "tapedb.schema.ts"), 'import { schema } from "@tapedb/tapedb/schema";\nexport default schema({});\n');
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/index.ts"), 'import { defineTapeDB } from "@tapedb/tapedb/worker";\nconst tapedb = defineTapeDB({ schema });\n');
  const pkg = join(root, "node_modules", "fake-ext");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fake-ext", type: "module", exports: { "./tapedb": { types: "./tapedb.d.ts", import: "./tapedb.mjs" } } }));
  writeFileSync(
    join(pkg, "tapedb.mjs"),
    `export default {
      name: "fake",
      add(project) {
        project.write("fake.config.ts", "export const fake = true;\\n");
        project.wrangler.addR2Bucket("CONTENT", "content");
        project.wrangler.addCron("* * * * *");
        project.wrangler.addVar("FAKE_MODE", "on");
        project.log("set up");
        project.useInSchema("fake", ['import { fake } from "./fake.config";']);
        project.useInWorker("fakeWorker()", ['import { fakeWorker } from "fake-ext";']);
      },
      build(project, { mode }) {
        const source = project.read("fake.source") ?? "none";
        project.write("tapedb/fake.gen.ts", "export const built = " + JSON.stringify(mode + ":" + source) + ";\\n", { overwrite: true });
        return { watch: ["fake.source"] };
      },
      commands: {
        hello: { summary: "Says hello", usage: "<name>", run(args, project) { project.write("hello.txt", "hello " + args[0]); return 0; } },
        fail: { summary: "Fails", usage: "", run() { return 3; } },
      },
    };\n`
  );
  return root;
}

test("tapedb add lists the extension, runs its setup once, and edits wrangler.jsonc only where something is missing", async () => {
  const root = project();
  expect(await run(["add", "fake-ext", "--dir", root])).toBe(0);
  expect(listedExtensions(root)).toEqual(["fake-ext"]);
  expect(readFileSync(join(root, "fake.config.ts"), "utf8")).toBe("export const fake = true;\n");
  const config = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
  expect(config.r2_buckets).toEqual([
    { binding: "DATA", bucket_name: "my-app-data" },
    { binding: "CONTENT", bucket_name: "my-app-content" },
  ]);
  expect(config.triggers).toEqual({ crons: ["* * * * *"] });
  expect(config.vars).toEqual({ FAKE_MODE: "on" });
  expect(readFileSync(join(root, "tapedb.schema.ts"), "utf8")).toBe('import { schema } from "@tapedb/tapedb/schema";\nimport { fake } from "./fake.config";\nexport default schema({}, { extensions: [fake] });\n');
  // The Worker is wrangler.jsonc's main.
  expect(readFileSync(join(root, "src/index.ts"), "utf8")).toBe('import { defineTapeDB } from "@tapedb/tapedb/worker";\nimport { fakeWorker } from "fake-ext";\nconst tapedb = defineTapeDB({ schema, extensions: [fakeWorker()] });\n');

  // Again: nothing is duplicated, and an edited file is kept.
  writeFileSync(join(root, "fake.config.ts"), "// mine\n");
  expect(await run(["add", "fake-ext", "--dir", root])).toBe(0);
  expect(listedExtensions(root)).toEqual(["fake-ext"]);
  expect(readFileSync(join(root, "fake.config.ts"), "utf8")).toBe("// mine\n");
  const again = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
  expect(again.r2_buckets).toHaveLength(2);
  expect(again.triggers.crons).toEqual(["* * * * *"]);
  expect(readFileSync(join(root, "src/index.ts"), "utf8").match(/fakeWorker/g)).toHaveLength(2);
});

test("tapedb build runs every listed extension's build, and dev rebuilds when a watched file changes", async () => {
  const root = project();
  await run(["add", "fake-ext", "--dir", root]);
  expect(await run(["build", "--dir", root])).toBe(0);
  expect(readFileSync(join(root, "tapedb/fake.gen.ts"), "utf8")).toBe('export const built = "deploy:none";\n');

  writeFileSync(join(root, "fake.source"), "v1");
  const live = await buildExtensions(root, "dev", true);
  expect(readFileSync(join(root, "tapedb/fake.gen.ts"), "utf8")).toBe('export const built = "dev:v1";\n');
  writeFileSync(join(root, "fake.source"), "v2");
  for (let i = 0; i < 40 && !readFileSync(join(root, "tapedb/fake.gen.ts"), "utf8").includes("v2"); i++) await Bun.sleep(50);
  expect(readFileSync(join(root, "tapedb/fake.gen.ts"), "utf8")).toBe('export const built = "dev:v2";\n');
  live.close();
});

test("an extension's commands run as tapedb <extension> <command>, with their exit codes", async () => {
  const root = project();
  await run(["add", "fake-ext", "--dir", root]);
  process.chdir(root);
  expect(await run(["fake", "hello", "Ada"])).toBe(0);
  expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("hello Ada");
  expect(await run(["fake", "fail"])).toBe(3);
  expect(await run(["fake", "--help"])).toBe(0);
  expect(await run(["fake", "nope"])).toBe(1);
  expect(await run(["nothing-like-it"])).toBe(0); // usage, as before
});

test("a listed extension that is not installed is named, with the fix", async () => {
  const root = project();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", tapedb: { extensions: ["missing-ext"] } }));
  await expect(run(["build", "--dir", root])).rejects.toThrow("missing-ext is listed as a TapeDB extension but missing-ext/tapedb cannot be found. Install it (npm i -D missing-ext)");
  expect(existsSync(join(root, "tapedb"))).toBe(false);
  expect(() => extensionProject(join(root, "nowhere"), "x").wrangler.addCron("* * * * *")).toThrow("No wrangler.jsonc");
});
