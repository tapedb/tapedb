// Load: live subscribers holding ordered windows while concurrent writers write.
// Reports write latency and the delay until every subscriber has seen each write.
// Not run by default: node scripts/e2e.mjs --only load
//   SUBSCRIBERS=50 ROWS=500 WRITES=400 CONCURRENCY=8; DISTINCT=1 makes each subscriber
//   its own user (claims signed with TAPEDB_CLAIM_SECRET, or .dev.vars locally).
import { randomUUID } from "node:crypto";
import { createClient } from "@tapedb/tapedb";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { BASE, s } from "./common.mjs";

const SUBSCRIBERS = Number(process.env.SUBSCRIBERS ?? 50);
const ROWS = Number(process.env.ROWS ?? 500);
const WRITES = Number(process.env.WRITES ?? 400);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8);
const workspace = randomUUID();
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

const writer = createClient({ schema: s, url: BASE, workspace });
for (let start = 0; start < ROWS; start += 250) {
  await writer.$transaction(Array.from({ length: Math.min(250, ROWS - start) }, (_, n) => writer.task.create({ data: { title: `seed-${String(start + n).padStart(5, "0")}` } })));
}

// Each subscriber is its own client and socket, as separate browsers would be.
const seenAt = new Map(); // title -> count of subscribers that have it
const lastSeen = new Map(); // title -> time the last subscriber saw it
const subscribers = [];
let ready = 0;
// DISTINCT=1: each subscriber is a different user, so no two share a run.
const secret =
  process.env.TAPEDB_CLAIM_SECRET ??
  (process.env.DISTINCT ? /TAPEDB_CLAIM_SECRET\s*=\s*"?([^"\n]+)/.exec(readFileSync(".dev.vars", "utf8"))?.[1] : undefined);
const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const tokenFor = (sub) => async () => {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, workspaceId: workspace, role: 4, iat: now, exp: now + 600 })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
};
for (let n = 0; n < SUBSCRIBERS; n += 1) {
  const db = createClient({ schema: s, url: BASE, workspace, ...(process.env.DISTINCT ? { getToken: tokenFor(`user-${n}`) } : {}) });
  const known = new Set();
  let first = true;
  db.task.findMany({ orderBy: { title: "desc" }, take: ROWS, select: { title: true } }).subscribe((state) => {
    if (!state.data) return;
    if (first) {
      first = false;
      ready += 1;
      for (const row of state.data) known.add(row.title);
      return;
    }
    const now = Date.now();
    for (const row of state.data) {
      if (known.has(row.title)) continue;
      known.add(row.title);
      const count = (seenAt.get(row.title) ?? 0) + 1;
      seenAt.set(row.title, count);
      if (count === SUBSCRIBERS) lastSeen.set(row.title, now);
    }
  });
  subscribers.push(db);
}
const setupStart = Date.now();
while (ready < SUBSCRIBERS) {
  if (Date.now() - setupStart > 60_000) throw new Error(`only ${ready}/${SUBSCRIBERS} subscribers got data`);
  await new Promise((r) => setTimeout(r, 50));
}
console.log(`${SUBSCRIBERS} subscribers ready in ${Date.now() - setupStart} ms, each holding ${ROWS} rows`);

// Writes sort to the top of every window ("z" > "seed"), so each one reaches every subscriber.
const latencies = [];
const sentAt = new Map();
let next = 0;
const started = Date.now();
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < WRITES) {
      const index = next++;
      const title = `z-${String(index).padStart(6, "0")}`;
      const t0 = Date.now();
      sentAt.set(title, t0);
      await writer.task.create({ data: { title } });
      latencies.push(Date.now() - t0);
    }
  })
);
const writeMs = Date.now() - started;
const deadline = Date.now() + 60_000;
while (lastSeen.size < WRITES && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));

const fanout = [...lastSeen].map(([title, at]) => at - sentAt.get(title));
console.log(`writes: ${WRITES} at concurrency ${CONCURRENCY} in ${writeMs} ms (${Math.round((WRITES / writeMs) * 1000)}/s)`);
console.log(`write latency ms: p50 ${quantile(latencies, 0.5)}  p95 ${quantile(latencies, 0.95)}  p99 ${quantile(latencies, 0.99)}  max ${Math.max(...latencies)}`);
console.log(`seen by all ${SUBSCRIBERS}: ${lastSeen.size}/${WRITES}; delay ms p50 ${quantile(fanout, 0.5)}  p95 ${quantile(fanout, 0.95)}  max ${Math.max(...fanout)}`);
for (const db of subscribers) db.$close();
writer.$close();
