// The live socket in workerd, past its old bounds: many large live queries on
// one socket (past the attachment's 16 KiB), a query larger than a frame
// (sent in parts), and a 2 MiB broadcast (relayed in parts).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@tapedb/tapedb";
import { BASE, s, until } from "./common.mjs";

const workspace = randomUUID();
const a = createClient({ schema: s, url: BASE, workspace });
const b = createClient({ schema: s, url: BASE, workspace });

// 40 live queries of ~4 KB each, all on a's socket.
const titles = (n) => Array.from({ length: 200 }, (_, index) => `t-${n}-${index}`).concat("shared");
const seen = new Map();
const stops = Array.from({ length: 40 }, (_, n) =>
  a.task.findMany({ where: { title: { in: titles(n) } } }).subscribe((state) => state.data && seen.set(n, state.data.length))
);
// And one query larger than a frame: 120,000 titles, about 2 MB.
const huge = Array.from({ length: 120_000 }, (_, index) => `huge-${index}`).concat("shared");
let hugeRows = null;
stops.push(a.task.findMany({ where: { title: { in: huge } } }).subscribe((state) => { if (state.data) hugeRows = state.data.length; }));
await until(() => seen.size === 40 && hugeRows === 0, "every live query answered", [seen.size, hugeRows]);

await b.task.create({ data: { title: "shared" } });
await until(() => [...seen.values()].every((rows) => rows === 1) && hugeRows === 1, "every live query updated", [[...seen.values()], hugeRows], 20_000);

// A 2 MiB broadcast.
const big = { blob: "x".repeat(2 * 1024 * 1024), n: 7 };
const heard = [];
const stopHear = b.$broadcast("big:1").subscribe((message) => heard.push(message));
await until(() => {
  a.$broadcast("big:1").send({ ping: true });
  return heard.length > 0;
}, "b joined the topic", heard);
heard.length = 0;
const mutable = { ...big };
a.$broadcast("big:1").send(mutable);
mutable.blob = "changed after send";
await until(() => heard.some((message) => message.n === 7), "b hears the 2 MiB message", heard.length, 60_000);
const received = heard.find((message) => message.n === 7);
assert.equal(received.blob.length, big.blob.length);
assert.ok(received.blob === big.blob, "the 2 MiB message arrives intact");

assert.equal(a.$broadcast("big:1").send({ blob: "x".repeat(4 * 1024 * 1024) }), false, "oversized messages are rejected before queueing");

for (const stop of stops) stop();
stopHear();
a.$close();
b.$close();
console.log("big-socket: ok");
