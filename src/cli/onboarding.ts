import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirm, interactive, select } from "./prompts";
export { ask, confirm, interactive } from "./prompts";

export function installProject(root: string, version: string): void {
  const path = join(root, "package.json");
  const pkg = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { private: true, type: "module" };
  pkg.dependencies ??= {};
  pkg.devDependencies ??= {};
  // Preserve the host project's selected versions.
  if (!pkg.dependencies["@tapedb/tapedb"] && !pkg.devDependencies["@tapedb/tapedb"]) pkg.dependencies["@tapedb/tapedb"] = version;
  if (!pkg.dependencies.wrangler && !pkg.devDependencies.wrangler) pkg.devDependencies.wrangler = "^4.163.0";
  pkg.scripts ??= {};
  for (const [name, command] of Object.entries({ "tapedb:dev": "tapedb dev", "tapedb:studio": "tapedb studio", "tapedb:deploy": "tapedb deploy" })) {
    pkg.scripts[name] ??= command;
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  const manager = declared ?? (existsSync(join(root, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(root, "yarn.lock")) ? "yarn" : existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")) ? "bun" : "npm");
  if (!["npm", "bun", "pnpm", "yarn"].includes(manager)) throw new Error("Unsupported package manager: " + manager);
  console.log("\nInstalling project dependencies with " + manager + "...");
  const result = spawnSync(manager, ["install"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error("Dependency installation failed; rerun init to resume.");
}

export function ignoreLocalFiles(root: string): void {
  const path = join(root, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const entries = ["node_modules/", ".wrangler/", ".dev.vars", ".dev.vars.*"];
  const missing = entries.filter(entry => !current.split(/\r?\n/).includes(entry));
  if (missing.length) appendFileSync(path, "\n" + missing.join("\n") + "\n");
}

export type CommandResult = { status: number | null; stdout: string; stderr: string };
export type WranglerCommand = (args: string[], capture?: boolean) => CommandResult;
type Bucket = { binding?: string; bucket_name?: string; jurisdiction?: string };
export type DeployConfig = {
  name?: string; account_id?: string; vars?: Record<string, string>;
  r2_buckets?: Bucket[];
  env?: Record<string, { name?: string; account_id?: string; vars?: Record<string, string>; r2_buckets?: Bucket[] }>;
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

/** Account-scoped, resumable provisioning; never overwrites an existing remote secret. */
export async function provisionAndDeploy(root: string, config: DeployConfig, env: string | undefined, yes: boolean, createCommand: typeof wranglerCommand = wranglerCommand): Promise<number> {
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
  // Persist the chosen account and production mode only after the deployment decision.
  config.account_id = account;
  selected.vars ??= {};
  selected.vars.ENVIRONMENT = "production";
  writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify(config, null, 2) + "\n");
  command = createCommand(root, account);
  const environmentArgs = env ? ["--env", env] : [];
  const known = new Map<string, Set<string>>();
  for (const bucket of buckets) {
    if (!bucket.bucket_name) throw new Error("Every R2 binding needs a bucket_name.");
    const jurisdiction = bucket.jurisdiction ?? "";
    let names = known.get(jurisdiction);
    if (!names) {
      const output = requireSuccess(command(["r2", "bucket", "list", ...(jurisdiction ? ["--jurisdiction", jurisdiction] : [])], true), "R2 bucket lookup");
      names = new Set(Array.from(output.matchAll(/^\s*name:\s*(\S+)\s*$/gm), match => match[1]!));
      known.set(jurisdiction, names);
    }
    if (!names.has(bucket.bucket_name)) {
      requireSuccess(command(["r2", "bucket", "create", bucket.bucket_name, ...(jurisdiction ? ["--jurisdiction", jurisdiction] : []), "--update-config=false"]), "R2 bucket creation");
      names.add(bucket.bucket_name);
    }
  }
  const listed = command(["secret", "list", "--format", "json", ...environmentArgs], true);
  let existing: Array<{ name: string }> = [];
  if (listed.status === 0) existing = JSON.parse(listed.stdout);
  else if (!workerNotFound(listed.stderr + listed.stdout, workerName(config, env))) requireSuccess(listed, "Secret lookup");
  const secrets = missingSecrets(existing.map(item => item.name));
  const temp = mkdtempSync(join(tmpdir(), "tapedb-deploy-"));
  try {
    const file = join(temp, "secrets.json");
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    const result = command(["deploy", ...environmentArgs, ...(Object.keys(secrets).length ? ["--secrets-file", file] : [])]);
    return result.status ?? 1;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

/** The name Wrangler deploys under: an environment without its own name gets `<name>-<env>`. */
function workerName(config: DeployConfig, env: string | undefined): string {
  if (!env) return config.name ?? "";
  return config.env?.[env]?.name ?? config.name + "-" + env;
}

/**
 * Whether a failed `wrangler secret list` only says this Worker does not exist yet (a first
 * deploy). The API answers with code 10007; Wrangler 4.163 prints `Worker "<name>" not found.`
 * without it. Any other failure, or a missing Worker of another name, is a real error.
 */
function workerNotFound(output: string, name: string): boolean {
  return /\b10007\b/.test(output) || output.includes('Worker "' + name + '" not found');
}

export function missingSecrets(existing: string[]): Record<string, string> {
  return Object.fromEntries(["TAPEDB_CLAIM_SECRET", "TAPEDB_KEY_SECRET"].filter(name => !existing.includes(name)).map(name => [name, randomBytes(32).toString("base64url")]));
}
