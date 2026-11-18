/**
 * `tapedb seed`: runs the project's seeder against a running Worker.
 *
 * Like `tapedb export`, it talks to the Worker over its own routes and mints a
 * development claim when no token is supplied, so the run needs no credentials
 * of its own.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { httpTransport } from "../seed/context";
import { runSeeder, type Seeder, type SeederDefinition } from "../seed";
import type { Models, Schema } from "../model/schema";
import { parseFlags } from "./flags";
import { loadProjectModule, loadSchema } from "./load-schema";
import { mintToken } from "./studio";

const DEFAULT_FILE = "tapedb.seed.ts";

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

/** Refuses a remote target unless the caller says so in as many words. */
function localOnly(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export async function seedProject(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const target = resolve(flagString(flags, "dir") ?? ".");
  const file = flagString(flags, "file") ?? DEFAULT_FILE;
  const url = (flagString(flags, "url") ?? "http://localhost:8787").replace(/\/+$/, "");
  const workspace = flagString(flags, "workspace") ?? process.env.TAPEDB_WORKSPACE ?? "";
  const seed = flagString(flags, "seed") ?? "tapedb";
  const only = flagString(flags, "model");
  const dryRun = flags["dry-run"] === true;
  const ifEmpty = flags["if-empty"] === true;

  if (!workspace) {
    console.error("Name the workspace: tapedb seed --workspace <uuid> [--url <worker>] (or set TAPEDB_WORKSPACE).");
    return 1;
  }
  if (!localOnly(url) && flags.force !== true) {
    console.error(
      `Refusing to seed ${url}: it is not a local Worker. A seeder writes rows, and pointing one at a deployed workspace is not something to do by accident. Pass --force if that is really what you want.`
    );
    return 1;
  }
  if (!existsSync(resolve(target, file))) {
    console.error(`No seeder at ${resolve(target, file)}. Pass --file <file>.`);
    return 1;
  }

  let schema;
  try {
    schema = await loadSchema(target, {});
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let seeder: SeederDefinition<Models> | Seeder<Models>;
  try {
    const loaded = await loadProjectModule(target, file);
    const found = loaded.default ?? loaded.seeder;
    if (typeof found === "function") {
      seeder = found as Seeder<Models>;
    } else if (typeof found === "object" && found !== null && typeof (found as SeederDefinition<Models>).run === "function") {
      seeder = found as SeederDefinition<Models>;
    } else {
      throw new Error(`${file} must export a defineSeeder(...) result as its default export.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let token: string;
  try {
    token = process.env.TAPEDB_TOKEN ?? (await mintToken(url, workspace, { sub: "seed" }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  // loadSchema validates the registry and migrations; the seeder also needs the
  // model graph, so check for it rather than casting blind.
  const graph = (schema as Partial<Schema<Models>>).graph;
  if (graph === undefined || typeof graph !== "object") {
    console.error("This schema has no model graph. Update @tapedb/tapedb.");
    return 1;
  }

  const summary = await runSeeder({
    schema: schema as Schema<Models>,
    seeder,
    transport: httpTransport({ url, workspace, token }),
    seed,
    ...(only === undefined ? {} : { models: [only] }),
    ifEmpty,
    dryRun,
    log: (line) => console.log(`  ${line}`),
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    return null;
  });

  if (summary === null) return 1;
  if (summary.skipped) {
    console.log(`Nothing to do: ${summary.reason}.`);
    return 0;
  }

  const models = Object.entries(summary.written);
  if (models.length === 0) {
    console.log("The seeder wrote nothing. Did it call ctx.create?");
    return 0;
  }
  const width = Math.max(...models.map(([model]) => model.length));
  for (const [model, count] of models) {
    console.log(`  ${model.padEnd(width)}  ${String(count).padStart(6)}`);
  }
  console.log(
    `${summary.dryRun ? "would write" : "wrote"} ${summary.total} row(s) in ${summary.elapsedMs} ms  (seed "${seed}")`
  );
  return 0;
}
