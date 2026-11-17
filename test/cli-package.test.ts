import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const cli = JSON.parse(readFileSync("packages/tapedb-cli/package.json", "utf8"));

test("tapedb-cli is released with, and runs, the same @tapedb/tapedb version", () => {
  expect(cli.version).toBe(root.version);
  expect(cli.dependencies).toEqual({ "@tapedb/tapedb": root.version });
  expect(cli.bin).toEqual({ "tapedb-cli": "bin.mjs" });
});
