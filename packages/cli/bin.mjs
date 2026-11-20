#!/usr/bin/env node
// `npx @tapedb/cli <command>` (bin name `tapedb-cli`): runs the CLI of the @tapedb/tapedb
// release this package pins. It does not touch the project's own @tapedb/tapedb — the
// exact pin is what decides which CLI runs, so npx and the project can differ.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.resolve("@tapedb/tapedb"))), "cli.js");
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
