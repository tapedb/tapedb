#!/usr/bin/env node
import { prepareAuthPage } from "./auth-page";
import { AUTH_FILE, AUTH_WORKER_FILE } from "./auth-template";
/**
 * tapedb CLI.
 *
 * `init` guides project setup, installs dependencies and writes:
 *   tapedb.schema.ts   the models
 *   worker.ts          the Worker entry (two exports)
 *   wrangler.jsonc     one Durable Object class, two R2 buckets
 *   .dev.vars          the claim secret, so dev works with no configuration
 *   tapedb/            the first migration, its snapshot and the bundle
 *
 * Existing files are kept, never overwritten, so `init` is safe to re-run.
 * `migrate` keeps tapedb/ in step with the schema; `deploy` refuses to ship a
 * development configuration or an unmigrated schema.
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as nodeModule from "node:module";

import type { TapeDBSchema } from "../schema";
import { migrateCheck, migrateDev, migrateRollback, readMigrations, readSnapshot } from "./migrate";
import { migrateSquash } from "./squash";
import { mintToken, startStudio } from "./studio";
import { moveWorkspaces } from "./move";
import { loadSchema } from "./load-schema";
import { parseFlags } from "./flags";
import { seedProject } from "./seed";
import { select } from "./prompts";
import { ask, confirm, ignoreLocalFiles, installProject, interactive, provisionAndDeploy, syncTapedb, type DeployConfig } from "./onboarding";

/** How the docs and messages tell people to run the CLI. */
const CLI = "npx tapedb-cli";

/** This CLI's own version, from the package it ships in. */
function ownVersion(): string {
  let root = ownDistDir();
  while (!existsSync(join(root, "package.json")) && dirname(root) !== root) root = dirname(root);
  return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
}

/** This CLI's own build: the last-resort root for the package's own specifiers. */
function ownDistDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function listFlag(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === `--${name}` && argv[index + 1] !== undefined) values.push(argv[index + 1]);
  }
  return values;
}

async function migrate(argv: string[]): Promise<number> {
  const action = argv[0];
  const flags = parseFlags(argv.slice(1));
  const root = resolve(typeof flags.dir === "string" ? flags.dir : ".");

  if (action === "status") {
    const migrations = readMigrations(root);
    if (migrations.length === 0) {
      console.log("No migrations yet. Run `npx tapedb-cli migrate dev --name init`.");
      return 0;
    }
    for (const migration of migrations) {
      console.log(`  ${migration.id}${migration.changes.length > 0 ? `  (${migration.changes.map((change) => change.kind).join(", ")})` : ""}`);
    }
    const result = migrateCheck(root, await loadSchema(root, flags));
    console.log(result.ok ? "\nUp to date." : `\n${result.problems.join("\n")}`);
    return 0;
  }

  if (action === "squash") {
    const dry = flags["dry-run"] === true || flags.dryRun === true;
    const result = migrateSquash(root, {
      ...(typeof flags.since === "string" ? { since: flags.since } : {}),
      ...(typeof flags.name === "string" ? { name: flags.name } : {}),
      ...(flags["accept-data-loss"] === true || flags.acceptDataLoss === true ? { acceptDataLoss: true } : {}),
      ...(dry ? { dryRun: true } : {}),
    });
    if (result.status === "refused") {
      for (const reason of result.reasons) console.error(reason);
      return 1;
    }
    if (result.status === "cancelled") {
      console.log(`${dry ? "Would remove" : "Removed"} ${result.folded.length} migrations that cancel out, leaving nothing to apply:`);
      for (const id of result.folded) console.log(`  ${id}`);
      return 0;
    }
    if (result.status === "would-squash") {
      console.log(`Would fold ${result.folded.length} migrations into ${result.into}: ${result.statements} statement(s).`);
      console.log(`  ${result.folded.join("\n  ")}`);
      return 0;
    }
    console.log(`Folded ${result.folded.length} migrations into ${result.into}: ${result.statements} statement(s).`);
    for (const id of result.removed) console.log(`  removed ${id}`);
    console.log("Run `npx tapedb-cli migrate check` to confirm the schema still matches.");
    return 0;
  }

  if (action === "check") {
    const result = migrateCheck(root, await loadSchema(root, flags));
    if (result.ok) {
      console.log("Migrations match the schema.");
      return 0;
    }
    console.error(result.problems.join("\n"));
    return 1;
  }

  if (action === "dev") {
    const name = typeof flags.name === "string" ? flags.name : readSnapshot(root) === null ? "entities" : "";
    if (!name) {
      console.error("Name the migration: npx tapedb-cli migrate dev --name <what changed>");
      return 1;
    }
    const result = migrateDev(root, await loadSchema(root, flags), name, {
      renames: listFlag(argv, "rename"),
      acceptDataLoss: flags["accept-data-loss"] === true,
    });
    if (result.status === "refused") {
      console.error(`No migration written:\n\n  ${result.reasons.join("\n  ")}`);
      return 1;
    }
    if (result.status === "unchanged") {
      console.log("The schema matches the last migration. Nothing to write.");
      return 0;
    }
    console.log(`Created tapedb/migrations/${result.id}.sql (${result.statements} statements).`);
    if (result.changes.length > 0) {
      console.log(`Declared: ${result.changes.map((change) => change.kind).join(", ")}.`);
    }
    console.log("Review it, commit it, and deploy: each workspace applies it on its next wake.");
    return 0;
  }

  if (action === "rollback") {
    const result = migrateRollback(root, {
      ...(typeof flags.to === "string" ? { to: flags.to } : {}),
      acceptDataLoss: flags["accept-data-loss"] === true,
    });
    if (result.status === "refused") {
      console.error(`No migration written:\n\n  ${result.reasons.join("\n  ")}`);
      return 1;
    }
    console.log(`Created tapedb/migrations/${result.id}.sql (${result.statements} statements): the schema after ${result.to}.`);
    if (result.schemaEdits.length > 0) {
      console.log(`\nChange the schema to match, then \`npx tapedb-cli migrate check\` passes:\n  ${result.schemaEdits.join("\n  ")}`);
    }
    console.log("\nReview it, commit it, and deploy: each workspace applies it on its next wake.");
    return 0;
  }

  console.error("Usage: npx tapedb-cli migrate dev --name <name> | rollback [--to <id>] | status | check | squash --since <id> [--name <what>] [--dry-run] [--accept-data-loss]");
  return 1;
}

/** JSON with comments, without mangling "//" inside strings. */
function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[index + 1] ?? "";
        index += 1;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
    } else if (char === "/" && text[index + 1] === "*") {
      index = text.indexOf("*/", index + 2) + 1;
      if (index === 0) break;
    } else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

async function deploy(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const root = resolve(typeof flags.dir === "string" ? flags.dir : ".");
  const env = typeof flags.env === "string" ? flags.env : undefined;

  const configPath = join(root, "wrangler.jsonc");
  if (!existsSync(configPath)) {
    console.error(`No wrangler.jsonc in ${root}.`);
    return 1;
  }
  // The deployed Worker bundles the project's copy of the runtime; bring it up to this CLI first.
  syncTapedb(root, ownVersion());
  const config = parseJsonc(readFileSync(configPath, "utf8")) as DeployConfig;
  const vars = env === undefined ? config.vars : config.env?.[env]?.vars;
  if (vars?.ENVIRONMENT !== "production" && !interactive() && flags.yes !== true) {
    console.error(
      `Refusing to deploy: ENVIRONMENT is ${JSON.stringify(vars?.ENVIRONMENT ?? null)}${env ? ` in env "${env}"` : ""}, not "production". Dev claims are only refused when it is "production". Set it in wrangler.jsonc${env ? ` under env.${env}.vars` : " (or add an env and pass --env)"}.`
    );
    return 1;
  }
  if (vars?.TAPEDB_DEV_CLAIMS !== undefined) {
    console.error("Refusing to deploy: TAPEDB_DEV_CLAIMS is set. It must never reach production.");
    return 1;
  }
  const residency = checkJurisdiction(vars ?? {}, (env === undefined ? undefined : config.env?.[env]?.r2_buckets) ?? config.r2_buckets ?? []);
  if (residency !== null) {
    console.error(`Refusing to deploy: ${residency}`);
    return 1;
  }

  const check = migrateCheck(root, await loadSchema(root, flags));
  if (!check.ok) {
    console.error(`Refusing to deploy:\n${check.problems.join("\n")}`);
    return 1;
  }

  if(existsSync(join(root,"auth.ts"))||existsSync(join(root,"tapedb.auth.tsx")))await prepareAuthPage(root);
  return provisionAndDeploy(root, config, env, flags.yes === true);
}

const JURISDICTIONS = ["eu", "fedramp"];

/**
 * Data residency is all or nothing: the Durable Objects (TAPEDB_JURISDICTION)
 * and every R2 bucket in the same jurisdiction, or none restricted.
 */
export function checkJurisdiction(
  vars: Record<string, string>,
  buckets: Array<{ binding?: string; bucket_name?: string; jurisdiction?: string }>
): string | null {
  const wanted = vars.TAPEDB_JURISDICTION;
  if (wanted !== undefined && !JURISDICTIONS.includes(wanted)) {
    return `TAPEDB_JURISDICTION is ${JSON.stringify(wanted)}; Cloudflare's jurisdictions are ${JURISDICTIONS.join(" and ")}.`;
  }
  const from = vars.TAPEDB_MOVE_FROM === "none" || vars.TAPEDB_MOVE_FROM === "" ? undefined : vars.TAPEDB_MOVE_FROM;
  if (vars.TAPEDB_MOVE_FROM !== undefined && from !== undefined && !JURISDICTIONS.includes(from)) return "TAPEDB_MOVE_FROM must be eu, fedramp or none.";
  if (vars.TAPEDB_MOVE_FROM !== undefined && !buckets.some(bucket => bucket.binding === "DATA_FROM")) return "A move requires the original DATA_FROM bucket.";
  const outside = buckets.filter(bucket => bucket.jurisdiction !== (bucket.binding?.endsWith("_FROM") ? from : wanted));
  if (outside.length === 0) return null;
  const names = outside.map((bucket) => `${bucket.binding ?? "?"} (${bucket.bucket_name ?? "?"}: ${bucket.jurisdiction ?? "no jurisdiction"})`).join(", ");
  return wanted === undefined
    ? `R2 buckets ${names} are restricted to a jurisdiction but TAPEDB_JURISDICTION is not set, so the Durable Objects holding the same data are not. Set TAPEDB_JURISDICTION and use tapedb move for existing workspaces.`
    : `TAPEDB_JURISDICTION is "${wanted}" but R2 buckets ${names} are not. Create them with \`wrangler r2 bucket create <name> --jurisdiction ${wanted}\` and add "jurisdiction": "${wanted}" to each r2_buckets entry.`;
}

export const SCHEMA_FILE = `import { model, schema, t } from "@tapedb/tapedb/schema";

/**
 * The whole database: tables, relations, indexes and access rules. Change it,
 * then run \`npx tapedb-cli migrate dev --name <what changed>\`.
 */
export default schema({
  board: model({
    name: t.string(),
    columns: t.hasMany("column"),
  }),
  column: model({
    name: t.string(),
    position: t.number().default(0).index(),
    board: t.belongsTo("board", { onDelete: "cascade" }),
    tasks: t.hasMany("task"),
  }),
  task: model({
    title: t.string(),
    done: t.boolean().default(false),
    column: t.belongsTo("column").optional(),
  }),
});
`;

const WORKER_FILE = `import { studio } from "@tapedb/tapedb/studio";
import { defineTapeDB } from "@tapedb/tapedb/worker";

import schema from "./tapedb.schema";
import { migrations } from "./tapedb/migrations.gen";

const tapedb = defineTapeDB({
  schema,
  migrations,
  // Development only: serves POST /_tapedb/claim so the client works with no
  // session. defineTapeDB refuses that route when ENVIRONMENT is "production".
  devClaims: true,
  // The studio at /_tapedb/studio on the deployed Worker. It signs in through
  // /_tapedb/claim like the app, so your identity adapter decides the role.
  // Remove it to serve nothing there.
  studio,
});

// Cloudflare requires the Durable Object class to be exported by the Worker
// that declares the binding.
export const WorkspaceRoom = tapedb.WorkspaceRoom;

export default tapedb.worker;
`;

function wrangler(name: string, jurisdiction?: string, auth=false, sender=""): string {
  const vars = jurisdiction ? `{ "ENVIRONMENT": "development", "TAPEDB_JURISDICTION": "${jurisdiction}" }` : `{ "ENVIRONMENT": "development" }`;
  const where = jurisdiction ? `, "jurisdiction": "${jurisdiction}"` : "";
  return `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${name}",
  "main": "worker.ts",
  "compatibility_date": "${new Date().toISOString().slice(0, 10)}",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,
  "observability": { "enabled": true, "traces": { "enabled": true } },
  "vars": ${auth?JSON.stringify({...JSON.parse(vars),EMAIL_FROM:sender}):vars},
  "durable_objects": {
    "bindings": [{ "name": "WORKSPACE", "class_name": "WorkspaceRoom" }${auth?', { "name": "AUTH", "class_name": "AuthRoom" }':""}]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["WorkspaceRoom"${auth?', "AuthRoom"':""}] }],
  ${auth?'"send_email": [{ "name": "EMAIL" }],\n  ':""}"r2_buckets": [
    { "binding": "DATA", "bucket_name": "${name}-data"${where} },
    { "binding": "FILES", "bucket_name": "${name}-files"${where} }
  ]
}
`;
}

function write(path: string, contents: string, force: boolean): "written" | "kept" {
  if (existsSync(path) && !force) return "kept";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return "written";
}

async function init(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const target = resolve(typeof flags.dir === "string" ? flags.dir : ".");
  const existingConfig = existsSync(join(target, "wrangler.jsonc"))
    ? parseJsonc(readFileSync(join(target, "wrangler.jsonc"), "utf8")) as DeployConfig : undefined;
  const defaultName = existingConfig?.name ?? (basename(target).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "tapedb-app");
  const name = typeof flags.name === "string" ? flags.name : flags.yes === true ? defaultName : await ask("Project name", defaultName);
  if (!/^[a-z0-9][a-z0-9-]{0,50}$/.test(name)) throw new Error("Use a project name of 1–51 lowercase letters, numbers or hyphens.");
  if (flags.local === true && flags.cloud === true) throw new Error("Choose --local or --cloud.");
  const cloud = flags.cloud === true || (interactive() && flags.local !== true && flags.yes !== true && (await select("How do you want to run TapeDB?", ["Run locally", "Deploy to Cloudflare"])) === 1);
  const hasAuth=existsSync(join(target,"auth.ts"));
  const withAuth=hasAuth || flags.auth===true || (interactive() && flags["no-auth"]!==true && flags.yes!==true && await select("Sign-in",["No built-in sign-in","With Better Auth"])===1);
  const sender=withAuth?(typeof flags["email-from"]==='string'?flags["email-from"]:await ask("Sender email",existingConfig?.vars?.EMAIL_FROM??"")):"";
  if(withAuth && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)))throw new Error("With auth, provide --email-from <address> on your sending domain.");
  if(withAuth && existingConfig && !hasAuth && !flags.force)throw new Error("Auth setup keeps existing projects safe: use a fresh directory or explicitly --force to replace the scaffold.");
  const force = flags.force === true;
  const jurisdiction = typeof flags.jurisdiction === "string" ? flags.jurisdiction : undefined;
  if (jurisdiction !== undefined && !JURISDICTIONS.includes(jurisdiction)) {
    console.error(`--jurisdiction must be one of ${JURISDICTIONS.join(", ")}.`);
    return 1;
  }

  mkdirSync(target, { recursive: true });

  const devVarsPath = join(target, ".dev.vars");
  const secret = existsSync(devVarsPath)
    ? (readFileSync(devVarsPath, "utf8").match(/^TAPEDB_CLAIM_SECRET=(.*)$/m)?.[1] ??
      randomBytes(32).toString("base64url"))
    : randomBytes(32).toString("base64url");

  const results: Array<[string, string]> = [
    ["tapedb.schema.ts", write(join(target, "tapedb.schema.ts"), SCHEMA_FILE, force)],
    ["worker.ts", write(join(target, "worker.ts"), withAuth?AUTH_WORKER_FILE:WORKER_FILE, force)],
    ["wrangler.jsonc", write(join(target, "wrangler.jsonc"), wrangler(name, jurisdiction,withAuth,sender), force)],
    [
      ".dev.vars",
      write(devVarsPath, `TAPEDB_CLAIM_SECRET=${secret}\nTAPEDB_KEY_SECRET=${randomBytes(32).toString("base64url")}\n`, force),
    ],
  ];

  if(withAuth){
    results.push(["auth.ts",write(join(target,"auth.ts"),AUTH_FILE,force)]);
    const current=readFileSync(devVarsPath,"utf8");
    if(!/^BETTER_AUTH_SECRET=/m.test(current))appendFileSync(devVarsPath,`BETTER_AUTH_SECRET=${randomBytes(32).toString("base64url")}\n`);
  }
  console.log(`tapedb init in ${target}\n`);
  for (const [file, status] of results) {
    console.log(`  ${status === "written" ? "created" : "kept   "}  ${file}`);
  }

  ignoreLocalFiles(target);
  if (flags["no-install"] !== true) {
    installProject(target, ownVersion(), withAuth);
  }

  if(withAuth)await prepareAuthPage(target);
  try {
    if (readSnapshot(target) === null) {
      const schema = await loadSchema(target, {});
      const result = migrateDev(target, schema, "entities");
      if (result.status === "created") console.log(`  created  tapedb/migrations/${result.id}.sql`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = message.includes("@tapedb/tapedb")
      ? `\n  The schema imports the package by name, so it must be installable from this project.\n  Run \`npm install @tapedb/tapedb\` and then \`npx tapedb-cli init\` again; existing files are kept.`
      : `\n  Fix the schema and run \`npx tapedb-cli init\` again; existing files are kept.`;
    console.error(`\n  Could not generate the first migration (${message}).${hint}`);
    return 1;
  }

  // Choosing cloud setup already expresses the deployment decision.
  if (cloud) return deploy(["--dir", target, "--yes"]);
  console.log(`\nReady. Start the database with ${CLI} dev`);
  if (interactive() && flags["no-start"] !== true && flags.yes !== true && await confirm("Start the local database now?", true)) {
    return dev(["--dir", target]);
  }
  return 0;
}

function usage(): number {
  console.log(`tapedb — a typed database for Cloudflare: models in, Durable Objects and R2 out

Usage:
  npx tapedb-cli init [--dir <path>] [--name <worker-name>] [--jurisdiction eu] [--local|--cloud] [--auth --email-from <address>] [--yes] [--no-install] [--no-start] [--force]
  npx tapedb-cli auth build [--dir <path>]
  npx tapedb-cli migrate dev|rollback|status|check [--dir <path>] [--schema <file>]
  npx tapedb-cli deploy [--dir <path>] [--env <name>]
  npx tapedb-cli dev  [--dir <path>] [--port <port>]
  npx tapedb-cli studio [--url <worker-url>] [--workspace <uuid>] [--port <port>]
  npx tapedb-cli export --workspace <uuid> [--url <worker-url>] [--out <file>]
  npx tapedb-cli seed --workspace <uuid> [--file <tapedb.seed.ts>] [--url <worker-url>] [--seed <label>]
  npx tapedb-cli erase --workspace <uuid> --confirm <uuid> [--url <worker-url>]
  npx tapedb-cli move --to eu|fedramp|none --workspaces <file> [--url <worker-url>]

Commands:
  init    Write tapedb.schema.ts, worker.ts, wrangler.jsonc and .dev.vars,
          and the first migration. Existing files are kept unless --force.
          --jurisdiction eu keeps Durable Objects and R2 buckets in the EU.
  migrate dev --name <name> [--rename old=new] [--accept-data-loss]
          Diff the schema against the last migration and write the next one.
  migrate rollback [--to <id>] [--accept-data-loss]
          Write the migration that takes the database back to the schema
          after <id> (default: the one before the last).
  migrate status | check
          List migrations; check fails if the schema has unmigrated changes.
  deploy  [--env <name>] [--yes]  Select an account, provision missing resources and secrets, and deploy.
  dev     Run the local database on port 8787, with the studio beside it.
  studio  Open a local table browser against a running Worker.
  export  Stream every row the claim may read as NDJSON (TAPEDB_TOKEN, or a dev claim).
  seed    Run the project's seeder against a running Worker: --seed makes the
          same seed give the same rows. --dry-run checks without writing.
  erase   Delete a workspace for good: its data, history and files (owner claim).
          --confirm must repeat the workspace id. The id answers 410 afterwards.
`);
  return 0;
}

/**
 * The local run: `wrangler dev` with the variables only a local database gets.
 * Passed on the command line, never written to wrangler.jsonc, so a deploy
 * never carries them.
 */
export function devArgs(port: string, studioUrl: string): string[] {
  return [
    "--no-install",
    "wrangler",
    "dev",
    "--port",
    port,
    // Local, whatever wrangler.jsonc says: deploy writes "production" there,
    // which would otherwise refuse dev claims on every later local run.
    "--var",
    "ENVIRONMENT:development",
    "--var",
    "TAPEDB_DEV_CLAIMS:true",
    // workerd has no jurisdictions: locally every object is unrestricted.
    // Deployed, TAPEDB_JURISDICTION from wrangler.jsonc applies.
    "--var",
    "TAPEDB_JURISDICTION:",
    // GET / on the local Worker opens the studio.
    "--var",
    `TAPEDB_STUDIO_URL:${studioUrl}`,
  ];
}

async function dev(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const target = resolve(typeof flags.dir === "string" ? flags.dir : ".");
  const port = typeof flags.port === "string" ? flags.port : "8787";

  if (!existsSync(join(target, ".dev.vars"))) {
    console.error(`No .dev.vars in ${target}. Run \`${CLI} init\` first.`);
    return 1;
  }
  syncTapedb(target, ownVersion());

  const probe = spawnSync("npx", ["--no-install", "wrangler", "--version"], {
    cwd: target,
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    console.error(
      "wrangler is required to run the local database.\n\n  npm i -D wrangler\n"
    );
    return 1;
  }

  const authPage=existsSync(join(target,"auth.ts"))||existsSync(join(target,"tapedb.auth.tsx"))?await prepareAuthPage(target,true):undefined;

  // The studio comes with the database: on 4400, or any free port when that is taken.
  const worker = `http://localhost:${port}`;
  const studio = await startStudio({ url: worker, workspace: "", port: 4400, project: target })
    .catch(() => startStudio({ url: worker, workspace: "", port: 0, project: target }));
  console.log(`\n  Database  ${worker}\n  Studio    ${studio.url}   (also at ${worker}/)\n`);

  const child = spawn("npx", devArgs(port, studio.url), { cwd: target, stdio: "inherit" });
  // Ctrl+C reaches wrangler too; the studio closes when it exits.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  const status = await new Promise<number>((done) => {
    child.on("error", () => done(1));
    child.on("exit", (code) => done(code ?? 1));
  });
  process.off("SIGINT", ignore);
  studio.close();
  await authPage?.close();
  return status;
}

/**
 * Streams a workspace export to a file or stdout. Uses TAPEDB_TOKEN when set,
 * otherwise mints a dev claim (which only `tapedb dev` serves).
 */
export async function exportWorkspace(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const url = (typeof flags.url === "string" ? flags.url : "http://localhost:8787").replace(/\/+$/, "");
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.env.TAPEDB_WORKSPACE ?? "";
  if (!workspace) {
    console.error("Name the workspace: tapedb export --workspace <uuid> [--url <worker>] [--out <file>]");
    return 1;
  }

  let response: Response;
  try {
    const token = process.env.TAPEDB_TOKEN || (await mintToken(url, workspace));
    response = await fetch(`${url}/engine/workspaces/${workspace}/export`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (!response.ok || !response.body) {
    console.error(`Export failed with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return 1;
  }

  const out = typeof flags.out === "string" ? resolve(flags.out) : null;
  if (out) writeFileSync(out, "");
  const write = (text: string) => (out ? appendFileSync(out, text) : process.stdout.write(text));

  const decoder = new TextDecoder();
  let tail = "";
  const reader = response.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    write(text);
    tail = (tail + text).slice(-65_536);
  }
  const last = tail.trim().split("\n").at(-1) ?? "";
  let end: { type?: string; rows?: number; consistent?: boolean; seq?: number; message?: string } = {};
  try {
    end = JSON.parse(last);
  } catch {
    // Reported below as an incomplete export.
  }
  if (end.type !== "end") {
    console.error(`Export incomplete: ${end.type === "error" ? end.message : "the stream ended without an end line"}.`);
    return 1;
  }
  console.error(
    `Exported ${end.rows} rows at seq ${end.seq}${end.consistent ? "" : " (writes landed during the export; it is not a single point in time)"}${out ? ` to ${out}` : ""}.`
  );
  return 0;
}

async function studio(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);

  const url = typeof flags.url === "string" ? flags.url : "http://localhost:8787";
  const workspace =
    typeof flags.workspace === "string"
      ? flags.workspace
      : process.env.TAPEDB_WORKSPACE ?? "";
  const port = Number(typeof flags.port === "string" ? flags.port : "4400");

  let server: { url: string; close: () => void };
  try {
    // From a project folder, the schema can be edited too.
    const project = existsSync(join(process.cwd(), "tapedb.schema.ts")) ? process.cwd() : undefined;
    server = await startStudio({ url, workspace, port, ...(project ? { project } : {}) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  console.log(`tapedb studio on ${server.url} -> ${url}`);
  console.log("Press Ctrl+C to stop.");

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      server.close();
      resolve();
    });
  });
  return 0;
}

/**
 * Erases a workspace: DELETE /engine/workspaces/:id with an owner claim
 * (TAPEDB_TOKEN, or a dev claim). Irreversible, so the id is typed twice.
 */
export async function eraseWorkspace(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const url = (typeof flags.url === "string" ? flags.url : "http://localhost:8787").replace(/\/+$/, "");
  const workspace = typeof flags.workspace === "string" ? flags.workspace : "";
  if (!workspace || flags.confirm !== workspace) {
    console.error("Erasing cannot be undone. Name the workspace twice: tapedb erase --workspace <uuid> --confirm <uuid> [--url <worker>]");
    return 1;
  }

  let response: Response;
  try {
    const token = process.env.TAPEDB_TOKEN || (await mintToken(url, workspace));
    response = await fetch(`${url}/engine/workspaces/${workspace}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const body = (await response.json().catch(() => null)) as { erased?: { historyObjects: number; files: number }; error?: { message?: string } } | null;
  if (response.status === 410) {
    console.log(`Workspace ${workspace} was already erased.`);
    return 0;
  }
  if (!response.ok || !body?.erased) {
    console.error(`Erase failed with HTTP ${response.status}: ${body?.error?.message ?? "no details"}. It is safe to run again.`);
    return 1;
  }
  console.log(`Erased workspace ${workspace}: ${body.erased.historyObjects} history objects and ${body.erased.files} files deleted, Durable Object storage cleared.`);
  return 0;
}

/** Runs the CLI and returns its exit code. Importable without side effects. */
export async function run(argv: string[]): Promise<number> {
  const command = argv[0];

  if (command === "auth") {
    if(argv[1]!=="build")throw new Error("Use tapedb auth build [--dir <path>].");
    const flags=parseFlags(argv.slice(2));
    const root=resolve(typeof flags.dir==='string'?flags.dir:'.');
    await(await prepareAuthPage(root)).close();
    console.log(existsSync(join(root,'tapedb.auth.tsx'))?'Built tapedb.auth.tsx.':'Using the built-in TapeDB auth page.');
    return 0;
  }
  if (command === "init") return init(argv.slice(1));
  if (command === "migrate") return migrate(argv.slice(1));
  if (command === "deploy") return deploy(argv.slice(1));
  if (command === "dev") return dev(argv.slice(1));
  if (command === "studio") return studio(argv.slice(1));
  if (command === "export") return exportWorkspace(argv.slice(1));
  if (command === "seed") return seedProject(argv.slice(1));
  if (command === "erase") return eraseWorkspace(argv.slice(1));
  if (command === "move") return moveWorkspaces(argv.slice(1));
  if (command === undefined || command === "--help" || command === "-h") {
    return usage();
  }

  console.error(`Unknown command "${command}".`);
  return usage();
}

/**
 * True when this module is the process entry point. npx runs it
 * through the node_modules/.bin symlink: argv[1] is the link, while
 * import.meta.url is the resolved file, so both are compared after resolving.
 */
export function isEntryPoint(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// Only execute when invoked as the binary, never when imported.
if (isEntryPoint(process.argv[1], import.meta.url)) {
  void run(process.argv.slice(2)).then((code) => process.exit(code)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
