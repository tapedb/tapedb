// Search latency on a real deployment, for the numbers a release note quotes.
//
//   TAPEDB_URL=https://<worker> TAPEDB_WORKSPACE=<uuid> TAPEDB_TOKEN=<claim> \
//     node scripts/bench-vector.mjs [--rows 200] [--samples 40] [--no-seed]
//
// `TAPEDB_TOKEN` is a signed workspace claim with a role that can read and write
// (see the pilot reference: sign HS256 over { sub, workspaceId, role, iat, exp }
// with TAPEDB_CLAIM_SECRET). The script seeds rows with known embeddings unless
// --no-seed is passed, waits for the provider to make them visible, then times
// text queries (embedding + hybrid fusion + rerank, when configured) and vector
// queries (the index alone), and prints p50/p95 for each.
//
// It is a measurement, not a gate: the numbers describe one deployment at one
// moment and are quoted that way.

import { randomUUID } from "node:crypto";

const url = process.env.TAPEDB_URL;
const workspace = process.env.TAPEDB_WORKSPACE;
const token = process.env.TAPEDB_TOKEN;
if (!url || !workspace || !token) {
  console.error("TAPEDB_URL, TAPEDB_WORKSPACE and TAPEDB_TOKEN are required.");
  process.exit(2);
}
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
const rows = arg("rows", 200);
const samples = arg("samples", 40);
const seed = !process.argv.includes("--no-seed");
const DIMENSIONS = arg("dimensions", 768);
const words = ["planning", "budget", "forecast", "invoice", "roadmap", "hiring", "latency", "billing"];

async function call(path, init = {}) {
  const started = performance.now();
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  const elapsed = performance.now() - started;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: response.status, body, elapsed };
}

const embed = (word) => {
  const values = new Array(DIMENSIONS).fill(0);
  for (const [position, char] of [...word].entries()) {
    values[(char.codePointAt(0) * 31 + position * 97) % DIMENSIONS] = 1;
  }
  return values;
};
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q))].toFixed(1));
};

if (seed) {
  const ops = Array.from({ length: rows }, (_, index) => ({
    op: "insert",
    namespace: process.env.TAPEDB_MODEL ?? "note",
    id: `bench-${String(index).padStart(4, "0")}`,
    values: {
      title: `${words[index % words.length]} note ${index}`,
      excerpt: `row ${index} about ${words[index % words.length]}`,
      archived: index % 10 === 0,
      embedding: embed(words[index % words.length]),
    },
  }));
  const written = await call(`/engine/workspaces/${workspace}/transact`, {
    method: "POST",
    body: JSON.stringify({ txId: randomUUID(), ops }),
  });
  console.log(`seed: ${written.status} ${written.body?.ok === true ? `${rows} rows` : JSON.stringify(written.body).slice(0, 200)}`);
}

const started = Date.now();
let accepted = null;
for (let attempt = 0; attempt < 120; attempt += 1) {
  await new Promise((done) => setTimeout(done, 2_000));
  const status = await call(`/engine/workspaces/${workspace}/status`);
  const vectorize = status.body?.vectorize;
  if (vectorize && vectorize.pending === 0 && vectorize.indexed >= (seed ? rows : 1)) {
    accepted = vectorize;
    break;
  }
}
console.log("accepted:", JSON.stringify(accepted));

// Visibility is the provider's schedule, measured at 50-100 s and once over
// three minutes for a batch of 200: wait for an answer, do not assume a delay.
let visible = 0;
for (let attempt = 0; attempt < 300; attempt += 1) {
  const answer = await call(`/engine/workspaces/${workspace}/search`, {
    method: "POST",
    body: JSON.stringify({ model: process.env.TAPEDB_MODEL ?? "note", text: "planning", limit: 10 }),
  });
  visible = (answer.body?.data?.note ?? []).length;
  if (visible > 0) break;
  await new Promise((done) => setTimeout(done, 2_000));
}
if (visible === 0) {
  console.error("no row became visible; the measurement would describe empty answers");
  process.exit(1);
}
console.log(`visible after ${Math.round((Date.now() - started) / 1000)}s: ${visible} rows`);

const text = [];
const vector = [];
let textAnswer = {};
let vectorAnswer = {};
for (let sample = 0; sample < samples; sample += 1) {
  const word = words[sample % words.length];
  const byText = await call(`/engine/workspaces/${workspace}/search`, {
    method: "POST",
    body: JSON.stringify({
      model: process.env.TAPEDB_MODEL ?? "note",
      text: word,
      limit: 10,
      filter: { archived: sample % 2 === 0 },
    }),
  });
  textAnswer = { status: byText.status, rows: (byText.body?.data?.note ?? []).length, ...byText.body?.search, error: byText.body?.error?.code };
  if (byText.status === 200 && textAnswer.rows > 0) text.push(byText.elapsed);

  const byVector = await call(`/engine/workspaces/${workspace}/search`, {
    method: "POST",
    body: JSON.stringify({ model: process.env.TAPEDB_MODEL ?? "note", vector: embed(word), limit: 10 }),
  });
  vectorAnswer = { status: byVector.status, rows: (byVector.body?.data?.note ?? []).length, ...byVector.body?.search, error: byVector.body?.error?.code };
  if (byVector.status === 200 && vectorAnswer.rows > 0) vector.push(byVector.elapsed);
}

const summary = (values, answer) => ({
  samples: values.length,
  p50: values.length === 0 ? null : quantile(values, 0.5),
  p95: values.length === 0 ? null : quantile(values, 0.95),
  min: values.length === 0 ? null : Number(Math.min(...values).toFixed(1)),
  max: values.length === 0 ? null : Number(Math.max(...values).toFixed(1)),
  rows: answer.rows,
  mode: answer.mode,
  reranked: answer.reranked,
});
console.log(JSON.stringify({ text: summary(text, textAnswer), vector: summary(vector, vectorAnswer) }, null, 2));
