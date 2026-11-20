import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const root = JSON.parse(readFileSync("package.json", "utf8"));

// Every package ships the core version and pins it exactly, so a wrapper can
// never drift onto an older core. The packed-consumer smoke proves the same
// thing against the tarballs; this catches it in the fast suite.
const packages = ["cli", "react", "auth", "email"].map((directory) => ({
  directory,
  manifest: JSON.parse(readFileSync(`packages/${directory}/package.json`, "utf8")),
}));

test("every package is released with, and pins, the same @tapedb/tapedb version", () => {
  for (const { directory, manifest } of packages) {
    expect(manifest.name).toBe(`@tapedb/${directory}`);
    expect(manifest.version).toBe(root.version);
    expect(manifest.dependencies).toEqual({ "@tapedb/tapedb": root.version });
    expect(manifest.repository.directory).toBe(`packages/${directory}`);
    expect(manifest.publishConfig).toEqual({ access: "public" });
  }
  const cli = packages.find(({ directory }) => directory === "cli")!.manifest;
  expect(cli.bin).toEqual({ "tapedb-cli": "bin.mjs" });
});
