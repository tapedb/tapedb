/**
 * `tapedb backup` / `tapedb restore`, end to end against a Worker over HTTP.
 *
 * The Worker here is the real one (`defineTapeDB(...).worker`), served by
 * Bun.serve on a free port with in-memory rooms and R2 buckets, so the CLI
 * talks to it exactly as it would talk to `tapedb dev` on a laptop or a
 * deployed Worker: real claim route, real export stream, real file route.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import { model, schema, t } from "../src/schema";
import { mintToken } from "../src/cli/studio";
import { FakeR2Bucket } from "./fixtures/test-support";
import { FakeRoomContext } from "./fixtures/room-harness";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");
const { backupWorkspace, restoreWorkspace } = await import("../src/cli/backup");

const SECRET = "backup-restore-secret-test-test-test";
const SOURCE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a01";
const TARGET = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a02";
const OCCUPIED = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a03";
const AFTER_TAMPER = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a04";
const DRY_RUN = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a05";

const models = schema({
  board: model({ name: t.string(), columns: t.hasMany("column") }),
  column: model({ name: t.string(), position: t.number().default(0), board: t.belongsTo("board") }),
});
const app = defineTapeDB({ schema: models, devClaims: true });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0xff]);

let server: ReturnType<typeof Bun.serve>;
let url = "";
const data = new FakeR2Bucket();
const files = new FakeR2Bucket();

function roomNamespace(bucketEviction = false) {
  const rooms = new Map<string, { room: InstanceType<typeof app.WorkspaceRoom>; context: FakeRoomContext }>();
  return {
    rooms,
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: async (input: Request | string, init?: RequestInit) => {
        let entry = rooms.get(name);
        if (!entry) {
          const context = new FakeRoomContext(new Database(":memory:"), name);
          entry = { context, room: new app.WorkspaceRoom(context as never, env as never) };
          rooms.set(name, entry);
          if (bucketEviction) void bucketEviction;
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

const executionContext = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (request) => app.worker.fetch(request, env as never, executionContext),
  });
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

async function owner(workspace: string): Promise<string> {
  return mintToken(url, workspace);
}

async function seed(workspace: string): Promise<void> {
  const token = await owner(workspace);
  const written = await fetch(`${url}/engine/workspaces/${workspace}/transact`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      txId: `seed-${workspace}`,
      clientTxId: `seed-${workspace}`,
      ops: [
        { op: "insert", namespace: "board", id: "b1", values: { name: "Backlog" } },
        { op: "insert", namespace: "column", id: "c1", values: { name: "Todo", position: 1, boardId: "b1" } },
        { op: "insert", namespace: "column", id: "c2", values: { name: "Doing", position: 2, boardId: "b1" } },
      ],
    }),
  });
  expect(written.status).toBe(200);
  const uploaded = await fetch(`${url}/engine/workspaces/${workspace}/files/avatars/me.png`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "image/png" },
    body: PNG,
  });
  expect(uploaded.status).toBe(201);
}

async function exportText(workspace: string): Promise<string> {
  const token = await owner(workspace);
  const response = await fetch(`${url}/engine/workspaces/${workspace}/export`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return response.text();
}

async function fileBytes(workspace: string, path: string): Promise<Uint8Array> {
  const token = await owner(workspace);
  const response = await fetch(`${url}/engine/workspaces/${workspace}/files/${path}`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return new Uint8Array(await response.arrayBuffer());
}

function records(text: string, kinds: string[]): string[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string })
    .filter((line) => kinds.includes(line.type))
    .map((line) => JSON.stringify(line));
}

function backupDir(): string {
  return mkdtempSync(join(tmpdir(), "tapedb-backup-test-"));
}

describe("tapedb backup and restore", () => {
  let dir = "";
  let exported = "";

  test("backup writes the export verbatim, the file bytes and a hashed manifest", async () => {
    await seed(SOURCE);
    exported = await exportText(SOURCE);
    dir = backupDir();

    expect(await backupWorkspace(["--workspace", SOURCE, "--url", url, "--out", dir])).toBe(0);

    // The saved export is the engine's own records, not a re-serialisation;
    // only `exportedAt` differs from a second export of the same sequence.
    const withoutTimestamp = (text: string) => text.split("\n").filter(Boolean).map((line) => {
      const { exportedAt: _at, ...rest } = JSON.parse(line) as Record<string, unknown>;
      return rest;
    });
    expect(withoutTimestamp(readFileSync(join(dir, "rows.ndjson"), "utf8"))).toEqual(withoutTimestamp(exported));
    expect(new Uint8Array(readFileSync(join(dir, "files", "avatars", "me.png")))).toEqual(PNG);

    const manifest = JSON.parse(readFileSync(join(dir, "backup.json"), "utf8")) as {
      format: string;
      version: number;
      workspaceId: string;
      rows: number;
      parts: Array<{ path: string; bytes: number; sha256: string; kind: string }>;
    };
    expect(manifest).toMatchObject({ format: "tapedb-backup", version: 1, workspaceId: SOURCE, rows: 3 });
    expect(manifest.parts.map((part) => [part.path, part.kind])).toEqual([
      ["rows.ndjson", "rows"],
      ["files/avatars/me.png", "file"],
    ]);
    for (const part of manifest.parts) {
      const bytes = readFileSync(join(dir, ...part.path.split("/")));
      expect(bytes.byteLength).toBe(part.bytes);
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(part.sha256);
    }
  });

  test("backup --dry-run prints the counts and writes nothing, not even the directory", async () => {
    const never = join(backupDir(), "not-created");
    const logs: string[] = [];
    const original = console.log;
    console.log = (...line: unknown[]) => void logs.push(line.join(" "));
    try {
      expect(await backupWorkspace(["--workspace", SOURCE, "--url", url, "--out", never, "--dry-run"])).toBe(0);
    } finally {
      console.log = original;
    }
    const printed = logs.join("\n");
    expect(printed).toContain("3 rows");
    expect(printed).toContain("files/avatars/me.png");
    expect(printed).toContain("sha256");
    expect(printed).toContain("Nothing was written");
    expect(existsSync(never)).toBe(false);
  });

  test("a directory that already holds a backup is refused", async () => {
    expect(await backupWorkspace(["--workspace", SOURCE, "--url", url, "--out", dir])).toBe(1);
  });

  test("--dry-run verifies the hashes, prints them and writes nothing", async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...line: unknown[]) => void logs.push(line.join(" "));
    try {
      expect(await restoreWorkspace(["--from", dir, "--into", DRY_RUN, "--url", url, "--dry-run"])).toBe(0);
    } finally {
      console.log = original;
    }
    const printed = logs.join("\n");
    expect(printed).toContain("rows.ndjson");
    expect(printed).toContain("sha256");
    expect(printed).toContain("Dry run");
    expect(printed).toContain("3 rows");
    // No request reached the destination: no room exists for it until this
    // line, and nothing in it when it does.
    expect(env.WORKSPACE.rooms.has(DRY_RUN)).toBe(false);
    expect(records(await exportText(DRY_RUN), ["row", "file"])).toEqual([]);
  });

  test("a tampered rows.ndjson is refused before anything is written", async () => {
    const tampered = backupDir();
    for (const part of ["rows.ndjson", "backup.json", "files/avatars/me.png"]) {
      const target = join(tampered, ...part.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(dir, ...part.split("/"))));
    }
    const rows = readFileSync(join(tampered, "rows.ndjson"), "utf8");
    // One row changes: byte length is preserved, so only the hash can catch it.
    writeFileSync(join(tampered, "rows.ndjson"), rows.replace('"Backlog"', '"Backloq"'));

    const errors: string[] = [];
    const original = console.error;
    console.error = (...line: unknown[]) => void errors.push(line.join(" "));
    try {
      expect(await restoreWorkspace(["--from", tampered, "--into", AFTER_TAMPER, "--url", url])).toBe(1);
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toContain("rows.ndjson does not match the backup");
    expect(errors.join("\n")).toContain("Nothing was written");
    expect(env.WORKSPACE.rooms.has(AFTER_TAMPER)).toBe(false);
  });

  test("restore into an occupied workspace is refused and changes nothing", async () => {
    await seed(OCCUPIED);
    const before = records(await exportText(OCCUPIED), ["row", "file"]);

    const errors: string[] = [];
    const original = console.error;
    console.error = (...line: unknown[]) => void errors.push(line.join(" "));
    try {
      expect(await restoreWorkspace(["--from", dir, "--into", OCCUPIED, "--url", url])).toBe(1);
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toContain("already holds");
    expect(records(await exportText(OCCUPIED), ["row", "file"])).toEqual(before);
  });

  test("erase, then restore into a new workspace: rows and file bytes come back", async () => {
    const token = await owner(SOURCE);
    const erased = await fetch(`${url}/engine/workspaces/${SOURCE}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    expect(erased.status).toBe(200);

    expect(await restoreWorkspace(["--from", dir, "--into", TARGET, "--url", url])).toBe(0);

    const after = await exportText(TARGET);
    expect(records(after, ["row"])).toEqual(records(exported, ["row"]));
    expect(records(after, ["file"]).map((line) => JSON.parse(line).file.path)).toEqual(["avatars/me.png"]);
    expect(await fileBytes(TARGET, "avatars/me.png")).toEqual(PNG);
  });

  test("a second restore into the same workspace is a clean refusal, not a copy", async () => {
    const before = records(await exportText(TARGET), ["row", "file"]);
    const errors: string[] = [];
    const original = console.error;
    console.error = (...line: unknown[]) => void errors.push(line.join(" "));
    try {
      expect(await restoreWorkspace(["--from", dir, "--into", TARGET, "--url", url])).toBe(1);
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toContain("already holds rows");
    expect(records(await exportText(TARGET), ["row", "file"])).toEqual(before);
  });
});
