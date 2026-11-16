// A file bigger than one request (multipart through the Worker into R2), read back whole.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@tapedb/tapedb";
import { BASE, s } from "./common.mjs";

const db = createClient({ schema: s, url: BASE, workspace: randomUUID() });
const size = 40 * 1024 * 1024 + 123;
const bytes = new Uint8Array(size);
for (let offset = 0; offset < size; offset += 65536) {
  crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, size)));
}
const digest = (data) => createHash("sha256").update(data).digest("hex");

const stored = await db.$files.upload(new Blob([bytes], { type: "video/mp4" }), { path: "videos/big.mp4" });
assert.equal(stored.size, size, "stored size");
const [listed] = await db.$files.list({ prefix: "videos/" });
assert.equal(listed?.size, size, "listed size");

const back = await db.$files.download("videos/big.mp4");
assert.equal(back.size, size, "downloaded size");
assert.equal(digest(new Uint8Array(await back.arrayBuffer())), digest(bytes), "downloaded bytes");
assert.equal(back.type, "video/mp4");

await db.$files.delete("videos/big.mp4");
assert.deepEqual(await db.$files.list({ prefix: "videos/" }), []);
db.$close();
console.log("large-file: ok");
