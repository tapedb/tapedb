// End-to-end: the packed package, in a fresh project, against a real Worker.
//
//   node scripts/e2e.mjs                    pack this checkout, `tapedb dev`, every scenario,
//                                           then the local drills (migration rebuild, recovery)
//   node scripts/e2e.mjs --url <worker>     the scenarios against a deployed Worker
//                                           (dev claims on; deployed with scripts/e2e/common.mjs's schema)
//   node scripts/e2e.mjs --deploy <name>    deploy a staging Worker <name> with your wrangler login
//                                           (buckets <name>-data / <name>-files, ENVIRONMENT=staging,
//                                           dev claims on), then run the scenarios and the load
//                                           test against it; --domain <host> serves it on a
//                                           custom domain (e.g. staging.tapedb.dev) instead of workers.dev
//   node scripts/e2e.mjs --deploy <name> --drill   also run the drills against it: a migration
//                                           that rebuilds a referenced table, then a real wipe
//                                           (the Durable Object class deleted and recreated)
//                                           and recovery from R2 (needs CLOUDFLARE_API_TOKEN)
//   node scripts/e2e.mjs --jurisdiction eu  init the project (and staging buckets) in a jurisdiction
//   node scripts/e2e.mjs --only select,bulk only these scenarios; --no-drills skips the drills
//
// Scenarios live in scripts/e2e/*.mjs. Each is a plain Node script against `tapedb` as a
// consumer installs it; it throws (exits non-zero) on failure.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Before useDevToken adds the run's token to claim requests.
const plainFetch = globalThis.fetch;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suite = join(root, "scripts", "e2e");
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const deployName = flag("deploy");
if (deployName !== undefined && !/^[a-z0-9-]{1,54}$/.test(deployName)) {
  throw new Error(`--deploy takes a Worker name (a-z 0-9 -), not ${JSON.stringify(deployName)}`);
}
const domain = flag("domain");
if (domain !== undefined && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
  throw new Error(`--domain takes a host name, not ${JSON.stringify(domain)}`);
}
const jurisdiction = flag("jurisdiction");
if (jurisdiction !== undefined && !["eu", "fedramp"].includes(jurisdiction)) {
  throw new Error(`--jurisdiction takes eu or fedramp, not ${JSON.stringify(jurisdiction)}`);
}
let remote = flag("url");
const only = flag("only")?.split(",");
const runDrills = deployName
  ? args.includes("--drill")
  : !remote && !args.includes("--no-drills") && only === undefined;

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", timeout: 600_000, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result.stdout;
}

function freePort() {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// ---- Project ----------------------------------------------------------------

const project = mkdtempSync(join(tmpdir(), "tapedb-e2e-"));
console.log(`e2e project: ${project}`);
run("npm", ["run", "build"], { cwd: root });
const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", project], { cwd: root }))[0].filename;
writeFileSync(join(project, "package.json"), JSON.stringify({ name: "tapedb-e2e", private: true, type: "module" }));
run("npm", ["install", join(project, packed), "wrangler@4", "--no-audit", "--no-fund"], { cwd: project });
run(process.execPath, [join(project, "node_modules/tapedb/dist/cli.js"), "init", ...(jurisdiction ? ["--jurisdiction", jurisdiction] : [])], { cwd: project });

const schemaSource = `import { model, schema, t } from "tapedb/schema";

export default schema({
  board: model({
    name: t.string(),
    columns: t.hasMany("column"),
  }),
  column: model({
    name: t.string(),
    position: t.number().default(0).index(),
    board: t.belongsTo("board", { onDelete: "cascade" }),
    tasks: t.hasMany("task"),
  }),
  task: model({
    title: t.string(),
    done: t.boolean().default(false),
    column: t.belongsTo("column").optional(),
  }),
});
`;
writeFileSync(join(project, "tapedb.schema.ts"), schemaSource);
run(process.execPath, [join(project, "node_modules/tapedb/dist/cli.js"), "migrate", "check"], { cwd: project });
for (const file of readdirSync(suite)) copyFileSync(join(suite, file), join(project, file));

// ---- Staging deploy -----------------------------------------------------------

/** Runs wrangler from the project with the caller's own login; streams its output. */
function wrangler(commandArgs, input) {
  // Workers Builds pins deploys to the Worker the build is connected to
  // (and to its tag). A run deploying a different name, such as the EU
  // staging Worker, must not be redirected onto it.
  const pinned = process.env.WRANGLER_CI_OVERRIDE_NAME;
  const env = { ...process.env };
  if (deployName !== undefined && pinned !== undefined && pinned !== deployName) {
    delete env.WRANGLER_CI_OVERRIDE_NAME;
    delete env.WRANGLER_CI_MATCH_TAG;
  }
  const result = spawnSync(join(project, "node_modules/.bin/wrangler"), commandArgs, {
    cwd: project,
    encoding: "utf8",
    env,
    input,
    timeout: 600_000,
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** The Cloudflare API, with the token Workers Builds (or the caller) provides. */
async function cloudflareApi(path, init = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return null;
  let account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const call = async (target) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4${target}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.success === false) throw new Error(`${target}: HTTP ${response.status} ${JSON.stringify(body?.errors ?? body)}`);
    return body.result;
  };
  if (!account) account = (await call("/accounts"))[0]?.id;
  return call(path.replace(":account", account));
}

/**
 * The Durable Object migration the Worker is at, so the deploy declares a
 * history that ends there (a drill deletes and recreates the class under new
 * tags). Without API access, the tag `init` writes.
 */
async function currentMigrationTag(name) {
  const scripts = await cloudflareApi("/accounts/:account/workers/scripts").catch(() => null);
  return scripts?.find((script) => script.id === name)?.migration_tag ?? "v1";
}

/**
 * The history to declare when the Worker is at `tag`, ending with the class
 * present. Wrangler checks a history is consistent from its first step (a
 * delete needs a create before it), and applies the steps after `tag`.
 */
function migrationsFrom(tag) {
  const created = { tag: "v1", new_sqlite_classes: ["WorkspaceRoom"] };
  const drill = /^(drill-\d+)-(delete|recreate)$/.exec(tag);
  if (!drill) return [{ ...created, tag }];
  // The last drill's pair; a drill that stopped after deleting recreates the class.
  return [
    created,
    { tag: `${drill[1]}-delete`, deleted_classes: ["WorkspaceRoom"] },
    { tag: `${drill[1]}-recreate`, new_sqlite_classes: ["WorkspaceRoom"] },
  ];
}

/** Wrangler reads the tag back to pick which steps to apply; wait until it reads this one. */
async function waitForMigrationTag(name, tag) {
  for (let waited = 0; (await currentMigrationTag(name)) !== tag; waited += 2000) {
    if (waited > 120_000) throw new Error(`${name} did not report migration tag ${tag}`);
    await sleep(2000);
  }
}

/**
 * A signed request through the Worker, until the claim secret just set
 * answers everywhere (a secret change is a new version, which takes a
 * moment to replace the old one).
 */
async function waitForClaimSecret(url) {
  const probe = randomUUID();
  let streak = 0;
  for (let waited = 0; streak < 5; waited += 1000) {
    if (waited > 120_000) throw new Error(`${url} kept rejecting claims signed with the new secret`);
    const claim = await fetch(`${url}/_tapedb/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: probe }) })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
    const status = claim?.token
      ? await fetch(`${url}/engine/workspaces/${probe}/status`, { headers: { authorization: `Bearer ${claim.token}` } })
          .then((response) => response.status)
          .catch(() => 0)
      : 0;
    streak = status === 200 ? streak + 1 : 0;
    await sleep(1000);
  }
  // And the route refuses anyone without the token, on the live Worker.
  if (process.env.TAPEDB_DEV_CLAIMS_TOKEN) {
    for (const headers of [{}, { "x-tapedb-dev-token": "guess" }]) {
      const refused = await plainFetch(`${url}/_tapedb/claim`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ workspaceId: probe }) });
      const body = await refused.json().catch(() => null);
      if (refused.status !== 401 || body?.token) throw new Error(`${url}/_tapedb/claim answered ${refused.status} without the dev token`);
    }
    console.log("  dev claim route refuses requests without this run's token");
  }
}

let stagingConfig = null;
let stagingUrl = null;

/** Deploys the project as it stands with `config`, and waits for it to answer. */
async function deployConfig(config, file = "wrangler.jsonc") {
  writeFileSync(join(project, file), JSON.stringify(config, null, 2));
  const deployed = wrangler(["deploy", "--config", file]);
  if (!deployed.ok) throw new Error(`wrangler deploy (${file}) failed:\n${deployed.output}`);
  return deployed.output;
}

async function waitForStatus(url, ms) {
  for (let waited = 0; ; waited += 2000) {
    const response = await fetch(`${url}/status`).catch(() => null);
    if (response?.ok) return;
    if (waited > ms) throw new Error(`${url}/status did not answer after deploy`);
    await sleep(2000);
  }
}

async function deployStaging(name) {
  const config = JSON.parse(readFileSync(join(project, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  config.migrations = migrationsFrom(await currentMigrationTag(name));
  config.name = name;
  // TAPEDB_DEV_CLAIMS is not a var: it is set as a secret after the token
  // that gates it, so the deployed Worker never has an open claim route.
  config.vars = { ENVIRONMENT: "staging", ...(jurisdiction ? { TAPEDB_JURISDICTION: jurisdiction } : {}) };
  if (domain) {
    // A Workers custom domain: Cloudflare creates the DNS record and certificate.
    config.routes = [{ pattern: domain, custom_domain: true }];
    config.workers_dev = false;
  }
  const where = jurisdiction ? { jurisdiction } : {};
  config.r2_buckets = [
    { binding: "DATA", bucket_name: `${name}-data`, ...where },
    { binding: "FILES", bucket_name: `${name}-files`, ...where },
  ];
  for (const bucket of [`${name}-data`, `${name}-files`]) {
    const created = wrangler(["r2", "bucket", "create", bucket, ...(jurisdiction ? ["--jurisdiction", jurisdiction] : [])]);
    if (!created.ok && !/already exists|already own/i.test(created.output)) {
      throw new Error(`creating bucket ${bucket} failed:\n${created.output}`);
    }
    console.log(`  bucket ${bucket}: ${created.ok ? "created" : "exists"}`);
  }

  const output = await deployConfig(config);
  const url = domain ? `https://${domain}` : /https:\/\/[\w.-]+\.workers\.dev/.exec(output)?.[0];
  if (!url) throw new Error(`deployed, but found no workers.dev URL in:\n${output}`);

  // The claim secret init generated for this project, shared with the load test.
  const secret = /^TAPEDB_CLAIM_SECRET=(.*)$/m.exec(readFileSync(join(project, ".dev.vars"), "utf8"))?.[1];
  // A deployed test Worker is reachable by anyone, so its dev claim route
  // mints only for this run's token: set it first, then turn the route on.
  const devToken = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
  for (const [secretName, value] of [["TAPEDB_CLAIM_SECRET", secret], ["TAPEDB_DEV_CLAIMS_TOKEN", devToken], ["TAPEDB_DEV_CLAIMS", "true"]]) {
    const put = wrangler(["secret", "put", secretName], `${value}\n`);
    if (!put.ok) throw new Error(`setting ${secretName} failed:\n${put.output}`);
  }
  process.env.TAPEDB_CLAIM_SECRET = secret;
  await useDevToken(devToken);

  // A new version takes a few seconds to answer everywhere; a new custom
  // domain also waits on its certificate.
  await waitForStatus(url, domain ? 300_000 : 60_000);
  await waitForClaimSecret(url);
  console.log(`  deployed ${name} at ${url}`);
  stagingConfig = config;
  stagingUrl = url;
  return url;
}

/**
 * Sends the run's dev token with every request to the claim route, from this
 * process and (through a preload) from every scenario and CLI it starts.
 */
async function useDevToken(token) {
  const preload = join(project, "dev-token-preload.mjs");
  writeFileSync(
    preload,
    `const token = process.env.TAPEDB_DEV_CLAIMS_TOKEN;
if (token) {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (!url.includes("/_tapedb/claim")) return original(input, init);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("x-tapedb-dev-token", token);
    return original(input, { ...init, headers });
  };
}
`
  );
  process.env.TAPEDB_DEV_CLAIMS_TOKEN = token;
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`.trim();
  await import(pathToFileURL(preload).href);
}

/** Redeploys staging as the project now stands (after a migration). */
async function redeployStaging() {
  await deployConfig(stagingConfig);
  await waitForStatus(stagingUrl, 120_000);
}

/**
 * The real disaster: every Durable Object's storage gone, R2 intact. Deletes
 * the class with a migration (deployed with a Worker that does not export
 * it), then recreates it; the workspace must recover from R2.
 */
async function wipeStagingObjects() {
  if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error("the remote drill needs CLOUDFLARE_API_TOKEN to track migration tags");
  const run = Date.now();
  const deleted = { tag: `drill-${run}-delete`, deleted_classes: ["WorkspaceRoom"] };
  writeFileSync(join(project, "wipe-worker.js"), 'export default { fetch: () => new Response("wiping", { status: 503 }) };\n');
  const wipe = { ...stagingConfig, main: "wipe-worker.js", migrations: [...stagingConfig.migrations, deleted] };
  delete wipe.durable_objects;
  await deployConfig(wipe, "wrangler.wipe.jsonc");
  await waitForMigrationTag(stagingConfig.name, deleted.tag);
  console.log("  drill: Durable Object class deleted (every object's storage)");
  stagingConfig = {
    ...stagingConfig,
    migrations: [...wipe.migrations, { tag: `drill-${run}-recreate`, new_sqlite_classes: ["WorkspaceRoom"] }],
  };
  await redeployStaging();
  console.log("  drill: class recreated, empty");
}

// ---- Worker -----------------------------------------------------------------

let dev = null;
let base = remote?.replace(/\/+$/, "");

async function startDev() {
  const port = await freePort();
  const log = [];
  dev = spawn(process.execPath, [join(project, "node_modules/tapedb/dist/cli.js"), "dev", "--port", String(port)], {
    cwd: project,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // TAPEDB_E2E_DEV_LOG=<file> keeps the dev server's output, for debugging a run.
  const keep = process.env.TAPEDB_E2E_DEV_LOG;
  const record = (chunk) => {
    log.push(String(chunk));
    if (keep) appendFileSync(keep, String(chunk));
  };
  dev.stdout.on("data", record);
  dev.stderr.on("data", record);
  for (let waited = 0; !log.join("").includes("Ready on"); waited += 250) {
    if (waited > 90_000 || dev.exitCode !== null) throw new Error(`tapedb dev did not start:\n${log.join("")}`);
    await sleep(250);
  }
  base = `http://127.0.0.1:${port}`;
}

async function stopDev() {
  if (!dev) return;
  try {
    process.kill(-dev.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  for (let waited = 0; dev.exitCode === null && waited < 10_000; waited += 100) await sleep(100);
  try {
    process.kill(-dev.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  dev = null;
}

function scenario(file) {
  return new Promise((resolveScenario) => {
    const started = Date.now();
    const child = spawn(process.execPath, [file], {
      cwd: project,
      env: { ...process.env, TAPEDB_URL: base },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveScenario({ ok: code === 0, ms: Date.now() - started, output });
    });
  });
}

// ---- Drills (local only) -------------------------------------------------------

// Fresh per run: a deployed staging Worker keeps earlier runs' workspaces.
const WORKSPACE = randomUUID();

async function client() {
  const { createClient } = await import(join(project, "node_modules/tapedb/dist/index.js"));
  const { s } = await import(join(project, "common.mjs"));
  return createClient({ schema: s, url: base, workspace: WORKSPACE });
}

async function exported(db) {
  const records = [];
  for await (const record of db.$export()) records.push(record);
  const end = records.at(-1);
  assert.equal(end.type, "end", "export ended without an end line");
  return {
    end,
    rows: records.filter((record) => record.type === "row").map((record) => JSON.stringify(record)).sort(),
    files: records.filter((record) => record.type === "file").map((record) => record.file.path),
  };
}

async function transact(body) {
  const { token } = await (
    await fetch(`${base}/_tapedb/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: WORKSPACE }) })
  ).json();
  const response = await fetch(`${base}/engine/workspaces/${WORKSPACE}/transact`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return response.json();
}

/**
 * Seeds past a snapshot, lets the durability alarm flush and snapshot, rebuilds a
 * referenced table through a migration, then wipes the Durable Object's storage and
 * checks it comes back from R2 identical: every row, the file index, receipts, the sequence.
 */
async function drills() {
  const db = await client();
  const board = await db.board.create({ data: { id: "drill-board", name: "Drill" } });
  await db.column.create({ data: { id: "drill-col", name: "Todo", board: { connect: board.id } } });
  // More than one snapshot's worth of sequences, one transaction each.
  for (let start = 0; start < 1100; start += 50) {
    await Promise.all(Array.from({ length: 50 }, (_, n) => db.task.create({ data: { title: `t${start + n}`, column: { connect: "drill-col" } } })));
  }
  // Enough rows that one bulk write over them is a log entry in parts.
  for (let start = 0; start < 30_000; start += 1000) {
    await db.$transaction(Array.from({ length: 1000 }, (_, n) => db.task.create({ data: { title: `bulk${start + n}` } })));
  }
  const receipt = await transact({ txId: "drill-tx", clientTxId: "drill-receipt", ops: [{ op: "insert", namespace: "task", id: "drill-once", values: { title: "once", done: false } }] });
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  await db.$files.upload(new Blob(["drill"], { type: "text/plain" }), { path: "drill/file.txt" });
  // A second workspace, durable in R2 by the same wait, erased before the wipe.
  const { createClient } = await import(join(project, "node_modules/tapedb/dist/index.js"));
  const { s } = await import(join(project, "common.mjs"));
  const erasedId = randomUUID();
  const doomed = createClient({ schema: s, url: base, workspace: erasedId });
  for (let n = 0; n < 20; n += 1) await doomed.task.create({ data: { title: `erase-me-${n}` } });
  await doomed.$files.upload(new Blob(["erase me"], { type: "text/plain" }), { path: "erase/me.txt" });
  doomed.$close();
  console.log("  drill: seeded 31,103 rows (and a workspace to erase); waiting for the durability alarm to flush and snapshot");
  await sleep(40_000);
  // Writes after the snapshot, replayed from log segments on recovery.
  for (let n = 0; n < 5; n += 1) await db.task.create({ data: { title: `late${n}` } });
  // One transaction over every task: its log entry is larger than a row, so it
  // is stored in parts and flushed as its own object, then replayed part by part.
  assert.deepEqual(await db.task.updateMany({ where: {}, data: { done: true } }), { count: 31_106 });
  await sleep(40_000);
  db.$close();

  // Rebuild of a referenced table (board <- column, cascade) with data in it.
  if (deployName) {
    writeFileSync(join(project, "tapedb.schema.ts"), schemaSource.replace("name: t.string(),\n    columns", 'name: t.string().default("untitled"),\n    columns'));
    run(process.execPath, [join(project, "node_modules/tapedb/dist/cli.js"), "migrate", "dev", "--name", "board_default"], { cwd: project });
    await redeployStaging();
  } else {
    await stopDev();
    writeFileSync(join(project, "tapedb.schema.ts"), schemaSource.replace("name: t.string(),\n    columns", 'name: t.string().default("untitled"),\n    columns'));
    run(process.execPath, [join(project, "node_modules/tapedb/dist/cli.js"), "migrate", "dev", "--name", "board_default"], { cwd: project });
    await startDev();
  }
  const migrated = await client();
  assert.deepEqual(await migrated.column.findMany({ select: { id: true, boardId: true } }), [{ id: "drill-col", boardId: "drill-board" }]);
  assert.equal(await migrated.task.count({ where: { columnId: "drill-col" } }), 1100);
  const before = await exported(migrated);
  migrated.$close();
  console.log(`  drill: referenced table rebuilt, children intact; export at seq ${before.end.seq}`);

  // Erase the second workspace. The wipe below removes its tombstone with
  // everything else, so after it the workspace must come back from R2 empty.
  run(process.execPath, [join(project, "node_modules/tapedb/dist/cli.js"), "erase", "--workspace", erasedId, "--confirm", erasedId, "--url", base], { cwd: project });

  // Wipe every Durable Object's storage; R2 stays.
  if (deployName) {
    await wipeStagingObjects();
  } else {
    await stopDev();
    const objects = join(project, ".wrangler/state/v3/do");
    assert.ok(existsSync(objects), "no local Durable Object state to wipe");
    for (const dir of readdirSync(objects)) rmSync(join(objects, dir), { recursive: true, force: true });
    await startDev();
  }

  const restored = await client();
  const after = await exported(restored);
  assert.equal(after.end.seq, before.end.seq, `sequence after recovery: ${after.end.seq}, before the wipe: ${before.end.seq}`);
  assert.deepEqual(after.files, before.files, "file index after recovery");
  assert.equal(after.rows.length, before.rows.length, `row count after recovery: ${after.rows.length}, before the wipe: ${before.rows.length}`);
  assert.deepEqual(after.rows, before.rows, "rows after recovery");
  const retry = await transact({ txId: "drill-tx-2", clientTxId: "drill-receipt", ops: [{ op: "insert", namespace: "task", id: "drill-once", values: { title: "once", done: false } }] });
  assert.deepEqual([retry.result?.seq, retry.result?.applied], [receipt.result.seq, 0], "receipt after recovery");
  const next = await restored.task.create({ data: { title: "after" } });
  assert.ok(next.id);
  restored.$close();

  console.log(`  drill: recovered ${after.rows.length} rows, ${after.files.length} file, seq ${after.end.seq}, receipt kept`);
  // Nothing of the erased workspace was left in R2 to recover from.
  const reborn = createClient({ schema: s, url: base, workspace: erasedId });
  const leftovers = await exported(reborn);
  reborn.$close();
  assert.deepEqual([leftovers.rows.length, leftovers.files.length, leftovers.end.seq], [0, 0, 0], "erased workspace after recovery");
  console.log("  drill: the erased workspace recovered with nothing: R2 held none of it");
}

// ---- Run --------------------------------------------------------------------

const scenarios = readdirSync(suite)
  .filter((file) => file.endsWith(".mjs") && file !== "common.mjs")
  .map((file) => file.replace(/\.mjs$/, ""))
  // The load run measures rather than checks, and takes a while: only on request.
  .filter((name) => (only === undefined ? name !== "load" || deployName !== undefined : only.includes(name)))
  .sort();

let failed = 0;
try {
  if (deployName) {
    base = remote = await deployStaging(deployName);
  } else if (!remote) {
    await startDev();
  } else if (process.env.TAPEDB_DEV_CLAIMS_TOKEN) {
    // A Worker deployed with a gated dev claim route.
    await useDevToken(process.env.TAPEDB_DEV_CLAIMS_TOKEN);
  }
  console.log(`against ${base}`);
  for (const name of scenarios) {
    const result = await scenario(`${name}.mjs`);
    console.log(`${result.ok ? "ok  " : "FAIL"} ${name} (${result.ms} ms)`);
    if (result.ok && name === "load") console.log(result.output.split("\n").map((line) => `     ${line}`).join("\n"));
    if (!result.ok) {
      failed += 1;
      console.log(result.output.split("\n").map((line) => `     ${line}`).join("\n"));
    }
  }
  if (runDrills) {
    try {
      await drills();
      console.log("ok   drills");
    } catch (error) {
      failed += 1;
      console.log(`FAIL drills\n     ${error instanceof Error ? error.stack : String(error)}`);
    }
  }
} finally {
  await stopDev();
  if (!args.includes("--keep")) rmSync(project, { recursive: true, force: true });
}
console.log(failed === 0 ? "e2e: all passed" : `e2e: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
