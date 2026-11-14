/**
 * Claim minting and verification.
 *
 * The interesting assertions are the refusals: a claim the engine accepts when
 * it should not is the one failure that matters here.
 */

import { describe, expect, test } from "bun:test";

import { handleClaimRequest } from "../src/claim-route";
import { WORKSPACE_ROLE_LEVELS, type WorkspaceRole } from "../src/claims";
import { mintClaim, mintDevClaim, signRoleClaim } from "../src/mint";
import { ClaimError, extractClaimToken, verifyRoleClaim } from "../src/verify";

const SECRET = "test-secret-do-not-use-in-production";
const OTHER_SECRET = "a-different-secret";
const WORKSPACE = "6f1c2f3e-6b1a-4c9a-9a6f-2f3e6b1a4c9a";
const OTHER_WORKSPACE = "11111111-2222-4333-8444-555555555555";

const env = { TAPEDB_CLAIM_SECRET: SECRET };

function base64Url(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("sign and verify", () => {
  test("round trips a claim the engine accepts", async () => {
    const minted = await signRoleClaim(SECRET, {
      sub: "user-1",
      workspaceId: WORKSPACE,
      role: WORKSPACE_ROLE_LEVELS.EDITOR,
    });

    const claim = await verifyRoleClaim(minted.token, env, WORKSPACE);
    expect(claim.sub).toBe("user-1");
    expect(claim.role).toBe(WORKSPACE_ROLE_LEVELS.EDITOR);
    expect(claim.workspaceId).toBe(WORKSPACE);
    expect(minted.expiresIn).toBe(300);
  });

  test("rejects a tampered payload even with a valid signature shape", async () => {
    const minted = await signRoleClaim(SECRET, {
      sub: "user-1",
      workspaceId: WORKSPACE,
      role: WORKSPACE_ROLE_LEVELS.GUEST,
    });

    const [header, , signature] = minted.token.split(".");
    const escalated = base64Url({
      sub: "user-1",
      workspaceId: WORKSPACE,
      role: WORKSPACE_ROLE_LEVELS.OWNER,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    await expect(
      verifyRoleClaim(`${header}.${escalated}.${signature}`, env, WORKSPACE)
    ).rejects.toThrow(/signature is invalid/);
  });

  test("rejects a claim signed with another secret", async () => {
    const minted = await signRoleClaim(OTHER_SECRET, {
      sub: "user-1",
      workspaceId: WORKSPACE,
      role: WORKSPACE_ROLE_LEVELS.OWNER,
    });

    await expect(verifyRoleClaim(minted.token, env, WORKSPACE)).rejects.toThrow(
      /signature is invalid/
    );
  });

  test("rejects an expired claim", async () => {
    const minted = await signRoleClaim(
      SECRET,
      { sub: "user-1", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.MEMBER, ttlSeconds: 60 },
      Date.now() - 10 * 60 * 1000
    );

    await expect(verifyRoleClaim(minted.token, env, WORKSPACE)).rejects.toThrow(
      /expired/
    );
  });

  test("rejects a claim minted for another workspace", async () => {
    const minted = await signRoleClaim(SECRET, {
      sub: "user-1",
      workspaceId: OTHER_WORKSPACE,
      role: WORKSPACE_ROLE_LEVELS.OWNER,
    });

    await expect(verifyRoleClaim(minted.token, env, WORKSPACE)).rejects.toThrow(
      /different workspace/
    );
  });

  test("rejects an unsigned token, not just a badly signed one", async () => {
    const header = base64Url({ alg: "none", typ: "JWT" });
    const payload = base64Url({
      sub: "user-1",
      workspaceId: WORKSPACE,
      role: WORKSPACE_ROLE_LEVELS.OWNER,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    await expect(
      verifyRoleClaim(`${header}.${payload}.`, env, WORKSPACE)
    ).rejects.toThrow(ClaimError);
  });
});

describe("dev claims", () => {
  test("mints an OWNER claim that verifies", async () => {
    const minted = await mintDevClaim(WORKSPACE, SECRET);
    const claim = await verifyRoleClaim(minted.token, env, WORKSPACE);
    expect(claim.sub).toBe("dev-user");
    expect(claim.role).toBe(WORKSPACE_ROLE_LEVELS.OWNER);
  });

  test("are served when the Worker is not production", async () => {
    const response = await handleClaimRequest(
      new Request("https://x/_tapedb/claim", {
        method: "POST",
        body: JSON.stringify({ workspaceId: WORKSPACE }),
      }),
      { env: { ENVIRONMENT: "development", TAPEDB_CLAIM_SECRET: SECRET, TAPEDB_DEV_CLAIMS: "true" }, devClaims: true }
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string };
    const claim = await verifyRoleClaim(body.token, env, WORKSPACE);
    expect(claim.role).toBe(WORKSPACE_ROLE_LEVELS.OWNER);
  });

  test("are refused in production even when devClaims is set", async () => {
    const response = await handleClaimRequest(
      new Request("https://x/_tapedb/claim", {
        method: "POST",
        body: JSON.stringify({ workspaceId: WORKSPACE }),
      }),
      { env: { ENVIRONMENT: "production", TAPEDB_CLAIM_SECRET: SECRET, TAPEDB_DEV_CLAIMS: "true" }, devClaims: true }
    );

    expect(response.status).toBe(501);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("identity_not_configured");
  });

  test("are refused when the deployment did not opt in", async () => {
    // The code flag alone is not enough: a plain `wrangler deploy` never sets
    // TAPEDB_DEV_CLAIMS, so the route must stay closed even in "development".
    const response = await handleClaimRequest(
      new Request("https://x/_tapedb/claim", {
        method: "POST",
        body: JSON.stringify({ workspaceId: WORKSPACE }),
      }),
      { env: { ENVIRONMENT: "development", TAPEDB_CLAIM_SECRET: SECRET }, devClaims: true }
    );

    expect(response.status).toBe(501);
  });

  test("with TAPEDB_DEV_CLAIMS_TOKEN set, mint only for requests carrying that token", async () => {
    const gated = { ENVIRONMENT: "staging", TAPEDB_CLAIM_SECRET: SECRET, TAPEDB_DEV_CLAIMS: "true", TAPEDB_DEV_CLAIMS_TOKEN: "run-token-1234" };
    const ask = (headers: Record<string, string>) =>
      handleClaimRequest(
        new Request("https://x/_tapedb/claim", { method: "POST", headers, body: JSON.stringify({ workspaceId: WORKSPACE }) }),
        { env: gated, devClaims: true }
      );

    for (const headers of [{}, { "x-tapedb-dev-token": "wrong" }, { "x-tapedb-dev-token": "run-token-123" }, { "x-tapedb-dev-token": "run-token-12345" }]) {
      const refused = await ask(headers);
      expect(refused.status).toBe(401);
      const body = (await refused.json()) as { error: { code: string }; token?: string };
      expect(body.error.code).toBe("dev_token_required");
      expect(body.token).toBeUndefined();
    }

    const allowed = await ask({ "x-tapedb-dev-token": "run-token-1234" });
    expect(allowed.status).toBe(200);
    const claim = await verifyRoleClaim(((await allowed.json()) as { token: string }).token, env, WORKSPACE);
    expect(claim.role).toBe(WORKSPACE_ROLE_LEVELS.OWNER);
  });

  test("reject a malformed workspace id", async () => {
    const response = await handleClaimRequest(
      new Request("https://x/_tapedb/claim", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "not-a-uuid" }),
      }),
      { env: { ENVIRONMENT: "development", TAPEDB_CLAIM_SECRET: SECRET, TAPEDB_DEV_CLAIMS: "true" }, devClaims: true }
    );

    expect(response.status).toBe(400);
  });
});

describe("identity adapter", () => {
  const identity = {
    async getSubject(headers: Headers) {
      const sub = headers.get("x-test-user");
      return sub ? { sub } : null;
    },
    async getRole(workspaceId: string, sub: string) {
      if (workspaceId !== WORKSPACE) return null;
      const roles: Record<string, WorkspaceRole> = {
        "user-editor": WORKSPACE_ROLE_LEVELS.EDITOR,
        "user-guest": WORKSPACE_ROLE_LEVELS.GUEST,
      };
      return roles[sub] ?? null;
    },
  };

  test("refuses an unauthenticated request", async () => {
    const response = await handleClaimRequest(
      new Request("https://x/_tapedb/claim", {
        method: "POST",
        body: JSON.stringify({ workspaceId: WORKSPACE }),
      }),
      { env, identity }
    );

    expect(response.status).toBe(401);
  });

  test("refuses a signed-in non-member", async () => {
    const response = await handleClaimRequest(
      new Request("https://x/_tapedb/claim", {
        method: "POST",
        headers: { "x-test-user": "user-stranger" },
        body: JSON.stringify({ workspaceId: WORKSPACE }),
      }),
      { env, identity }
    );

    expect(response.status).toBe(403);
  });

  test("mints the resolved role, not a default", async () => {
    const response = await handleClaimRequest(
      new Request("https://x/_tapedb/claim", {
        method: "POST",
        headers: { "x-test-user": "user-editor" },
        body: JSON.stringify({ workspaceId: WORKSPACE }),
      }),
      { env, identity }
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string };
    const claim = await verifyRoleClaim(body.token, env, WORKSPACE);
    expect(claim.sub).toBe("user-editor");
    expect(claim.role).toBe(WORKSPACE_ROLE_LEVELS.EDITOR);
  });

  test("mintClaim is reachable directly for custom routes", async () => {
    const response = await mintClaim(
      new Request("https://x/_tapedb/claim", {
        method: "POST",
        headers: { "x-test-user": "user-guest" },
        body: JSON.stringify({ workspaceId: WORKSPACE }),
      }),
      { identity, secret: SECRET }
    );

    const body = (await response.json()) as { token: string };
    const claim = await verifyRoleClaim(body.token, env, WORKSPACE);
    expect(claim.role).toBe(WORKSPACE_ROLE_LEVELS.GUEST);
  });
});

describe("claim transport", () => {
  test("reads a WebSocket upgrade's claim from Sec-WebSocket-Protocol", () => {
    const request = new Request("https://x.test/engine/workspaces/w/websocket", {
      headers: { "sec-websocket-protocol": "tapedb, tapedb.claim.h.p.s" },
    });
    expect(extractClaimToken(request)).toBe("h.p.s");
  });

  test("never reads a claim from the URL", () => {
    expect(extractClaimToken(new Request("https://x.test/engine/workspaces/w/websocket?claim=h.p.s"))).toBeNull();
  });

  test("an Authorization header wins and is never mixed with the protocol header", () => {
    const bearer = new Request("https://x.test/", { headers: { authorization: "Bearer a.b.c", "sec-websocket-protocol": "tapedb.claim.h.p.s" } });
    expect(extractClaimToken(bearer)).toBe("a.b.c");
    const basic = new Request("https://x.test/", { headers: { authorization: "Basic xyz", "sec-websocket-protocol": "tapedb.claim.h.p.s" } });
    expect(extractClaimToken(basic)).toBeNull();
  });
});
