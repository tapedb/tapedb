import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { confirm, interactive, select } from "./prompts";
export { ask, confirm, interactive } from "./prompts";

export function installProject(root: string, version: string, auth=false): void {
  const path = join(root, "package.json");
  const pkg = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { private: true, type: "module" };
  pkg.dependencies ??= {};
  pkg.devDependencies ??= {};
  // A project that already depends on tapedb keeps its entry; syncTapedb below brings an older
  // installed copy up to this CLI's version after the install.
  if (!pkg.dependencies["@tapedb/tapedb"] && !pkg.devDependencies["@tapedb/tapedb"]) pkg.dependencies["@tapedb/tapedb"] = version;
  if (!pkg.dependencies.wrangler && !pkg.devDependencies.wrangler) pkg.devDependencies.wrangler = "^4.163.0";
  if(auth){
    pkg.dependencies["better-auth"] ??= "^1.7.25";
    pkg.devDependencies.esbuild ??= "0.28.2";
    pkg.scripts ??= {};
    pkg.scripts["tapedb:auth:build"] ??= "tapedb auth build";
    if(existsSync(join(root,"tapedb.auth.tsx"))){pkg.dependencies.react??="^19.0.0";pkg.dependencies["react-dom"]??="^19.0.0";pkg.devDependencies["@types/react"]??="19";pkg.devDependencies["@types/react-dom"]??="19";}
  }
  pkg.scripts ??= {};
  for (const [name, command] of Object.entries({ "tapedb:dev": "tapedb dev", "tapedb:studio": "tapedb studio", "tapedb:deploy": "tapedb deploy" })) {
    pkg.scripts[name] ??= command;
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  const manager = packageManager(root);
  if (!["npm", "bun", "pnpm", "yarn"].includes(manager)) throw new Error("Unsupported package manager: " + manager);
  console.log("\nInstalling project dependencies with " + manager + "...");
  const result = spawnSync(manager, ["install"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error("Dependency installation failed; rerun init to resume.");
  syncTapedb(root, version);
}

export type PackageRunner = (manager: string, args: string[], root: string) => number | null;
const runPackageManager: PackageRunner = (manager, args, root) => spawnSync(manager, args, { cwd: root, stdio: "inherit" }).status;

/** The package manager a project uses: its packageManager field, else its lockfile, else npm. */
export function packageManager(root: string): string {
  const path = join(root, "package.json");
  const pkg = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as { packageManager?: unknown } : {};
  const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0]! : undefined;
  return declared ?? (existsSync(join(root, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(root, "yarn.lock")) ? "yarn" : existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")) ? "bun" : "npm");
}

/**
 * Brings the project's installed @tapedb/tapedb up to this CLI's version, so `dev` and `deploy`
 * run and bundle the runtime the CLI was built with. Only ever moves forward, never touches a
 * `workspace:`, `file:` or `link:` dependency, and does nothing in a project without tapedb.
 * Returns the version it moved from, or null.
 */
export function syncTapedb(root: string, version: string, run: PackageRunner = runPackageManager): string | null {
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) return null;
  const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const dev = !pkg.dependencies?.["@tapedb/tapedb"] && Boolean(pkg.devDependencies?.["@tapedb/tapedb"]);
  const spec = pkg.dependencies?.["@tapedb/tapedb"] ?? pkg.devDependencies?.["@tapedb/tapedb"];
  if (spec === undefined || /^(workspace|file|link|portal):/.test(spec)) return null;
  const installedPath = join(root, "node_modules", "@tapedb", "tapedb", "package.json");
  const installed = existsSync(installedPath) ? (JSON.parse(readFileSync(installedPath, "utf8")) as { version?: string }).version : undefined;
  if (installed === undefined || !olderExactVersion(installed, version)) return null;
  const manager = packageManager(root);
  if (!["npm", "bun", "pnpm", "yarn"].includes(manager)) throw new Error("Unsupported package manager: " + manager);
  console.log(`  updated  @tapedb/tapedb ${installed} → ${version}`);
  const args = manager === "npm" ? ["install", ...(dev ? ["--save-dev"] : []), `@tapedb/tapedb@${version}`]
    : ["add", ...(dev ? [manager === "bun" ? "--dev" : "-D"] : []), `@tapedb/tapedb@${version}`];
  if (run(manager, args, root) !== 0) throw new Error(`Updating @tapedb/tapedb to ${version} failed; run \`${manager} ${args.join(" ")}\` in the project.`);
  return installed;
}

/**
 * Whether `pinned` is an exact release (`1.2.3`) older than `current`. Anything else, a range,
 * tag, link or prerelease, is never older.
 */
export function olderExactVersion(pinned: unknown, current: string): boolean {
  const exact = /^(\d+)\.(\d+)\.(\d+)$/;
  const a = typeof pinned === "string" ? exact.exec(pinned) : null;
  const b = exact.exec(current);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]);
  }
  return false;
}

export function ignoreLocalFiles(root: string): void {
  const path = join(root, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const entries = ["node_modules/", ".wrangler/", ".dev.vars", ".dev.vars.*", "tapedb/auth-page.gen.ts"];
  const missing = entries.filter(entry => !current.split(/\r?\n/).includes(entry));
  if (missing.length) appendFileSync(path, "\n" + missing.join("\n") + "\n");
}

export type CommandResult = { status: number | null; stdout: string; stderr: string };
export type WranglerCommand = (args: string[], capture?: boolean) => CommandResult;
type Bucket = { binding?: string; bucket_name?: string; jurisdiction?: string };
/** A Vectorize binding, as Wrangler declares it in `wrangler.jsonc`. */
export type VectorizeBinding = { binding?: string; index_name?: string };
type DeployEnvironment = {
  name?: string; account_id?: string; vars?: Record<string, string>;
  r2_buckets?: Bucket[]; vectorize?: VectorizeBinding[];
};
export type DeployConfig = DeployEnvironment & {
  env?: Record<string, DeployEnvironment>;
  [key: string]: unknown;
};

export function wranglerCommand(root: string, account?: string): WranglerCommand {
  return (args, capture = false) => {
    const result = spawnSync("npx", ["--no-install", "wrangler", ...args], {
      cwd: root, encoding: "utf8", stdio: capture ? "pipe" : "inherit",
      env: { ...process.env, NO_COLOR: "1", ...(account ? { CLOUDFLARE_ACCOUNT_ID: account } : {}) },
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

function requireSuccess(result: CommandResult, operation: string): string {
  if (result.status !== 0) throw new Error(operation + " failed. " + result.stderr);
  return result.stdout;
}

/**
 * A refusal the operator can fix. Thrown by a deploy hook that validated
 * something before uploading; the CLI prints it and exits non-zero instead of
 * a stack trace.
 */
export class DeployRefused extends Error {}

/** What a deploy hook may do once the account is known and before the upload. */
export type BeforeDeploy = (
  command: WranglerCommand,
  context: { account: string; worker: string; selected: DeployConfig; env: string | undefined }
) => Promise<void> | void;

/** Account-scoped, resumable provisioning; never overwrites an existing remote secret. */
export async function provisionAndDeploy(root: string, config: DeployConfig, env: string | undefined, yes: boolean, createCommand: typeof wranglerCommand = wranglerCommand, beforeDeploy?: BeforeDeploy): Promise<number> {
  const selected = env ? config.env?.[env] : config;
  if (!selected) throw new Error("Unknown Wrangler environment: " + env);
  let command = createCommand(root);
  let identity = command(["whoami", "--json"], true);
  if (identity.status !== 0) {
    if (!interactive()) throw new Error("Cloudflare authentication is required for deployment.");
    requireSuccess(command(["login"]), "Cloudflare login");
    identity = command(["whoami", "--json"], true);
  }
  const user = JSON.parse(requireSuccess(identity, "Cloudflare account lookup")) as { accounts?: Array<{ id: string; name: string }> };
  const accounts = user.accounts ?? [];
  let account = selected.account_id ?? config.account_id ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) {
    if (accounts.length === 1) account = accounts[0]!.id;
    else {
      if (!interactive()) throw new Error("Select an account using account_id in wrangler.jsonc.");
      const index = await select("Cloudflare account", accounts.map(item => item.name + " (" + item.id + ")"));
      account = accounts[index]?.id;
    }
  }
  if (!account || !accounts.some(item => item.id === account)) throw new Error("Selected account is not available in this Cloudflare login.");
  const buckets = selected.r2_buckets ?? config.r2_buckets ?? [];
  if (!selected.name && !config.name) throw new Error("Worker name is missing.");
  console.log("\nDeploy " + (selected.name ?? config.name) + " to " + accounts.find(item => item.id === account)!.name);
  console.log("  R2: " + buckets.map(bucket => bucket.bucket_name).join(", "));
  console.log("  Existing buckets and secrets are kept. Missing secrets are generated.");
  if (!yes && !(await confirm("Deploy now?", true))) return 1;
  const scoped = createCommand(root, account);
  // Provisioning runs after the decision and before the upload: nothing is
  // created in the account for a deploy the operator cancelled, and nothing is
  // uploaded that needs a resource this step failed to create.
  if (beforeDeploy !== undefined) {
    try {
      await beforeDeploy(scoped, { account, worker: workerName(config, env), selected, env });
    } catch (error) {
      if (error instanceof DeployRefused) {
        console.error("Refusing to deploy: " + error.message);
        return 1;
      }
      throw error;
    }
  }
  // Persist the chosen account and production mode only after the deployment decision.
  config.account_id = account;
  selected.vars ??= {};
  selected.vars.ENVIRONMENT = "production";
  writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify(config, null, 2) + "\n");
  command = scoped;
  const environmentArgs = env ? ["--env", env] : [];
  if(existsSync(join(root,"auth.ts"))){
    const sender=selected.vars?.EMAIL_FROM??config.vars?.EMAIL_FROM;
    if(!sender||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender))throw new Error("EMAIL_FROM must be an address on your sending domain.");
    requireSuccess(command(["email","sending","enable",sender.split("@")[1]!]),"Email sending domain setup");
  }
  const ensured = new Set<string>();
  for (const bucket of buckets) {
    if (!bucket.bucket_name) throw new Error("Every R2 binding needs a bucket_name.");
    const jurisdiction = bucket.jurisdiction ?? "";
    if (ensured.has(jurisdiction + "/" + bucket.bucket_name)) continue;
    ensureBucket(command, bucket.bucket_name, jurisdiction);
    ensured.add(jurisdiction + "/" + bucket.bucket_name);
  }
  const listed = command(["secret", "list", "--format", "json", ...environmentArgs], true);
  let existing: Array<{ name: string }> = [];
  if (listed.status === 0) existing = JSON.parse(listed.stdout);
  else if (!workerNotFound(listed.stderr + listed.stdout, workerName(config, env))) requireSuccess(listed, "Secret lookup");
  const secrets = missingSecrets(existing.map(item => item.name));
  if(existsSync(join(root,"auth.ts"))&&!existing.some(item=>item.name==="BETTER_AUTH_SECRET"))secrets.BETTER_AUTH_SECRET=randomBytes(32).toString("base64url");
  const temp = mkdtempSync(join(tmpdir(), "tapedb-deploy-"));
  try {
    const file = join(temp, "secrets.json");
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    const result = command(["deploy", ...environmentArgs, ...(Object.keys(secrets).length ? ["--secrets-file", file] : [])]);
    if (result.status === 0 && servesStudio(root)) console.log("\n  Studio: open the address above; it is at /_tapedb/studio.");
    return result.status ?? 1;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

/** Whether worker.ts passes the studio to defineTapeDB. */
export function servesStudio(root: string): boolean {
  try {
    return /from\s+["']@tapedb\/tapedb\/studio["']/.test(readFileSync(join(root, "worker.ts"), "utf8"));
  } catch {
    return false;
  }
}

/** The name Wrangler deploys under: an environment without its own name gets `<name>-<env>`. */
function workerName(config: DeployConfig, env: string | undefined): string {
  if (!env) return config.name ?? "";
  return config.env?.[env]?.name ?? config.name + "-" + env;
}

/**
 * Whether a failed `wrangler secret list` only says this Worker does not exist yet (a first
 * deploy). The API answers with code 10007; Wrangler 4.163 prints `Worker "<name>" not found.`
 * without it, and may colour it. Any other failure, or a missing Worker of another name, is a
 * real error.
 */
function workerNotFound(output: string, name: string): boolean {
  const plain = stripVTControlCharacters(output);
  return /\b10007\b/.test(plain) || plain.includes('Worker "' + name + '" not found');
}

/**
 * Creates the bucket unless this account already owns it. Creating is the check: Cloudflare
 * answers code 10004 "already exists, and you own it" for an owned bucket, while
 * `wrangler r2 bucket list` shows only the first page of 20 buckets and would miss it on a
 * larger account. A bucket another account owns, or any other failure, stops deployment.
 */
function ensureBucket(command: WranglerCommand, name: string, jurisdiction: string): void {
  const created = command(["r2", "bucket", "create", name, ...(jurisdiction ? ["--jurisdiction", jurisdiction] : []), "--update-config=false"], true);
  const output = stripVTControlCharacters(created.stderr + created.stdout);
  if (created.status === 0) {
    console.log(`  created  R2 bucket ${name}${jurisdiction ? ` (${jurisdiction})` : ""}`);
  } else if (/\b10004\b/.test(output) && /you own it/i.test(output)) {
    console.log(`  kept     R2 bucket ${name}${jurisdiction ? ` (${jurisdiction})` : ""}`);
  } else {
    requireSuccess(created, "R2 bucket creation");
  }
}

export function missingSecrets(existing: string[]): Record<string, string> {
  return Object.fromEntries(["TAPEDB_CLAIM_SECRET", "TAPEDB_KEY_SECRET"].filter(name => !existing.includes(name)).map(name => [name, randomBytes(32).toString("base64url")]));
}
