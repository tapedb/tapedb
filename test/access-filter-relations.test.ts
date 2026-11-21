/**
 * A `filter()` read rule that names a relation.
 *
 * `grants: { some: { subject: auth.sub } }` is the ordinary way to express
 * per-object access, so it has to work as a read rule and not only as a query.
 * It did not: the rule builder compiled the filter without the model graph, so
 * `toEngineWhere` could not resolve the relation target and threw. A throwing
 * read rule hides every row, which is why the whole catalog looked empty to
 * everybody instead of failing loudly.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_LEVELS, type RoleClaim, type WorkspaceRole } from "../src/claims";
import { MemoryOutbox } from "../src/client/outbox";
import { defaultDeploymentConfig } from "../src/engine/config";
import { configureMigrations } from "../src/engine/migrations-bundle";
import { executeQueryWithPageInfo } from "../src/engine/query-execute";
import { configureRegistry } from "../src/engine/registry";
import { configurePermissions } from "../src/engine/tx-permissions";
import type { SqlExecutor, SqlRow, SqlValue } from "../src/engine/tx-sql";
import { runTransaction } from "../src/engine/tx-pipeline";
import { TxError } from "../src/engine/tx-types";
import { createClient } from "../src/model/client";
import { filter, model, schema, t } from "../src/schema";

const engineConfig = defaultDeploymentConfig();
const WORKSPACE = "7f2d3a4b-5c6d-4e8f-9a0b-1c2d3e4f5a6b";

const models = {
  project: model({
    title: t.string(),
    createdBy: t.string().index(),
    grants: t.hasMany("grant"),
  }).access({
    read: filter(({ auth }) => [
      { createdBy: auth.sub },
      { grants: { some: { subject: auth.sub } } },
    ]),
  }),
  grant: model({
    project: t.belongsTo("project", { onDelete: "cascade" }),
    subject: t.string().index(),
  }).access({
    read: filter(({ auth }) => ({ subject: auth.sub })),
  }),
};

let sql: SqlExecutor;
let appSchema: ReturnType<typeof schema>;

function claimFor(sub: string, role: WorkspaceRole = WORKSPACE_ROLE_LEVELS.EDITOR): RoleClaim {
  const now = Math.floor(Date.now() / 1000);
  return { sub, workspaceId: WORKSPACE, role, exp: now + 600, iat: now };
}

function client(sub: string, role: WorkspaceRole = WORKSPACE_ROLE_LEVELS.EDITOR) {
  const claim = claimFor(sub, role);
  return createClient(
    { schema: appSchema, url: "http://engine.test", workspace: WORKSPACE, getToken: async () => "t" },
    {
      outbox: new MemoryOutbox(),
      createWebSocket: () => {
        throw new Error("no socket here");
      },
      fetch: async (url: string, init?: { body?: string }) => {
        const body = init?.body === undefined ? undefined : JSON.parse(init.body);
        try {
          if (url.endsWith("/transact")) {
            return Response.json({ ok: true, result: runTransaction(sql, WORKSPACE, claim, body, engineConfig) });
          }
          const { data, pageInfo } = executeQueryWithPageInfo(sql, claim, body);
          return Response.json({ ok: true, data, pageInfo });
        } catch (error) {
          if (error instanceof TxError) {
            return Response.json({ ok: false, error: error.toJSON() }, { status: 400 });
          }
          throw error;
        }
      },
    }
  );
}

beforeEach(() => {
  appSchema = schema(models);
  configureRegistry(appSchema.registry);
  configureMigrations(appSchema.migrations);
  configurePermissions({ overrides: { ...appSchema.permissions.overrides } });

  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of appSchema.migrations) db.exec(migration.sql);
  sql = {
    exec: (q: string, ...p: SqlValue[]) => db.query(q).run(...(p as never[])).changes,
    all: <T extends SqlRow = SqlRow>(q: string, ...p: SqlValue[]) => db.query(q).all(...(p as never[])) as T[],
    one: <T extends SqlRow = SqlRow>(q: string, ...p: SqlValue[]) =>
      (db.query(q).get(...(p as never[])) ?? undefined) as T | undefined,
    transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
  };
});

async function seed() {
  const owner = client("alice", WORKSPACE_ROLE_LEVELS.OWNER);
  await owner.project.create({ data: { id: "p-own", title: "Own", createdBy: "alice" } });
  await owner.project.create({ data: { id: "p-shared", title: "Shared", createdBy: "mallory" } });
  await owner.grant.create({ data: { id: "g-bob", projectId: "p-shared", subject: "bob" } });
}

describe("a read rule naming a relation", () => {
  test("admits the grantee and hides the project from everyone else", async () => {
    await seed();
    const ids = async (sub: string) =>
      (await client(sub).project.findMany({ orderBy: { id: "asc" } })).map((row) => row.id);

    // The creator keeps access without a grant row, and only to her own row.
    expect(await ids("alice")).toEqual(["p-own"]);
    // The grant is the only way in for anyone else.
    expect(await ids("bob")).toEqual(["p-shared"]);
    // No grant, no rows.
    expect(await ids("carol")).toEqual([]);
  });

  test("the rule compiles to a link branch instead of throwing", () => {
    const where = (appSchema as unknown as {
      permissions: { overrides: Record<string, { view: { where: (auth: unknown) => unknown } }> };
    }).permissions.overrides.project!.view.where;
    // Before the fix this threw "undefined is not an object", and the engine
    // turns a throwing read rule into "hide every row".
    expect(where({ sub: "bob", role: WORKSPACE_ROLE_LEVELS.EDITOR, workspaceId: WORKSPACE })).toEqual([
      { createdBy: "bob" },
      { $link: [{ label: "grants", mode: "some", where: { subject: "bob" } }] },
    ]);
  });
});
