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

  // The wrappers. Each one is an alias for a single entry of this core release,
  // so a wrapper left behind by a release fails here instead of on a consumer's
  // machine: the version equals the core's, the core pin is exact, the tarball
  // carries the declared files and nothing else, and the alias exports the
  // subpath's own bindings. Every wrapper is installed beside the packed core
  // tarball, never the registry: the version its pin names does not exist there
  // yet, and "installed fine from npm" would prove nothing about this release.
  const coreManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const wrappers = [
    // The CLI is a command, not an import: its entry is the core's bin, so it
    // asserts delegation (`--help` and exit codes come from the core CLI)
    // where the other three assert export identity.
    { dir: "packages/cli", name: "@tapedb/cli", entry: null, install: [], command: "tapedb-cli" },
    { dir: "packages/react", name: "@tapedb/react", entry: "react", install: ["react@19"], type: "PresencePeersOptions" },
    { dir: "packages/auth", name: "@tapedb/auth", entry: "auth", install: ["better-auth@1.7.25"], type: "TapeDBAuthOptions" },
    { dir: "packages/email", name: "@tapedb/email", entry: "email", install: [], type: "MailerOptions" },
  ];
  for (const wrapper of wrappers) {
    const manifest = JSON.parse(readFileSync(join(root, wrapper.dir, "package.json"), "utf8"));
    assert.equal(manifest.name, wrapper.name, `${wrapper.dir} must be published as ${wrapper.name}`);
    assert.equal(manifest.version, coreManifest.version, `${wrapper.name} must ship the core package version`);
    assert.deepEqual(
      manifest.dependencies,
      { "@tapedb/tapedb": coreManifest.version },
      `${wrapper.name} must pin the exact core version, so a drifted wrapper fails this gate`
    );
    assert.equal(manifest.repository.directory, wrapper.dir, `${wrapper.name} must point repository.directory at ${wrapper.dir}`);
    assert.equal(manifest.publishConfig.access, "public", `${wrapper.name} must publish publicly`);

    const packed = JSON.parse(command("npm", ["pack", "--json", "--pack-destination", scratch], join(root, wrapper.dir)).stdout)[0];
    const wrapperArchive = join(scratch, packed.filename);
    assert.deepEqual(
      packed.files.map(file => file.path).sort(),
      [...manifest.files, "package.json"].sort(),
      `${wrapper.name} ships the alias and nothing else`
    );

    const app = join(scratch, wrapper.name.replace("@", "").replace("/", "-"));
    mkdirSync(app);
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: `${wrapper.dir}-consumer`, private: true, type: "module" }));
    command("npm", ["install", archive, wrapperArchive, ...wrapper.install, "--ignore-scripts", "--no-audit", "--no-fund"], app);
    // Both sides came from disk: a registry fetch would mean the pin drifted.
    const lockfile = JSON.parse(readFileSync(join(app, "package-lock.json"), "utf8"));
    assert.match(lockfile.packages["node_modules/@tapedb/tapedb"].resolved, /\.tgz$/, `${wrapper.name} must install beside the packed core tarball, never the registry`);
    assert.match(lockfile.packages[`node_modules/${wrapper.name}`].resolved, /\.tgz$/, `${wrapper.name} itself must be the packed tarball`);
    assert.equal(
      JSON.parse(readFileSync(join(app, "node_modules", "@tapedb", "tapedb", "package.json"), "utf8")).version,
      coreManifest.version,
      `${wrapper.name}'s exact pin must resolve to this core version`
    );

    if (wrapper.entry === null) {
      const bin = join(app, "node_modules", ".bin", wrapper.command);
      const coreCli = join(app, "node_modules", "@tapedb", "tapedb", "dist", "cli.js");
      const coreHelp = command(process.execPath, [coreCli, "--help"], app).stdout;
      assert.match(coreHelp, /npx tapedb-cli init/, "the core CLI's help still names the tapedb-cli command");
      assert.equal(command(bin, ["--help"], app).stdout, coreHelp, `${wrapper.name} must run the core CLI, not a copy of it`);
      const project = join(scratch, "cli-project");
      mkdirSync(project);
      const initialised = command(bin, ["init", "--no-install", "--no-start"], project);
      assert.match(initialised.stdout, /Ready\. Start the database with npx tapedb-cli dev/);
      assert.ok(existsSync(join(project, "tapedb", "migrations", "0002_entities.sql")), `${wrapper.name} must run a working init`);
      // Exit codes pass through: a failing command fails the wrapper.
      writeFileSync(join(project, "tapedb.schema.ts"), "export default {};\n");
      command(bin, ["migrate", "check"], project, 1);
      console.log(`package smoke: ${wrapper.name} passed (bin ${wrapper.command} delegates to the packed core CLI, exit codes pass through)`);
      continue;
    }

    // One probe for both import paths in one process: the names must match and
    // each value must be the subpath's own binding, not a copy of it.
    writeFileSync(join(app, "probe.mjs"), [
      'import assert from "node:assert/strict";',
      `import * as alias from "${wrapper.name}";`,
      `import * as subpath from "@tapedb/tapedb/${wrapper.entry}";`,
      'assert.ok(Object.keys(subpath).length > 0, "the subpath must export names");',
      `assert.deepEqual(Object.keys(alias).sort(), Object.keys(subpath).sort(), "${wrapper.name} and the subpath must export the same names");`,
      `for (const name of Object.keys(subpath)) assert.equal(alias[name], subpath[name], name + " must be the subpath's own binding, not a copy");`,
      'console.log(Object.keys(alias).sort().join(", "));',
    ].join("\n"));
    const exportsSeen = command(process.execPath, ["probe.mjs"], app).stdout.trim();
    assert.ok(exportsSeen.length > 0, `${wrapper.name} must export the subpath's names`);

    // Declarations emitted through the alias must name the subpath's types.
    writeFileSync(join(app, "consumer.ts"), [
      `import type { ${wrapper.type} } from "${wrapper.name}";`,
      `export const probe: ${wrapper.type} | undefined = undefined;`,
    ].join("\n"));
    writeFileSync(join(app, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true,
        skipLibCheck: true, declaration: true, emitDeclarationOnly: true, outDir: "types",
      },
      include: ["consumer.ts"],
    }));
    command(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", app], app);
    assert.match(readFileSync(join(app, "types", "consumer.d.ts"), "utf8"), new RegExp(wrapper.type), `${wrapper.name} must carry the subpath's declarations`);
    console.log(`package smoke: ${wrapper.name} passed (${exportsSeen})`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
