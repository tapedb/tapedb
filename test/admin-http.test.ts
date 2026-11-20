/**
 * The admin HTTP API: `POST /v1/query`, `/v1/transact`, `/v1/claim`.
 *
 * Two properties matter more than the routes themselves, and most of these
 * tests are about them:
 *
 *   1. **It is opt-in.** A deployment without `http` answers 404 on these
 *      paths, not 401, so an API nobody enabled cannot be found by probing.
 *   2. **It is not a way around the rules.** A request names who it acts as,
 *      and the engine judges that identity exactly as it judges a socket
 *      holding the same claim — including a rule that denies a high role, and
 *      the write budget the socket path spends.
 *
 * The Worker under test is the real one and the rooms are real
 * `WorkspaceRoom`s over in-memory SQLite, so the answers here are the answers
 * a deployment would give.
 */

import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim } from "../src/claims";
import { signRoleClaim } from "../src/mint";
import { check, filter, model, role, schema, t } from "../src/schema";
import { encodeTrustedRoleClaim, TRUSTED_CLAIM_HEADER } from "../src/verify";
import { FakeR2Bucket } from "./fixtures/test-support";
import { FakeRoomContext } from "./fixtures/room-harness";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");

const SECRET = "admin-http-test-secret-test-test-1234";
/** 36 bytes: over the 32-byte floor, and long enough to notice in a leak. */
const TOKEN = "tapedb-admin-token-0123456789abcdefghij";
const SHORT_TOKEN = "tapedb-admin-token-too-short";
const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a01";
const OTHER = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a02";

const { MEMBER, EDITOR, ADMIN } = WORKSPACE_ROLE_LEVELS;

/**
 * `note` has a `filter` view rule, so the rows a caller sees depend on the
 * subject in the claim — the sharpest way to see whether `as` is honoured.
 * `task` has a `check` create rule, so a high role alone is not enough.
 */
const models = schema({
  note: model({ title: t.string(), ownerId: t.string() }).access({
    read: filter(({ auth }) => ({ ownerId: auth.sub })),
    create: role("editor"),
    update: role("editor"),
    delete: role("moderator"),
  }),
  task: model({ title: t.string(), ownerId: t.string() }).access({
    read: role("member"),
    create: check(({ auth, data }) => data?.ownerId === auth.sub),
    update: role("editor"),
    delete: role("moderator"),
  }),
});

/** The deployment these tests exercise: the API is on, and `task` is budgeted. */
const app = defineTapeDB({
  schema: models,
  http: { token: TOKEN },
  limits: { writes: { models: { task: { count: 2, windowSeconds: 60 } } } },
});

/** The same schema with no `http`: the paths must not exist at all. */
const closed = defineTapeDB({ schema: models });

interface Entry {
  context: FakeRoomContext;
  room: InstanceType<typeof app.WorkspaceRoom>;
}

/**
 * One Worker with its own buckets and its own rooms. Each test builds a fresh
 * one, so a write budget spent in one cannot explain a refusal in the next.
 */
function harness(worker: typeof app) {
  const data = new FakeR2Bucket();
  const files = new FakeR2Bucket();
  const rooms = new Map<string, Entry>();

  const env = {
    DATA: data,
    FILES: files,
    TAPEDB_CLAIM_SECRET: SECRET,
    ENVIRONMENT: "development",
    WORKSPACE: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async (input: Request | string, init?: RequestInit) => {
          let entry = rooms.get(name);
          if (entry === undefined) {
            const context = new FakeRoomContext(new Database(":memory:"), name);
            entry = { context, room: new worker.WorkspaceRoom(context as never, env as never) };
            rooms.set(name, entry);
          }
          await entry.context.ready;
          return entry.room.fetch(typeof input === "string" ? new Request(input, init) : input);
        },
      }),
    },
  } as never;

  const request = (path: string, init: RequestInit = {}) =>
    worker.worker.fetch(new Request(`https://tapedb.test${path}`, init), env, {} as ExecutionContext);

  const post = (path: string, body: unknown, token: string | null = TOKEN) =>
    request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });

  /** The room directly, with the claim a socket for that identity would hold. */
  const asRoom = (workspace: string, path: string, body: unknown, identity: { sub: string; role: number }) => {
    const claim: RoleClaim = {
      sub: identity.sub,
      workspaceId: workspace,
      role: identity.role as RoleClaim["role"],
      iat: 0,
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    // Straight to the Durable Object, as the Worker's own room call does: the
    // Worker strips every `x-tapedb-*` header a client sends, so a trusted
    // claim only ever arrives by this path.
    return (env as unknown as { WORKSPACE: { get(name: string): { fetch(input: Request): Promise<Response> } } })
      .WORKSPACE.get(workspace)
      .fetch(
        new Request(`https://room.internal${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", [TRUSTED_CLAIM_HEADER]: encodeTrustedRoleClaim(claim) },
          body: JSON.stringify(body),
        })
      );
  };

  return { env, request, post, asRoom, rooms };
}

const noteWrite = (id: string, ownerId: string, title = `note ${id}`) => ({
  op: "insert",
  namespace: "note",
  id,
  values: { title, ownerId },
});

const taskWrite = (id: string, ownerId: string) => ({
  op: "insert",
  namespace: "task",
  id,
  values: { title: `task ${id}`, ownerId },
});

describe("opt-in", () => {
  test("without `http` the paths 404, even with the right token", async () => {
    const h = harness(closed);
    for (const route of ["/v1/query", "/v1/transact", "/v1/claim"]) {
      const response = await h.post(route, { workspace: WORKSPACE, as: { sub: "u1", role: MEMBER }, query: {}, writes: [] });
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("no_route");
    }
    // No Durable Object was addressed: the paths are not merely refused.
    expect(h.rooms.size).toBe(0);
  });

  test("with `http` an unknown /v1 path is a 404, and a wrong method a 405", async () => {
    const h = harness(app);
    const unknown = await h.post("/v1/presence", { workspace: WORKSPACE, as: { sub: "u1", role: MEMBER } });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("no_route");

    const wrongMethod = await h.request("/v1/query", {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(wrongMethod.status).toBe(405);
    expect(((await wrongMethod.json()) as { error: { code: string } }).error.code).toBe("method_not_allowed");
  });

  test("a token under 32 bytes is refused where the Worker is defined", () => {
    expect(() => defineTapeDB({ schema: models, http: { token: SHORT_TOKEN } })).toThrow(/at least 32 bytes/);
    // The floor is 32 bytes, not 33.
    expect(() => defineTapeDB({ schema: models, http: { token: "a".repeat(32) } })).not.toThrow();
  });

  test("a token from `env` is checked on the request that resolves it", async () => {
    const fromEnv = defineTapeDB({ schema: models, http: { token: (env) => env.TAPEDB_API_TOKEN } });
    const h = harness(fromEnv);
    // Nothing in `env`: no caller can be authorised, and the token is not echoed.
    const missing = await h.post("/v1/query", { workspace: WORKSPACE, as: { sub: "u1", role: MEMBER }, query: {} });
    expect(missing.status).toBe(500);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("api_token_misconfigured");

    // A short secret from the environment is still refused, without echoing it.
    const short = await fromEnv.worker.fetch(
      new Request("https://tapedb.test/v1/query", {
        method: "POST",
        headers: { authorization: `Bearer ${SHORT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ workspace: WORKSPACE, as: { sub: "u1", role: MEMBER }, query: {} }),
      }),
      { ...(h.env as object), TAPEDB_API_TOKEN: SHORT_TOKEN } as never,
      {} as ExecutionContext
    );
    const text = await short.text();
    expect(short.status).toBe(500);
    expect(text).not.toContain(SHORT_TOKEN);
  });
});

describe("the token", () => {
  test("a wrong, absent or claim-shaped token is refused and leaks nothing", async () => {
    const h = harness(app);
    const seeded = await h.post("/v1/transact", {
      workspace: WORKSPACE,
      as: { sub: "u1", role: EDITOR },
      writes: [noteWrite("n1", "u1", "Secret note")],
    });
    expect(seeded.status).toBe(200);

    // A valid engine claim is not an API token: the two secrets are different.
    const { token: claim } = await signRoleClaim(SECRET, { sub: "u1", workspaceId: WORKSPACE, role: ADMIN });

    for (const [label, token] of [
      ["absent", null],
      ["wrong", "not-the-token-not-the-token-not-the-t"],
      ["claim", claim],
      ["prefix", TOKEN.slice(0, -1)],
    ] as Array<[string, string | null]>) {
      const response = await h.post(
        "/v1/query",
        { workspace: WORKSPACE, as: { sub: "u1", role: MEMBER }, query: { note: {} } },
        token
      );
      expect({ label, status: response.status }).toEqual({ label, status: 401 });
      const text = await response.text();
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("Secret note");
      expect(text).not.toContain("tapedb.test");
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["error"]);
      expect((body.error as { code: string }).code).toBe("unauthorized");
    }
    expect(h.rooms.size).toBe(1);
  });

  test("the token never appears in a refusal body", async () => {
    const h = harness(app);
    const bodies: string[] = [];
    for (const [route, body] of [
      ["/v1/query", { workspace: "nope", as: { sub: "u1", role: MEMBER }, query: {} }],
      ["/v1/transact", { workspace: WORKSPACE, as: { sub: "u1", role: MEMBER }, writes: [] }],
      ["/v1/transact", { workspace: WORKSPACE, as: { sub: "", role: MEMBER }, writes: [noteWrite("n1", "u1")] }],
      ["/v1/claim", { workspace: WORKSPACE, as: { sub: "u1", role: 99 } }],
    ] as Array<[string, unknown]>) {
      const response = await h.post(route, body);
      expect(response.ok).toBe(false);
      bodies.push(await response.text());
    }
    for (const text of bodies) expect(text).not.toContain(TOKEN);
  });
});

describe("query", () => {
  test("returns exactly what the same claim sees over the room path", async () => {
    const h = harness(app);
    for (const [sub, title] of [["u1", "u1 note"], ["u2", "u2 note"]]) {
      const written = await h.post("/v1/transact", {
        workspace: WORKSPACE,
        as: { sub, role: EDITOR },
        writes: [noteWrite(`n-${sub}`, sub, title)],
      });
      expect(written.status).toBe(200);
    }

    const read = async (identity: { sub: string; role: number }) => {
      const response = await h.post("/v1/query", {
        workspace: WORKSPACE,
        as: identity,
        query: { note: {} },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; data: { note: Array<{ title: string; ownerId: string }> } };
      expect(body.ok).toBe(true);
      return body.data.note;
    };

    // The `filter` view rule decides, not the API: u1 sees its row, u2 its own.
    const mine = await read({ sub: "u1", role: MEMBER });
    expect(mine.map((row) => row.title)).toEqual(["u1 note"]);
    expect((await read({ sub: "u2", role: MEMBER })).map((row) => row.title)).toEqual(["u2 note"]);

    // And the same claim through the room's own read path answers identically.
    const direct = await h.asRoom(WORKSPACE, "/query", { query: { note: {} } }, { sub: "u1", role: MEMBER });
    expect(((await direct.json()) as { data: { note: unknown[] } }).data.note).toEqual(mine);
  });

  test("a role the rules refuse is refused here too", async () => {
    const h = harness(app);
    await h.post("/v1/transact", {
      workspace: WORKSPACE,
      as: { sub: "u1", role: EDITOR },
      writes: [noteWrite("n1", "u1")],
    });
    const guest = await h.post("/v1/query", { workspace: WORKSPACE, as: { sub: "u1", role: WORKSPACE_ROLE_LEVELS.GUEST }, query: { note: {} } });
    // `note.read` is a filter, so a GUEST sees the filter's rows, not a 403;
    // `task.read` is a role rule and must refuse below MEMBER.
    expect(guest.status).toBe(200);
    const tasks = await h.post("/v1/query", { workspace: WORKSPACE, as: { sub: "u1", role: WORKSPACE_ROLE_LEVELS.GUEST }, query: { task: {} } });
    expect(tasks.status).toBe(403);
    // Whatever the engine's read path calls a refused role, the API repeats:
    // the answer is the room's, not this route's own idea of one.
    expect(["permission_denied", "insufficient_role"]).toContain(
      ((await tasks.json()) as { error: { code: string } }).error.code
    );
  });

  test("a malformed query is the engine's answer, not a 500", async () => {
    const h = harness(app);
    const response = await h.post("/v1/query", { workspace: WORKSPACE, as: { sub: "u1", role: MEMBER }, query: "note" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_query");

    const empty = await h.post("/v1/query", { workspace: WORKSPACE, as: { sub: "u1", role: MEMBER } });
    expect(empty.status).toBe(400);
  });
});

describe("transact", () => {
  test("applies rows and appears in the log", async () => {
    const h = harness(app);
    const written = await h.post("/v1/transact", {
      workspace: WORKSPACE,
      as: { sub: "u1", role: EDITOR },
      writes: [noteWrite("n1", "u1", "logged")],
    });
    expect(written.status).toBe(200);
    const body = (await written.json()) as { ok: boolean; result: { applied: number; seq: number } };
    expect(body.ok).toBe(true);
    expect(body.result.applied).toBe(1);
    expect(body.result.seq).toBeGreaterThan(0);

    // A claim minted by /v1/claim reads the log over the ordinary engine route.
    const claimed = await h.post("/v1/claim", { workspace: WORKSPACE, as: { sub: "boss", role: ADMIN } });
    expect(claimed.status).toBe(200);
    const minted = (await claimed.json()) as { token: string; workspaceId: string; roleLevel: number; expiresAt: number; expiresIn: number };
    expect(minted.workspaceId).toBe(WORKSPACE);
    expect(minted.roleLevel).toBe(ADMIN);
    expect(minted.expiresIn).toBeGreaterThan(0);

    const log = await h.request(`/engine/workspaces/${WORKSPACE}/log?limit=10`, {
      headers: { authorization: `Bearer ${minted.token}` },
    });
    expect(log.status).toBe(200);
    const entries = ((await log.json()) as { data: { entries: Array<{ rows: number; counts: Record<string, Record<string, number>> }> } }).data.entries;
    expect(entries[0]?.rows).toBe(1);
    expect(Object.values(entries[0]!.counts.note ?? {})).toEqual([1]);
  });

  test("a rule that denies the model denies it whatever role the backend names", async () => {
    const h = harness(app);
    // `task.create` requires the row's owner to be the caller. ADMIN is not a
    // licence: the rule runs for whoever `as` names.
    const denied = await h.post("/v1/transact", {
      workspace: WORKSPACE,
      as: { sub: "u1", role: ADMIN },
      writes: [taskWrite("t1", "u2")],
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("permission_denied");

    const allowed = await h.post("/v1/transact", {
      workspace: WORKSPACE,
      as: { sub: "u1", role: EDITOR },
      writes: [taskWrite("t2", "u1")],
    });
    expect(allowed.status).toBe(200);

    const rows = await h.post("/v1/query", { workspace: WORKSPACE, as: { sub: "u1", role: MEMBER }, query: { task: {} } });
    const data = ((await rows.json()) as { data: { task: Array<{ id: string }> } }).data.task;
    expect(data.map((row) => row.id)).toEqual(["t2"]);
  });

  test("a replayed clientTxId does not write twice", async () => {
    const h = harness(app);
    const write = {
      workspace: WORKSPACE,
      as: { sub: "u1", role: EDITOR },
      writes: [noteWrite("n1", "u1")],
      clientTxId: "retry-1",
    };
    expect((await h.post("/v1/transact", write)).status).toBe(200);

    const replay = await h.post("/v1/transact", write);
    expect(replay.status).toBe(200);
    const replayed = (await replay.json()) as { ok: boolean; result: { applied: number } };
    expect(replayed.ok).toBe(true);
    // The receipt answers the retry; nothing was applied a second time.
    expect(replayed.result.applied).toBe(0);

    const rows = await h.post("/v1/query", { workspace: WORKSPACE, as: { sub: "u1", role: MEMBER }, query: { note: {} } });
    expect(((await rows.json()) as { data: { note: unknown[] } }).data.note).toHaveLength(1);

    // The same id with different operations is a conflict, not a second write.
    const different = await h.post("/v1/transact", {
      ...write,
      writes: [noteWrite("n2", "u1")],
    });
    expect(different.status).toBe(409);
    expect(((await different.json()) as { error: { code: string } }).error.code).toBe("conflict");
  });

  test("a malformed body is a 400 with the engine's codes", async () => {
    const h = harness(app);
    const cases: Array<[unknown, string]> = [
      [{ workspace: "not-a-uuid", as: { sub: "u1", role: EDITOR }, writes: [noteWrite("n1", "u1")] }, "invalid_workspace_id"],
      [{ workspace: WORKSPACE, as: "u1", writes: [noteWrite("n1", "u1")] }, "invalid_as"],
      [{ workspace: WORKSPACE, as: { sub: "", role: EDITOR }, writes: [noteWrite("n1", "u1")] }, "invalid_sub"],
      [{ workspace: WORKSPACE, as: { sub: "u1", role: 9 }, writes: [noteWrite("n1", "u1")] }, "invalid_role"],
      [{ workspace: WORKSPACE, as: { sub: "u1", role: EDITOR }, writes: [] }, "invalid_envelope"],
      [{ workspace: WORKSPACE, as: { sub: "u1", role: EDITOR }, writes: [{ op: "nope", namespace: "note" }] }, "invalid_op"],
    ];
    for (const [body, code] of cases) {
      const response = await h.post("/v1/transact", body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
    }
  });
});

describe("write budgets", () => {
  test("admin writes spend the budget, and a refusal is the socket path's 429", async () => {
    const h = harness(app);
    const create = (id: string, token: string | null = TOKEN) =>
      h.post(
        "/v1/transact",
        { workspace: WORKSPACE, as: { sub: "u1", role: EDITOR }, writes: [taskWrite(id, "u1")] },
        token
      );

    expect((await create("t1")).status).toBe(200);
    expect((await create("t2")).status).toBe(200);

    const refused = await create("t3");
    expect(refused.status).toBe(429);
    const retryAfter = refused.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    const body = (await refused.json()) as {
      ok: boolean;
      error: { code: string; model: string; limit: number; windowSeconds: number; retryAfterMs: number };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.model).toBe("task");
    expect(body.error.limit).toBe(2);
    expect(body.error.windowSeconds).toBe(60);
    expect(body.error.retryAfterMs).toBeGreaterThan(0);
    // The header and the body agree.
    expect(Number(retryAfter)).toBe(Math.max(1, Math.ceil(body.error.retryAfterMs / 1000)));

    const rows = await h.post("/v1/query", { workspace: WORKSPACE, as: { sub: "u1", role: MEMBER }, query: { task: {} } });
    expect(((await rows.json()) as { data: { task: unknown[] } }).data.task).toHaveLength(2);

    // The budget is the workspace's, not the API's: a client with a claim is
    // refused by the same counter, so the admin API is not a way around it.
    const { token } = await signRoleClaim(SECRET, { sub: "u1", workspaceId: WORKSPACE, role: EDITOR });
    const socket = await h.request(`/engine/workspaces/${WORKSPACE}/transact`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ txId: "socket-t3", ops: [taskWrite("t3", "u1")] }),
    });
    expect(socket.status).toBe(429);
    expect(((await socket.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
  });
});

describe("workspaces", () => {
  test("a workspace id that is not a UUID is a 400, not a 500", async () => {
    const h = harness(app);
    const response = await h.post("/v1/query", { workspace: "workspace-1", as: { sub: "u1", role: MEMBER }, query: {} });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_workspace_id");
    expect(h.rooms.size).toBe(0);
  });

  test("a workspace with no data yet answers empty, as a claim would", async () => {
    const h = harness(app);
    const response = await h.post("/v1/query", { workspace: OTHER, as: { sub: "u1", role: MEMBER }, query: { note: {} } });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: { note: unknown[] } }).data.note).toEqual([]);
  });

  test("one workspace's writes are not visible in another", async () => {
    const h = harness(app);
    await h.post("/v1/transact", {
      workspace: WORKSPACE,
      as: { sub: "u1", role: EDITOR },
      writes: [noteWrite("n1", "u1")],
    });
    const other = await h.post("/v1/query", { workspace: OTHER, as: { sub: "u1", role: MEMBER }, query: { note: {} } });
    expect(((await other.json()) as { data: { note: unknown[] } }).data.note).toEqual([]);
  });
});
