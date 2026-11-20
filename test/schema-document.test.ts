/**
 * GET /schema describes the models for tooling. The studio reads which field
 * stores each link, to name related rows and offer a picker for them.
 */
import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS } from "../src/claims";
import { encodeTrustedRoleClaim } from "../src/verify";
import { createSqlStorage } from "./fixtures/room-harness";
import { FakeR2Bucket, TEST_WORKSPACE } from "./fixtures/test-support";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");
const { model, schema, t } = await import("../src/schema");

test("the schema document names the field that stores each link, and each field's default", async () => {
  const tapedb = defineTapeDB({
    schema: schema({
      board: model({ name: t.string(), archived: t.boolean().default(false), rank: t.number().default(3), columns: t.hasMany("column") }),
      column: model({ name: t.string(), board: t.belongsTo("board") }),
      card: model({ title: t.string(), column: t.belongsTo("column", { onDelete: "cascade" }) }),
    }),
  });
  const db = new Database(":memory:");
  const ctx = {
    id: { name: TEST_WORKSPACE },
    storage: { sql: createSqlStorage(db), transactionSync: <T>(fn: () => T) => db.transaction(fn)(), getAlarm: async () => null, setAlarm: async () => {} },
    ready: Promise.resolve() as Promise<unknown>,
    blockConcurrencyWhile<T>(fn: () => Promise<T>) {
      this.ready = fn();
      return this.ready as Promise<T>;
    },
    getWebSockets: () => [],
  };
  // The room comes from the deployment that was just defined: it carries that
  // deployment's configuration, not whatever was defined last in this process.
  const room = new tapedb.WorkspaceRoom(ctx as never, { DATA: new FakeR2Bucket() } as never);
  await ctx.ready;
  const claim = encodeTrustedRoleClaim({ sub: "u", workspaceId: TEST_WORKSPACE, role: WORKSPACE_ROLE_LEVELS.MEMBER, iat: 0, exp: Math.floor(Date.now() / 1000) + 60 });
  const response = await room.fetch(new Request("http://room/schema", { headers: { "x-tapedb-claims": claim } }));
  const body = (await response.json()) as { data: { links: Array<{ foreignKey: unknown; forward: { namespace: string }; reverse: { namespace: string } }> } };
  expect(body.data.links).toHaveLength(2);
  const [link, cascade] = body.data.links;
  expect((cascade.foreignKey as { onDelete: string }).onDelete).toBe("CASCADE");
  expect(link.foreignKey).toEqual({ namespace: "column", attribute: expect.any(String), onDelete: "SET NULL" });
  const attribute = (link.foreignKey as { attribute: string }).attribute;
  const columns = (await (await room.fetch(new Request("http://room/schema", { headers: { "x-tapedb-claims": claim } }))).json()) as { data: { namespaces: Array<{ apiName: string; attributes: Record<string, unknown> }> } };
  expect(Object.keys(columns.data.namespaces.find((n) => n.apiName === "column")!.attributes)).toContain(attribute);
  // Defaults as written in the schema, for the studio's read-only structure.
  const board = columns.data.namespaces.find((n) => n.apiName === "board")!.attributes as Record<string, { default: unknown }>;
  expect([board.archived.default, board.rank.default, board.name.default]).toEqual([false, 3, null]);
});

test("the schema document says who may do what, with filter rules evaluated for the caller", async () => {
  const { role, filter, check, attachedTo } = await import("../src/schema");
  const tapedb = defineTapeDB({
    schema: schema(
      {
        board: model({ name: t.string(), ownerId: t.string().index(), open: t.boolean().default(false) }).access({
          read: filter(({ auth }) => [{ ownerId: auth.sub }, { open: true }]),
          update: check(({ auth, row }) => row?.ownerId === auth.sub),
          delete: role("admin"),
        }),
        note: model({ body: t.string() }),
      },
      { files: { read: attachedTo("board", (path) => path.split("/")[0]), write: role("member") } }
    ),
  });
  const db = new Database(":memory:");
  const ctx = {
    id: { name: TEST_WORKSPACE },
    storage: { sql: createSqlStorage(db), transactionSync: <T>(fn: () => T) => db.transaction(fn)(), getAlarm: async () => null, setAlarm: async () => {} },
    ready: Promise.resolve() as Promise<unknown>,
    blockConcurrencyWhile<T>(fn: () => Promise<T>) {
      this.ready = fn();
      return this.ready as Promise<T>;
    },
    getWebSockets: () => [],
  };
  const room = new tapedb.WorkspaceRoom(ctx as never, { DATA: new FakeR2Bucket() } as never);
  await ctx.ready;
  const claim = encodeTrustedRoleClaim({ sub: "alice", workspaceId: TEST_WORKSPACE, role: WORKSPACE_ROLE_LEVELS.EDITOR, iat: 0, exp: Math.floor(Date.now() / 1000) + 60 });
  const response = await room.fetch(new Request("http://room/schema", { headers: { "x-tapedb-claims": claim } }));
  const data = ((await response.json()) as { data: { caller: unknown; files: unknown; namespaces: Array<{ apiName: string; access: unknown }> } }).data;
  expect(data.caller).toEqual({ sub: "alice", role: WORKSPACE_ROLE_LEVELS.EDITOR });
  expect(data.files).toEqual({
    read: { rule: "attachedTo", model: "board" },
    write: { rule: "role", role: WORKSPACE_ROLE_LEVELS.MEMBER },
    delete: { rule: "role", role: WORKSPACE_ROLE_LEVELS.EDITOR },
  });
  const access = Object.fromEntries(data.namespaces.map((n) => [n.apiName, n.access]));
  expect(access.board).toEqual({
    read: { rule: "filter", where: [{ ownerId: "alice" }, { open: true }] },
    create: { rule: "role", role: WORKSPACE_ROLE_LEVELS.EDITOR },
    update: { rule: "check" },
    delete: { rule: "role", role: WORKSPACE_ROLE_LEVELS.ADMIN },
  });
  expect(access.note).toEqual({
    read: { rule: "role", role: WORKSPACE_ROLE_LEVELS.MEMBER },
    create: { rule: "role", role: WORKSPACE_ROLE_LEVELS.EDITOR },
    update: { rule: "role", role: WORKSPACE_ROLE_LEVELS.EDITOR },
    delete: { rule: "role", role: WORKSPACE_ROLE_LEVELS.MODERATOR },
  });
});
