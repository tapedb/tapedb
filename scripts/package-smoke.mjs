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
    run("init", "--no-install", "--no-start");
    assert.ok(existsSync(join(dir, "tapedb", "migrations", "0002_entities.sql")));
    assert.ok(existsSync(join(dir, "tapedb", "migrations.gen.ts")));
    const secret = readFileSync(join(dir, ".dev.vars"), "utf8");
    run("init", "--no-install", "--no-start");
    assert.equal(readFileSync(join(dir, ".dev.vars"), "utf8"), secret);
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), installedManifest);
    run("migrate", "check");
    if (type === undefined) {
      // Exercise dependency installation against this packed version, before
      // it is published: the existing file dependency must remain intact.
      run("init", "--yes", "--no-start");
      const ready = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      assert.ok(ready.devDependencies.wrangler, "init must install Wrangler");
      assert.equal(ready.scripts["tapedb:dev"], "tapedb dev");
      assert.ok(existsSync(join(dir, "node_modules", "wrangler", "package.json")));
      assert.equal(ready.dependencies["@tapedb/tapedb"], JSON.parse(installedManifest).dependencies["@tapedb/tapedb"]);
      assert.ok(readFileSync(join(dir, ".gitignore"), "utf8").includes(".dev.vars"));
      console.log("package smoke: automatic project installation passed");
    }

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
    const failed = command(process.execPath, [cli, "init", "--no-install", "--no-start"], dir, 1);
    assert.match(failed.stderr, /must export a schema/);
    assert.doesNotMatch(failed.stdout, /Run it locally:/);
    assert.equal(readFileSync(schemaPath, "utf8"), "export default {};\n");
    assert.equal(readFileSync(join(dir, ".dev.vars"), "utf8"), secret);
    assert.equal(readdirSync(dir).filter(name => /^\.tapedb\.schema\./.test(name)).length, 0);
    console.log(`package smoke: ${type ?? "default npm"} passed`);
  }

  // `npx @tapedb/tapedb init` runs the CLI from outside the project: the schema it
  // writes imports the package by name, and with no node_modules beside it that name
  // cannot resolve. The README's first command must still write the first migration.
  const standalone = join(scratch, "standalone");
  mkdirSync(standalone);
  const outsideCli = join(scratch, "default", "node_modules", "@tapedb", "tapedb", "dist", "cli.js");
  command(process.execPath, [outsideCli, "init", "--no-install", "--no-start"], standalone);
  assert.ok(
    existsSync(join(standalone, "tapedb", "migrations", "0002_entities.sql")),
    "init outside a project must still write the first migration"
  );
  assert.equal(readdirSync(standalone).filter(name => /^\.tapedb\.schema\./.test(name)).length, 0);
  console.log("package smoke: init outside a project passed");

  // Missing-package resolution applies to the module graph, not to string
  // values inside the schema. Helpers may import the package themselves.
  for (const nested of [false, true]) {
    const dir = join(scratch, nested ? "standalone-helper" : "standalone-defaults");
    mkdirSync(dir);
    const schemaPath = join(dir, "tapedb.schema.ts");
    const values = ['@tapedb/tapedb', '@tapedb/tapedb/schema', '@tapedb/tapedb/worker', '@tapedb/tapedb/react'];
    const fields = values.map((value, index) => `field${index}: t.string().default(${JSON.stringify(value)})`).join(',');
    const source = nested
      ? 'import { schema, model } from "@tapedb/tapedb/schema";\nimport { fields } from "./fields.mts";\nexport default schema({ note: model(fields) });\n'
      : `import { schema, model, t } from "@tapedb/tapedb/schema";\nexport default schema({ note: model({${fields}}) });\n`;
    if (nested) writeFileSync(join(dir, "fields.mts"), `import { t } from "@tapedb/tapedb/schema";\nexport const fields = {${fields}};\n`);
    writeFileSync(schemaPath, source);
    command(process.execPath, [outsideCli, "init", "--no-install", "--no-start"], dir);
    const sql = readFileSync(join(dir, "tapedb", "migrations", "0002_entities.sql"), "utf8");
    for (const value of values) assert.ok(sql.includes(`DEFAULT '${value}'`), `schema default must remain ${value}`);
    assert.equal(readFileSync(schemaPath, "utf8"), source);
    assert.equal(readdirSync(dir).filter(name => /^\.tapedb\.schema\./.test(name)).length, 0);
  }
  console.log("package smoke: standalone defaults and helper imports passed");

  // Compile an actual consumer of the auth scaffold against the packed declarations.
  const authApp=join(scratch,"auth-app");mkdirSync(authApp);
  writeFileSync(join(authApp,"package.json"),JSON.stringify({name:"auth-consumer",private:true,type:"module"}));
  command("npm",["install",archive,"better-auth@1.7.25","react@19","react-dom@19","esbuild@0.28.2","--ignore-scripts","--no-audit","--no-fund"],authApp);
  const authCli=join(authApp,"node_modules/@tapedb/tapedb/dist/cli.js");
  command(process.execPath,[authCli,"init","--auth","--email-from","no-reply@local.test","--no-install","--no-start","--yes"],authApp);
  const config=JSON.parse(readFileSync(join(authApp,"wrangler.jsonc"),"utf8"));
  assert.ok(config.durable_objects.bindings.some(binding=>binding.name==="AUTH"));
  assert.ok(config.send_email.some(binding=>binding.name==="EMAIL"));
  assert.match(readFileSync(join(authApp,".dev.vars"),"utf8"),/^BETTER_AUTH_SECRET=.+$/m);
  writeFileSync(join(authApp,"tsconfig.json"),JSON.stringify({compilerOptions:{target:"ES2022",module:"ESNext",moduleResolution:"Bundler",strict:true,skipLibCheck:true,noEmit:true,types:[join(root,"node_modules/@cloudflare/workers-types")]},include:["worker.ts","auth.ts","tapedb.schema.ts","tapedb/migrations.gen.ts"]}));
  command(process.execPath,[join(root,"node_modules/typescript/bin/tsc"),"-p",authApp],authApp);
  writeFileSync(join(authApp,"tapedb.auth.tsx"),'import "./auth.css";export default function Auth(){return <h1>Custom auth from packed CLI</h1>;}');
  writeFileSync(join(authApp,"auth.css"),'h1{color:green}');
  command(process.execPath,[authCli,"auth","build"],authApp);
  const customPage=readFileSync(join(authApp,"tapedb/auth-page.gen.ts"),"utf8");
  assert.ok(customPage.includes("Custom auth from packed CLI"));
  assert.ok(customPage.includes('"css"'));
  command(process.execPath,[join(root,"node_modules/typescript/bin/tsc"),"-p",authApp],authApp);
  console.log("package smoke: auth scaffold, React override and public declarations passed");

  // `npx tapedb-cli <command>`: the wrapper package runs the CLI of the @tapedb/tapedb it pins.
  const cliPacked = command("npm", ["pack", "--json", "--pack-destination", scratch], join(root, "packages", "tapedb-cli"));
  const cliArchive = join(scratch, JSON.parse(cliPacked.stdout)[0].filename);
  const wrapper = join(scratch, "tapedb-cli");
  mkdirSync(wrapper);
  writeFileSync(join(wrapper, "package.json"), JSON.stringify({ name: "cli-consumer", private: true }));
  command("npm", ["install", archive, cliArchive, "--ignore-scripts", "--no-audit", "--no-fund"], wrapper);
  const bin = join(wrapper, "node_modules", ".bin", "tapedb-cli");
  assert.match(command(bin, ["--help"], wrapper).stdout, /npx tapedb-cli init/);
  const app = join(scratch, "tapedb-cli-app");
  mkdirSync(app);
  const initialised = command(bin, ["init", "--no-install", "--no-start"], app);
  assert.match(initialised.stdout, /Ready\. Start the database with npx tapedb-cli dev/);
  assert.ok(existsSync(join(app, "tapedb", "migrations", "0002_entities.sql")));
  // Exit codes pass through: a failing command fails the wrapper.
  writeFileSync(join(app, "tapedb.schema.ts"), "export default {};\n");
  command(bin, ["migrate", "check"], app, 1);
  console.log("package smoke: tapedb-cli passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
