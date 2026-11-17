// Writes src/studio/runner.gen.ts: the query editor's translator
// (src/studio/runner.ts, which runs the client's own model code) bundled for
// the studio page. Run after changing it or the model code it uses:
// node scripts/gen-studio-runner.mjs (a test fails while it is out of date).
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRunner } from "./studio-runner-build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
writeFileSync(join(root, "src", "studio", "runner.gen.ts"), await buildRunner(root));
