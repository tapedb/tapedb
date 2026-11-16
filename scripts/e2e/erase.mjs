// Erasing a workspace in workerd: owner only, files and data gone, 410 after.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@tapedb/tapedb";
import { BASE, s } from "./common.mjs";

const workspace = randomUUID();
const db = createClient({ schema: s, url: BASE, workspace });
await db.task.create({ data: { title: "alice@example.com" } });
await db.$files.upload(new Blob(["cv"], { type: "text/plain" }), { path: "people/alice.txt" });
db.$close();

const claim = async (body) =>
  (await (await fetch(`${BASE}/_tapedb/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: workspace, ...body }) })).json()).token;
const owner = await claim({});
const call = (path, init = {}, token = owner) =>
  fetch(`${BASE}/engine/workspaces/${workspace}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

// The CLI refuses without the id typed twice.
assert.throws(() => execFileSync(process.execPath, ["node_modules/@tapedb/tapedb/dist/cli.js", "erase", "--workspace", workspace, "--url", BASE], { stdio: "pipe" }));
execFileSync(process.execPath, ["node_modules/@tapedb/tapedb/dist/cli.js", "erase", "--workspace", workspace, "--confirm", workspace, "--url", BASE], { stdio: "inherit" });

for (const [path, init] of [["/status", {}], ["/export", {}], ["/files/people/alice.txt", {}], ["/transact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txId: "x", ops: [{ op: "insert", namespace: "task", id: "t", values: { title: "back", done: false } }] }) }]]) {
  const response = await call(path, init);
  // The e2e schema has file rules, so the workspace decides file reads too
  // and answers 410 like every route. (Without rules the Worker serves bytes
  // straight from R2, where they are gone: 404.)
  assert.equal(response.status, 410, `${path} after erase`);
}
// Erasing again is a no-op the CLI reports as done.
execFileSync(process.execPath, ["node_modules/@tapedb/tapedb/dist/cli.js", "erase", "--workspace", workspace, "--confirm", workspace, "--url", BASE], { stdio: "inherit" });
console.log("drive-erase: ok");
