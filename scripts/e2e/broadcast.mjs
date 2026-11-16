// Two clients on one workspace exchange broadcast messages through workerd.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@tapedb/tapedb";
import { BASE, s, until } from "./common.mjs";
const workspace = randomUUID();
const a = createClient({ schema: s, url: BASE, workspace });
const b = createClient({ schema: s, url: BASE, workspace });
const heardA = [], heardB = [];
const stopA = a.$broadcast("room:1").subscribe((m, from) => heardA.push([m, from.userId]));
const stopB = b.$broadcast("room:1").subscribe((m) => heardB.push(m));
// Wait until both sockets are joined: keep sending until B hears one.
await until(() => { a.$broadcast("room:1").send({ hello: "b" }); return heardB.length > 0; }, "b hears a", heardB);
assert.deepEqual(heardB[0], { hello: "b" });
assert.equal(heardA.length, 0, "the sender does not hear itself");
b.$broadcast("room:1").send({ hello: "a" });
await until(() => heardA.length > 0, "a hears b", heardA);
assert.equal(heardA[0][1], "dev-user");
stopB();
await new Promise((r) => setTimeout(r, 200));
const before = heardB.length;
a.$broadcast("room:1").send("after leave");
await new Promise((r) => setTimeout(r, 300));
assert.equal(heardB.length, before, "b left the topic");
stopA(); a.$close(); b.$close();
console.log("drive-broadcast: ok");
