import { AUTH_FILE } from "../../src/cli/auth-template";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "tapedb-auth-"));
const bundle = await build({
  entryPoints: ["scripts/auth/runtime-worker.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["cloudflare:workers", "node:*"],
  conditions: ["workerd", "worker", "browser"],
  alias: {
    "@tapedb/tapedb/auth": resolve("src/auth/index.ts"),
    "@tapedb/tapedb/email": resolve("src/email/index.ts"),
    "@tapedb/tapedb/worker": resolve("src/worker/index.ts"),
  },
  plugins: [
    {
      name: "generated-auth",
      setup(builder) {
        builder.onResolve({ filter: /^tapedb-generated-auth$/ }, () => ({
          path: "auth.ts",
          namespace: "generated-auth",
        }));
        builder.onLoad({ filter: /.*/, namespace: "generated-auth" }, () => ({
          contents: AUTH_FILE,
          loader: "ts",
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
});
function runtime(email = false) {
  return new Miniflare({
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
        TEST_AUTH_EMAIL: email ? "true" : "false",
        BETTER_AUTH_SECRET:
          "test-only-better-auth-secret-at-least-thirty-two-characters",
        EMAIL_FROM: "no-reply@local.test",
      },
      durableObjectsPersist: directory,
    }),
    resourcePersistencePath: directory,
    isolatedResourcePersistencePath: join(directory, "isolated"),
  });
}
let mf = runtime();
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});
test("Better Auth signs up, persists sessions across a runtime restart, then signs out", async () => {
  const signup = await mf.dispatchFetch(
    "https://auth.test/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://auth.test",
      },
      body: JSON.stringify({
        email: "owner@example.test",
        name: "Owner",
        password: "a-long-test-password",
      }),
    },
  );
  expect(signup.status, await signup.clone().text()).toBe(200);
  const cookies = signup.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  expect(cookies).toContain("session_token=");
  const getSession = () =>
    mf.dispatchFetch("https://auth.test/api/auth/get-session", {
      headers: { cookie: cookies },
    });
  const session = (await (await getSession()).json()) as {
    user: { email: string };
  };
  expect(session.user.email).toBe("owner@example.test");
  const call = async (path: string, cookie: string, body?: unknown) =>
    mf.dispatchFetch("https://auth.test" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie,
        origin: "https://auth.test",
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const unowned = crypto.randomUUID();
  expect(
    (await call("/_tapedb/claim", "", { workspaceId: unowned })).status,
  ).toBe(401);
  expect(
    (await call("/_tapedb/claim", cookies, { workspaceId: unowned })).status,
  ).toBe(403);
  const created = await call("/_tapedb/workspaces", cookies, {});
  expect(created.status, await created.clone().text()).toBe(201);
  const workspace = (await created.json()) as { id: string; role: number };
  expect(workspace.role).toBe(6);
  const claimResponse = await call("/_tapedb/claim", cookies, {
    workspaceId: workspace.id,
  });
  expect(claimResponse.status, await claimResponse.clone().text()).toBe(200);
  const claim = (await claimResponse.json()) as { token: string };
  const profileResponse = await mf.dispatchFetch(
    "https://auth.test/engine/workspaces/" + workspace.id + "/query",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + claim.token,
      },
      body: JSON.stringify({ query: { $users: {} } }),
    },
  );
  expect(profileResponse.status, await profileResponse.clone().text()).toBe(
    200,
  );
  expect(await profileResponse.text()).toContain("Owner");
  const externalProfileWrite = await mf.dispatchFetch(
    "https://auth.test/engine/workspaces/" + workspace.id + "/transact",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + claim.token,
      },
      body: JSON.stringify({
        txId: crypto.randomUUID(),
        ops: [
          {
            op: "update",
            namespace: "$users",
            id: (session as unknown as { user: { id: string } }).user.id,
            values: { name: "Forged", image: null },
          },
        ],
      }),
    },
  );
  expect(externalProfileWrite.status).toBe(403);
  const eraseProfile = await mf.dispatchFetch(
    "https://auth.test/_test/stale-profile",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace: workspace.id,
        user: (session as unknown as { user: { id: string } }).user.id,
      }),
    },
  );
  expect(eraseProfile.status, await eraseProfile.clone().text()).toBe(200);
  const erasedProfile = await mf.dispatchFetch(
    "https://auth.test/engine/workspaces/" + workspace.id + "/query",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + claim.token,
      },
      body: JSON.stringify({ query: { $users: {} } }),
    },
  );
  const erasedText = await erasedProfile.text();
  expect(erasedText).not.toContain("Stale profile");
  expect(erasedText).not.toContain("Owner");
  const removeLast = await call(
    "/_tapedb/auth/members?workspaceId=" + workspace.id,
    cookies,
    {
      userId: (session as unknown as { user: { id: string } }).user.id,
      role: 2,
    },
  );
  expect(removeLast.status, await removeLast.clone().text()).toBe(409);
  await mf.dispose();
  mf = runtime();
  const restored = (await (await getSession()).json()) as {
    user: { email: string };
  };
  expect(restored.user.email).toBe("owner@example.test");
  const logout = await mf.dispatchFetch("https://auth.test/api/auth/sign-out", {
    method: "POST",
    headers: {
      cookie: cookies,
      origin: "https://auth.test",
      "content-type": "application/json",
    },
    body: "{}",
  });
  expect(logout.status).toBe(200);
  expect(await (await getSession()).json()).toBeNull();
});

test("generated auth verifies email, resets passwords, and consumes magic links once", async () => {
  await mf.dispose();
  mf = runtime(true);
  const origin = "http://localhost:8787";
  const post = async (path: string, body: unknown, cookie = "") =>
    mf.dispatchFetch(origin + path, {
      method: "POST",
      headers: { origin, "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
  const callbackURL = origin + "/_tapedb/studio/users";
  const signup = await post("/api/auth/sign-up/email", {
    email: "verified@local.test",
    name: "Verified user",
    password: "original-test-password",
    callbackURL,
  });
  expect(signup.status, await signup.clone().text()).toBe(200);
  expect(((await signup.json()) as { token: unknown }).token).toBeNull();
  const inbox = async () => {
    const response = await mf.dispatchFetch(origin + "/_tapedb/dev/emails");
    expect(response.status).toBe(200);
    return (
      (await response.json()) as {
        emails: Array<{ text: string; subject: string }>;
      }
    ).emails;
  };
  let emails = await inbox();
  const verify = await mf.dispatchFetch(emails.at(-1)!.text, {
    redirect: "manual",
  });
  expect(verify.status, await verify.clone().text()).toBe(302);
  const cookies = verify.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  const session = await mf.dispatchFetch(origin + "/api/auth/get-session", {
    headers: { cookie: cookies },
  });
  expect(
    ((await session.json()) as { user: { emailVerified: boolean } }).user
      .emailVerified,
  ).toBe(true);
  const reset = await post("/api/auth/request-password-reset", {
    email: "verified@local.test",
    redirectTo: callbackURL,
  });
  expect(reset.status).toBe(200);
  emails = await inbox();
  const resetLink = await mf.dispatchFetch(emails.at(-1)!.text, {
    redirect: "manual",
  });
  const token = new URL(resetLink.headers.get("location")!).searchParams.get(
    "token",
  );
  expect(token).toBeTruthy();
  expect(
    (
      await post("/api/auth/reset-password", {
        token,
        newPassword: "replacement-test-password",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post("/api/auth/sign-in/email", {
        email: "verified@local.test",
        password: "replacement-test-password",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post("/api/auth/sign-in/magic-link", {
        email: "verified@local.test",
        callbackURL,
      })
    ).status,
  ).toBe(200);
  emails = await inbox();
  const link = emails.at(-1)!.text;
  const first = await mf.dispatchFetch(link, { redirect: "manual" });
  expect(first.status).toBe(302);
  expect(first.headers.getSetCookie().join("")).toContain("session_token");
  const again = await mf.dispatchFetch(link, { redirect: "manual" });
  expect(again.headers.getSetCookie().join("")).not.toContain("session_token=");
  expect(again.headers.get("location")).toContain("error=");
  const magicCookies = first.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  const owned = await post("/_tapedb/workspaces", {}, magicCookies);
  expect(owned.status).toBe(201);
  const ownedWorkspace = (await owned.json()) as { id: string };
  const deniedDelete = await post(
    "/api/auth/delete-user",
    { password: "replacement-test-password" },
    magicCookies,
  );
  expect(deniedDelete.status, await deniedDelete.clone().text()).toBe(403);
  const nextSignup = await post("/api/auth/sign-up/email", {
    email: "next-owner@local.test",
    name: "Next owner",
    password: "another-test-password",
    callbackURL,
  });
  expect(nextSignup.status).toBe(200);
  const next = (await nextSignup.json()) as { user: { id: string } };
  expect(
    (
      await post(
        "/_tapedb/auth/members?workspaceId=" + ownedWorkspace.id,
        { userId: next.user.id, role: 6 },
        magicCookies,
      )
    ).status,
  ).toBe(200);
  const deleted = await post(
    "/api/auth/delete-user",
    { password: "replacement-test-password" },
    magicCookies,
  );
  expect(deleted.status, await deleted.clone().text()).toBe(200);
  const afterDelete = await mf.dispatchFetch(origin + "/api/auth/get-session", {
    headers: { cookie: magicCookies },
  });
  expect(await afterDelete.json()).toBeNull();
  expect(
    (await mf.dispatchFetch("https://auth.test/_tapedb/dev/emails")).status,
  ).toBe(404);
});
