#!/usr/bin/env node
/**
 * tapedb CLI.
 *
 * `init` writes the files a Worker needs, and nothing else:
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
import { spawnSync } from "node:child_process";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { TapeDBSchema } from "../schema";
import { migrateCheck, migrateDev, migrateRollback, readMigrations, readSnapshot } from "./migrate";
import { mintToken, startStudio } from "./studio";
import { moveWorkspaces } from "./move";

let schemaLoads = 0;

/** Loads the schema module: its default export, or an export named `schema`. */
async function loadSchema(root: string, flags: Record<string, string | boolean>): Promise<TapeDBSchema> {
  const path = resolve(root, typeof flags.schema === "string" ? flags.schema : "tapedb.schema.ts");
  if (!existsSync(path)) throw new Error(`No schema at ${path}. Pass --schema <file>.`);
  let loaded: Record<string, unknown>;
  try {
    // Import a fresh copy beside the original, so its relative imports still
    // resolve and no runtime's module cache can hand back an older schema.
    // (Node keys its cache on the URL; Bun ignores the query string.)
    // A counter, not the clock: two loads within one millisecond must still
    // get different files.
    schemaLoads += 1;
    // TapeDB's TypeScript schema is ESM even when the host application is
    // CommonJS. An explicit .mts copy avoids inheriting its package type;
    // leave explicit .cts and JavaScript module formats alone.
    const extension = extname(path) === ".ts" ? ".mts" : extname(path);
    const copy = join(dirname(path), `.${basename(path, extname(path))}.${process.pid}.${schemaLoads}${extension}`);
    copyFileSync(path, copy);
    try {
      loaded = (await import(pathToFileURL(copy).href)) as Record<string, unknown>;
    } finally {
      rmSync(copy, { force: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION/.test(message)) {
      throw new Error(
        `This Node cannot load TypeScript directly. Use Node 22.18 or newer, or run the CLI through tsx: npx tsx node_modules/@tapedb/tapedb/dist/cli.js ...`
      );
    }
    throw error;
  }
  const schema = (loaded.default ?? loaded.schema) as TapeDBSchema | undefined;
  if (!schema || !schema.registry || !Array.isArray(schema.migrations)) {
    throw new Error(`${path} must export a schema() as its default export (or as "schema").`);
  }
  return schema;
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
      console.log("No migrations yet. Run `tapedb migrate dev --name init`.");
      return 0;
    }
    for (const migration of migrations) {
      console.log(`  ${migration.id}${migration.changes.length > 0 ? `  (${migration.changes.map((change) => change.kind).join(", ")})` : ""}`);
    }
    const result = migrateCheck(root, await loadSchema(root, flags));
    console.log(result.ok ? "\nUp to date." : `\n${result.problems.join("\n")}`);
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
      console.error("Name the migration: tapedb migrate dev --name <what changed>");
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
      console.log(`\nChange the schema to match, then \`tapedb migrate check\` passes:\n  ${result.schemaEdits.join("\n  ")}`);
    }
    console.log("\nReview it, commit it, and deploy: each workspace applies it on its next wake.");
    return 0;
  }

  console.error("Usage: tapedb migrate dev --name <name> | rollback [--to <id>] | status | check");
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
  const config = parseJsonc(readFileSync(configPath, "utf8")) as {
    vars?: Record<string, string>;
    r2_buckets?: Array<{ binding?: string; bucket_name?: string; jurisdiction?: string }>;
    env?: Record<string, { vars?: Record<string, string>; r2_buckets?: Array<{ binding?: string; bucket_name?: string; jurisdiction?: string }> }>;
  };
  const vars = env === undefined ? config.vars : config.env?.[env]?.vars;
  if (vars?.ENVIRONMENT !== "production") {
    console.error(
      `Refusing to deploy: ENVIRONMENT is ${JSON.stringify(vars?.ENVIRONMENT ?? null)}${env ? ` in env "${env}"` : ""}, not "production". Dev claims are only refused when it is "production". Set it in wrangler.jsonc${env ? ` under env.${env}.vars` : " (or add an env and pass --env)"}.`
    );
    return 1;
  }
  if (vars.TAPEDB_DEV_CLAIMS !== undefined) {
    console.error("Refusing to deploy: TAPEDB_DEV_CLAIMS is set. It must never reach production.");
    return 1;
  }
  const residency = checkJurisdiction(vars, (env === undefined ? undefined : config.env?.[env]?.r2_buckets) ?? config.r2_buckets ?? []);
  if (residency !== null) {
    console.error(`Refusing to deploy: ${residency}`);
    return 1;
  }

  const check = migrateCheck(root, await loadSchema(root, flags));
  if (!check.ok) {
    console.error(`Refusing to deploy:\n${check.problems.join("\n")}`);
    return 1;
  }

  const run = spawnSync("npx", ["--no-install", "wrangler", "deploy", ...(env ? ["--env", env] : [])], {
    cwd: root,
    stdio: "inherit",
  });
  return run.status ?? 1;
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

const SCHEMA_FILE = `import { model, schema, t } from "@tapedb/tapedb/schema";

/**
 * The whole database: tables, relations, indexes and access rules. Change it,
 * then run \`npx @tapedb/tapedb migrate dev --name <what changed>\`.
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

const WORKER_FILE = `import { defineTapeDB } from "@tapedb/tapedb/worker";

import schema from "./tapedb.schema";
import { migrations } from "./tapedb/migrations.gen";

const tapedb = defineTapeDB({
  schema,
  migrations,
  // Development only: serves POST /_tapedb/claim so the client works with no
  // session. defineTapeDB refuses that route when ENVIRONMENT is "production".
  devClaims: true,
});

// Cloudflare requires the Durable Object class to be exported by the Worker
// that declares the binding.
export const WorkspaceRoom = tapedb.WorkspaceRoom;

export default tapedb.worker;
`;

function wrangler(name: string, jurisdiction?: string): string {
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
  "vars": ${vars},
  "durable_objects": {
    "bindings": [{ "name": "WORKSPACE", "class_name": "WorkspaceRoom" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["WorkspaceRoom"] }],
  "r2_buckets": [
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

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

async function init(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const target = resolve(typeof flags.dir === "string" ? flags.dir : ".");
  const name = typeof flags.name === "string" ? flags.name : "tapedb-app";
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
    ["worker.ts", write(join(target, "worker.ts"), WORKER_FILE, force)],
    ["wrangler.jsonc", write(join(target, "wrangler.jsonc"), wrangler(name, jurisdiction), force)],
    [
      ".dev.vars",
      write(devVarsPath, `TAPEDB_CLAIM_SECRET=${secret}\nTAPEDB_KEY_SECRET=${randomBytes(32).toString("base64url")}\n`, force),
    ],
  ];

  console.log(`tapedb init in ${target}\n`);
  for (const [file, status] of results) {
    console.log(`  ${status === "written" ? "created" : "kept   "}  ${file}`);
  }

  try {
    if (readSnapshot(target) === null) {
      const schema = await loadSchema(target, {});
      const result = migrateDev(target, schema, "entities");
      if (result.status === "created") console.log(`  created  tapedb/migrations/${result.id}.sql`);
    }
  } catch (error) {
    console.error(
      `\n  Could not generate the first migration (${error instanceof Error ? error.message : String(error)}).\n  Fix the schema and run \`npx @tapedb/tapedb init\` again; existing files are kept.`
    );
    return 1;
  }

  console.log(`
Next:

  npx wrangler r2 bucket create ${name}-data${jurisdiction ? ` --jurisdiction ${jurisdiction}` : ""}
  npx wrangler r2 bucket create ${name}-files${jurisdiction ? ` --jurisdiction ${jurisdiction}` : ""}
  npx wrangler secret put TAPEDB_CLAIM_SECRET
  npx wrangler secret put TAPEDB_KEY_SECRET
  npx @tapedb/tapedb dev          # local database
  npx @tapedb/tapedb deploy       # once ENVIRONMENT is "production"

That is the whole footprint: one Durable Object class, two R2 buckets.
`);
  return 0;
}

function usage(): number {
  console.log(`tapedb — a typed database for Cloudflare: models in, Durable Objects and R2 out

Usage:
  tapedb init [--dir <path>] [--name <worker-name>] [--jurisdiction eu] [--force]
  tapedb migrate dev|rollback|status|check [--dir <path>] [--schema <file>]
  tapedb deploy [--dir <path>] [--env <name>]
  tapedb dev  [--dir <path>] [--port <port>]
  tapedb studio [--url <worker-url>] [--workspace <uuid>] [--port <port>]
  tapedb export --workspace <uuid> [--url <worker-url>] [--out <file>]
  tapedb erase --workspace <uuid> --confirm <uuid> [--url <worker-url>]
  tapedb move --to eu|fedramp|none --workspaces <file> [--url <worker-url>]

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
  deploy  [--env <name>]  Check ENVIRONMENT, dev claims, data residency and migrations, then wrangler deploy.
  dev     Run the local database with wrangler dev on port 8787.
  studio  Open a local table browser against a running Worker.
  export  Stream every row the claim may read as NDJSON (TAPEDB_TOKEN, or a dev claim).
  erase   Delete a workspace for good: its data, history and files (owner claim).
          --confirm must repeat the workspace id. The id answers 410 afterwards.
`);
  return 0;
}

function dev(argv: string[]): number {
  const flags = parseFlags(argv);
  const target = resolve(typeof flags.dir === "string" ? flags.dir : ".");
  const port = typeof flags.port === "string" ? flags.port : "8787";

  if (!existsSync(join(target, ".dev.vars"))) {
    console.error(`No .dev.vars in ${target}. Run \`tapedb init\` first.`);
    return 1;
  }

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

  const run = spawnSync(
    "npx",
    [
      "--no-install",
      "wrangler",
      "dev",
      "--port",
      port,
      // Passed here, never written to wrangler.jsonc: a plain `wrangler deploy`
      // therefore has no dev claim route even if ENVIRONMENT is the default.
      "--var",
      "TAPEDB_DEV_CLAIMS:true",
      // workerd has no jurisdictions: locally every object is unrestricted.
      // Deployed, TAPEDB_JURISDICTION from wrangler.jsonc applies.
      "--var",
      "TAPEDB_JURISDICTION:",
    ],
    { cwd: target, stdio: "inherit" }
  );
  return run.status ?? 1;
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
    server = await startStudio({ url, workspace, port });
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

  if (command === "init") return init(argv.slice(1));
  if (command === "migrate") return migrate(argv.slice(1));
  if (command === "deploy") return deploy(argv.slice(1));
  if (command === "dev") return dev(argv.slice(1));
  if (command === "studio") return studio(argv.slice(1));
  if (command === "export") return exportWorkspace(argv.slice(1));
  if (command === "erase") return eraseWorkspace(argv.slice(1));
  if (command === "move") return moveWorkspaces(argv.slice(1));
  if (command === undefined || command === "--help" || command === "-h") {
    return usage();
  }

  console.error(`Unknown command "${command}".`);
  return usage();
}

/**
 * True when this module is the process entry point. `npx @tapedb/tapedb` runs it
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
  void run(process.argv.slice(2)).then((code) => process.exit(code));
}
