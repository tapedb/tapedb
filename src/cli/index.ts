#!/usr/bin/env node
/**
 * tapedb CLI.
 *
 * `init` writes the four files a Worker needs, and nothing else:
 *   tapedb.schema.ts   one schema, two artifacts
 *   worker.ts          the Worker entry (two exports)
 *   wrangler.jsonc     one Durable Object class, two R2 buckets
 *   .dev.vars          the claim secret, so dev works with no configuration
 *
 * Existing files are kept, never overwritten, so `init` is safe to re-run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA_FILE = `import { defineSchema } from "tapedb";

/**
 * One schema, two artifacts: the engine registry and the client schema are
 * both generated from this object, so they cannot drift.
 */
export const schema = defineSchema({
  entities: {
    boards: {
      name: { type: "string" },
    },
    columns: {
      name: { type: "string" },
      boardId: { type: "string", optional: true, indexed: true },
    },
    tasks: {
      title: { type: "string" },
      done: { type: "boolean", optional: true },
      columnId: { type: "string", optional: true, indexed: true },
    },
  },
  links: [
    {
      apiName: "boardColumns",
      kind: "one-to-many",
      forward: { namespace: "boards", label: "columns", has: "many" },
      reverse: { namespace: "columns", label: "board", has: "one" },
      foreignKey: { namespace: "columns", attribute: "boardId" },
    },
    {
      apiName: "columnTasks",
      kind: "one-to-many",
      forward: { namespace: "columns", label: "tasks", has: "many" },
      reverse: { namespace: "tasks", label: "column", has: "one" },
      foreignKey: { namespace: "tasks", attribute: "columnId" },
    },
  ],
});
`;

const WORKER_FILE = `import { defineTapeDB } from "tapedb/worker";

import { schema } from "./tapedb.schema";

const tapedb = defineTapeDB({
  schema,
  // Development only: serves POST /_tapedb/claim so the client works with no
  // session. defineTapeDB refuses that route when ENVIRONMENT is "production".
  devClaims: true,
});

// Cloudflare requires the Durable Object class to be exported by the Worker
// that declares the binding.
export const WorkspaceRoom = tapedb.WorkspaceRoom;

export default tapedb.worker;
`;

function wrangler(name: string): string {
  return `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${name}",
  "main": "worker.ts",
  "compatibility_date": "${new Date().toISOString().slice(0, 10)}",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,
  "vars": { "ENVIRONMENT": "development" },
  "durable_objects": {
    "bindings": [{ "name": "WORKSPACE", "class_name": "WorkspaceRoom" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["WorkspaceRoom"] }],
  "r2_buckets": [
    { "binding": "DATA", "bucket_name": "${name}-data" },
    { "binding": "FILES", "bucket_name": "${name}-files" }
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

function init(argv: string[]): number {
  const flags = parseFlags(argv);
  const target = resolve(typeof flags.dir === "string" ? flags.dir : ".");
  const name = typeof flags.name === "string" ? flags.name : "tapedb-app";
  const force = flags.force === true;

  mkdirSync(target, { recursive: true });

  const devVarsPath = join(target, ".dev.vars");
  const secret = existsSync(devVarsPath)
    ? (readFileSync(devVarsPath, "utf8").match(/^TAPEDB_CLAIM_SECRET=(.*)$/m)?.[1] ??
      randomBytes(32).toString("base64url"))
    : randomBytes(32).toString("base64url");

  const results: Array<[string, string]> = [
    ["tapedb.schema.ts", write(join(target, "tapedb.schema.ts"), SCHEMA_FILE, force)],
    ["worker.ts", write(join(target, "worker.ts"), WORKER_FILE, force)],
    ["wrangler.jsonc", write(join(target, "wrangler.jsonc"), wrangler(name), force)],
    [
      ".dev.vars",
      write(devVarsPath, `TAPEDB_CLAIM_SECRET=${secret}\n`, force),
    ],
  ];

  console.log(`tapedb init in ${target}\n`);
  for (const [file, status] of results) {
    console.log(`  ${status === "written" ? "created" : "kept   "}  ${file}`);
  }

  console.log(`
Next:

  npx wrangler r2 bucket create ${name}-data
  npx wrangler r2 bucket create ${name}-files
  npx wrangler secret put TAPEDB_CLAIM_SECRET
  npx wrangler deploy

That is the whole footprint: one Durable Object class, two R2 buckets.
`);
  return 0;
}

function usage(): number {
  console.log(`tapedb — a log-structured database for Cloudflare Durable Objects

Usage:
  tapedb init [--dir <path>] [--name <worker-name>] [--force]
  tapedb dev  [--dir <path>] [--port <port>]

Commands:
  init    Write tapedb.schema.ts, worker.ts, wrangler.jsonc and .dev.vars.
          Existing files are kept unless --force is passed.
  dev     Run the local database with wrangler dev on port 8787.
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
    ["--no-install", "wrangler", "dev", "--port", port],
    { cwd: target, stdio: "inherit" }
  );
  return run.status ?? 1;
}

/** Runs the CLI and returns its exit code. Importable without side effects. */
export function run(argv: string[]): number {
  const command = argv[0];

  if (command === "init") return init(argv.slice(1));
  if (command === "dev") return dev(argv.slice(1));
  if (command === undefined || command === "--help" || command === "-h") {
    return usage();
  }

  console.error(`Unknown command "${command}".`);
  return usage();
}

// Only execute when invoked as the binary, never when imported.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exit(run(process.argv.slice(2)));
}
