// Webhooks against the real runtime: a receiver on loopback, the Worker's own
// alarm posting to it, and the signature checked the way a consumer would —
// HMAC-SHA256 over the exact bytes that arrived. A unit test with an
// in-memory transport proves the outbox agrees with its own model of the
// network; this proves workerd can reach an HTTP endpoint and sign what it sent.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createClient } from "@tapedb/tapedb";
import { BASE, s, until } from "./common.mjs";

// scripts/e2e.mjs bakes the endpoint and its secret into the Worker it
// generates, along with the port this process then binds (a deployed Worker
// cannot reach a loopback receiver, so it has neither).
const secret = process.env.TAPEDB_E2E_WEBHOOK_SECRET;
const url = process.env.TAPEDB_E2E_WEBHOOK_URL;
if (!secret || !url) {
  console.log("webhooks: skipped (run through scripts/e2e.mjs: it configures the Worker and the endpoint)");
  process.exit(0);
}
const port = Number(new URL(url).port);

// ---- The receiver ---------------------------------------------------------

const received = [];
const attempts = new Map();
// The one row whose first attempt is answered 500, so the retry path is the
// engine's own: same event, same body, one backoff later.
const RETRY_ROW = "board-retry";

const server = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    let event = null;
    try {
      event = JSON.parse(body);
    } catch {
      // A body that is not JSON still counts as a delivery: the signature
      // assertions below will say what arrived.
    }
    const attempt = (attempts.get(event?.eventId) ?? 0) + 1;
    if (event?.eventId !== undefined) attempts.set(event.eventId, attempt);
    received.push({ at: Date.now(), path: request.url, headers: request.headers, body, event, attempt });
    const fail = event?.row?.id === RETRY_ROW && attempt === 1;
    response.writeHead(fail ? 500 : 200, { "content-type": "text/plain" }).end(fail ? "try again" : "ok");
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});

/** Everything this run pointed the Worker at, from this or any other workspace. */
const all = () => received.filter((delivery) => delivery.path === "/tapedb");

// ---- One write, one signed delivery --------------------------------------

const workspace = randomUUID();
const deliveries = () => all().filter((delivery) => delivery.event?.workspaceId === workspace);
const forRow = (id) => deliveries().filter((delivery) => delivery.event.row?.id === id);

/** Checks `X-Tapedb-Signature` the way a consumer does; returns its timestamp. */
function verify(delivery) {
  const header = delivery.headers["x-tapedb-signature"];
  assert.equal(typeof header, "string", `every delivery is signed, got headers ${JSON.stringify(delivery.headers)}`);
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  assert.ok(match, `signature shape t=<seconds>,v1=<hex>: ${header}`);
  const [, timestamp, v1] = match;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${delivery.body}`).digest("hex");
  assert.equal(v1, expected, "HMAC-SHA256 over `${t}.${body}` with this endpoint's secret");
  return Number(timestamp);
}

const db = createClient({ schema: s, url: BASE, workspace });
const token = await fetch(`${BASE}/_tapedb/claim`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ workspaceId: workspace }),
})
  .then((response) => response.json())
  .then((claim) => claim.token);

const board = await db.board.create({ data: { name: "hooked" } });
await until(() => forRow(board.id).length > 0, "the create delivered", forRow(board.id), 20_000);
const created = forRow(board.id)[0];
const createdSignatureAt = verify(created);
assert.equal(created.event.model, "board");
assert.equal(created.event.op, "create");
assert.equal(created.event.eventId, created.headers["x-tapedb-event-id"], "the body's eventId is the header's");
assert.equal(created.event.seq, Number(created.headers["x-tapedb-seq"]), "the body's seq is the header's");
assert.equal(created.headers["x-tapedb-model"], "board");
assert.equal(created.headers["x-tapedb-event"], "create");
assert.ok(created.event.seq > 0, `a sequence from the write's log entry, got ${created.event.seq}`);
assert.ok(Math.abs(Date.now() / 1000 - createdSignatureAt) < 120, `the signature's timestamp is this attempt's, got ${createdSignatureAt}`);
assert.deepEqual(
  Object.keys(created.event).sort(),
  ["at", "eventId", "model", "op", "row", "seq", "workspaceId"],
  "the payload's shape"
);
assert.deepEqual(created.event.row, { id: board.id, name: "hooked" }, "the row as a consumer sees it");

// An update sends the row after the write; a delete sends the values it had
// (captured in the trigger, before the row was gone).
await db.board.update({ where: { id: board.id }, data: { name: "hooked-again" } });
await until(() => deliveries().some((delivery) => delivery.event.row?.id === board.id && delivery.event.op === "update"), "the update delivered", deliveries(), 20_000);
const updated = deliveries().find((delivery) => delivery.event.row?.id === board.id && delivery.event.op === "update");
verify(updated);
assert.deepEqual(updated.event.row, { id: board.id, name: "hooked-again" });
assert.ok(updated.event.seq > created.event.seq, "events follow the log: the update's seq is after the create's");

// ---- Personal fields never leave the workspace ----------------------------

const person = await db.person.create({ data: { name: "Private Payload", data: { secret: "never leaves" } } });
await until(() => forRow(person.id).length > 0, "the person's create delivered", forRow(person.id), 20_000);
const personal = forRow(person.id)[0];
verify(personal);
assert.equal(personal.event.model, "person");
assert.deepEqual(personal.event.row, { id: person.id }, "only the non-personal attributes: no name, no data");
assert.equal(personal.body.includes("Private Payload"), false, "the plaintext is not in the body");
assert.equal(personal.body.includes("never leaves"), false, "nor is the personal JSON");

// A delete carries the row's values as they were, personal fields still out.
await db.board.delete({ where: { id: board.id } });
await until(() => deliveries().some((delivery) => delivery.event.row?.id === board.id && delivery.event.op === "delete"), "the delete delivered", deliveries(), 20_000);
const deleted = deliveries().find((delivery) => delivery.event.row?.id === board.id && delivery.event.op === "delete");
verify(deleted);
assert.deepEqual(deleted.event.row, { id: board.id, name: "hooked-again" }, "a delete carries what the row had");

// ---- The same clientTxId replayed is not a second write -------------------

/** A transaction straight to the engine, as a retrying client would send it. */
async function transact(body) {
  const response = await fetch(`${BASE}/engine/workspaces/${workspace}/transact`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return response.json();
}

const once = {
  txId: randomUUID(),
  clientTxId: `replay-${randomUUID()}`,
  ops: [{ op: "insert", namespace: "board", id: "board-once", values: { name: "once" } }],
};
const applied = await transact(once);
assert.equal(applied.ok, true, JSON.stringify(applied));
assert.equal(applied.result.applied, 1);
const replay = await transact(once);
assert.equal(replay.result.applied, 0, "the replay is not applied");
assert.equal(replay.result.seq, applied.result.seq, "and it answers the first attempt's sequence");
await until(() => forRow("board-once").length > 0, "the first attempt's create delivered", forRow("board-once"), 20_000);
// Nothing else for that row: a replay appends no log entry, so nothing is captured.
await new Promise((resolve) => setTimeout(resolve, 3_000));
assert.equal(forRow("board-once").length, 1, "one delivery for a write sent twice");
assert.equal(forRow("board-once")[0].event.op, "create");

// ---- A 500 is retried, a 200 ends it -------------------------------------

// Through the engine's own backoff (30 s, then doubling): the receiver answers
// this row's first attempt 500 and everything after it 200.
const retry = await transact({
  txId: randomUUID(),
  clientTxId: `retry-${randomUUID()}`,
  ops: [{ op: "insert", namespace: "board", id: RETRY_ROW, values: { name: "retry" } }],
});
assert.equal(retry.ok, true, JSON.stringify(retry));
await until(() => forRow(RETRY_ROW).length === 1, "the first attempt (answered 500)", forRow(RETRY_ROW), 20_000);
const first = forRow(RETRY_ROW)[0];
const firstSignatureAt = verify(first);
await until(() => forRow(RETRY_ROW).length === 2, "the retry after a 500 (the first backoff is 30 s)", forRow(RETRY_ROW), 75_000);
const second = forRow(RETRY_ROW)[1];
const secondSignatureAt = verify(second);
assert.equal(second.event.eventId, first.event.eventId, "a retry is the same event, not a new one");
assert.equal(second.body, first.body, "and the same bytes, byte for byte");
assert.equal(second.event.seq, first.event.seq);
assert.ok(
  secondSignatureAt >= firstSignatureAt + 25,
  `a retry is signed again with its own timestamp: ${firstSignatureAt} then ${secondSignatureAt}`
);
const backoff = second.at - first.at;
assert.ok(backoff >= 25_000 && backoff <= 60_000, `the first backoff is 30 s, saw ${backoff} ms`);
// The 200 ended it: a third attempt would only exist if the 200 had been lost.
await new Promise((resolve) => setTimeout(resolve, 10_000));
assert.equal(forRow(RETRY_ROW).length, 2, "no third delivery after a 2xx");

// ---- What the outbox says ------------------------------------------------

const status = await fetch(`${BASE}/engine/workspaces/${workspace}/status`, {
  headers: { authorization: `Bearer ${token}` },
}).then((response) => response.json());
assert.deepEqual(
  status.webhooks,
  { pending: 0, delivered: 6, dead: 0 },
  "six writes: board create/update/delete, person create, board-once, board-retry (delivered once)"
);

// ---- Operating the outbox ------------------------------------------------

// The inspection and retry routes against the real runtime. Worth doing here
// rather than only in bun: the outbox gained a column in place
// (`revived_at`), and a Durable Object's SQLite is the one that has to take
// that ALTER on a workspace whose table already existed.
const report = await db.$webhooks();
assert.equal(report.endpoints.length, 1, JSON.stringify(report));
assert.equal(report.endpoints[0].url, url);
assert.equal(report.endpoints[0].delivered, 6);
assert.equal(report.endpoints[0].pending, 0);
assert.equal(report.endpoints[0].head, null, "nothing is waiting once every delivery landed");
assert.equal(report.endpoints[0].retired, false);
assert.ok(report.policy.maxAttempts > 1 && report.policy.maxAgeMs > report.policy.firstRetryMs);

const listed = await db.$webhookDeliveries();
assert.equal(listed.length, 6);
// Newest transaction first, and bookkeeping only: the signed body never comes
// back, because no read rule filtered it.
assert.ok(listed[0].seq >= listed[listed.length - 1].seq);
assert.ok(listed.every((row) => row.status === "delivered" && row.eventId && row.model));
assert.ok(!Object.hasOwn(listed[0], "body"), "the signed body is not returned");
assert.ok(!JSON.stringify(listed).includes("@"), "no personal value reaches an inspection read");

// Every one of these is delivered, so every one is refused: an acknowledged
// event is never re-sent, even when named by id.
const refused = await db.$webhookRetry({ ids: listed.map((row) => row.id) });
assert.equal(refused.requeued, 0);
assert.equal(refused.skipped.length, 6);
assert.ok(refused.skipped.every((entry) => entry.reason === "already_delivered"));

const unknown = await db.$webhookRetry({ ids: ["no-such-delivery"] });
assert.deepEqual(unknown.skipped, [{ id: "no-such-delivery", reason: "not_found" }]);

// A filter run over a queue with nothing to do is a clean no-op, not an error.
const none = await db.$webhookRetry({ status: "dead" });
assert.equal(none.requeued, 0);
assert.equal(none.more, false);

// A member may not read any of it.
const memberToken = await fetch(`${BASE}/_tapedb/claim`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  // The development claim route takes a numeric level, not a role name.
  body: JSON.stringify({ workspaceId: workspace, role: 2 }),
})
  .then((response) => response.json())
  .then((claim) => claim.token);
for (const path of ["webhooks", "webhooks/deliveries"]) {
  const response = await fetch(`${BASE}/engine/workspaces/${workspace}/${path}`, {
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(response.status, 403, `${path} is admin-only`);
}

server.close();
db.$close();
console.log(
  `webhooks: 6 delivered (1 after a 500, 500→200 in ${Math.round(backoff / 1000)}s), signatures verify, personal fields absent, ` +
    `a replayed clientTxId delivered once, outbox inspection admin-only and bodyless, delivered events never re-sent`
);
