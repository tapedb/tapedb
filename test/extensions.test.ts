/**
 * Extensions: packages that add models and file rules to the schema, and
 * routes, cron work and change handlers to the Worker.
 *
 * The change handler runs the real `WorkspaceRoom` over in-memory SQLite: an
 * extension's events take the webhook outbox's path (capture in the write,
 * delivery after the commit, retries) and end in a function call in the room.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { encodeTrustedRoleClaim } from "../src/verify";
import { fileCheck, model, role, schema, t, type SchemaExtension } from "../src/schema";
import { authorizeFile, readableFiles, resolveFileRules } from "../src/engine/file-access";
import type { Env } from "../src/types";
import { FakeR2Bucket } from "./fixtures/test-support";
import { FakeRoomContext } from "./fixtures/room-harness";

class MockDurableObject<EnvShape> {
  protected ctx: DurableObjectState;
  protected env: EnvShape;
  constructor(ctx: DurableObjectState, env: EnvShape) {
    this.ctx = ctx;
    this.env = env;
  }
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");

const ID = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";
const SECRET = "extension-test-claim-secret-at-least-32-bytes";

afterEach(() => setSystemTime());

const content = {
  name: "cms",
  models: { article: model({ title: t.string() }) },
  files: {
    prefix: "public/",
    read: fileCheck(() => true),
    write: role("member"),
  },
} satisfies SchemaExtension;

const appSchema = schema({ task: model({ title: t.string() }) }, { files: { read: role("editor") }, extensions: [content] });

function claim(level: number = WORKSPACE_ROLE_LEVELS.DEVELOPER, sub = "user-1"): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return { sub, workspaceId: ID, role: level as never, exp: now + 3600, iat: now };
}

describe("schema extensions", () => {
  test("an extension's models join the app's, typed", () => {
    expect(Object.keys(appSchema.models).sort()).toEqual(["article", "task"]);
    expect(appSchema.registry.namespaces.map((n) => n.apiName).sort()).toEqual(["article", "task"]);
    // The client sees both: a compile-time check that `article` is a model of this schema.
    const keys: Array<keyof typeof appSchema.models> = ["article", "task"];
    expect(keys).toHaveLength(2);
  });

  test("a model name an extension shares with the app is refused, naming both", () => {
    expect(() => schema({ article: model({ body: t.string() }) }, { extensions: [content] })).toThrow(
      'Model "article" from the cms extension has the same name as another model; rename one of them.'
    );
  });

  test("an extension's file rules decide under its prefix; the app's everywhere else", () => {
    const rules = resolveFileRules(appSchema.files);
    const file = (path: string) => ({ path, size: 1, contentType: "image/png", uploadedBy: "someone" });
    const guest = claim(WORKSPACE_ROLE_LEVELS.GUEST);
    const member = claim(WORKSPACE_ROLE_LEVELS.MEMBER);
    const sql = {} as never;
    expect(authorizeFile(sql, guest, rules, "read", file("public/a.png"))).toBe(true);
    expect(authorizeFile(sql, member, rules, "read", file("private/a.png"))).toBe(false);
    expect(authorizeFile(sql, claim(WORKSPACE_ROLE_LEVELS.EDITOR), rules, "read", file("private/a.png"))).toBe(true);
    expect(authorizeFile(sql, member, rules, "write", file("public/b.png"))).toBe(true);
    // The extension sets no delete rule: the default (editor) applies under its prefix too.
    expect(authorizeFile(sql, member, rules, "delete", file("public/b.png"))).toBe(false);
    expect(readableFiles(sql, guest, [file("public/x"), file("private/y"), file("publicity/z")], rules).map((f) => f.path)).toEqual(["public/x"]);
  });

  test("the longest prefix decides, and two extensions cannot claim one prefix", () => {
    const rules = resolveFileRules({
      paths: [
        { prefix: "public/", read: fileCheck(() => true) },
        { prefix: "public/private/", read: role("admin") },
      ],
    } as never);
    const f = { path: "public/private/x", size: 1, contentType: null, uploadedBy: "a" };
    expect(authorizeFile({} as never, claim(WORKSPACE_ROLE_LEVELS.MEMBER), rules, "read", f)).toBe(false);
    expect(() => resolveFileRules({ paths: [{ prefix: "a/" }, { prefix: "a/" }] } as never)).toThrow("two rule sets claim the same prefix");
    expect(() => resolveFileRules({ paths: [{ prefix: "/abs" }] } as never)).toThrow("a relative path");
  });
});

describe("worker extensions", () => {
  test("routes TapeDB does not answer go to the extensions in order; TapeDB's own routes stay its own", async () => {
    const seen: string[] = [];
    const app = defineTapeDB({
      schema: appSchema,
      extensions: [
        { name: "first", fetch: (r) => (new URL(r.url).pathname === "/first" ? new Response("first") : (seen.push("first"), null)) },
        { name: "second", fetch: (r) => (new URL(r.url).pathname.startsWith("/s") ? new Response("second") : null) },
      ],
    });
    const env = { DATA: new FakeR2Bucket(), FILES: new FakeR2Bucket(), TAPEDB_CLAIM_SECRET: SECRET } as unknown as Env;
    const ask = async (path: string) => app.worker.fetch(new Request(`https://w.test${path}`), env, {} as ExecutionContext);
    expect(await (await ask("/first")).text()).toBe("first");
    expect(await (await ask("/second")).text()).toBe("second");
    expect((await ask("/status")).status).toBe(200);
    expect((await ask("/nothing")).status).toBe(404);
    expect(seen).toEqual(["first", "first"]);
  });

  test("an extension signs claims for the deployment and verifies a caller's", async () => {
    let context: Parameters<NonNullable<Parameters<typeof defineTapeDB>[0]["extensions"]>[number]["fetch"] & {}>[3] | undefined;
    const app = defineTapeDB({ schema: appSchema, extensions: [{ name: "probe", fetch: (_r, _e, _c, tapedb) => ((context = tapedb), new Response("ok")) }] });
    const env = { DATA: new FakeR2Bucket(), FILES: new FakeR2Bucket(), TAPEDB_CLAIM_SECRET: SECRET } as unknown as Env;
    await app.worker.fetch(new Request("https://w.test/probe"), env, {} as ExecutionContext);
    const token = await context!.signClaim(ID, { sub: "scheduler", role: WORKSPACE_ROLE_LEVELS.EDITOR });
    expect(await context!.verifyClaim(`Bearer ${token}`, ID)).toEqual({ sub: "scheduler", role: WORKSPACE_ROLE_LEVELS.EDITOR, workspaceId: ID });
    expect(await context!.verifyClaim(token, "0190a5b2-0000-4e8f-9a0b-1c2d3e4f5a6b")).toBeNull();
    expect(await context!.verifyClaim("nonsense", ID)).toBeNull();
    expect(await context!.verifyClaim(null, ID)).toBeNull();
  });

  test("cron triggers run each extension's scheduled work", async () => {
    const ran: string[] = [];
    const app = defineTapeDB({
      schema: appSchema,
      extensions: [
        { name: "a", scheduled: (c) => void ran.push(`a@${c.scheduledTime}`) },
        { name: "b" },
        { name: "c", scheduled: async () => void ran.push("c") },
      ],
    });
    await app.worker.scheduled({ scheduledTime: 42, cron: "* * * * *", noRetry() {} } as ScheduledController, {} as Env, {} as ExecutionContext);
    expect(ran).toEqual(["a@42", "c"]);
  });

  test("names are checked when the Worker is defined", () => {
    expect(() => defineTapeDB({ schema: appSchema, extensions: [{ name: "Bad Name" }] })).toThrow("lowercase letters, digits and dashes");
    expect(() => defineTapeDB({ schema: appSchema, extensions: [{ name: "x" }, { name: "x" }] })).toThrow('Two extensions are named "x"');
    expect(() => defineTapeDB({ schema: appSchema, extensions: [{ name: "x", changes: {} as never }] })).toThrow("changes.handle must be a function");
  });
});

describe("extension change events", () => {
  async function workspace(handle: (event: { model: string; op: string; row: Record<string, unknown> | null; seq: number }) => void | Promise<void>, models?: string[]) {
    const app = defineTapeDB({ schema: appSchema, extensions: [{ name: "listener", changes: { ...(models ? { models } : {}), handle } }] });
    const db = new Database(":memory:");
    const context = new FakeRoomContext(db, ID);
    const env = { DATA: new FakeR2Bucket(), FILES: new FakeR2Bucket(), TAPEDB_KEY_SECRET: "extension-test-personal-key-secret-32" } as unknown as Env;
    const room = new app.WorkspaceRoom(context as never, env);
    await context.ready;
    const transact = (ops: unknown[]) =>
      room.fetch(
        new Request("http://test/transact", {
          method: "POST",
          headers: { "content-type": "application/json", "x-tapedb-claims": encodeTrustedRoleClaim(claim()) },
          body: JSON.stringify({ txId: crypto.randomUUID(), ops }),
        })
      );
    const outbox = () => db.query(`SELECT url, status, attempts FROM "_webhook_outbox" ORDER BY rowid`).all() as Array<Record<string, unknown>>;
    return { room, transact, outbox };
  }

  test("are handed to the extension in the room after the commit, in order, without a network", async () => {
    const got: string[] = [];
    const w = await workspace((e) => void got.push(`${e.model}:${e.op}:${e.row?.title}`), ["article"]);
    const fetchSpy = mock(globalThis.fetch);
    globalThis.fetch = fetchSpy as never;
    await w.transact([{ op: "insert", namespace: "article", id: "a1", values: { title: "One" } }]);
    await w.transact([{ op: "insert", namespace: "task", id: "t1", values: { title: "Not watched" } }]);
    await w.transact([{ op: "patch", namespace: "article", id: "a1", values: { title: "Two" } }]);
    expect(got).toEqual([]);
    await w.room.alarm();
    expect(got).toEqual(["article:create:One", "article:update:Two"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(w.outbox().map((r) => [r.url, r.status])).toEqual([
      ["tapedb-extension:listener", "delivered"],
      ["tapedb-extension:listener", "delivered"],
    ]);
  });

  test("a handler that throws is retried with backoff, and later events wait behind it", async () => {
    let fail = true;
    const got: string[] = [];
    const w = await workspace((e) => {
      if (fail) throw new Error("bucket unavailable");
      got.push(String(e.row?.title));
    });
    await w.transact([{ op: "insert", namespace: "article", id: "a1", values: { title: "First" } }]);
    await w.transact([{ op: "insert", namespace: "article", id: "a2", values: { title: "Second" } }]);
    await w.room.alarm();
    expect(got).toEqual([]);
    expect(w.outbox().map((r) => [r.status, r.attempts])).toEqual([
      ["pending", 1],
      ["pending", 0],
    ]);
    fail = false;
    setSystemTime(new Date(Date.now() + 60_000));
    await w.room.alarm();
    expect(got).toEqual(["First", "Second"]);
  });
});
