import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "tapedb-browser-"));
const bundle = join(scratch, "client.js");
const built = spawnSync("bun", ["build", "scripts/browser/harness.ts", "--target", "browser", "--outfile", bundle], { encoding: "utf8" });
if (built.status !== 0) throw new Error(built.stderr || built.error?.message);
const receipts = new Set();
const server = createServer(async (request, response) => {
  response.setHeader("cache-control", "no-store");
  if (request.url === "/client.js") {
    response.setHeader("content-type", "text/javascript");
    return response.end(readFileSync(bundle));
  }
  if (request.url.endsWith("/transact")) {
    let body = "";
    for await (const part of request) body += part;
    const write = JSON.parse(body);
    receipts.add(write.clientTxId);
    response.setHeader("content-type", "application/json");
    return response.end(JSON.stringify({ ok: true, result: { seq: receipts.size, applied: write.ops.length } }));
  }
  response.setHeader("content-type", "text/html");
  response.end('<!doctype html><title>TapeDB persistence test</title>');
});
server.listen(4499, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
  process.exit();
});
