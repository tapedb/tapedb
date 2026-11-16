import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ignoreLocalFiles, missingSecrets, provisionAndDeploy, type DeployConfig, type WranglerCommand } from "../src/cli/onboarding";

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
    if (args[0] === "r2" && args[2] === "list") stdout = "name: app-data\ncreation_date: 2026-01-01\n";
    if (args[0] === "secret") stdout = JSON.stringify([{ name: "TAPEDB_CLAIM_SECRET" }]);
    if (args[0] === "deploy") {
      secretFile = args[args.indexOf("--secrets-file") + 1]!;
      const secrets = JSON.parse(readFileSync(secretFile, "utf8"));
      expect(Object.keys(secrets)).toEqual(["TAPEDB_KEY_SECRET"]);
    }
    return { status: 0, stdout, stderr: "" };
  };
  const config: DeployConfig = { name: "app", vars: { ENVIRONMENT: "development" }, r2_buckets: [{ binding: "DATA", bucket_name: "app-data" }, { binding: "FILES", bucket_name: "app-files" }] };
  const factory = (_root: string, account?: string) => { if (account) expect(account).toBe("account"); return command; };
  expect(await provisionAndDeploy(root, config, undefined, true, factory)).toBe(0);
  expect(calls.filter(args => args[0] === "r2" && args[2] === "create").map(args => args[3])).toEqual(["app-files"]);
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
  await expect(provisionAndDeploy(root, { name: "app" }, undefined, true, () => command)).rejects.toThrow("Secret lookup failed");
  expect(deployed).toBe(false);
});
