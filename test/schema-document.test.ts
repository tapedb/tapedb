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
const { WorkspaceRoom } = await import("../src/engine/workspace-room");
const { model, schema, t } = await import("../src/schema");

test("the schema document names the field that stores each link, and each field's default", async () => {
  defineTapeDB({
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
  const room = new WorkspaceRoom(ctx as never, { DATA: new FakeR2Bucket() } as never);
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
