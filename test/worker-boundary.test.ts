import { describe, expect, mock, test } from "bun:test";
import { WORKSPACE_ROLE_LEVELS } from "../src/claims";
import { signRoleClaim } from "../src/mint";
import { encodeTrustedRoleClaim } from "../src/verify";
import { model, schema, t } from "../src/schema";
import { FakeR2Bucket, TEST_WORKSPACE } from "./fixtures/test-support";

class MockDurableObject {
  constructor(protected ctx: unknown, protected env: unknown) {}
}
mock.module("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));
const { defineTapeDB } = await import("../src/worker/index");
const secret = "boundary-test-secret-never-production";
const app = defineTapeDB({ schema: schema({ note: model({ text: t.string() }) }) });
const forged = encodeTrustedRoleClaim({ sub: "attacker", workspaceId: TEST_WORKSPACE, role: WORKSPACE_ROLE_LEVELS.OWNER, iat: 0, exp: Math.floor(Date.now() / 1000) + 60 });
function target() {
  const forwarded: Request[] = [];
  return {
    forwarded,
    env: {
      TAPEDB_CLAIM_SECRET: secret, ENVIRONMENT: "production", DATA: new FakeR2Bucket(),
      WORKSPACE: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async (request: Request) => { forwarded.push(request); return Response.json({ ok: true }); } }),
      },
    },
  };
}
const call = (state: ReturnType<typeof target>, suffix: string, headers: Record<string, string>, method = "GET") =>
  app.worker.fetch(new Request(`https://worker.test/engine/workspaces/${TEST_WORKSPACE}${suffix}`, { method, headers }), state.env as never, {} as ExecutionContext);

describe("public Worker trust boundary", () => {
  test("a forged trusted header never reaches a room without a signed token", async () => {
    const state = target();
    for (const [path, method] of [["/status", "GET"], ["/query", "POST"], ["/transact", "POST"], ["/files", "GET"], ["/files/x", "GET"], ["/subjects/alice", "DELETE"], ["", "DELETE"], ["/import", "POST"]]) {
      const response = await call(state, path, { "x-tapedb-claims": forged }, method);
      expect(response.status).toBe(401);
    }
    expect(state.forwarded).toHaveLength(0);
  });

  test("the forwarded identity and role come only from the verified token", async () => {
    const state = target();
    const { token } = await signRoleClaim(secret, { sub: "member", workspaceId: TEST_WORKSPACE, role: WORKSPACE_ROLE_LEVELS.MEMBER });
    expect((await call(state, "/status", { authorization: `Bearer ${token}`, "x-tapedb-claims": forged })).status).toBe(200);
    const encoded = state.forwarded[0].headers.get("x-tapedb-claims")!;
    const claim = JSON.parse(Buffer.from(encoded, "base64url").toString());
    expect(claim).toMatchObject({ sub: "member", role: WORKSPACE_ROLE_LEVELS.MEMBER, workspaceId: TEST_WORKSPACE });
    expect(encoded).not.toBe(forged);
  });

  test("a different workspace token cannot address this workspace or its files", async () => {
    const state = target();
    const { token } = await signRoleClaim(secret, { sub: "owner", workspaceId: "7f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a", role: WORKSPACE_ROLE_LEVELS.OWNER });
    for (const path of ["/status", "/files/x", "/export"]) expect((await call(state, path, { authorization: `Bearer ${token}` })).status).toBe(403);
    expect(state.forwarded).toHaveLength(0);
  });
});
