import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import { model, schema, t } from "../src/schema";
import { signRoleClaim } from "../src/mint";
import { FakeR2Bucket } from "./fixtures/test-support";
import { FakeRoomContext } from "./fixtures/room-harness";
import { migratePersonal } from "../src/engine/personal-migrate";
import { defaultDeploymentConfig } from "../src/engine/config";
import { durableObjectSqlExecutor } from "../src/engine/tx-sql";
import { PersonalRuntime } from "../src/engine/personal";
import { flushPending, snapshotWorkspace } from "../src/engine/durability";
import { durableObjectRecoverySqlExecutor } from "../src/engine/durability/recovery-support";
import { NAMESPACES } from "../src/engine/registry";
class MockDurableObject { constructor(protected ctx: unknown, protected env: unknown) {} }
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");
const ID = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";
const SECRET = "personal-encryption-test-secret-32-characters";
test("personal writes store ciphertext and a lost subject key makes historical ciphertext unreadable", async () => {
  const app = defineTapeDB({ schema: schema({ person: model({ name: t.string().personal({ subject: "self" }), data: t.json().personal({ subject: "self" }).optional() }) }) });
  const data = new FakeR2Bucket();
  const env: any = { DATA: data, FILES: new FakeR2Bucket(), TAPEDB_CLAIM_SECRET: SECRET, TAPEDB_KEY_SECRET: SECRET };
  const db = new Database(":memory:"), context = new FakeRoomContext(db, ID);
  let room = new app.WorkspaceRoom(context as never, env); await context.ready;
  env.WORKSPACE = { idFromName: (id: string) => id, get: () => ({ fetch: (request: Request) => room.fetch(request) }) };
  const token = (await signRoleClaim(SECRET, { sub: "owner", workspaceId: ID, role: 6 })).token;
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => app.worker.fetch(new Request(`https://worker.test/engine/workspaces/${ID}/${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, {} as ExecutionContext);
  const result = await call("transact", { txId: "write", clientTxId: "receipt", ops: [{ op: "insert", namespace: "person", id: "alice", values: { name: "Private Alice", data: { secret: "Private payload" } } }] });
  expect(await result.clone().text()).toContain('"ok":true');
  const stored = db.query(`SELECT * FROM "person"`).get() as any;
  expect(JSON.stringify(stored)).not.toContain("Private");
  expect(JSON.stringify(db.query(`SELECT * FROM "_tx_log"`).all())).not.toContain("Private");
  const query = await call("query", { query: { person: {} } });
  expect(await query.json()).toMatchObject({ ok: true, data: { person: [{ name: "Private Alice", data: { secret: "Private payload" } }] } });
  const durability = durableObjectRecoverySqlExecutor(context.storage as never);
  expect((await flushPending(data as never, durability, ID, Date.now())).flushed).toBe(true);
  const reset = async () => {
    const fresh = new FakeRoomContext(new Database(":memory:"), ID);
    room = new app.WorkspaceRoom(fresh as never, env); await fresh.ready;
  };
  await reset();
  expect(await (await call("query", { query: { person: {} } })).json()).toMatchObject({ data: { person: [{ name: "Private Alice" }] } });
  await snapshotWorkspace(data as never, durability, ID, Date.now());
  const exported = await (await call("export")).text();
  expect(exported).toContain("Private Alice");
  const filtered = await call("query", { query: { person: { $: { where: { name: "Private Alice" } } } } });
  expect(filtered.status).toBe(400);
  expect((await call("subjects/alice", undefined, "DELETE")).status).toBe(200);
  expect(await (await call("query", { query: { person: {} } })).json()).toMatchObject({ data: { person: [{ name: null, data: null, $erased: ["name", "data"] }] } });
  await reset();
  expect(await (await call("query", { query: { person: {} } })).json()).toMatchObject({ data: { person: [{ name: null, $erased: ["name", "data"] }] } });
  const runtime = new PersonalRuntime(env, ID);
  await runtime.erase("alice");
  const restored = new PersonalRuntime(env, ID);
  const decoded = await restored.read(() => restored.decodeRows("person", [stored]));
  expect(decoded[0].name).toBeNull(); expect(decoded[0].data).toBeNull();
  expect(JSON.parse(String(decoded[0].__tapedb_erased))).toEqual(["name", "data"]);
  await restored.seal(NAMESPACES.person, "alice", "name", "New Alice", "alice");
  restored.clearPlaintext();
  expect((await restored.read(() => restored.decodeRows("person", [stored])))[0].name).toBeNull();
  const erasedExport = await (await call("export")).text();
  const targetEnv = { ...env, DATA: new FakeR2Bucket() };
  const targetContext = new FakeRoomContext(new Database(":memory:"), ID);
  const target = new app.WorkspaceRoom(targetContext as never, targetEnv); await targetContext.ready;
  targetEnv.WORKSPACE = { idFromName: (id: string) => id, get: () => ({ fetch: (request: Request) => target.fetch(request) }) };
  const imported = await app.worker.fetch(new Request(`https://worker.test/engine/workspaces/${ID}/import`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/x-ndjson" }, body: erasedExport }), targetEnv, {} as ExecutionContext);
  expect(await imported.json()).toMatchObject({ ok: true, imported: { rows: 1 } });
  const targetRuntime = new PersonalRuntime(targetEnv, ID);
  const targetRows = await targetRuntime.read(() => targetRuntime.decodeRows("person", targetContext.db.query(`SELECT * FROM person`).all() as any));
  expect(targetRows[0].name).toBeNull();
  expect(JSON.parse(String(targetRows[0].__tapedb_erased))).toEqual(["name", "data"]);

});

test("existing plaintext is encrypted in resumable batches without changing row timestamps", async () => {
  const app = defineTapeDB({ schema: schema({ person: model({ name: t.string().personal({ subject: "self" }) }) }) });
  const data = new FakeR2Bucket(), env: any = { DATA: data, FILES: new FakeR2Bucket(), TAPEDB_KEY_SECRET: SECRET };
  const db = new Database(":memory:"), context = new FakeRoomContext(db, ID);
  new app.WorkspaceRoom(context as never, env); await context.ready;
  db.exec(`DELETE FROM "_engine_meta" WHERE "key" = 'personal_migration'`);
  for (let n = 0; n < 205; n++) db.query(`INSERT INTO person (id, name, created_at, updated_at, updated_seq) VALUES (?, ?, 10, 20, 0)`).run(String(n).padStart(4, "0"), `Private ${n}`);
  const sql = durableObjectSqlExecutor(context.storage as never), personal = new PersonalRuntime(env, ID);
  expect(await migratePersonal(sql, personal, context.storage.transaction, 0, defaultDeploymentConfig())).toBe(false);
  let batches = 0;
  const transaction = async <T>(fn: () => Promise<T>) => {
    if (++batches === 2) throw new Error("restart");
    return context.storage.transaction(fn);
  };
  await expect(migratePersonal(sql, personal, transaction, Infinity, defaultDeploymentConfig())).rejects.toThrow("restart");
  expect(db.query(`SELECT COUNT(*) AS n FROM person WHERE name LIKE 'tapedb:personal:%'`).get()).toEqual({ n: 100 });
  expect(await migratePersonal(sql, new PersonalRuntime(env, ID), context.storage.transaction, Infinity, defaultDeploymentConfig())).toBe(true);
  expect(db.query(`SELECT COUNT(*) AS n FROM person WHERE name LIKE 'tapedb:personal:%' AND created_at = 10 AND updated_at = 20`).get()).toEqual({ n: 205 });
  expect(JSON.stringify(db.query(`SELECT * FROM _tx_log`).all())).not.toContain("Private");
  const fresh = new PersonalRuntime(env, ID);
  expect((await fresh.read(() => fresh.decodeRows("person", [db.query(`SELECT * FROM person WHERE id = '0204'`).get() as any])))[0].name).toBe("Private 204");
});

test("changing a subject rekeys values and ciphertext cannot move between rows", async () => {
  const app = defineTapeDB({ schema: schema({ note: model({ userId: t.string(), body: t.string().personal({ subject: "userId" }) }) }) });
  const env: any = { DATA: new FakeR2Bucket(), TAPEDB_KEY_SECRET: SECRET };
  const db = new Database(":memory:"), context = new FakeRoomContext(db, ID);
  new app.WorkspaceRoom(context as never, env); await context.ready;
  const runtime = new PersonalRuntime(env, ID), sql = durableObjectSqlExecutor(context.storage as never);
  const cipher = await runtime.seal(NAMESPACES.note, "n", "body", "secret", "alice");
  db.query(`INSERT INTO note (id, user_id, body, created_at, updated_at, updated_seq) VALUES ('n', 'alice', ?, 1, 1, 0)`).run(cipher as string);
  const changed = await runtime.prepare(sql, NAMESPACES.note, "n", { user_id: "bob" }, false);
  expect(changed.body).not.toBe(cipher);
  const transferred = { id: "n", user_id: "bob", body: changed.body };
  await runtime.erase("alice");
  expect((await runtime.read(() => runtime.decodeRows("note", [transferred])))[0].body).toBe("secret");
  await expect(runtime.read(() => runtime.decodeRows("note", [{ ...transferred, id: "other" }]))).rejects.toThrow();
  await runtime.erase("bob");
  expect((await runtime.read(() => runtime.decodeRows("note", [transferred])))[0].body).toBeNull();
});

test("personal fields cannot be grouped or aggregated: the result would carry ciphertext", async () => {
  defineTapeDB({ schema: schema({ person: model({ name: t.string().personal({ subject: "self" }), age: t.number() }) }) });
  const { compileAggregate } = await import("../src/engine/query-aggregate");
  for (const shape of [{ groupBy: ["name"], count: true }, { min: ["name"] }, { max: ["name"] }, { count: true, groupBy: ["age"], max: ["name"] }]) {
    expect(() => compileAggregate(NAMESPACES.person, shape as never)).toThrow(/Personal field "name"/);
  }
  expect(() => compileAggregate(NAMESPACES.person, { groupBy: ["age"], count: true } as never)).not.toThrow();
});

test("the plaintext cache is bounded, and a read larger than it still completes", async () => {
  defineTapeDB({ schema: schema({ person: model({ name: t.string().personal({ subject: "self" }) }) }) });
  const { PLAINTEXT_CACHE_UNITS } = await import("../src/engine/personal");
  const env: any = { DATA: new FakeR2Bucket(), TAPEDB_KEY_SECRET: SECRET };
  const runtime = new PersonalRuntime(env, ID);
  const value = (n: number) => `${n}:`.padEnd(40_000, "x");
  const rows = [];
  for (let n = 0; n < 300; n += 1) rows.push({ id: `p${n}`, name: await runtime.seal(NAMESPACES.person, `p${n}`, "name", value(n), "subject") });
  // 300 values of 40,000 characters: 12 M units sealed, 8 M kept.
  expect(runtime.cacheSize().units).toBeLessThanOrEqual(PLAINTEXT_CACHE_UNITS);
  expect(runtime.cacheSize().entries).toBeLessThan(300);

  runtime.clearPlaintext();
  const decoded = await runtime.read(() => runtime.decodeRows("person", rows));
  expect(decoded.map((row) => row.name)).toEqual(rows.map((_, n) => value(n)));
  expect(runtime.cacheSize().units).toBeLessThanOrEqual(PLAINTEXT_CACHE_UNITS);
}, 60_000);

test("receipt hashes of personal transactions are keyed, not a plain hash of the plaintext", async () => {
  const app = defineTapeDB({ schema: schema({ person: model({ phone: t.string().personal({ subject: "self" }) }) }) });
  const { opsHash } = await import("../src/engine/tx-hash");
  const env: any = { DATA: new FakeR2Bucket(), FILES: new FakeR2Bucket(), TAPEDB_CLAIM_SECRET: SECRET, TAPEDB_KEY_SECRET: SECRET };
  const db = new Database(":memory:"), context = new FakeRoomContext(db, ID);
  const room = new app.WorkspaceRoom(context as never, env); await context.ready;
  env.WORKSPACE = { idFromName: (id: string) => id, get: () => ({ fetch: (request: Request) => room.fetch(request) }) };
  const token = (await signRoleClaim(SECRET, { sub: "owner", workspaceId: ID, role: 6 })).token;
  const ops = [{ op: "insert", namespace: "person", id: "alice", values: { phone: "+31612345678" } }];
  const send = () => app.worker.fetch(new Request(`https://worker.test/engine/workspaces/${ID}/transact`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ txId: "t", clientTxId: "receipt", ops }) }), env, {} as ExecutionContext);
  expect((await send()).status).toBe(200);

  const { ops_hash } = db.query(`SELECT ops_hash FROM "_tx_receipts" WHERE id = 'receipt'`).get() as { ops_hash: string };
  const { ops_hash: logged } = db.query(`SELECT ops_hash FROM "_tx_log" ORDER BY seq DESC LIMIT 1`).get() as { ops_hash: string };
  // Anyone with the log could otherwise test guesses: opsHash(ops with "+316…").
  expect(ops_hash).not.toBe(opsHash(ops as never));
  expect(logged).toBe(ops_hash);
  // A retry still deduplicates.
  const retry = await (await send()).json() as { ok: boolean; data?: { applied?: number } };
  expect(retry.ok).toBe(true);
  expect(Number((db.query(`SELECT COUNT(*) AS n FROM "person"`).get() as { n: number }).n)).toBe(1);
});
