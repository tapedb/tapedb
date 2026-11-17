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
const OTHER_SECRET = "a-different-secret-for-the-signature-test";
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

  test("take a role and a user to mint for, so rules can be tried as anyone", async () => {
    const devEnv = { ENVIRONMENT: "development", TAPEDB_CLAIM_SECRET: SECRET, TAPEDB_DEV_CLAIMS: "true" };
    const ask = (fields: Record<string, unknown>) =>
      handleClaimRequest(new Request("https://x/_tapedb/claim", { method: "POST", body: JSON.stringify({ workspaceId: WORKSPACE, ...fields }) }), { env: devEnv, devClaims: true });

    const response = await ask({ role: WORKSPACE_ROLE_LEVELS.MEMBER, sub: "alice" });
    const body = (await response.json()) as { token: string; roleLevel: number };
    const claim = await verifyRoleClaim(body.token, env, WORKSPACE);
    expect([claim.sub, claim.role, body.roleLevel]).toEqual(["alice", WORKSPACE_ROLE_LEVELS.MEMBER, WORKSPACE_ROLE_LEVELS.MEMBER]);

    for (const bad of [{ role: 9 }, { role: 1.5 }, { role: "owner" }, { sub: "" }, { sub: "x".repeat(257) }, { sub: 4 }]) {
      expect((await ask(bad)).status).toBe(400);
    }
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

  test("mints a lower role when asked, and never a higher one", async () => {
    const ask = (role: unknown) =>
      handleClaimRequest(
        new Request("https://x/_tapedb/claim", { method: "POST", headers: { "x-test-user": "user-editor" }, body: JSON.stringify({ workspaceId: WORKSPACE, role }) }),
        { env, identity }
      );

    const lower = await ask(WORKSPACE_ROLE_LEVELS.MEMBER);
    expect(lower.status).toBe(200);
    const body = (await lower.json()) as { token: string; roleLevel: number };
    const claim = await verifyRoleClaim(body.token, env, WORKSPACE);
    expect([claim.sub, claim.role, body.roleLevel]).toEqual(["user-editor", WORKSPACE_ROLE_LEVELS.MEMBER, WORKSPACE_ROLE_LEVELS.MEMBER]);

    const same = await ask(WORKSPACE_ROLE_LEVELS.EDITOR);
    expect(same.status).toBe(200);

    const higher = await ask(WORKSPACE_ROLE_LEVELS.OWNER);
    expect(higher.status).toBe(403);
    expect(((await higher.json()) as { error: { code: string } }).error.code).toBe("role_above_membership");

    expect((await ask("admin")).status).toBe(400);
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

  test("the identity's allowRequest limits the claim route before anything else runs", async () => {
    const keys: string[] = [];
    let lookups = 0;
    const limited = {
      ...identity,
      async getSubject(headers: Headers) {
        lookups++;
        return identity.getSubject(headers);
      },
      async allowRequest(key: string) {
        keys.push(key);
        return keys.length <= 1;
      },
    };
    const claim = () =>
      handleClaimRequest(
        new Request("https://x/_tapedb/claim", {
          method: "POST",
          headers: { "x-test-user": "user-editor", "cf-connecting-ip": "203.0.113.7" },
          body: JSON.stringify({ workspaceId: WORKSPACE }),
        }),
        { env, identity: limited }
      );

    expect((await claim()).status).toBe(200);
    const refused = await claim();
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    expect(keys).toEqual(["claim:203.0.113.7", "claim:203.0.113.7"]);
    expect(lookups).toBe(1);

    const broken = await handleClaimRequest(
      new Request("https://x/_tapedb/claim", { method: "POST", body: JSON.stringify({ workspaceId: WORKSPACE }) }),
      { env, identity: { ...identity, allowRequest: async () => { throw new Error("binding down"); } } }
    );
    expect(broken.status).toBe(500);
  });

  test("mintClaim mints the resolved role for the claim route", async () => {
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

describe("claim secret length", () => {
  const short = "x".repeat(31);
  const enough = "x".repeat(32);

  test("signing refuses a secret under 32 bytes", async () => {
    await expect(signRoleClaim(short, { sub: "u", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.MEMBER })).rejects.toThrow("at least 32 bytes");
    await expect(signRoleClaim(enough, { sub: "u", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.MEMBER })).resolves.toHaveProperty("token");
  });

  test("verification refuses a secret under 32 bytes, even for a token signed with it", async () => {
    const { token } = await signRoleClaim(enough, { sub: "u", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.MEMBER });
    const forged = await forgeWithShortSecret(short);
    await expect(verifyRoleClaim(forged, { TAPEDB_CLAIM_SECRET: short }, WORKSPACE)).rejects.toThrow("at least 32 bytes");
    await expect(verifyRoleClaim(token, { TAPEDB_CLAIM_SECRET: enough }, WORKSPACE)).resolves.toHaveProperty("sub", "u");
  });

  test("counts bytes, not characters", async () => {
    // 16 two-byte characters: 32 bytes.
    await expect(signRoleClaim("é".repeat(16), { sub: "u", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.MEMBER })).resolves.toHaveProperty("token");
    await expect(signRoleClaim("é".repeat(15), { sub: "u", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.MEMBER })).rejects.toThrow("at least 32 bytes");
  });

  test("the claim routes answer 500 claim_secret_missing", async () => {
    const identity = { getSubject: async () => ({ sub: "u" }), getRole: async () => WORKSPACE_ROLE_LEVELS.MEMBER };
    const request = () => new Request("https://w.test/_tapedb/claim", { method: "POST", body: JSON.stringify({ workspaceId: WORKSPACE }) });
    const minted = await handleClaimRequest(request(), { env: { TAPEDB_CLAIM_SECRET: short }, identity });
    expect(minted.status).toBe(500);
    expect(await minted.json()).toMatchObject({ error: { code: "claim_secret_missing" } });
    const dev = await handleClaimRequest(request(), { env: { TAPEDB_CLAIM_SECRET: short, TAPEDB_DEV_CLAIMS: "true" }, devClaims: true });
    expect(dev.status).toBe(500);
  });
});

/** A token signed directly with WebCrypto, bypassing signRoleClaim's check. */
async function forgeWithShortSecret(secret: string): Promise<string> {
  const header = base64Url({ alg: "HS256", typ: "JWT" });
  const body = base64Url({ sub: "u", workspaceId: WORKSPACE, role: WORKSPACE_ROLE_LEVELS.OWNER, iat: 0, exp: Math.floor(Date.now() / 1000) + 60 });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`)));
  return `${header}.${body}.${btoa(String.fromCharCode(...signature)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}
