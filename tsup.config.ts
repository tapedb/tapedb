import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    schema: "src/schema-entry.ts",
    react: "src/react/index.ts",
    worker: "src/worker/index.ts",
    cli: "src/cli/index.ts",
  },
  format: ["esm"],
  target: "es2022",
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  // The client entry must never pull React or any UI dependency. React lives
  // behind the `./react` subpath only, and is never bundled.
  external: ["react", "cloudflare:workers"],
});
