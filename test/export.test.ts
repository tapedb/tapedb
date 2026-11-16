/**
 * `$export()`: every row the caller may read, as NDJSON, streamed a chunk at
 * a time through the same read path as any query.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim, type WorkspaceRole } from "../src/claims";
import { MemoryOutbox } from "../src/client/outbox";
import { exportLines, exportStream } from "../src/engine/export";
import { configureFileAccess } from "../src/engine/file-access";
import { recordFileEntry } from "../src/engine/file-index";
import { configureMigrations } from "../src/engine/migrations-bundle";
import { configureRegistry } from "../src/engine/registry";
import { configurePermissions } from "../src/engine/tx-permissions";
import { runTransaction } from "../src/engine/tx-pipeline";
import type { SqlExecutor, SqlRow, SqlValue } from "../src/engine/tx-sql";
import { exportWorkspace } from "../src/cli/index";
import { createClient, type ExportRecord } from "../src/model/client";
import { check, filter, model, role, schema, t } from "../src/schema";

const WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";

const appSchema = schema({
  board: model({ name: t.string(), ownerId: t.string().index(), columns: t.hasMany("column") }).access({
    read: filter(({ auth }) => ({ ownerId: auth.sub })),
  }),
  column: model({ name: t.string(), board: t.belongsTo("board", { onDelete: "cascade" }) }),
  note: model({ body: t.string(), author: t.string() }).access({
    read: check(({ auth, row }) => row?.author === auth.sub),
  }),
  secret: model({ value: t.string() }).access({ read: role("admin") }),
});

afterEach(() => configureFileAccess(undefined));

let sql: SqlExecutor;

function claim(sub = "alice", level: WorkspaceRole = WORKSPACE_ROLE_LEVELS.EDITOR): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return { sub, workspaceId: WORKSPACE, role: level, exp: now + 600, iat: now };
}

const owner = () => claim("seed", WORKSPACE_ROLE_LEVELS.OWNER);

beforeEach(() => {
  configureFileAccess(undefined);
  configureRegistry(appSchema.registry);
  configureMigrations(appSchema.migrations);
  configurePermissions(appSchema.permissions);
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of appSchema.migrations) db.exec(migration.sql);
  sql = {
    exec: (q: string, ...p: SqlValue[]) => db.query(q).run(...(p as never[])).changes,
    all: <T extends SqlRow = SqlRow>(q: string, ...p: SqlValue[]) => db.query(q).all(...(p as never[])) as T[],
    one: <T extends SqlRow = SqlRow>(q: string, ...p: SqlValue[]) => (db.query(q).get(...(p as never[])) ?? undefined) as T | undefined,
    transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
  };
});

function seed() {
  runTransaction(sql, WORKSPACE, owner(), {
    txId: "boards",
    ops: [
      { op: "insert", namespace: "board", id: "b-alice", values: { name: "Mine", ownerId: "alice" } },
      { op: "insert", namespace: "board", id: "b-bob", values: { name: "Theirs", ownerId: "bob" } },
      { op: "insert", namespace: "secret", id: "s1", values: { value: "hidden" } },
    ],
  });
  // More columns than one chunk holds.
  runTransaction(sql, WORKSPACE, owner(), {
    txId: "columns",
    ops: Array.from({ length: 2300 }, (_, n) => ({
      op: "insert",
      namespace: "column",
      id: `c${String(n).padStart(4, "0")}`,
      values: { name: `c${n}`, boardId: "b-alice" },
    })),
  });
  runTransaction(sql, WORKSPACE, owner(), {
    txId: "notes",
    ops: Array.from({ length: 1500 }, (_, n) => ({
      op: "insert",
      namespace: "note",
      id: `n${String(n).padStart(4, "0")}`,
      values: { body: `n${n}`, author: n % 3 === 0 ? "alice" : "bob" },
    })),
  });
  recordFileEntry(sql, { path: "a.png", key: "k/a", size: 3, contentType: "image/png" } as never);
}

const parse = (lines: Iterable<string>) => [...lines].map((line) => JSON.parse(line) as Record<string, unknown>);

describe("export", () => {
  test("streams every readable row, through read rules, then the file index and an end line", () => {
    seed();
    const records = parse(exportLines(sql, claim(), WORKSPACE, () => 42));

    const header = records[0];
    expect(header).toMatchObject({ type: "header", format: "tapedb-export", version: 1, workspaceId: WORKSPACE, exportedAt: 42 });
    expect(header.models).toEqual(["board", "column", "note"]);
    expect((header.skipped as Array<{ model: string }>).map((entry) => entry.model)).toEqual(["secret"]);

    const rows = records.filter((record) => record.type === "row") as Array<{ model: string; data: Record<string, unknown> }>;
    // A filter rule in SQL, a function rule row by row.
    expect(rows.filter((row) => row.model === "board").map((row) => row.data.id)).toEqual(["b-alice"]);
    expect(rows.filter((row) => row.model === "note")).toHaveLength(500);
    expect(rows.every((row) => row.model !== "note" || row.data.author === "alice")).toBe(true);

    // Every column exactly once, in id order, across chunks, in the API shape.
    const columns = rows.filter((row) => row.model === "column").map((row) => row.data.id as string);
    expect(columns).toHaveLength(2300);
    expect(columns).toEqual([...columns].sort());
    expect(rows.find((row) => row.model === "column")?.data).toMatchObject({ name: "c0", boardId: "b-alice", createdAt: expect.any(Number) });

    expect(records.filter((record) => record.type === "file")).toEqual([
      { type: "file", file: expect.objectContaining({ path: "a.png", size: 3, contentType: "image/png" }) },
    ]);
    expect(records.at(-1)).toEqual({
      type: "end",
      startSeq: 4,
      seq: 4,
      rows: 2801,
      counts: { board: 1, column: 2300, note: 500 },
      consistent: true,
    });

    const admin = parse(exportLines(sql, claim("alice", WORKSPACE_ROLE_LEVELS.ADMIN), WORKSPACE));
    expect(admin[0].skipped).toEqual([]);
    expect(admin.some((record) => record.type === "row" && record.model === "secret")).toBe(true);
  });

  test("reads lazily and says when a write landed during the export", () => {
    seed();
    const lines = exportLines(sql, claim(), WORKSPACE);
    lines.next(); // header
    lines.next(); // the board row
    // A write between chunks.
    runTransaction(sql, WORKSPACE, owner(), {
      txId: "late",
      ops: [{ op: "insert", namespace: "column", id: "c9999", values: { name: "late", boardId: "b-alice" } }],
    });
    const rest = parse(lines);
    expect(rest.at(-1)).toMatchObject({ type: "end", startSeq: 4, seq: 5, consistent: false });
  });

  test("an export that fails mid-stream ends with an error line, not an end line", () => {
    seed();
    const broken: SqlExecutor = {
      ...sql,
      all: ((query: string, ...params: SqlValue[]) => {
        if (query.includes('FROM "note"')) throw new Error("disk on fire");
        return sql.all(query, ...params);
      }) as SqlExecutor["all"],
    };
    const records = parse(exportLines(broken, claim(), WORKSPACE));
    expect(records.at(-1)).toMatchObject({ type: "error", code: "storage_error" });
    expect(records.some((record) => record.type === "end")).toBe(false);
  });

  test("the client parses the stream however it is split, typed per model", async () => {
    seed();
    const db = createClient(
      { schema: appSchema, url: "http://engine.test", workspace: WORKSPACE, getToken: async () => "t" },
      {
        outbox: new MemoryOutbox(),
        createWebSocket: () => {
          throw new Error("no socket here");
        },
        fetch: async (url: string) => {
          expect(url).toBe(`http://engine.test/engine/workspaces/${WORKSPACE}/export`);
          // Re-chunk the engine's bytes at awkward, line-splitting sizes.
          const bytes = new Uint8Array(await new Response(exportStream(sql, claim(), WORKSPACE)).arrayBuffer());
          let offset = 0;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset >= bytes.length) return controller.close();
              const size = 1 + ((offset * 7919) % 97);
              controller.enqueue(bytes.slice(offset, offset + size));
              offset += size;
            },
          });
          return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
        },
      }
    );

    const records: ExportRecord<typeof appSchema.models>[] = [];
    for await (const record of db.$export()) records.push(record);
    expect(records[0].type).toBe("header");
    expect(records.filter((record) => record.type === "row")).toHaveLength(2801);
    expect(records.at(-1)).toMatchObject({ type: "end", rows: 2801, consistent: true });
    const column = records.find((record) => record.type === "row" && record.model === "column");
    if (column?.type === "row" && column.model === "column") {
      const name: string = column.data.name;
      expect(name).toBe("c0");
    }
  });

  test("tapedb export writes the stream to a file and fails on an incomplete one", async () => {
    seed();
    let broken = false;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/_tapedb/claim") return Response.json({ token: "dev" });
        expect(request.headers.get("authorization")).toBe("Bearer dev");
        if (broken) return new Response('{"type":"header"}\n{"type":"error","code":"storage_error","message":"boom"}\n');
        return new Response(exportStream(sql, claim(), WORKSPACE));
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "tapedb-export-"));
    const out = join(dir, "export.ndjson");
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect(await exportWorkspace(["--url", base, "--workspace", WORKSPACE, "--out", out])).toBe(0);
      const lines = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(lines.at(-1)).toMatchObject({ type: "end", rows: 2801 });

      broken = true;
      expect(await exportWorkspace(["--url", base, "--workspace", WORKSPACE, "--out", out])).toBe(1);
      expect(await exportWorkspace(["--url", base])).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});


describe("export file permissions", () => {
  test("a guest cannot enumerate member-only file metadata", () => {
    recordFileEntry(sql, { path: "private/customer.pdf", key: "private/key", size: 3, contentType: "application/pdf", uploadedBy: "bob" });
    expect(parse(exportLines(sql, claim("guest", WORKSPACE_ROLE_LEVELS.GUEST), WORKSPACE)).filter(record => record.type === "file")).toEqual([]);
  });

  test("file checks filter every page without leaking hidden metadata", () => {
    configureFileAccess({ read: { decision: "check", test: ({ file }) => file.uploadedBy === "alice" } });
    for (let n = 0; n < 1001; n++) recordFileEntry(sql, { path: `a-hidden-${String(n).padStart(4, "0")}`, key: `k/${n}`, size: 1, contentType: "text/plain", uploadedBy: "bob" });
    recordFileEntry(sql, { path: "z-visible", key: "k/visible", size: 1, contentType: "text/plain", uploadedBy: "alice" });
    const files = parse(exportLines(sql, claim(), WORKSPACE)).filter(record => record.type === "file");
    expect(files.map(record => (record.file as { path: string }).path)).toEqual(["z-visible"]);
  });

  test("attached files follow the parent row's read rule", () => {
    seed();
    configureFileAccess({ read: { decision: "attachedTo", model: "board", locate: path => path.split("/")[0] } });
    for (const id of ["b-alice", "b-bob"]) recordFileEntry(sql, { path: `${id}/file`, key: `k/${id}`, size: 1, contentType: "text/plain", uploadedBy: "seed" });
    expect(parse(exportLines(sql, claim(), WORKSPACE)).filter(record => record.type === "file").map(record => (record.file as { path: string }).path)).toEqual(["b-alice/file"]);
  });
});
