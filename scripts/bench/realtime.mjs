// Live updates, presence and broadcast fan-out, and reconnection.
//   SUBSCRIBERS (10,50,200 × SCALE) sockets; LIVE_WRITES (100) writes per run;
//   SUBS_PER_CLIENT (5) for the multi-subscription run; FANOUT_MESSAGES (50).
import { randomUUID } from "node:crypto";
import { createClient } from "@tapedb/tapedb";
import { BASE, s } from "./common.mjs";
import { metrics, emit, env, envList, scaled, sleep, summarize, tokenFor } from "./lib.mjs";

const SUBSCRIBERS = envList("SUBSCRIBERS", [scaled(10), scaled(50), scaled(200)]);
const WRITES = env("LIVE_WRITES", 100);
const SUBS_PER_CLIENT = env("SUBS_PER_CLIENT", 5);
const MESSAGES = env("FANOUT_MESSAGES", 50);

async function until(predicate, label, ms = 60_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out: ${label}`);
}

/** A raw socket that records every frame with its arrival time. */
async function rawSocket(workspace, token) {
  const frames = [];
  const socket = new WebSocket(`${BASE.replace(/^http/, "ws")}/engine/workspaces/${workspace}/websocket`, ["tapedb", `tapedb.claim.${token}`]);
  socket.addEventListener("message", (event) => frames.push({ at: performance.now(), frame: JSON.parse(String(event.data)) }));
  await until(() => frames.some((f) => f.frame.type === "session:ready"), "session:ready", 30_000);
  return { socket, frames, send: (message) => socket.send(JSON.stringify(message)) };
}

// ---- Live query propagation: one window per subscriber, writes landing in it.
async function liveRun(subscribers, subsPerClient) {
  const workspace = randomUUID();
  const writer = createClient({ schema: s, url: BASE, workspace });
  await writer.$transaction(Array.from({ length: 100 }, (_, n) => writer.task.create({ data: { title: `seed-${String(n).padStart(4, "0")}` } })));

  const seen = new Map(); // title -> { count, last }
  const clients = [];
  const stops = [];
  let ready = 0;
  const readyStarted = performance.now();
  for (let c = 0; c < subscribers; c += 1) {
    const client = createClient({ schema: s, url: BASE, workspace });
    clients.push(client);
    for (let k = 0; k < subsPerClient; k += 1) {
      let first = true;
      const known = new Set();
      // Ordered newest-first window: every write lands in it.
      stops.push(
        client.task.findMany({ orderBy: { title: "desc" }, take: 20 + k }).subscribe((state) => {
          if (!state.data) return;
          if (first) {
            first = false;
            ready += 1;
            for (const row of state.data) known.add(row.title);
            return;
          }
          const now = performance.now();
          for (const row of state.data) {
            if (known.has(row.title)) continue;
            known.add(row.title);
            const entry = seen.get(row.title) ?? { count: 0, last: 0 };
            entry.count += 1;
            entry.last = now;
            seen.set(row.title, entry);
          }
        })
      );
    }
  }
  const total = subscribers * subsPerClient;
  await until(() => ready === total, `${total} subscriptions ready`, 120_000);
  const readyMs = performance.now() - readyStarted;

  const sentAt = new Map();
  const writeLatencies = [];
  const started = performance.now();
  for (let n = 0; n < WRITES; n += 1) {
    const title = `zz-${String(n).padStart(4, "0")}`;
    const t0 = performance.now();
    sentAt.set(title, t0);
    await writer.task.create({ data: { title } });
    writeLatencies.push(performance.now() - t0);
  }
  const writeMs = performance.now() - started;
  await until(() => [...sentAt.keys()].every((title) => (seen.get(title)?.count ?? 0) >= total), "every subscription saw every write", 120_000).catch(() => {});
  const delays = [...sentAt].filter(([title]) => (seen.get(title)?.count ?? 0) >= total).map(([title, at]) => seen.get(title).last - at);
  const missed = [...sentAt.keys()].filter((title) => (seen.get(title)?.count ?? 0) < total).length;
  const diag = await metrics({ id: workspace, token: await tokenFor(workspace) });

  for (const stop of stops) stop();
  for (const client of clients) client.$close();
  writer.$close();
  return {
    subscriptionsReadyMs: Math.round(readyMs),
    writesPerSecond: Math.round((WRITES / (writeMs / 1000)) * 10) / 10,
    writeLatencyMs: summarize(writeLatencies),
    seenByAllDelayMs: summarize(delays),
    writesNotSeenByAll: missed,
    serverLiveUpdateMs: diag?.metrics.latency.timers.subscriptionUpdate ?? null,
    subscriptionUpdates: diag?.metrics.counters["subscriptions.updates"] ?? null,
  };
}

for (const subscribers of SUBSCRIBERS) {
  emit("realtime", "live-subscribers", { subscribers, subsPerClient: 1, writes: WRITES }, await liveRun(subscribers, 1));
}
{
  const subscribers = Math.min(...SUBSCRIBERS);
  emit("realtime", "multi-subscription", { subscribers, subsPerClient: SUBS_PER_CLIENT, writes: WRITES }, await liveRun(subscribers, SUBS_PER_CLIENT));
}

// ---- Presence and broadcast fan-out over raw sockets.
for (const peers of SUBSCRIBERS) {
  const workspace = randomUUID();
  const token = await tokenFor(workspace);
  const sockets = [];
  for (let n = 0; n < peers; n += 1) sockets.push(await rawSocket(workspace, token));
  const [speaker, ...listeners] = sockets;

  // Presence: everyone joins one target, then the speaker updates its state.
  for (const peer of sockets) peer.send({ type: "presence:set", target: "bench", presence: { n: 0 } });
  await until(() => listeners.every((l) => l.frames.some((f) => f.frame.type === "presence:update" && f.frame.peers?.length === peers)), "presence joined", 60_000).catch(() => {});
  const presenceDelays = [];
  for (let m = 1; m <= MESSAGES; m += 1) {
    const sent = performance.now();
    speaker.send({ type: "presence:set", target: "bench", presence: { n: m } });
    const match = (f) => f.frame.type === "presence:update" && f.frame.peers?.some((p) => p.presence?.n === m);
    await until(() => listeners.every((l) => l.frames.some(match)), `presence ${m}`, 30_000).catch(() => {});
    const arrivals = listeners.map((l) => l.frames.find(match)?.at).filter((at) => at !== undefined);
    if (arrivals.length === listeners.length && arrivals.length > 0) presenceDelays.push(Math.max(...arrivals) - sent);
  }
  emit("realtime", "presence-fanout", { peers, updates: MESSAGES }, { allPeersDelayMs: summarize(presenceDelays), updatesNotSeenByAll: MESSAGES - presenceDelays.length });

  // Broadcast: everyone joins a topic, the speaker sends.
  for (const peer of sockets) peer.send({ type: "topic:join", topic: "bench" });
  await until(() => sockets.every((p) => p.frames.some((f) => f.frame.type === "topic:joined")), "topic joined", 60_000).catch(() => {});
  const broadcastDelays = [];
  for (let m = 0; m < MESSAGES; m += 1) {
    const sent = performance.now();
    speaker.send({ type: "topic:send", topic: "bench", message: { m } });
    const match = (f) => f.frame.type === "topic:message" && f.frame.message?.m === m;
    await until(() => listeners.every((l) => l.frames.some(match)), `broadcast ${m}`, 30_000).catch(() => {});
    const arrivals = listeners.map((l) => l.frames.find(match)?.at).filter((at) => at !== undefined);
    if (arrivals.length === listeners.length && arrivals.length > 0) broadcastDelays.push(Math.max(...arrivals) - sent);
  }
  emit("realtime", "broadcast-fanout", { peers, messages: MESSAGES }, { allPeersDelayMs: summarize(broadcastDelays), messagesNotSeenByAll: MESSAGES - broadcastDelays.length });
  for (const peer of sockets) peer.socket.close();
}

// ---- Reconnection: close a subscribed socket, time until it has data again.
{
  const workspace = randomUUID();
  const token = await tokenFor(workspace);
  const delays = [];
  for (let round = 0; round < 10; round += 1) {
    const started = performance.now();
    const peer = await rawSocket(workspace, token);
    peer.send({ type: "query:subscribe", id: "q", query: { task: {} } });
    await until(() => peer.frames.some((f) => f.frame.type === "query:data"), "first data", 30_000);
    delays.push(performance.now() - started);
    peer.socket.close();
  }
  emit("realtime", "connect-subscribe", { rounds: 10 }, { socketToFirstDataMs: summarize(delays) });
}
