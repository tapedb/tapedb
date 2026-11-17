/**
 * Loads a project's schema module, the way the CLI and the studio both do.
 */

import { copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { TapeDBSchema } from "../schema";

let schemaLoads = 0;

/** This CLI's own build: the last-resort root for the package's own specifiers. */
function ownDistDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Resolve missing package imports without changing schema source or values. */
function schemaPackageResolution() {
  // The packaged CLI requires Node 22.18+. Bun can still load installed
  // schemas when running the source tests, without Node's loader hooks.
  if (typeof nodeModule.registerHooks !== "function") return undefined;
  const dist = ownDistDir();
  const modules: Record<string, string> = {
    "@tapedb/tapedb/schema": "schema.js",
    "@tapedb/tapedb/worker": "worker.js",
    "@tapedb/tapedb/react": "react.js",
    "@tapedb/tapedb": "index.js",
  };
  return nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const file = Object.hasOwn(modules, specifier) ? modules[specifier] : undefined;
        if (!file || !isUnresolvedPackage(error)) throw error;
        return nextResolve(pathToFileURL(join(dist, file)).href, context);
      }
    },
  });
}

/** True when the failure is "the package cannot be resolved from this project". */
function isUnresolvedPackage(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") && message.includes("@tapedb/tapedb");
}

/** Loads the schema module: its default export, or an export named `schema`. */
export async function loadSchema(root: string, flags: Record<string, string | boolean>): Promise<TapeDBSchema> {
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
    const stem = `.${basename(path, extname(path))}.${process.pid}.${schemaLoads}`;
    const copy = join(dirname(path), `${stem}${extension}`);
    copyFileSync(path, copy);
    const hooks = schemaPackageResolution();
    try {
      loaded = (await import(pathToFileURL(copy).href)) as Record<string, unknown>;
    } finally {
      hooks?.deregister();
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

/**
 * Loads schema source that is not on disk yet (an edit being previewed), from
 * beside the real file so its relative imports resolve. Nothing is left behind.
 */
export async function loadSchemaSource(root: string, schemaPath: string, source: string): Promise<TapeDBSchema> {
  schemaLoads += 1;
  const draft = join(dirname(schemaPath), `.${basename(schemaPath, extname(schemaPath))}.draft.${process.pid}.${schemaLoads}${extname(schemaPath)}`);
  writeFileSync(draft, source);
  try {
    return await loadSchema(root, { schema: draft });
  } finally {
    rmSync(draft, { force: true });
  }
}
