#!/usr/bin/env node
/**
 * Stage a release for approval on npm.
 *
 * Called by the Cloudflare Workers Builds deploy command on `tapedb-staging`:
 *
 *   bun run release:publish
 *
 * Staged publishing needs no second factor — the approval is the proof of
 * presence, and a maintainer gives it once for the whole batch on npmjs.com.
 * That is why this uses `npm stage publish` and never `npm publish`: a token in
 * a build environment should be able to fill the queue, not empty it.
 *
 *   NPM_TOKEN          granular token with publish rights, no bypass 2FA
 *   RELEASE_TAG        optional; defaults to the tag on HEAD (v0.2.1)
 *   --dry-run          print the plan and the preconditions, stage nothing
 *   --check            preconditions only, exit non-zero if they fail
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/** Core first: every wrapper pins it exactly, so it must reach the registry. */
const PACKAGES = [
  ".",
  "packages/cli",
  "packages/react",
  "packages/auth",
  "packages/email",
  "packages/react-native",
];

const MIN_NPM = [11, 15, 0]; // staged publishing
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const checkOnly = args.has("--check");

function run(cmd, cmdArgs, options = {}) {
  return execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function fail(message) {
  console.error(`release-publish: ${message}`);
  process.exit(1);
}

function npmVersion() {
  const raw = run("npm", ["--version"]);
  const parts = raw.split(".").map((n) => Number.parseInt(n, 10));
  return { raw, parts };
}

function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function exactTag() {
  try {
    return run("git", ["describe", "--tags", "--exact-match", "HEAD"]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- preconditions

if (run("git", ["status", "--porcelain"])) {
  fail("working tree is dirty; a release is staged from a clean checkout");
}

const tag = process.env.RELEASE_TAG || exactTag();
if (!tag) {
  fail("HEAD is not a tag. Staging runs from the release tag (or set RELEASE_TAG).");
}
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  fail(`tag "${tag}" is not a release tag (vX.Y.Z)`);
}
const version = tag.slice(1);

const { raw: npmRaw, parts: npmParts } = npmVersion();
if (compare(npmParts, MIN_NPM) < 0) {
  fail(`npm ${npmRaw} is too old for staged publishing; 11.15.0 or newer is required`);
}

const manifests = PACKAGES.map((dir) => {
  const path = join(dir, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const pin = manifest.dependencies?.["@tapedb/tapedb"];
  if (manifest.private === true) fail(`${manifest.name} is marked private`);
  if (manifest.version !== version) {
    fail(`${manifest.name} is ${manifest.version}, tag says ${version} — bump before tagging`);
  }
  if (dir !== "." && pin !== version) {
    fail(`${manifest.name} pins @tapedb/tapedb at ${pin ?? "nothing"}, expected ${version}`);
  }
  return { dir, name: manifest.name, version: manifest.version };
});

console.log(`staging ${tag} — six packages, core first`);
for (const m of manifests) console.log(`  ${m.name}@${m.version}  (${m.dir})`);

if (checkOnly) {
  console.log("release-publish: preconditions pass");
  process.exit(0);
}
if (dryRun) {
  console.log("release-publish: dry run, nothing staged");
  process.exit(0);
}

// ---------------------------------------------------------------- staging

// No token is needed for staging: `npm stage publish` accepts any credential
// type and never asks for a second factor. From a developer's machine the npm
// session is enough, which is the path to prefer — a granular token now cannot
// be issued without an expiry date, so a build secret is a standing chore.
// NPM_TOKEN is used only when one is actually supplied.
const token = process.env.NPM_TOKEN;
let configDir = null;
let env = process.env;
if (token) {
  configDir = mkdtempSync(join(tmpdir(), "tapedb-release-"));
  const userconfig = join(configDir, "npmrc");
  writeFileSync(userconfig, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 });
  env = { ...process.env, npm_config_userconfig: userconfig, NPM_CONFIG_USERCONFIG: userconfig };
  console.log("using NPM_TOKEN from the environment");
} else {
  console.log("using your npm session (no NPM_TOKEN set) — staging needs no second factor");
}

function stage(dir, name) {
  console.log(`::group::stage ${name}`);
  try {
    execFileSync("npm", ["stage", "publish", "--access", "public", "--tag", "latest"], {
      cwd: dir,
      env,
      stdio: "inherit",
    });
  } catch {
    fail(`${name} failed to stage`);
  }
  console.log("::endgroup::");
}

try {
  for (const m of manifests) stage(m.dir, m.name);

  console.log("\nstaged — approve once for the whole batch:");
  console.log("  https://www.npmjs.com/settings/tapedb/packages  (Staged Packages)");
  console.log("  or: npm stage list @tapedb/tapedb");
  console.log("\nApprove with one passkey for the whole batch.");
  console.log("No provenance on these publishes: it needs OIDC, and this pipeline has no OIDC provider.");
} finally {
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}
