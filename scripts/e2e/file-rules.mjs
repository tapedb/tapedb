// File rules in workerd: the workspace decides each file operation before bytes move.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "tapedb";
import { BASE, s } from "./common.mjs";

const db = createClient({ schema: s, url: BASE, workspace: randomUUID() });
const refused = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error.status;
  }
  return "allowed";
};

// The dev claim is an owner; the rule still refuses it.
assert.equal(await refused(db.$files.upload(new Blob(["x"]), { path: "sealed/secret.txt" })), 403, "sealed write");
assert.equal(await refused(db.$files.upload(new Blob([new Uint8Array(17 * 1024 * 1024)]), { path: "sealed/big.bin" })), 403, "sealed multipart");
assert.equal(await refused(db.$files.download("sealed/secret.txt")), 404, "sealed read");

const stored = await db.$files.upload(new Blob(["open"], { type: "text/plain" }), { path: "open/readme.txt" });
assert.equal(stored.size, 4);
const listed = await db.$files.list();
assert.deepEqual(listed.map((file) => [file.path, file.uploadedBy]), [["open/readme.txt", "dev-user"]]);
assert.equal(await (await db.$files.download("open/readme.txt")).text(), "open");
await db.$files.delete("open/readme.txt");
assert.deepEqual(await db.$files.list(), []);
db.$close();
console.log("file-rules: ok");
