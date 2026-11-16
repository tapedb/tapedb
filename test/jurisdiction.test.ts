/**
 * Data residency: with TAPEDB_JURISDICTION set, every workspace's Durable
 * Object is addressed inside that jurisdiction, a room found outside it
 * serves nothing, and deploy refuses buckets that do not match.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import { useLegacyFixture } from "./fixtures/registry";
useLegacyFixture();

import { WORKSPACE_ROLE_LEVELS } from "../src/claims";
import { signRoleClaim } from "../src/mint";
import { encodeTrustedRoleClaim } from "../src/verify";
import { FakeR2Bucket, TEST_WORKSPACE } from "./fixtures/test-support";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");
const { WorkspaceRoom } = await import("../src/engine/workspace-room");
const { checkJurisdiction, run } = await import("../src/cli/index");
const { model, schema, t } = await import("../src/schema");

const SECRET = "test-secret-test-secret-test-secret";

interface SqlCursor<T> { toArray(): T[]; one(): T; rowsWritten: number }
function createSqlStorage(db: Database) {
  return {
    exec<T extends Record<string, unknown>>(
      query: string,
      ...params: unknown[]
    ): SqlCursor<T> {
      const trimmed = query.trim();
      const lower = trimmed.toLowerCase();
      const isRead =
        /^(select|with|explain)\b/i.test(trimmed) ||
        (lower.startsWith("pragma") && !lower.includes("="));

      if (isRead) {
        const rows = db.query(query).all(...(params as never[])) as T[];
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length === 0) throw new Error("Query returned no rows.");
            return rows[0];
          },
          rowsWritten: 0,
        };
      }

      const statements = trimmed.split(";").filter((part) => part.trim());
      let changes = 0;
      if (statements.length > 1) {
        db.exec(query);
      } else {
        changes = db.prepare(query).run(...(params as never[])).changes;
      }

      return {
        toArray: () => [],
        one: () => {
          throw new Error("Statement returned no rows.");
        },
        rowsWritten: changes,
      };
    },
  };
}


describe("the Worker", () => {
  const tapedb = defineTapeDB({ schema: schema({ note: model({ body: t.string() }) }) });
  const namespace = () => {
    const used: string[] = [];
    const scoped = (where: string) => ({
      idFromName: (name: string) => `${where}:${name}`,
      get: (id: string) => ({
        fetch: async () => {
          used.push(id);
          return new Response("{}");
        },
      }),
    });
    return { used, binding: { ...scoped("global"), jurisdiction: (where: string) => scoped(where) } };
  };
  const call = async (vars: Record<string, string>) => {
    const ns = namespace();
    const { token } = await signRoleClaim(SECRET, { sub: "u", workspaceId: TEST_WORKSPACE, role: WORKSPACE_ROLE_LEVELS.MEMBER });
    await tapedb.worker.fetch(
      new Request(`http://w.test/engine/workspaces/${TEST_WORKSPACE}/status`, { headers: { authorization: `Bearer ${token}` } }),
      { WORKSPACE: ns.binding, DATA: new FakeR2Bucket(), TAPEDB_CLAIM_SECRET: SECRET, ENVIRONMENT: "development", ...vars } as never,
      {} as ExecutionContext
    );
    return ns.used;
  };

  test("addresses workspaces inside TAPEDB_JURISDICTION", async () => {
    expect(await call({ TAPEDB_JURISDICTION: "eu" })).toEqual([`eu:${TEST_WORKSPACE}`]);
  });

  test("without it (or with it cleared, as tapedb dev does), unrestricted", async () => {
    expect(await call({})).toEqual([`global:${TEST_WORKSPACE}`]);
    expect(await call({ TAPEDB_JURISDICTION: "" })).toEqual([`global:${TEST_WORKSPACE}`]);
  });
});

describe("the room", () => {
  const room = async (jurisdiction: string | undefined) => {
    const db = new Database(":memory:");
    const ctx = {
      id: { name: TEST_WORKSPACE, jurisdiction },
      storage: { sql: createSqlStorage(db), transactionSync: <T>(fn: () => T) => db.transaction(fn)(), getAlarm: async () => null, setAlarm: async () => {} },
      ready: Promise.resolve() as Promise<unknown>,
      blockConcurrencyWhile<T>(fn: () => Promise<T>) {
        this.ready = fn();
        return this.ready as Promise<T>;
      },
      getWebSockets: () => [],
    };
    const instance = new WorkspaceRoom(ctx as never, { DATA: new FakeR2Bucket(), TAPEDB_JURISDICTION: "eu" } as never);
    await ctx.ready;
    const claim = encodeTrustedRoleClaim({ sub: "u", workspaceId: TEST_WORKSPACE, role: WORKSPACE_ROLE_LEVELS.MEMBER, iat: 0, exp: Math.floor(Date.now() / 1000) + 60 });
    const response = await instance.fetch(new Request("http://room/status", { headers: { "x-tapedb-claims": claim } }));
    const tables = db.query(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'`).get() as { n: number };
    return { response, tables: tables.n };
  };

  test("serves when its id is in the configured jurisdiction", async () => {
    expect((await room("eu")).response.status).toBe(200);
  });

  test("outside it, serves nothing and stores nothing", async () => {
    for (const where of [undefined, "fedramp"]) {
      const { response, tables } = await room(where);
      expect(response.status).toBe(500);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("jurisdiction_mismatch");
      expect(tables).toBe(0);
    }
  });
});

describe("tapedb deploy and init", () => {
  const buckets = (jurisdiction?: string) => [
    { binding: "DATA", bucket_name: "a-data", ...(jurisdiction ? { jurisdiction } : {}) },
    { binding: "FILES", bucket_name: "a-files", ...(jurisdiction ? { jurisdiction } : {}) },
  ];

  test("deploy wants the objects and every bucket in one jurisdiction, or none restricted", () => {
    expect(checkJurisdiction({}, buckets())).toBeNull();
    expect(checkJurisdiction({ TAPEDB_JURISDICTION: "eu" }, buckets("eu"))).toBeNull();
    expect(checkJurisdiction({ TAPEDB_JURISDICTION: "eu" }, buckets())).toContain("--jurisdiction eu");
    expect(checkJurisdiction({ TAPEDB_JURISDICTION: "eu" }, [buckets("eu")[0], buckets()[1]])).toContain("FILES");
    expect(checkJurisdiction({}, buckets("eu"))).toContain("TAPEDB_JURISDICTION is not set");
    expect(checkJurisdiction({ TAPEDB_JURISDICTION: "mars" }, buckets())).toContain("eu and fedramp");
  });

  test("init --jurisdiction eu writes the var and EU buckets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapedb-eu-"));
    const [log, error] = [console.log, console.error];
    console.log = console.error = () => {};
    try {
      // The files are written first; the first migration then needs an
      // installed tapedb, which a temp dir lacks (the e2e covers that path).
      await run(["init", "--dir", dir, "--jurisdiction", "eu", "--no-install", "--no-start"]);
    } finally {
      [console.log, console.error] = [log, error];
    }
    const config = JSON.parse(readFileSync(join(dir, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
    expect(config.vars.TAPEDB_JURISDICTION).toBe("eu");
    expect(config.r2_buckets.map((bucket: { jurisdiction?: string }) => bucket.jurisdiction)).toEqual(["eu", "eu"]);
    expect(checkJurisdiction(config.vars, config.r2_buckets)).toBeNull();
  });
});
