import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { model, schema, t } from "../src/schema";
import { signRoleClaim } from "../src/mint";
import { FakeR2Bucket } from "./fixtures/test-support";
import { FakeRoomContext } from "./fixtures/room-harness";
class MockDurableObject { constructor(protected ctx: unknown, protected env: unknown) {} }
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");
const { copyObject } = await import("../src/engine/workspace-move");
const { setLogPartBytesForTests } = await import("../src/engine/tx-log");
const { flushPending } = await import("../src/engine/durability/flusher");
const { durableObjectRecoverySqlExecutor } = await import("../src/engine/durability/recovery-support");
const ID = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";
const SECRET = "workspace-move-secret-test-test";
const models = schema({
  parent: model({ name: t.string(), children: t.hasMany("child") }),
  child: model({ name: t.string(), parent: t.belongsTo("parent") }),
});
async function deployment() {
  const app = defineTapeDB({ schema: models });
  const sourceData = new FakeR2Bucket(), targetData = new FakeR2Bucket(), sourceFiles = new FakeR2Bucket(), targetFiles = new FakeR2Bucket();
  const source: Record<string, any> = { DATA: sourceData, FILES: sourceFiles, TAPEDB_CLAIM_SECRET: SECRET };
  const target: Record<string, any> = { DATA: targetData, FILES: targetFiles, DATA_FROM: sourceData, FILES_FROM: sourceFiles, TAPEDB_CLAIM_SECRET: SECRET, TAPEDB_MOVE_FROM: "none" };
  const rooms = (env: Record<string, any>) => {
    const all = new Map<string, { room: InstanceType<typeof app.WorkspaceRoom>; context: FakeRoomContext }>();
    return { all, idFromName: (id: string) => id, get: (id: string) => ({ fetch: async (input: Request | string, init?: RequestInit) => {
      let entry = all.get(id);
      if (!entry) {
        const context = new FakeRoomContext(new Database(":memory:"), id);
        entry = { context, room: new app.WorkspaceRoom(context as never, env as never) }; all.set(id, entry);
      }
      await entry.context.ready;
      return entry.room.fetch(typeof input === "string" ? new Request(input, init) : input);
    } }) };
  };
  source.WORKSPACE = rooms(source); target.WORKSPACE = rooms(target); target.WORKSPACE_FROM = source.WORKSPACE;
  const token = (await signRoleClaim(SECRET, { sub: "owner", workspaceId: ID, role: 6 })).token;
  const call = (env: Record<string, any>, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => app.worker.fetch(new Request(`https://worker.test/engine/workspaces/${ID}/${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": typeof body === "string" ? "application/x-ndjson" : "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  }), env as never, {} as ExecutionContext);
  const write = (env: Record<string, any>, name = "Original") => call(env, "transact", { txId: "write", clientTxId: "original-id", ops: [
    { op: "insert", namespace: "parent", id: "p", values: { name } },
    { op: "insert", namespace: "child", id: "c", values: { name: "Child", parentId: "p" } },
  ] });
  return { app, source, target, sourceData, targetData, sourceFiles, targetFiles, call, write };
}
describe("workspace moves and imports", () => {
  test("moves rows, files and receipt IDs; cleans source state and remains idempotent", async () => {
    const d = await deployment();
    expect((await d.write(d.source)).status).toBe(200);
    expect((await d.call(d.source, "files/readme.txt", "file contents", "PUT")).status).toBe(201);
    const before = (await (await d.call(d.source, "export")).text()).split("\n").filter(Boolean).map(line => JSON.parse(line));
    const moved = await d.call(d.target, "move", { to: "none" });
    expect(await moved.clone().json()).toMatchObject({ ok: true });
    expect(moved.status).toBe(200);
    expect(await (await d.call(d.target, "files/readme.txt")).text()).toBe("file contents");
    const after = (await (await d.call(d.target, "export")).text()).split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(after.filter(line => line.type === "row" || line.type === "file")).toEqual(before.filter(line => line.type === "row" || line.type === "file"));
    expect(await (await d.write(d.target)).json()).toMatchObject({ ok: true, result: { applied: 0 } });
    expect((await d.call(d.source, "query", { query: { parent: {} } })).status).toBe(308);
    expect([...d.sourceData.objects.keys()].filter(key => key.startsWith("ws/"))).toEqual([]);
    expect(d.sourceFiles.objects.size).toBe(0);
    expect((await d.call(d.target, "move", { to: "none" })).status).toBe(200);
  });
  test("a failed copy leaves writes frozen, permits reads and resumes safely", async () => {
    const d = await deployment(); await d.write(d.source);
    const put = d.targetData.put.bind(d.targetData); let fail = true;
    d.targetData.put = async (...args: Parameters<typeof put>) => { if (fail && args[0].includes("snapshots/")) throw new Error("copy interrupted"); return put(...args); };
    expect((await d.call(d.target, "move", { to: "none" })).status).toBe(503);
    expect((await d.write(d.target)).status).toBe(409);
    expect((await d.call(d.target, "export")).status).toBe(200);
    fail = false;
    expect((await d.call(d.target, "move", { to: "none" })).status).toBe(200);
    expect(await (await d.write(d.target)).json()).toMatchObject({ result: { applied: 0 } });
  });
  test("an upload in flight during the move cannot overwrite the previous file", async () => {
    const d = await deployment(); await d.write(d.source);
    await d.call(d.source, "files/race.txt", "OLD", "PUT");
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => entered = resolve);
    const wait = new Promise<void>(resolve => release = resolve);
    const put = d.sourceFiles.put.bind(d.sourceFiles);
    d.sourceFiles.put = async (...args: Parameters<typeof put>) => { entered(); await wait; return put(...args); };
    const writing = d.call(d.source, "files/race.txt", "NEW", "PUT");
    await started;
    expect((await d.call(d.target, "move", { to: "none" })).status).toBe(200);
    release();
    expect((await writing).status).toBe(502);
    expect(await (await d.call(d.target, "files/race.txt")).text()).toBe("OLD");
    expect(d.sourceFiles.objects.size).toBe(0);
  });
  test("two move requests for one workspace cannot copy concurrently", async () => {
    const d = await deployment(); await d.write(d.source);
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => entered = resolve), wait = new Promise<void>(resolve => release = resolve);
    const put = d.targetData.put.bind(d.targetData);
    d.targetData.put = async (...args: Parameters<typeof put>) => { if (args[0].includes("snapshots/")) { entered(); await wait; } return put(...args); };
    const first = d.call(d.target, "move", { to: "none" }); await started;
    expect((await d.call(d.target, "move", { to: "none" })).status).toBe(409);
    release(); expect((await first).status).toBe(200);
  });

  test("never copies over an occupied destination", async () => {
    const d = await deployment(); await d.write(d.source);
    const from = d.target.TAPEDB_MOVE_FROM; delete d.target.TAPEDB_MOVE_FROM;
    expect((await d.write(d.target, "Destination")).status).toBe(200); d.target.TAPEDB_MOVE_FROM = from;
    expect((await d.call(d.target, "move", { to: "none" })).status).toBe(409);
    expect(d.targetData.objects.size).toBe(0);
  });
  test("consistent exports import atomically into an empty workspace, preserving dates", async () => {
    const d = await deployment(); await d.write(d.source);
    const exported = await (await d.call(d.source, "export")).text();
    delete d.target.TAPEDB_MOVE_FROM;
    const imported = await d.call(d.target, "import", exported);
    expect(await imported.clone().json()).toMatchObject({ ok: true, imported: { rows: 2 } });
    expect(imported.status).toBe(200);
    const rows = (text: string) => text.trim().split("\n").map(line => JSON.parse(line)).filter(line => line.type === "row");
    expect(rows(await (await d.call(d.target, "export")).text())).toEqual(rows(exported));
    expect((await d.call(d.target, "import", exported)).status).toBe(409);
  });
  test("an imported workspace restores from its transaction log without a snapshot", async () => {
    const d = await deployment(); await d.write(d.source); delete d.target.TAPEDB_MOVE_FROM;
    await d.call(d.source, "files/imported.txt", "bytes", "PUT");
    const exported = await (await d.call(d.source, "export")).text();
    // Children precede parents, and each row occupies its own log part.
    const lines = exported.trim().split("\n").map(line => JSON.parse(line));
    const reordered = [lines[0], ...lines.filter(line => line.type === "row").reverse(), ...lines.filter(line => line.type === "file"), lines.at(-1)].map(line => JSON.stringify(line)).join("\n") + "\n";
    setLogPartBytesForTests(180);
    try { expect((await d.call(d.target, "import", reordered)).status).toBe(200); }
    finally { setLogPartBytesForTests(null); }
    const entry = d.target.WORKSPACE.all.get(ID);
    await flushPending(d.targetData as never, durableObjectRecoverySqlExecutor(entry.context.storage as never), ID, Date.now());
    d.target.WORKSPACE.all.clear();
    const after = await (await d.call(d.target, "export")).text();
    const records = (text: string) => text.trim().split("\n").map(line => JSON.parse(line)).filter(line => line.type === "row" || line.type === "file");
    expect(records(after)).toEqual(records(exported));
  });

  test("large file copies stream R2 ranges into valid multipart uploads", async () => {
    const source = new FakeR2Bucket(), target = new FakeR2Bucket();
    const bytes = new Uint8Array(9 * 1024 * 1024).fill(17);
    await source.put("large", bytes, { httpMetadata: { contentType: "application/octet-stream" } });
    await copyObject(source as never, target as never, "large");
    expect(target.bodyOf("large")).toEqual(bytes);
    expect((await target.head("large") as { httpMetadata: { contentType: string } }).httpMetadata.contentType).toBe("application/octet-stream");
  });

  test("an inconsistent or truncated export leaves no data or history behind", async () => {
    const d = await deployment(); await d.write(d.source); delete d.target.TAPEDB_MOVE_FROM;
    const exported = await (await d.call(d.source, "export")).text();
    expect((await d.call(d.target, "import", exported.replace('"consistent":true', '"consistent":false'))).status).toBe(400);
    expect((await d.call(d.target, "import", exported.split("\n").slice(0, -2).join("\n"))).status).toBe(400);
    expect((await d.call(d.target, "import", exported)).status).toBe(200);
  });
});
