// Vector search in workerd, against a real Vectorize index.
//
//   TAPEDB_VECTOR_INDEX=<index> node scripts/e2e-vector.mjs
//
// Requires a wrangler login with access to the index's account. The Worker runs
// in workerd under `wrangler dev`, and the VECTORIZE binding is declared
// `remote: true`, so every submission and query goes through the real Workers
// binding to the real provider. That is the protocol coverage CONTRIBUTING.md
// asks for and a double cannot give: the binding's own upsert, delete and query
// paths are the ones being exercised.
//
// It is opt-in rather than part of `test:e2e` because it needs an index and an
// account. It asserts observable outcomes only: a write becomes searchable, the
// embedding never comes back in a row, an archived row is filtered out, and a
// delete leaves the index.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const index = process.env.TAPEDB_VECTOR_INDEX;
if (!index) {
  console.error("TAPEDB_VECTOR_INDEX is required: the name of an existing Vectorize index (768 dimensions, cosine).");
  console.error("Create one with `tapedb deploy` in a project that declares tapedb.vectorize.json, or:");
  console.error("  npx wrangler vectorize create <index> --dimensions 768 --metric cosine");
  console.error("  npx wrangler vectorize create-metadata-index <index> --propertyName archived --type boolean");
  process.exit(2);
}

const DIMENSIONS = 768;
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const WORKSPACE = randomUUID();
const project = mkdtempSync(join(tmpdir(), "tapedb-e2e-vector-"));
const children = [];

const ok = (line) => console.log(`ok   ${line}`);

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 120_000, ...options });
  assert.equal(result.status, 0, `${executable} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

/** A deterministic embedding: one hot dimension per character. */
function embed(word) {
  const values = new Array(DIMENSIONS).fill(0);
  for (const [position, char] of [...word].entries()) {
    values[(char.codePointAt(0) * 31 + position * 97) % DIMENSIONS] = 1;
  }
  return values;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(label, probe, { attempts = 50, delay = 3_000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value;
    await sleep(delay);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function claim() {
  const response = await fetch(`${BASE}/_tapedb/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: WORKSPACE }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `claim answered ${response.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  assert.ok(body.token, "claim answered without a token");
  return body.token;
}

async function call(token, path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: response.status, body };
}

try {
  mkdirSync(join(project, "tapedb"), { recursive: true });
  // The dev claim route signs with these; a scratch project has no `.dev.vars`
  // and `wrangler dev` alone does not provide them.
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(join(project, ".dev.vars"), `TAPEDB_CLAIM_SECRET=${secret}\nTAPEDB_KEY_SECRET=${secret}\n`, {
    mode: 0o600,
  });
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "tapedb-e2e-vector", private: true, type: "module" }, null, 2) + "\n"
  );
  writeFileSync(
    join(project, "tapedb.schema.ts"),
    `import { model, schema, t } from "@tapedb/tapedb/schema";

export default schema({
  note: model({
    title: t.string(),
    excerpt: t.string(),
    archived: t.boolean().default(false),
    embedding: t.vector({ dimensions: ${DIMENSIONS} }).optional(),
  }),
});
`
  );
  writeFileSync(
    join(project, "worker.ts"),
    `import { defineTapeDB } from "@tapedb/tapedb/worker";

import schema from "./tapedb.schema";
import { migrations } from "./tapedb/migrations.gen";

const tapedb = defineTapeDB({
  schema,
  migrations,
  // The development claim route, so this run needs no identity adapter. It is
  // only served because the dev server also sets TAPEDB_DEV_CLAIMS=true and
  // ENVIRONMENT=development; a deployed Worker refuses it.
  devClaims: true,
  vectorize: { index: "VECTORIZE", model: "note", field: "embedding", filterFields: ["archived"] },
});

export const WorkspaceRoom = tapedb.WorkspaceRoom;
export default tapedb.worker;
`
  );
  writeFileSync(
    join(project, "wrangler.jsonc"),
    JSON.stringify(
      {
        name: "tapedb-e2e-vector",
        main: "worker.ts",
        compatibility_date: "2026-11-16",
        compatibility_flags: ["nodejs_compat"],
        durable_objects: { bindings: [{ name: "WORKSPACE", class_name: "WorkspaceRoom" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["WorkspaceRoom"] }],
        r2_buckets: [
          { binding: "DATA", bucket_name: "tapedb-e2e-vector-data" },
          { binding: "FILES", bucket_name: "tapedb-e2e-vector-files" },
        ],
        vars: { ENVIRONMENT: "development" },
        // The one line that makes this a provider test rather than a double test.
        vectorize: [{ binding: "VECTORIZE", index_name: index, remote: true }],
      },
      null,
      2
    ) + "\n"
  );

  // The project's package resolves @tapedb/tapedb through the repo, so the code
  // under test is this checkout's dist.
  // wrangler comes with the scratch project because the repo does not depend on it.
  run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", root, "wrangler@^4.166.0"], { cwd: project });
  run(process.execPath, [join(root, "dist", "cli.js"), "migrate", "dev", "--name", "init"], { cwd: project });

  const dev = spawn(
    "npx",
    [
      "--no-install",
      "wrangler",
      "dev",
      "--port",
      String(PORT),
      "--var",
      "ENVIRONMENT:development",
      "--var",
      "TAPEDB_DEV_CLAIMS:true",
    ],
    // Its own process group: killing the npx wrapper alone leaves wrangler and
    // workerd behind, holding the port for the next run.
    { cwd: project, stdio: ["ignore", "pipe", "pipe"], detached: true }
  );
  children.push(dev);
  let devLog = "";
  dev.stdout.on("data", (chunk) => (devLog += String(chunk)));
  dev.stderr.on("data", (chunk) => (devLog += String(chunk)));

  await waitFor(
    "the dev server",
    async () => {
      try {
        const response = await fetch(`${BASE}/health`);
        return response.ok || null;
      } catch {
        return null;
      }
    },
    { attempts: 40, delay: 1_000 }
  );
  assert.match(devLog, /Vectorize Index\s+remote/, "the VECTORIZE binding is not remote; the test would prove nothing");
  ok("workerd runs the Worker with the vector index bound remotely");

  const token = await claim();
  const write = await call(token, `/engine/workspaces/${WORKSPACE}/transact`, {
    method: "POST",
    body: JSON.stringify({
      txId: randomUUID(),
      ops: [
        {
          op: "insert",
          namespace: "note",
          id: "e2e-open",
          values: { title: "Workerd open", excerpt: "a", archived: false, embedding: embed("planning") },
        },
        {
          op: "insert",
          namespace: "note",
          id: "e2e-archived",
          values: { title: "Workerd archived", excerpt: "b", archived: true, embedding: embed("planning") },
        },
      ],
    }),
  });
  assert.equal(write.status, 200, `write answered ${write.status}: ${JSON.stringify(write.body).slice(0, 300)}`);
  ok("two rows committed with their embeddings");

  await waitFor("the provider to accept both vectors", async () => {
    const answer = await call(token, `/engine/workspaces/${WORKSPACE}/status`);
    const vectorize = answer.body?.vectorize;
    return vectorize && vectorize.pending === 0 && vectorize.indexed >= 2 ? true : null;
  });
  ok("the durability alarm drained both intents through the binding");

  // Visibility is the provider's own schedule: 52-70 s in the pilots, and one
  // run needed longer, so this waits minutes rather than one.
  const found = await waitFor(
    "the row to become searchable",
    async () => {
      const answer = await call(token, `/engine/workspaces/${WORKSPACE}/search`, {
        method: "POST",
        body: JSON.stringify({ model: "note", vector: embed("planning"), limit: 5, select: ["id", "title"] }),
      });
      const rows = answer.body?.data?.note ?? [];
      return rows.length > 0 ? rows : null;
    },
    { attempts: 90, delay: 4_000 }
  );
  assert.deepEqual(
    found.map((row) => row.id).sort(),
    ["e2e-archived", "e2e-open"],
    `search answered ${JSON.stringify(found)}`
  );
  ok("search returned both rows nearest first");

  // Metadata indexes become queryable on their own schedule, after the vectors
  // themselves: the first pilot saw a filtered search answer empty while the
  // unfiltered one returned every row. Retry rather than assert once.
  await waitFor(
    "the metadata filter to see the vectors",
    async () => {
      const answer = await call(token, `/engine/workspaces/${WORKSPACE}/search`, {
        method: "POST",
        body: JSON.stringify({ model: "note", vector: embed("planning"), limit: 5, filter: { archived: false } }),
      });
      const ids = (answer.body?.data?.note ?? []).map((row) => row.id);
      return ids.length === 1 && ids[0] === "e2e-open" ? true : null;
    },
    { attempts: 30, delay: 3_000 }
  );
  ok("the metadata filter excluded the archived row at the provider");

  const withEmbedding = await call(token, `/engine/workspaces/${WORKSPACE}/search`, {
    method: "POST",
    body: JSON.stringify({ model: "note", vector: embed("planning"), limit: 5, select: ["embedding"] }),
  });
  for (const row of withEmbedding.body?.data?.note ?? []) {
    assert.equal(row.embedding, undefined, "a search answer carried the embedding");
  }
  ok("the embedding is never returned in a row");

  await waitFor(
    "the archived row to be filterable",
    async () => {
      const answer = await call(token, `/engine/workspaces/${WORKSPACE}/search`, {
        method: "POST",
        body: JSON.stringify({ model: "note", vector: embed("planning"), limit: 5, filter: { archived: true } }),
      });
      return (answer.body?.data?.note ?? []).length === 1 ? true : null;
    },
    { attempts: 20, delay: 3_000 }
  );

  const deletion = await call(token, `/engine/workspaces/${WORKSPACE}/transact`, {
    method: "POST",
    body: JSON.stringify({ txId: randomUUID(), ops: [{ op: "delete", namespace: "note", id: "e2e-archived" }] }),
  });
  assert.equal(deletion.status, 200, `delete answered ${deletion.status}`);

  await waitFor("the deleted row to leave search", async () => {
    const answer = await call(token, `/engine/workspaces/${WORKSPACE}/search`, {
      method: "POST",
      body: JSON.stringify({ model: "note", vector: embed("planning"), limit: 5 }),
    });
    const ids = (answer.body?.data?.note ?? []).map((row) => row.id);
    return ids.includes("e2e-archived") ? null : true;
  });
  ok("the deleted row left the answer");

  // The row leaves the answer as soon as the write commits, because every
  // candidate is re-read. The delete itself has to reach the provider, so wait
  // for the queue to empty rather than stopping at the gate.
  const settled = await waitFor("the provider to accept the delete", async () => {
    const answer = await call(token, `/engine/workspaces/${WORKSPACE}/status`);
    const vectorize = answer.body?.vectorize;
    return vectorize && vectorize.pending === 0 ? vectorize : null;
  });
  assert.equal(settled.deadLettered, 0, "an intent was dead-lettered");
  ok(`queue settled: ${JSON.stringify(settled)}`);

  console.log("\ne2e-vector: all passed");
} finally {
  for (const child of children) {
    if (child.pid === undefined) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  await new Promise((done) => setTimeout(done, 2_000));
  // The dev server is still writing its state as it dies; a removal that races
  // it throws ENOTEMPTY and would report a passing run as a failure.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(project, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 500));
    }
  }
}
