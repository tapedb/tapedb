import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Exercise the artifact under Node, rather than letting Bun's module loader
// hide differences in a consumer's package type. No published package needed.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "tapedb-package-"));
function command(executable, args, cwd, expected = 0) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, expected, `${executable} ${args.join(" ")}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result;
}
try {
  const packed = command("npm", ["pack", "--json", "--pack-destination", scratch], root);
  const archive = join(scratch, JSON.parse(packed.stdout)[0].filename);
  for (const type of [undefined, "commonjs", "module"]) {
    const dir = join(scratch, type ?? "default");
    mkdirSync(dir);
    const manifest = JSON.stringify({ name: "consumer", private: true, ...(type ? { type } : {}) });
    writeFileSync(join(dir, "package.json"), manifest);
    command("npm", ["install", archive, "--ignore-scripts", "--omit=peer", "--no-audit", "--no-fund"], dir);
    const installedManifest = readFileSync(join(dir, "package.json"), "utf8");
    const cli = join(dir, "node_modules", "@tapedb/tapedb", "dist", "cli.js");
    const run = (...args) => command(process.execPath, [cli, ...args], dir);
    run("init");
    assert.ok(existsSync(join(dir, "tapedb", "migrations", "0002_entities.sql")));
    assert.ok(existsSync(join(dir, "tapedb", "migrations.gen.ts")));
    const secret = readFileSync(join(dir, ".dev.vars"), "utf8");
    run("init");
    assert.equal(readFileSync(join(dir, ".dev.vars"), "utf8"), secret);
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), installedManifest);
    run("migrate", "check");

    // Compile the installed public types, including declaration emission for
    // the generated Worker. Source-only typechecks miss private-name leaks in
    // bundled .d.ts files (TS2742 in a downstream library or Worker).
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "Bundler",
        strict: true, skipLibCheck: true, declaration: true,
        emitDeclarationOnly: true, outDir: "types",
        types: [join(root, "node_modules/@cloudflare/workers-types")],
      },
      include: ["worker.ts", "tapedb.schema.ts", "tapedb/migrations.gen.ts"],
    }));
    command(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", dir], dir);
    assert.ok(existsSync(join(dir, "types/worker.d.ts")));

    // Relative imports must still resolve from beside the original schema.
    const schemaPath = join(dir, "tapedb.schema.ts");
    const original = readFileSync(schemaPath, "utf8");
    writeFileSync(join(dir, "fields.mts"), 'export const label: string = "Extra";\n');
    writeFileSync(schemaPath, 'import { label } from "./fields.mts";\n' + original.replace('export default schema({', 'export default schema({\n  extra: model({ title: t.string().default(label) }),'));
    command(process.execPath, [cli, "migrate", "check"], dir, 1);
    run("migrate", "dev", "--name", "extra");
    run("migrate", "check");
    assert.equal(readdirSync(dir).filter(name => /^\.tapedb\.schema\./.test(name)).length, 0);

    // A failed init must fail the process, keep user files, and clean its copy.
    rmSync(join(dir, "tapedb"), { recursive: true });
    writeFileSync(schemaPath, "export default {};\n");
    const failed = command(process.execPath, [cli, "init"], dir, 1);
    assert.match(failed.stderr, /must export a schema/);
    assert.doesNotMatch(failed.stdout, /Next:/);
    assert.equal(readFileSync(schemaPath, "utf8"), "export default {};\n");
    assert.equal(readFileSync(join(dir, ".dev.vars"), "utf8"), secret);
    assert.equal(readdirSync(dir).filter(name => /^\.tapedb\.schema\./.test(name)).length, 0);
    console.log(`package smoke: ${type ?? "default npm"} passed`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
