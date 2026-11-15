// $export() and `tapedb export` against workerd, over more rows than one chunk.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "tapedb";
import { BASE, s } from "./common.mjs";
const workspace = randomUUID();
const db = createClient({ schema: s, url: BASE, workspace });
const board = await db.board.create({ data: { name: "B" } });
await db.$transaction(Array.from({ length: 200 }, (_, n) => db.column.create({ data: { name: `c${n}`, board: { connect: board.id } } })));
for (let start = 0; start < 2400; start += 400) {
  await db.$transaction(Array.from({ length: 400 }, (_, n) => db.task.create({ data: { title: `t${start + n}` } })));
}
await db.$files.upload(new Blob(["hello"], { type: "text/plain" }), { path: "notes/hello.txt" });
const counts = {};
let header, end;
for await (const record of db.$export()) {
  if (record.type === "header") header = record;
  if (record.type === "row") counts[record.model] = (counts[record.model] ?? 0) + 1;
  if (record.type === "file") assert.equal(record.file.path, "notes/hello.txt");
  if (record.type === "end") end = record;
}
assert.deepEqual(header.models, ["person", "board", "column", "task"]);
assert.deepEqual(counts, { board: 1, column: 200, task: 2400 });
assert.equal(end.rows, 2601);
assert.equal(end.consistent, true);
execFileSync(process.execPath, ["node_modules/tapedb/dist/cli.js", "export", "--workspace", workspace, "--url", BASE, "--out", join(tmpdir(), `tapedb-e2e-export-${workspace}.ndjson`)], { stdio: "inherit" });
const lines = readFileSync(join(tmpdir(), `tapedb-e2e-export-${workspace}.ndjson`), "utf8").trim().split("\n");
assert.equal(lines.length, 1 + 2601 + 1 + 1);
db.$close();
console.log("drive-export: ok");
