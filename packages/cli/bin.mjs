#!/usr/bin/env node
// `npx @tapedb/cli <command>` (bin name `tapedb-cli`): runs the CLI of the @tapedb/tapedb release this package pins.
// npx fetches the newest @tapedb/cli when it isn't installed in the project, so the CLI is always
// current; it then brings the project's own @tapedb/tapedb up to the same version.
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
