import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ignoreLocalFiles, installProject, missingSecrets, olderExactVersion, provisionAndDeploy, type DeployConfig, type WranglerCommand } from "../src/cli/onboarding";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project() { const root = mkdtempSync(join(tmpdir(), "tapedb-onboarding-")); roots.push(root); return root; }

test("local secret files are ignored without losing host rules or duplicating entries", () => {
  const root = project();
  writeFileSync(join(root, ".gitignore"), "custom/\n");
  ignoreLocalFiles(root);
  const once = readFileSync(join(root, ".gitignore"), "utf8");
  ignoreLocalFiles(root);
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(once);
  expect(once).toContain("custom/");
  expect(once).toContain(".dev.vars");
});

test("remote secrets are never rotated by setup", () => {
  const missing = missingSecrets(["TAPEDB_CLAIM_SECRET"]);
  expect(Object.keys(missing)).toEqual(["TAPEDB_KEY_SECRET"]);
  expect(Buffer.from(missing.TAPEDB_KEY_SECRET!, "base64url")).toHaveLength(32);
  expect(missingSecrets(["TAPEDB_CLAIM_SECRET", "TAPEDB_KEY_SECRET"])).toEqual({});
});

test("deployment reuses a bucket and secret, scopes commands to the chosen account and removes its secret file", async () => {
  const root = project();
  const calls: string[][] = [];
  let secretFile = "";
  const command: WranglerCommand = (args) => {
    calls.push(args);
    let stdout = "";
    if (args[0] === "whoami") stdout = JSON.stringify({ accounts: [{ id: "account", name: "My account" }] });
    if (args[0] === "r2" && args[2] === "create" && args[3] === "app-data") return { status: 1, stdout: "", stderr: "\u001b[31m✘ [ERROR]\u001b[0m The bucket you tried to create already exists, and you own it. [code: 10004]" };
    if (args[0] === "secret") stdout = JSON.stringify([{ name: "TAPEDB_CLAIM_SECRET" }]);
    if (args[0] === "deploy") {
      secretFile = args[args.indexOf("--secrets-file") + 1]!;
      const secrets = JSON.parse(readFileSync(secretFile, "utf8"));
      expect(Object.keys(secrets)).toEqual(["TAPEDB_KEY_SECRET"]);
    }
    return { status: 0, stdout, stderr: "" };
  };
  const config: DeployConfig = { account_id: "account", name: "app", vars: { ENVIRONMENT: "development" }, r2_buckets: [{ binding: "DATA", bucket_name: "app-data" }, { binding: "FILES", bucket_name: "app-files" }] };
  const factory = (_root: string, account?: string) => { if (account) expect(account).toBe("account"); return command; };
  expect(await provisionAndDeploy(root, config, undefined, true, factory)).toBe(0);
  expect(calls.filter(args => args[0] === "r2" && args[2] === "list")).toEqual([]);
  expect(calls.filter(args => args[0] === "r2" && args[2] === "create").map(args => args[3])).toEqual(["app-data", "app-files"]);
  expect(config.vars!.ENVIRONMENT).toBe("production");
  expect(existsSync(secretFile)).toBe(false);
});

test("a secret lookup permission error stops deployment instead of generating replacement secrets", async () => {
  const root = project();
  let deployed = false;
  const command: WranglerCommand = (args) => {
    if (args[0] === "whoami") return { status: 0, stdout: JSON.stringify({ accounts: [{ id: "account", name: "Account" }] }), stderr: "" };
    if (args[0] === "deploy") deployed = true;
    return { status: 1, stdout: "", stderr: "Authentication error [code: 10000]" };
  };
  await expect(provisionAndDeploy(root, { account_id: "account", name: "app" }, undefined, true, () => command)).rejects.toThrow("Secret lookup failed");
  expect(deployed).toBe(false);
});

test("a first deploy treats wrangler's missing-Worker answer as no secrets yet", async () => {
  // Wrangler 4.163 prints this without Cloudflare's 10007 code.
  const missing = `✘ [ERROR] Worker "tapedb-app" not found.\n\n  If this is a new Worker, run \`wrangler deploy\` first to create it.\n`;
  for (const answer of [missing, "A request to the Cloudflare API failed. workers.api.error.script_not_found [code: 10007]"]) {
    const root = project();
    let generated: string[] = [];
    const command: WranglerCommand = (args) => {
      if (args[0] === "whoami") return { status: 0, stdout: JSON.stringify({ accounts: [{ id: "account", name: "Account" }] }), stderr: "" };
      if (args[0] === "secret") return { status: 1, stdout: "", stderr: answer };
      if (args[0] === "deploy") generated = Object.keys(JSON.parse(readFileSync(args[args.indexOf("--secrets-file") + 1]!, "utf8")));
      return { status: 0, stdout: "", stderr: "" };
    };
    expect(await provisionAndDeploy(root, { account_id: "account", name: "tapedb-app" }, undefined, true, () => command)).toBe(0);
    expect(generated).toEqual(["TAPEDB_CLAIM_SECRET", "TAPEDB_KEY_SECRET"]);
  }
});

test("a missing-Worker answer about a different Worker still stops deployment", async () => {
  const root = project();
  let deployed = false;
  const command: WranglerCommand = (args) => {
    if (args[0] === "whoami") return { status: 0, stdout: JSON.stringify({ accounts: [{ id: "account", name: "Account" }] }), stderr: "" };
    if (args[0] === "deploy") deployed = true;
    return { status: 1, stdout: "", stderr: `✘ [ERROR] Worker "other-app" not found.` };
  };
  await expect(provisionAndDeploy(root, { account_id: "account", name: "tapedb-app" }, undefined, true, () => command)).rejects.toThrow("Secret lookup failed");
  expect(deployed).toBe(false);
});

test.each([
  '✘ [ERROR] Worker "app" not found.\n\nIf this is a new Worker, run wrangler deploy first to create it.',
  'A request to the Cloudflare API failed [code: 10007]',
  '\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mWorker "\u001b[0m\u001b[1mapp\u001b[0m\u001b[1m" not found.\u001b[0m',
])("first deployment accepts a missing Worker and preserves its generated secrets on rerun: %s", async (message) => {
  const root = project();
  const remote = new Map<string, string>();
  let deployments = 0;
  let removedFile = "";
  const command: WranglerCommand = (args) => {
    if (args[0] === "whoami") return { status: 0, stdout: JSON.stringify({ accounts: [{ id: "account", name: "Account" }] }), stderr: "" };
    if (args[0] === "secret") return remote.size
      ? { status: 0, stdout: JSON.stringify([...remote.keys()].map(name => ({ name }))), stderr: "" }
      : { status: 1, stdout: "", stderr: message };
    if (args[0] === "deploy") {
      deployments++;
      const at = args.indexOf("--secrets-file");
      if (deployments === 1) {
        expect(at).toBeGreaterThan(-1);
        removedFile = args[at + 1]!;
        const created = JSON.parse(readFileSync(removedFile, "utf8")) as Record<string, string>;
        expect(Object.keys(created).sort()).toEqual(["TAPEDB_CLAIM_SECRET", "TAPEDB_KEY_SECRET"]);
        for (const [name, value] of Object.entries(created)) {
          expect(Buffer.from(value, "base64url")).toHaveLength(32);
          remote.set(name, value);
        }
      } else expect(at).toBe(-1);
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error("Unexpected command: " + args.join(" "));
  };
  const config: DeployConfig = { account_id: "account", name: "app" };
  expect(await provisionAndDeploy(root, config, undefined, true, () => command)).toBe(0);
  expect(existsSync(removedFile)).toBe(false);
  const firstSecrets = [...remote];
  expect(await provisionAndDeploy(root, config, undefined, true, () => command)).toBe(0);
  expect([...remote]).toEqual(firstSecrets);
  expect(deployments).toBe(2);
});

test.each([
  '✘ [ERROR] Worker "different-app" not found.',
  '✘ [ERROR] Authentication error [code: 10000]',
  '✘ [ERROR] Permission denied',
  '✘ [ERROR] Unexpected response 404',
])("unrelated secret lookup failure stops deployment: %s", async (message) => {
  const root = project();
  let deployed = false;
  const command: WranglerCommand = (args) => {
    if (args[0] === "whoami") return { status: 0, stdout: JSON.stringify({ accounts: [{ id: "account", name: "Account" }] }), stderr: "" };
    if (args[0] === "deploy") deployed = true;
    return { status: 1, stdout: "", stderr: message };
  };
  await expect(provisionAndDeploy(root, { account_id: "account", name: "app" }, undefined, true, () => command)).rejects.toThrow("Secret lookup failed");
  expect(deployed).toBe(false);
});

test("buckets the account already owns are kept, however many buckets it has", async () => {
  // `wrangler r2 bucket list` shows only the API's first page (20 buckets), so on a larger
  // account it omits existing ones; creating answers 10004 for a bucket the account owns.
  const owned = "✘ [ERROR] A request to the Cloudflare API (/accounts/account/r2/buckets) failed.\n\n  The bucket you tried to create already exists, and you own it. [code: 10004]\n";
  const root = project();
  const created: string[] = [];
  let deployed = false;
  const command: WranglerCommand = (args) => {
    if (args[0] === "whoami") return { status: 0, stdout: JSON.stringify({ accounts: [{ id: "account", name: "Account" }] }), stderr: "" };
    if (args[0] === "r2" && args[2] === "list") return { status: 0, stdout: Array.from({ length: 20 }, (_, i) => `name: other-${i}\ncreation_date: 2026-01-01`).join("\n\n"), stderr: "" };
    if (args[0] === "r2" && args[2] === "create") {
      if (args[3] === "app-data") return { status: 1, stdout: "", stderr: owned };
      created.push(args[3]!);
    }
    if (args[0] === "secret") return { status: 0, stdout: "[]", stderr: "" };
    if (args[0] === "deploy") deployed = true;
    return { status: 0, stdout: "", stderr: "" };
  };
  const config: DeployConfig = { account_id: "account", name: "app", r2_buckets: [{ binding: "DATA", bucket_name: "app-data" }, { binding: "FILES", bucket_name: "app-files" }] };
  expect(await provisionAndDeploy(root, config, undefined, true, () => command)).toBe(0);
  expect(created).toEqual(["app-files"]);
  expect(deployed).toBe(true);
});

test("a bucket another account owns, or any other create failure, stops deployment", async () => {
  for (const stderr of [
    "The bucket you tried to create already exists. [code: 10004]",
    "✘ [ERROR] Authentication error [code: 10000]",
  ]) {
    const root = project();
    let deployed = false;
    const command: WranglerCommand = (args) => {
      if (args[0] === "whoami") return { status: 0, stdout: JSON.stringify({ accounts: [{ id: "account", name: "Account" }] }), stderr: "" };
      if (args[0] === "r2" && args[2] === "create") return { status: 1, stdout: "", stderr };
      if (args[0] === "deploy") deployed = true;
      return { status: 0, stdout: "[]", stderr: "" };
    };
    const config: DeployConfig = { account_id: "account", name: "app", r2_buckets: [{ binding: "DATA", bucket_name: "app-data" }] };
    await expect(provisionAndDeploy(root, config, undefined, true, () => command)).rejects.toThrow("R2 bucket creation failed");
    expect(deployed).toBe(false);
  }
});

test("only an exact older release counts as outdated", () => {
  expect(olderExactVersion("0.1.4", "0.1.7")).toBe(true);
  expect(olderExactVersion("0.1.9", "0.2.0")).toBe(true);
  expect(olderExactVersion("0.1.10", "0.1.9")).toBe(false);
  expect(olderExactVersion("0.1.7", "0.1.7")).toBe(false);
  expect(olderExactVersion("0.2.0", "0.1.7")).toBe(false);
  for (const chosen of ["^0.1.4", "~0.1.4", "latest", "workspace:*", "file:../tapedb", "0.1.4-beta.1", "", undefined]) {
    expect(olderExactVersion(chosen, "0.1.7")).toBe(false);
  }
});

test("init moves a project's exact older tapedb to its own version and keeps chosen ranges", () => {
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ dependencies: { "@tapedb/tapedb": "0.1.4" } }, "dependencies", "0.1.7"],
    [{ devDependencies: { "@tapedb/tapedb": "0.1.4" } }, "devDependencies", "0.1.7"],
    [{ dependencies: { "@tapedb/tapedb": "^0.1.4" } }, "dependencies", "^0.1.4"],
    [{ dependencies: { "@tapedb/tapedb": "0.2.0" } }, "dependencies", "0.2.0"],
  ];
  for (const [manifest, field, expected] of cases) {
    const root = project();
    // An unsupported manager stops installProject after package.json is written, before any install runs.
    writeFileSync(join(root, "package.json"), JSON.stringify({ ...manifest, packageManager: "deno@2.0.0" }));
    expect(() => installProject(root, "0.1.7")).toThrow("Unsupported package manager");
    const written = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(written[field]["@tapedb/tapedb"]).toBe(expected);
  }
});
