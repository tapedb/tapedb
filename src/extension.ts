/**
 * `@tapedb/tapedb/extension`: the command-line half of a TapeDB extension.
 *
 * A package that extends TapeDB (the CMS, for one) ships a module at
 * `<package>/tapedb` whose default export is `defineExtension({...})`. The
 * project lists it in package.json, and the `tapedb` CLI then:
 *
 * - `tapedb add <package>`: installs the package, lists it and runs `add`,
 *   which sets the project up (files, wrangler bindings, cron triggers);
 * - runs `build` before `tapedb dev` (watching what it names) and before
 *   `tapedb deploy`, as it does for tapedb.auth.tsx;
 * - offers `commands` as `tapedb <name> <command>`.
 *
 *   // package.json
 *   "tapedb": { "extensions": ["@tapedb/cms"] }
 *
 * Its Worker half is `defineTapeDB({ extensions })`, and its schema half
 * `schema(models, { extensions })`.
 */

/** The project the CLI is working in, with the edits an extension may make. */
export interface ExtensionProject {
  /** The project's directory. */
  root: string;
  /** Reads a project file, or null when it does not exist. */
  read(path: string): string | null;
  /**
   * Writes a project file. Without `overwrite`, an existing file is kept and
   * false is returned, so a second `tapedb add` changes nothing.
   */
  write(path: string, contents: string, options?: { overwrite?: boolean }): boolean;
  /** wrangler.jsonc: adds what is missing and leaves the rest as it is. */
  wrangler: {
    /** An R2 bucket binding; the bucket is named `<worker name>-<suffix>` and `tapedb deploy` creates it. */
    addR2Bucket(binding: string, suffix: string): void;
    /** A cron trigger for the Worker's `scheduled` handler. */
    addCron(expression: string): void;
    /** A plain variable (not a secret). */
    addVar(name: string, value: string): void;
    /** Another binding entry under `key` (e.g. "images": { binding: "IMAGES" }), when the key is absent. */
    setIfAbsent(key: string, value: unknown): void;
  };
  /**
   * Adds `expression` to the schema's `schema(models, { extensions: [...] })`
   * in tapedb.schema.ts, with the import lines it needs. Returns false, and
   * changes nothing, when the call is not written in a way the CLI can edit
   * with certainty; say what to add by hand then.
   */
  useInSchema(expression: string, imports: string[]): boolean;
  /** The same for the Worker's `defineTapeDB({ extensions: [...] })` (wrangler.jsonc's `main`). */
  useInWorker(expression: string, imports: string[]): boolean;
  /** Adds dev dependencies with the project's package manager, skipping those already listed. */
  installDev(packages: string[]): void;
  /** One line of output under the extension's name. */
  log(message: string): void;
}

/** */
export interface ExtensionCommand {
  /** One line for `tapedb <extension> --help`. */
  summary: string;
  /** e.g. "<file> --workspace <uuid> [--publish]" */
  usage: string;
  /** Returns the exit code. */
  run(args: string[], project: ExtensionProject): Promise<number | void> | number | void;
}

/** The command-line half of an extension. */
export interface TapeDBCliExtension {
  /** `tapedb <name> <command>`; lowercase letters, digits and dashes. */
  name: string;
  /** Sets the project up for the extension. Runs once from `tapedb add`; safe to run again. */
  add?(project: ExtensionProject): Promise<void> | void;
  /**
   * Generates files before `tapedb dev` and `tapedb deploy`. Return the
   * project files to watch: during `tapedb dev`, a change to one runs build again.
   */
  build?(project: ExtensionProject, options: { mode: "dev" | "deploy" }): Promise<{ watch?: string[] } | void> | { watch?: string[] } | void;
  commands?: Record<string, ExtensionCommand>;
}

/** Declares the command-line half of an extension. */
export function defineExtension(extension: TapeDBCliExtension): TapeDBCliExtension {
  return extension;
}
