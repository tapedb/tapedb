// Writes src/studio/graph.gen.ts: the studio's model graph, React Flow bundled
// for the page. Run after changing src/studio/graph.tsx or upgrading React Flow:
// node scripts/gen-studio-graph.mjs (a test fails while it is out of date).
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph } from "./studio-graph-build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
writeFileSync(join(root, "src", "studio", "graph.gen.ts"), await buildGraph(root));
