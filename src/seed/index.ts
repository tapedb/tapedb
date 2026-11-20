/**
 * Seeders, defined by the application and run by the CLI.
 *
 * The library does not know what a plausible customer looks like, and that is
 * deliberate: names, postcodes and IBAN formats are the application's business.
 * What it does own is everything around the values, so a seeder is a short file
 * of plain TypeScript instead of a hand-rolled insertion script.
 */

import type { Models, Schema } from "../model/schema";
import { dryTransport, SeedContext, type SeedOp, type SeedTransport } from "./context";
import { Random } from "./rng";

// `SeedContext.relations` is typed as `Record<string, RelationInfo>`, so the type
// is already part of this entry's public surface. It is named here so a consumer
// can write that type down without a TS2742 from declaration emit.
export type { RelationInfo } from "../model/schema";
export type { SeedContext, SeedModel, SeedOp, SeedTransport } from "./context";
export { Random } from "./rng";

export interface SeederArgs<M extends Models> {
  ctx: SeedContext<M>;
}

export type Seeder<M extends Models> = (args: SeederArgs<M>) => void | Promise<void>;

export interface SeederDefinition<M extends Models> {
  readonly run: Seeder<M>;
}

/**
 * Declares the seeder. The generic is the schema, so `ctx.create("user", ...)`
 * checks the row against that model's fields in the editor.
 *
 *   export default defineSeeder<typeof app>(async ({ ctx }) => {
 *     const users = await ctx.create("user", 20, (rng) => ({
 *       email: ctx.unique("user", "email", (r) => `user${r.int(1, 1e6)}@example.com`),
 *       name: rng.pick(["Sanne", "Bram"]),
 *     }));
 *     await ctx.create("post", 100, (rng) => ({ authorId: ctx.ref(users) }));
 *   });
 */
export function defineSeeder<M extends Models>(run: Seeder<M>): SeederDefinition<M> {
  return { run };
}

export interface RunSeederOptions<M extends Models> {
  schema: Schema<M>;
  /** A `defineSeeder` result, or a bare function. */
  seeder: SeederDefinition<M> | Seeder<M>;
  transport: SeedTransport;
  /** The reproducible seed. The same seed and the same seeder give the same rows. */
  seed?: string;
  /** Restrict writes to these models. */
  models?: readonly string[];
  /** Skip the whole run when any target model already has rows. */
  ifEmpty?: boolean;
  /** Build the rows and check them, but send no writes. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface SeedSummary {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  /** Rows written per model; in a dry run, the rows that would have been written. */
  written: Record<string, number>;
  total: number;
  elapsedMs: number;
  dryRun: boolean;
}

/** Runs the seeder against one workspace. */
export async function runSeeder<M extends Models>(options: RunSeederOptions<M>): Promise<SeedSummary> {
  const started = Date.now();
  const seed = options.seed === undefined || options.seed === "" ? "tapedb" : options.seed;
  const log = options.log ?? (() => {});
  const dryRun = options.dryRun === true;

  const transport = dryRun
    ? dryTransport(options.transport, (ops: readonly SeedOp[]) => {
        void ops;
      })
    : options.transport;

  const ctx = new SeedContext<M>({
    schema: options.schema,
    transport,
    seed,
    ...(options.models === undefined ? {} : { models: options.models }),
  });

  if (options.ifEmpty === true) {
    const targets = options.models ?? ctx.models();
    for (const model of targets) {
      const ids = await ctx.listIds(model).catch(() => []);
      if (ids.length > 0) {
        const reason = `"${model}" already has ${ids.length} row(s)`;
        log(`skipped: ${reason}`);
        return { ok: true, skipped: true, reason, written: {}, total: 0, elapsedMs: Date.now() - started, dryRun };
      }
    }
  }

  const run = typeof options.seeder === "function" ? options.seeder : options.seeder.run;
  await run({ ctx });

  const written = ctx.written();
  const total = Object.values(written).reduce((sum, count) => sum + count, 0);
  return { ok: true, skipped: false, written, total, elapsedMs: Date.now() - started, dryRun };
}
