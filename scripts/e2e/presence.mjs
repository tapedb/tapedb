// Presence against the real engine: several rooms on one socket, the
// deployment's authorizer refusing one of them, and the room cap. The refusal
// is checked twice — as the frame the server puts on the wire, and as the
// error the app's `onError` receives — because a unit test against a
// hand-written frame proves the client agrees with itself, not with workerd.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@tapedb/tapedb";
import { BASE, s, until } from "./common.mjs";

// scripts/e2e.mjs bakes the authorizer and the cap into the Worker it
// generates, for a local run only (a deployed Worker has neither). Without
// them this scenario would assert a refusal the Worker was never asked for.
const refusedRoom = process.env.TAPEDB_E2E_REFUSED_ROOM;
const roomCap = Number(process.env.TAPEDB_E2E_PRESENCE_ROOMS);
if (!refusedRoom || !Number.isInteger(roomCap)) {
  console.log("presence: skipped (run through scripts/e2e.mjs: it configures the Worker)");
  process.exit(0);
}

const workspace = randomUUID();
const claim = await fetch(`${BASE}/_tapedb/claim`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ workspaceId: workspace }),
}).then((response) => response.json());
assert.equal(typeof claim.token, "string", "a claim for the workspace");

// ---- The wire: what the server answers one socket -------------------------
//
// A raw socket, so the assertions are about the engine's own frames rather
// than about what the client made of them.

const frames = [];
const socket = new WebSocket(
  `${BASE.replace(/^http/, "ws")}/engine/workspaces/${workspace}/websocket`,
  ["tapedb", `tapedb.claim.${claim.token}`]
);
socket.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
const send = (message) => socket.send(JSON.stringify(message));
const frame = (predicate) => frames.find(predicate);

await until(() => frame((f) => f.type === "session:ready"), "session:ready on the raw socket", frames);
const self = frame((f) => f.type === "session:ready").clientId;
assert.ok(typeof self === "string" && self.length > 0, "the server assigns the socket an id");

send({ type: "presence:set", target: "raw:1", presence: { name: "raw" } });
await until(() => frame((f) => f.type === "presence:update" && f.target === "raw:1"), "raw:1 joined", frames);
assert.deepEqual(
  frame((f) => f.type === "presence:update" && f.target === "raw:1").peers,
  [{ clientId: self, presence: { name: "raw" } }],
  "the peer list the server sends includes the caller, so a client can draw its own cursor"
);

send({ type: "presence:set", target: refusedRoom, presence: { name: "raw" } });
await until(() => frame((f) => f.type === "error"), `a refusal for ${refusedRoom}`, frames);
const denial = frame((f) => f.type === "error");
assert.equal(denial.code, "presence_denied");
assert.equal(denial.target, refusedRoom, "the refusal frame names the room it refused");

send({ type: "presence:set", target: "raw:2", presence: { name: "raw" } });
await until(() => frame((f) => f.type === "presence:update" && f.target === "raw:2"), `raw:2 joined (cap ${roomCap})`, frames);
send({ type: "presence:set", target: "raw:3", presence: { name: "raw" } });
await until(() => frame((f) => f.type === "error" && f.code === "presence_rooms_exceeded"), "the room cap refusing a new room", frames);
const capped = frame((f) => f.type === "error" && f.code === "presence_rooms_exceeded");
assert.equal(capped.target, "raw:3", "the cap refusal names the room it refused");

// A refusal changes nothing: the rooms already joined still take an update,
// and no frame ever arrives for the refused ones.
send({ type: "presence:set", target: "raw:1", presence: { name: "raw:2" } });
await until(
  () => frame((f) => f.type === "presence:update" && f.target === "raw:1" && f.peers[0]?.presence?.name === "raw:2"),
  "raw:1 still joined after two refusals",
  frames
);
assert.equal(frame((f) => f.type === "presence:update" && f.target === refusedRoom), undefined, "the refused room never became a peer list");
assert.equal(frame((f) => f.type === "presence:update" && f.target === "raw:3"), undefined, "the capped room never became a peer list");
socket.close();

// ---- The client: what an app sees ----------------------------------------

const db = createClient({ schema: s, url: BASE, workspace });
const peersSeen = { one: [], two: [], refused: [], three: [] };
const errors = { one: [], two: [], refused: [], three: [] };
const stop = [];
for (const [key, room] of [["one", "client:1"], ["two", "client:2"], ["refused", refusedRoom], ["three", "client:3"]]) {
  stop.push(
    db.$presence(room).subscribe((peers) => peersSeen[key].push(peers), {
      onError: (error) => errors[key].push(error),
    })
  );
}

// Publishing before the socket is open is dropped by the transport, so wait
// for the id the server assigns (the client replays local presence then).
await until(() => db.clientId !== undefined, "session:ready on the client socket", [db.clientId]);
db.$presence("client:1").set({ name: "one" });
await until(() => peersSeen.one.at(-1)?.some((peer) => peer.isSelf && peer.presence?.name === "one"), "client:1 peers include self", peersSeen.one);

const mine = await db.$presence("client:1").peers();
assert.equal(mine.length, 1, `one peer in client:1, got ${JSON.stringify(mine)}`);
assert.equal(mine[0].isSelf, true, "the caller's own entry is marked");
assert.equal(mine[0].clientId, db.clientId, "isSelf is this socket, not some other entry");
assert.deepEqual(mine[0].presence, { name: "one" });

// The authorizer's refusal reaches the handle for that room, by code and
// target. Below the cap only: a join past it is refused as a cap first, which
// is the engine's order (cap, then authorizer, then the byte budget).
db.$presence(refusedRoom).set({ name: "denied" });
await until(() => errors.refused.length > 0, `onError for ${refusedRoom}`, errors.refused);
assert.deepEqual(errors.refused[0], { code: "presence_denied", target: refusedRoom }, "onError carries the code and the room");
assert.equal(errors.one.length, 0, "a refusal naming one room is not delivered to another room's handle");
assert.equal(errors.two.length, 0, "not to a handle for a room that was never joined either");
assert.deepEqual(await db.$presence(refusedRoom).peers(), [], "a refused room holds no peers");
assert.deepEqual(await db.$presence("client:1").peers(), mine, "a refusal left the joined room exactly as it was");

// A second room fits; the third is past the cap and refused the same way.
db.$presence("client:2").set({ name: "two" });
await until(() => peersSeen.two.at(-1)?.some((peer) => peer.isSelf && peer.presence?.name === "two"), "client:2 joined (cap 2)", peersSeen.two);
db.$presence("client:3").set({ name: "three" });
await until(() => errors.three.length > 0, `the cap's onError for client:3 (cap ${roomCap})`, errors.three);
assert.deepEqual(errors.three[0], { code: "presence_rooms_exceeded", target: "client:3" }, "the cap refusal reaches onError");
assert.deepEqual(await db.$presence("client:3").peers(), [], "the room past the cap holds no peers");
assert.deepEqual(await db.$presence("client:1").peers(), mine, "nor did the cap refusal touch the rooms that were joined");

// And the subscription that was refused nothing still delivers the next update.
db.$presence("client:1").set({ name: "one-again" });
await until(
  () => peersSeen.one.at(-1)?.some((peer) => peer.isSelf && peer.presence?.name === "one-again"),
  "client:1 delivers the next update after the refusals",
  peersSeen.one
);
assert.deepEqual(await db.$presence("client:1").peers(), [{ clientId: db.clientId, presence: { name: "one-again" }, isSelf: true }]);

for (const unsubscribe of stop) unsubscribe();
db.$close();
console.log(`presence: ${roomCap}-room socket, ${refusedRoom} refused on the wire and in onError, cap enforced`);
