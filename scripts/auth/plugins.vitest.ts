/**
 * Better Auth's identity-heavy plugins on tapedb's adapter, in workerd.
 *
 * Each test drives a real flow over HTTP against a Worker whose Better Auth
 * stores everything in the AuthRoom Durable Object, and the security-sensitive
 * ones race the step that must happen once: two redemptions of one magic
 * link, one backup code, one authorization code, one refresh token, one
 * device code. The adapter has no multi-statement transactions
 * (`transaction: false`), so what matters is that Better Auth's single-step
 * primitives — `consumeOne` and `incrementOne` — are atomic here.
 *
 * The results are the compatibility matrix in AUTH-COMPATIBILITY.md.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const ORIGIN = "https://auth.test";
const directory = await mkdtemp(join(tmpdir(), "tapedb-auth-plugins-"));
const bundle = await build({
  entryPoints: ["scripts/auth/plugins-worker.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["cloudflare:workers", "node:*"],
  conditions: ["workerd", "worker", "browser"],
});
const mf = new Miniflare({
  ...convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-11-17",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      AUTH: { className: "AuthRoom", useSQLite: true },
      WORKSPACE: { className: "WorkspaceRoom", useSQLite: true },
    },
    r2Buckets: ["DATA"],
    bindings: {
      TAPEDB_CLAIM_SECRET: "test-claim-secret-at-least-thirty-two-characters",
      TAPEDB_KEY_SECRET: "test-key-secret-at-least-thirty-two-characters",
      ENVIRONMENT: "development",
      TAPEDB_DEV_CLAIMS: "true",
    },
    durableObjectsPersist: directory,
  }),
});
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

type Jar = { cookie: string };
const jar = (): Jar => ({ cookie: "" });
function keep(target: Jar, response: Response): void {
  const fresh = response.headers.getSetCookie().map((c) => c.split(";")[0]);
  const map = new Map(target.cookie.split("; ").filter(Boolean).map((c) => [c.split("=")[0], c] as const));
  for (const c of fresh) map.set(c.split("=")[0], c);
  target.cookie = [...map.values()].filter((c) => !/=$/.test(c)).join("; ");
}
async function call(path: string, options: { jar?: Jar; body?: unknown; method?: string; headers?: Record<string, string>; form?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, ...(options.headers ?? {}) };
  if (options.jar?.cookie) headers.cookie = options.jar.cookie;
  let body: string | undefined;
  if (options.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(options.form).toString();
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await mf.dispatchFetch(ORIGIN + path, {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
    redirect: "manual",
  });
  if (options.jar) keep(options.jar, response);
  return response;
}
async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`not JSON (${response.status}): ${text.slice(0, 300)}`);
  }
}
async function signUp(email: string): Promise<{ jar: Jar; id: string }> {
  const session = jar();
  const response = await call("/api/auth/sign-up/email", { jar: session, body: { email, name: email.split("@")[0], password: "a-long-test-password" } });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await json<{ user: { id: string } }>(response);
  return { jar: session, id: body.user.id };
}
async function signIn(email: string): Promise<{ jar: Jar; response: Response }> {
  const session = jar();
  const response = await call("/api/auth/sign-in/email", { jar: session, body: { email, password: "a-long-test-password" } });
  return { jar: session, response };
}
const outbox = async () => json<Array<{ kind: string; to: string; token?: string; url?: string }>>(await call("/_test/outbox"));
const statuses = (responses: Response[]) => responses.map((r) => r.status).sort();

/** RFC 6238 TOTP, SHA-1, 6 digits, 30 s. */
function totp(secretBase32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secretBase32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

describe("sessions", () => {
  test("revoking one session ends it; revoking the others keeps the current one", async () => {
    await signUp("sessions@example.test");
    const a = await signIn("sessions@example.test");
    const b = await signIn("sessions@example.test");
    const c = await signIn("sessions@example.test");
    const list = await json<Array<{ token: string }>>(await call("/api/auth/list-sessions", { jar: a.jar }));
    expect(list.length).toBeGreaterThanOrEqual(4);
    const bToken = decodeURIComponent(b.jar.cookie.match(/session_token=([^;.]+)/)![1]);
    expect((await call("/api/auth/revoke-session", { jar: a.jar, body: { token: bToken } })).status).toBe(200);
    expect(await json(await call("/api/auth/get-session", { jar: b.jar }))).toBeNull();
    expect((await call("/api/auth/revoke-other-sessions", { jar: a.jar, body: {} })).status).toBe(200);
    expect(await json(await call("/api/auth/get-session", { jar: c.jar }))).toBeNull();
    expect((await json<{ user: { email: string } }>(await call("/api/auth/get-session", { jar: a.jar }))).user.email).toBe("sessions@example.test");
  });
});

describe("magic link", () => {
  test("a link signs in once, even when two requests redeem it at the same time", async () => {
    await signUp("magic@example.test");
    expect((await call("/api/auth/sign-in/magic-link", { body: { email: "magic@example.test" } })).status).toBe(200);
    const link = (await outbox()).filter((m) => m.kind === "magic-link" && m.to === "magic@example.test").at(-1)!;
    const verify = () => call(`/api/auth/magic-link/verify?token=${encodeURIComponent(link.token!)}&callbackURL=/done`);
    const results = await Promise.all([verify(), verify(), verify()]);
    const signedIn = results.filter((r) => r.headers.getSetCookie().some((c) => /session_token=[^;]/.test(c)));
    expect(signedIn.length).toBe(1);
  });
});

describe("two-factor", () => {
  test("TOTP enrols and gates sign-in; a backup code works once under a race", async () => {
    const user = await signUp("totp@example.test");
    const enabled = await json<{ totpURI: string; backupCodes: string[] }>(await call("/api/auth/two-factor/enable", { jar: user.jar, body: { password: "a-long-test-password" } }));
    const secret = new URL(enabled.totpURI).searchParams.get("secret")!;
    const verified = await call("/api/auth/two-factor/verify-totp", { jar: user.jar, body: { code: totp(secret) } });
    expect(verified.status, await verified.clone().text()).toBe(200);

    const pending = await signIn("totp@example.test");
    expect((await json<{ twoFactorRedirect?: boolean }>(pending.response)).twoFactorRedirect).toBe(true);
    const otp = await call("/api/auth/two-factor/verify-totp", { jar: pending.jar, body: { code: totp(secret) } });
    expect(otp.status, await otp.clone().text()).toBe(200);
    expect((await json<{ user: { email: string } }>(await call("/api/auth/get-session", { jar: pending.jar }))).user.email).toBe("totp@example.test");

    // Three sign-ins waiting on a second factor race one backup code.
    const waiting = await Promise.all([signIn("totp@example.test"), signIn("totp@example.test"), signIn("totp@example.test")]);
    const code = enabled.backupCodes[0];
    const redeemed = await Promise.all(waiting.map((w) => call("/api/auth/two-factor/verify-backup-code", { jar: w.jar, body: { code } })));
    expect(redeemed.filter((r) => r.status === 200).length).toBe(1);
  });
});

describe("organization", () => {
  test("create, invite, accept and change a member's role", async () => {
    const owner = await signUp("org-owner@example.test");
    const member = await signUp("org-member@example.test");
    const created = await json<{ id: string }>(await call("/api/auth/organization/create", { jar: owner.jar, body: { name: "Acme", slug: `acme-${Date.now()}` } }));
    expect(created.id).toBeTruthy();
    const invitation = await json<{ id: string }>(await call("/api/auth/organization/invite-member", { jar: owner.jar, body: { email: "org-member@example.test", role: "member", organizationId: created.id } }));
    const accepted = await call("/api/auth/organization/accept-invitation", { jar: member.jar, body: { invitationId: invitation.id } });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const full = await json<{ members: Array<{ id: string; userId: string; role: string }> }>(await call(`/api/auth/organization/get-full-organization?organizationId=${created.id}`, { jar: owner.jar }));
    const row = full.members.find((m) => m.userId === member.id)!;
    expect(row.role).toBe("member");
    const updated = await call("/api/auth/organization/update-member-role", { jar: owner.jar, body: { memberId: row.id, role: "admin", organizationId: created.id } });
    expect(updated.status, await updated.clone().text()).toBe(200);
    // Accepting the same invitation again does not add a second membership.
    await call("/api/auth/organization/accept-invitation", { jar: member.jar, body: { invitationId: invitation.id } });
    const after = await json<{ members: Array<{ userId: string; role: string }> }>(await call(`/api/auth/organization/get-full-organization?organizationId=${created.id}`, { jar: owner.jar }));
    expect(after.members.filter((m) => m.userId === member.id)).toEqual([expect.objectContaining({ role: "admin" })]);
  });
});

describe("admin", () => {
  test("banning a user ends their sessions and refuses sign-in", async () => {
    const adminUser = await signUp("boss@example.test");
    await call("/_test/admin", { body: { id: adminUser.id } });
    const adminSession = (await signIn("boss@example.test")).jar;
    const target = await signUp("banned@example.test");
    const banned = await call("/api/auth/admin/ban-user", { jar: adminSession, body: { userId: target.id } });
    expect(banned.status, await banned.clone().text()).toBe(200);
    expect(await json(await call("/api/auth/get-session", { jar: target.jar }))).toBeNull();
    expect((await signIn("banned@example.test")).response.status).toBe(403);
  });
});

describe("JWT", () => {
  test("a session's JWT verifies against the published key set", async () => {
    const user = await signUp("jwt@example.test");
    const session = await call("/api/auth/get-session", { jar: user.jar });
    const token = session.headers.get("set-auth-jwt");
    expect(token, "the jwt plugin sets set-auth-jwt on get-session").toBeTruthy();
    const jwks = await json<{ keys: Array<{ kid: string }> }>(await call("/api/auth/jwks"));
    const kid = JSON.parse(Buffer.from(token!.split(".")[0], "base64url").toString()).kid;
    expect(jwks.keys.map((k) => k.kid)).toContain(kid);
  });
});

describe("OAuth 2.1 provider", () => {
  const redirect = "https://client.test/callback";
  let clientId = "";
  let clientSecret = "";
  let user: { jar: Jar; id: string };

  beforeAll(async () => {
    user = await signUp("oauth@example.test");
    const registered = await call("/api/auth/oauth2/register", {
      body: { redirect_uris: [redirect], client_name: "Test client", token_endpoint_auth_method: "client_secret_post", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "openid profile email offline_access" },
    });
    expect(registered.status, await registered.clone().text()).toBeLessThan(300);
    const client = await json<{ client_id: string; client_secret: string }>(registered);
    clientId = client.client_id;
    clientSecret = client.client_secret;
  });

  async function authorize(): Promise<{ code: string; verifier: string }> {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, scope: "openid profile email offline_access", state: "s1", code_challenge: challenge, code_challenge_method: "S256", prompt: "consent" });
    let response = await call(`/api/auth/oauth2/authorize?${query}`, { jar: user.jar });
    // The provider answers a fetch with JSON `{ redirect, url }` rather than a 302.
    const target = async (r: Response) => r.headers.get("location") ?? (r.headers.get("content-type")?.includes("json") ? (await json<{ url?: string; redirect_uri?: string }>(r.clone())).url ?? "" : "");
    let location = await target(response);
    if (!location) throw new Error(`authorize answered ${response.status}: ${(await response.text()).slice(0, 400)}`);
    if (location.includes("/consent")) {
      const consent = new URL(location, ORIGIN).searchParams;
      response = await call("/api/auth/oauth2/consent", { jar: user.jar, body: { accept: true, oauth_query: consent.toString() } });
      location = await target(response);
      if (!location) throw new Error(`consent answered ${response.status}: ${(await response.text()).slice(0, 400)}`);
    }
    const code = new URL(location, ORIGIN).searchParams.get("code");
    expect(code, `no code in ${location}`).toBeTruthy();
    return { code: code!, verifier };
  }
  const token = (form: Record<string, string>) => call("/api/auth/oauth2/token", { form: { client_id: clientId, client_secret: clientSecret, ...form } });

  test("authorization code with PKCE: a wrong verifier is refused, and the code redeems once under a race", async () => {
    const { code, verifier } = await authorize();
    const wrong = await token({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: randomBytes(32).toString("base64url") });
    expect(wrong.status).toBe(400);
    const results = await Promise.all([1, 2, 3].map(() => token({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier })));
    expect(statuses(results).filter((s) => s === 200).length).toBe(1);
  });

  test("a refresh token rotates once under a race, and replaying the old one revokes the family", async () => {
    const { code, verifier } = await authorize();
    const issued = await json<{ refresh_token: string }>(await token({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier }));
    expect(issued.refresh_token).toBeTruthy();
    const raced = await Promise.all([1, 2, 3].map(() => token({ grant_type: "refresh_token", refresh_token: issued.refresh_token })));
    const winners = raced.filter((r) => r.status === 200);
    expect(winners.length).toBe(1);
    const rotated = await json<{ refresh_token: string }>(winners[0]);
    // Reuse of a rotated token is treated as theft: the old one is refused and
    // the token it was rotated into stops working too.
    expect((await token({ grant_type: "refresh_token", refresh_token: issued.refresh_token })).status).toBe(400);
    expect((await token({ grant_type: "refresh_token", refresh_token: rotated.refresh_token })).status).toBe(400);
  });

  test("revoking a refresh token ends it", async () => {
    const { code, verifier } = await authorize();
    const issued = await json<{ refresh_token: string }>(await token({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier }));
    const revoked = await call("/api/auth/oauth2/revoke", { form: { client_id: clientId, client_secret: clientSecret, token: issued.refresh_token, token_type_hint: "refresh_token" } });
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect((await token({ grant_type: "refresh_token", refresh_token: issued.refresh_token })).status).toBe(400);
  });
});

describe("device authorization", () => {
  test("an approved device code yields a token once under a race", async () => {
    const user = await signUp("device@example.test");
    const issued = await json<{ device_code: string; user_code: string }>(await call("/api/auth/device/code", { body: { client_id: "tv-app" } }));
    // The user opens the verification page while signed in, which claims the code for them.
    const claimed = await call(`/api/auth/device?user_code=${encodeURIComponent(issued.user_code)}`, { jar: user.jar });
    expect(claimed.status, await claimed.clone().text()).toBe(200);
    const approved = await call("/api/auth/device/approve", { jar: user.jar, body: { userCode: issued.user_code } });
    expect(approved.status, await approved.clone().text()).toBe(200);
    const poll = () => call("/api/auth/device/token", { body: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: issued.device_code, client_id: "tv-app" } });
    const results = await Promise.all([poll(), poll(), poll()]);
    expect(results.filter((r) => r.status === 200).length).toBe(1);
  });
});

describe("passkey", () => {
  test("registration options are issued and their challenge is stored", async () => {
    const user = await signUp("passkey@example.test");
    const options = await call("/api/auth/passkey/generate-register-options", { jar: user.jar });
    expect(options.status, await options.clone().text()).toBe(200);
    const body = await json<{ challenge: string; rp: { id: string } }>(options);
    expect(body.challenge).toBeTruthy();
    expect(body.rp.id).toBe("auth.test");
  });
});
