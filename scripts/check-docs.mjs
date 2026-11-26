// Fails when a document that ships to consumers carries a reserved
// documentation domain (RFC 2606: example.com, example.org, example.net).
//
// Those are legitimate in general docs, but not here: these files are the
// package's own page on npm and the README a consumer reads before installing,
// so a fake host reads as a real value and names a Worker that never exists.
// Write the shape `tapedb init` produces instead, with the unknown part in
// angle brackets — `https://tapedb-app.<account-subdomain>.workers.dev`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// package.json "files": what the published tarball carries.
const SHIPPED = ["README.md", "API.md", "PRIVACY.md", "SECURITY.md", "LIMITATIONS.md", "RELEASING.md", "AUTH-COMPATIBILITY.md"];

const RESERVED = /(^|[^\w-])([\w-]+\.)*example\.(com|org|net)\b/;

const hits = [];
for (const file of SHIPPED) {
  const text = readFileSync(join(root, file), "utf8");
  text.split("\n").forEach((line, index) => {
    if (RESERVED.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
  });
}

assert.equal(
  hits.length,
  0,
  `reserved documentation domains must not ship; use the shape \`tapedb init\` writes instead:\n${hits.join("\n")}`
);

console.log(`docs check: ${SHIPPED.length} shipped files, no reserved example domains`);
