/**
 * An embedding's stored string, byte for byte, through every artefact a row
 * passes: SQLite, the transaction log (in SQLite and on the tape in R2), a
 * snapshot, recovery from R2 after the Durable Object's storage is gone,
 * `$export`, and a backup's `rows.ndjson` restored into another workspace.
 *
 * Each one is written and read back here rather than asserted about: the value
 * that comes out is compared with the value that went in.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS } from "../src/claims";
import { flushPending } from "../src/engine/durability/flusher";
import { snapshotWorkspace } from "../src/engine/durability/snapshot";
import { encodeVector } from "../src/model/vector";
import { model, schema, t } from "../src/schema";
import { encodeTrustedRoleClaim, TRUSTED_CLAIM_HEADER } from "../src/verify";
import { FakeRoomContext } from "./fixtures/room-harness";
import { FakeR2Bucket } from "./fixtures/test-support";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");
const { backupWorkspace, restoreWorkspace } = await import("../src/cli/backup");
const { mintToken } = await import("../src/cli/studio");

const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5c01";
const BACKUP_SOURCE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5c02";
const BACKUP_TARGET = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5c03";
const SECRET = "round-trip-secret-secret-secret-32";
const DIMENSIONS = 8;
const EMBEDDING = [0.5, -0.25, 0.125, -0.0625, 0.1, -0.3, 1e-7, 3];
const TEXT = encodeVector(EMBEDDING, DIMENSIONS);

const app = defineTapeDB({
  schema: schema({
    note: model({ title: t.string(), embedding: t.vector({ dimensions: DIMENSIONS }).optional() }),
  }),
  devClaims: true,
});

function claimHeaders(workspace: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim({
      sub: "owner",
      workspaceId: workspace,
      role: WORKSPACE_ROLE_LEVELS.OWNER,
      iat: now,
      exp: now + 600,
    } as never),
    "content-type": "application/json",
  };
}

function call(target: { fetch(request: Request): Promise<Response> }, workspace: string, path: string, body?: unknown) {
  return target.fetch(
    new Request(`https://room${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: claimHeaders(workspace),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
}

const insert = (id: string, title: string) => [
  { op: "insert", namespace: "note", id, values: { title, embedding: EMBEDDING } },
];

describe("one stored string through every artefact", () => {
  const bucket = new FakeR2Bucket();
  const env = { FILES: new FakeR2Bucket(), DATA: bucket, TAPEDB_CLAIM_SECRET: SECRET, ENVIRONMENT: "development" };
  let context: FakeRoomContext;
  let room: InstanceType<typeof app.WorkspaceRoom>;

  beforeAll(async () => {
    context = new FakeRoomContext(new Database(":memory:"), WORKSPACE);
    room = new app.WorkspaceRoom(context as never, env as never);
    await context.ready;
    const written = await call(room, WORKSPACE, "/transact", { txId: "t1", ops: insert("n1", "First") });
    expect(written.status).toBe(200);
  });

  test("SQLite holds the string itself", () => {
    const row = context.db.query(`SELECT embedding FROM "note" WHERE id = 'n1'`).get() as { embedding: string };
    expect(row.embedding).toBe(TEXT);
    // Type and bytes: TEXT, not a blob, and it decodes back to the numbers.
    const type = context.db.query(`SELECT typeof(embedding) AS t FROM "note" WHERE id = 'n1'`).get() as { t: string };
    expect(type.t).toBe("text");
  });

  test("the transaction log row holds it", () => {
    const log = context.db.query(`SELECT ops FROM "_tx_log" ORDER BY seq`).all() as Array<{ ops: string }>;
    expect(log).toHaveLength(1);
    const ops = JSON.parse(log[0]!.ops) as Array<{ values: Record<string, unknown> }>;
    expect(ops[0]!.values.embedding).toBe(TEXT);
  });

  test("the log tape in R2 holds it, and a snapshot chunk holds it", async () => {
    await flushPending(bucket as never, context.storage.sql as never, WORKSPACE, Date.now());
    await snapshotWorkspace(bucket as never, context.storage.sql as never, WORKSPACE, Date.now());

    const segment = [...bucket.objects.keys()].filter((key) => /\/log\/\d+-\d+\.ndjson$/.test(key));
    expect(segment).toHaveLength(1);
    const segmentText = new TextDecoder().decode(bucket.objects.get(segment[0]!)!.body);
    expect(segmentText).toContain(TEXT);

    const snapshotChunk = [...bucket.objects.keys()].filter((key) => key.includes("/snapshots/") && key.endsWith(".ndjson.gz"));
    expect(snapshotChunk.length).toBeGreaterThan(0);
    const gzipped = bucket.objects.get(snapshotChunk[0]!)!.body;
    const decoded = await new Response(
      new Response(gzipped as unknown as BodyInit).body!.pipeThrough(new DecompressionStream("gzip"))
    ).text();
    expect(decoded).toContain(TEXT);
  });

  test("$export carries it, and a default read still does not", async () => {
    const exported = await call(room, WORKSPACE, "/export");
    expect(exported.status).toBe(200);
    const rows = (await exported.text())
      .split("\n")
      .filter((line) => line.includes('"type":"row"'))
      .map((line) => JSON.parse(line) as { data: Record<string, unknown> });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data.embedding).toBe(TEXT);

    const read = (await (await call(room, WORKSPACE, "/query", { query: { note: {} } })).json()) as {
      data: { note: Array<Record<string, unknown>> };
    };
    expect("embedding" in read.data.note[0]!).toBe(false);
  });

  test("recovery from R2, after the Durable Object's storage is gone, holds it", async () => {
    // The live copy goes first: from here the room's data exists only in R2.
    await context.storage.deleteAll();
    expect(() => context.db.query(`SELECT embedding FROM "note"`).all()).toThrow();

    const restoredContext = new FakeRoomContext(new Database(":memory:"), WORKSPACE);
    const restored = new app.WorkspaceRoom(restoredContext as never, env as never);
    await restoredContext.ready;

    const read = (await (await call(restored, WORKSPACE, "/query", { query: { note: { $: { select: ["id", "title", "embedding"] } } } })).json()) as {
      data: { note: Array<Record<string, unknown>> };
    };
    expect(read.data.note).toEqual([{ id: "n1", title: "First", embedding: TEXT }]);
    // And the recovered row keeps working: it is the same value, not a rewrite.
    expect((restoredContext.db.query(`SELECT embedding FROM "note"`).get() as { embedding: string }).embedding).toBe(TEXT);
  });
});

describe("a backup's rows.ndjson and a restore into another workspace", () => {
  const data = new FakeR2Bucket();
  const files = new FakeR2Bucket();
  let server: ReturnType<typeof Bun.serve>;
  let url = "";
  let directory = "";

  function roomNamespace() {
    const rooms = new Map<string, { room: InstanceType<typeof app.WorkspaceRoom>; context: FakeRoomContext }>();
    return {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async (input: Request | string, init?: RequestInit) => {
          let entry = rooms.get(name);
          if (!entry) {
            const context = new FakeRoomContext(new Database(":memory:"), name);
            entry = { context, room: new app.WorkspaceRoom(context as never, env as never) };
            rooms.set(name, entry);
          }
          await entry.context.ready;
          return entry.room.fetch(typeof input === "string" ? new Request(input, init) : input);
        },
      }),
    };
  }

  const env = {
    DATA: data,
    FILES: files,
    TAPEDB_CLAIM_SECRET: SECRET,
    ENVIRONMENT: "development",
    TAPEDB_DEV_CLAIMS: "true",
    WORKSPACE: roomNamespace(),
  };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: (request) => app.worker.fetch(request, env as never, { waitUntil: () => {}, passThroughOnException: () => {} } as never),
    });
    url = `http://127.0.0.1:${server.port}`;
    directory = mkdtempSync(join(tmpdir(), "tapedb-vector-backup-"));
  });

  afterAll(() => {
    server?.stop(true);
  });

  test("the string is written to rows.ndjson and comes back from the restore", async () => {
    const token = await mintToken(url, BACKUP_SOURCE);
    const written = await fetch(`${url}/engine/workspaces/${BACKUP_SOURCE}/transact`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ txId: "seed", ops: insert("n1", "Backed up") }),
    });
    expect(written.status).toBe(200);

    expect(await backupWorkspace(["--workspace", BACKUP_SOURCE, "--out", directory, "--url", url])).toBe(0);
    const rowsFile = readFileSync(join(directory, "rows.ndjson"), "utf8");
    expect(existsSync(join(directory, "backup.json"))).toBe(true);
    // The file holds the stored string exactly: no decoding, no JSON array.
    expect(rowsFile).toContain(`"embedding":"${TEXT}"`);
    expect(rowsFile).toContain(`"title":"Backed up"`);

    expect(await restoreWorkspace(["--from", directory, "--into", BACKUP_TARGET, "--url", url])).toBe(0);

    const restored = await fetch(`${url}/engine/workspaces/${BACKUP_TARGET}/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${await mintToken(url, BACKUP_TARGET)}`, "content-type": "application/json" },
      body: JSON.stringify({ query: { note: { $: { select: ["id", "title", "embedding"] } } } }),
    });
    expect(restored.status).toBe(200);
    const body = (await restored.json()) as { data: { note: Array<Record<string, unknown>> } };
    expect(body.data.note).toEqual([{ id: "n1", title: "Backed up", embedding: TEXT }]);
  });
});
