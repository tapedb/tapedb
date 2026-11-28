/**
 * Extensions in the CLI: the packages a project lists under
 * `"tapedb": { "extensions": [...] }` in package.json, each loaded from
 * `<package>/tapedb`. See src/extension.ts for the contract.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionProject, TapeDBCliExtension } from "../extension";
import { parseJsonc } from "./jsonc";
import { SchemaEditError } from "./schema-edit";
import { wireSchemaExtension, wireWorkerExtension } from "./wire-extension";

interface PackageJson {
  name?: string;
  tapedb?: { extensions?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackage(root: string): PackageJson {
  const file = join(root, "package.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as PackageJson) : {};
}

/** The packages the project lists as extensions. */
export function listedExtensions(root: string): string[] {
  const list = readPackage(root).tapedb?.extensions ?? [];
  if (!Array.isArray(list) || list.some((p) => typeof p !== "string")) throw new Error('package.json "tapedb.extensions" must be a list of package names.');
  return list;
}

/**
 * The file `<package>/tapedb` names, found from the project as Node finds a
 * package (node_modules up the tree) and read from its "exports" with the
 * import conditions, so ESM-only packages load too.
 */
function resolveEntry(root: string, pkg: string): string | null {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const base = join(dir, "node_modules", pkg);
    if (existsSync(join(base, "package.json"))) {
      const manifest = JSON.parse(readFileSync(join(base, "package.json"), "utf8")) as { exports?: unknown };
      const pick = (target: unknown): string | null => {
        if (typeof target === "string") return target;
        if (target && typeof target === "object") {
          for (const condition of ["node", "import", "default"]) {
            const found = pick((target as Record<string, unknown>)[condition]);
            if (found) return found;
          }
        }
        return null;
      };
      const exported = manifest.exports && typeof manifest.exports === "object" ? pick((manifest.exports as Record<string, unknown>)["./tapedb"]) : null;
      const file = exported ? join(base, exported) : ["tapedb.js", "tapedb.mjs"].map((f) => join(base, f)).find(existsSync);
      return file && existsSync(file) ? file : null;
    }
    if (dirname(dir) === dir) return null;
  }
}

/** Loads `<package>/tapedb` as the project resolves it. */
export async function loadExtension(root: string, pkg: string): Promise<TapeDBCliExtension> {
  const entry = resolveEntry(root, pkg);
  if (!entry) {
    throw new Error(`${pkg} is listed as a TapeDB extension but ${pkg}/tapedb cannot be found. Install it (npm i -D ${pkg}) or remove it from "tapedb.extensions".`);
  }
  const mod = (await import(pathToFileURL(entry).href)) as { default?: TapeDBCliExtension };
  const ext = mod.default;
  if (!ext || typeof ext.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(ext.name)) {
    throw new Error(`${pkg}/tapedb must default-export defineExtension({ name, ... }).`);
  }
  return ext;
}

export async function loadExtensions(root: string): Promise<{ pkg: string; ext: TapeDBCliExtension }[]> {
  const out = [];
  for (const pkg of listedExtensions(root)) out.push({ pkg, ext: await loadExtension(root, pkg) });
  return out;
}

/** What an extension may do to the project. */
export function extensionProject(root: string, name: string): ExtensionProject {
  root = resolve(root);
  const wranglerFile = join(root, "wrangler.jsonc");
  const editWrangler = (change: (config: Record<string, any>) => boolean) => {
    if (!existsSync(wranglerFile)) throw new Error(`No wrangler.jsonc in ${root}. Run tapedb init first.`);
    const config = parseJsonc(readFileSync(wranglerFile, "utf8")) as Record<string, any>;
    if (change(config)) writeFileSync(wranglerFile, `${JSON.stringify(config, null, 2)}\n`);
  };
  const log = (message: string) => console.log(`  ${name}  ${message}`);
  const wire = (path: string, edit: (src: string, expression: string, imports: readonly string[]) => string | null, expression: string, imports: string[]) => {
    const file = join(root, path);
    if (!existsSync(file)) return false;
    try {
      const next = edit(readFileSync(file, "utf8"), expression, imports);
      if (next !== null) {
        writeFileSync(file, next);
        log(`${path}: added ${expression}`);
      }
      return true;
    } catch (error) {
      if (!(error instanceof SchemaEditError)) throw error;
      log(`${path}: ${error.message}`);
      return false;
    }
  };
  return {
    root,
    read: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null),
    write: (path, contents, options = {}) => {
      const file = join(root, path);
      if (existsSync(file) && !options.overwrite) return false;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, contents);
      return true;
    },
    wrangler: {
      addR2Bucket: (binding, suffix) =>
        editWrangler((config) => {
          const buckets: { binding: string; bucket_name: string; jurisdiction?: string }[] = (config.r2_buckets ??= []);
          if (buckets.some((b) => b.binding === binding)) return false;
          const jurisdiction = buckets.find((b) => b.jurisdiction)?.jurisdiction;
          buckets.push({ binding, bucket_name: `${config.name}-${suffix}`, ...(jurisdiction ? { jurisdiction } : {}) });
          return true;
        }),
      addCron: (expression) =>
        editWrangler((config) => {
          const crons: string[] = ((config.triggers ??= {}).crons ??= []);
          if (crons.includes(expression)) return false;
          crons.push(expression);
          return true;
        }),
      addVar: (key, value) =>
        editWrangler((config) => {
          const vars = (config.vars ??= {});
          if (key in vars) return false;
          vars[key] = value;
          return true;
        }),
      setIfAbsent: (key, value) =>
        editWrangler((config) => {
          if (key in config) return false;
          config[key] = value;
          return true;
        }),
    },
    useInSchema: (expression, imports) => wire("tapedb.schema.ts", wireSchemaExtension, expression, imports),
    useInWorker: (expression, imports) => {
      const main = existsSync(wranglerFile) ? (parseJsonc(readFileSync(wranglerFile, "utf8")) as { main?: string }).main : undefined;
      return wire(main ?? "worker.ts", wireWorkerExtension, expression, imports);
    },
    installDev: (packages) => {
      const pkg = readPackage(root);
      const missing = packages.filter((p) => {
        const bare = p.replace(/(?<=.)@[^@/]*$/, "");
        return !pkg.dependencies?.[bare] && !pkg.devDependencies?.[bare];
      });
      if (missing.length === 0) return;
      const result = spawnSync("npm", ["install", "--save-dev", ...missing], { cwd: root, stdio: "inherit" });
      if (result.status !== 0) throw new Error(`npm install ${missing.join(" ")} failed.`);
    },
    log,
  };
}

/** `tapedb add <package>`: install, list in package.json, set the project up. */
export async function addExtension(root: string, pkg: string): Promise<number> {
  root = resolve(root);
  const before = readPackage(root);
  const bare = pkg.replace(/(?<=.)@[^@/]*$/, "");
  if (!before.dependencies?.[bare] && !before.devDependencies?.[bare]) {
    const result = spawnSync("npm", ["install", pkg], { cwd: root, stdio: "inherit" });
    if (result.status !== 0) return 1;
  }
  const after = readPackage(root);
  const list = (after.tapedb ??= {}).extensions ?? [];
  if (!list.includes(bare)) {
    after.tapedb.extensions = [...list, bare];
    writeFileSync(join(root, "package.json"), `${JSON.stringify(after, null, 2)}\n`);
  }
  const ext = await loadExtension(root, bare);
  await ext.add?.(extensionProject(root, ext.name));
  console.log(`\nAdded ${bare}. ${ext.commands ? `Its commands: tapedb ${ext.name} --help` : ""}`.trimEnd());
  return 0;
}

/**
 * Runs every listed extension's build. With `live`, watches the files each
 * build names and runs that build again when one changes; `close` stops it.
 */
export async function buildExtensions(root: string, mode: "dev" | "deploy", live = false): Promise<{ close(): void }> {
  const watchers: ReturnType<typeof watch>[] = [];
  for (const { ext } of await loadExtensions(root)) {
    if (!ext.build) continue;
    const project = extensionProject(root, ext.name);
    const result = (await ext.build(project, { mode })) ?? {};
    if (!live) continue;
    for (const path of result.watch ?? []) {
      const file = join(resolve(root), path);
      if (!existsSync(file)) continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      watchers.push(
        watch(file, () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            Promise.resolve(ext.build!(project, { mode })).catch((error) => project.log(`build failed: ${error instanceof Error ? error.message : error}`));
          }, 100);
        }),
      );
    }
  }
  return { close: () => watchers.forEach((w) => w.close()) };
}

/** `tapedb <extension> <command> ...`, or null when no listed extension has that name. */
export async function runExtensionCommand(root: string, argv: string[]): Promise<number | null> {
  const [name, command, ...rest] = argv;
  let found: TapeDBCliExtension | undefined;
  try {
    found = (await loadExtensions(root)).find(({ ext }) => ext.name === name)?.ext;
  } catch (error) {
    if (listedExtensions(root).length) throw error;
  }
  if (!found) return null;
  const commands = found.commands ?? {};
  if (!command || command === "--help" || command === "-h" || !commands[command]) {
    console.log(`tapedb ${found.name}\n\n${Object.entries(commands).map(([c, d]) => `  npx tapedb-cli ${found!.name} ${c} ${d.usage}\n      ${d.summary}`).join("\n") || "  (no commands)"}`);
    return command && command !== "--help" && command !== "-h" ? 1 : 0;
  }
  const code = await commands[command]!.run(rest, extensionProject(root, found.name));
  return typeof code === "number" ? code : 0;
}
