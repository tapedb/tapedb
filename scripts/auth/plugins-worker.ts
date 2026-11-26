// A Worker with Better Auth's identity-heavy plugins on tapedb's adapter, for
// scripts/auth/plugins.vitest.ts. Emails and codes the plugins would send are
// kept in memory and read back through /_test/outbox.
import { betterAuth } from "better-auth";
import { admin, bearer, deviceAuthorization, jwt, magicLink, organization, twoFactor } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { tapedbAuth } from "../../src/auth";
import type { TapeDBAuthEnv } from "../../src/auth";
import { defineTapeDB } from "../../src/worker";
import { schema, model, t } from "../../src/schema";

const outbox: Array<{ kind: string; to: string; token?: string; url?: string; otp?: string }> = [];


let adminId: string | null = null;

function auth(env: TapeDBAuthEnv) {
  if (!env.AUTH) throw Error("Missing AUTH");
  const database = env.AUTH.get(env.AUTH.idFromName("auth"));
  return betterAuth({
    secret: "test-only-auth-secret-at-least-thirty-two-characters",
    baseURL: "https://auth.test",
    trustedOrigins: ["https://auth.test", "https://client.test"],
    database: tapedbAuth({ database }),
    emailAndPassword: { enabled: true },
    // The OAuth provider issues its own tokens; Better Auth's session cookie
    // stays the login for its consent page.
    disabledPaths: ["/token"],
    plugins: [
      jwt(),
      bearer(),
      twoFactor({ issuer: "tapedb-test" }),
      organization({
        sendInvitationEmail: async (data) => {
          outbox.push({ kind: "invitation", to: data.email, token: data.id });
        },
      }),
      admin({ adminUserIds: adminId ? [adminId] : [] }),
      magicLink({
        sendMagicLink: async ({ email, token, url }) => {
          outbox.push({ kind: "magic-link", to: email, token, url });
        },
      }),
      deviceAuthorization({ validateClient: async () => true, expiresIn: "10m", interval: "1s" }),
      passkey({ rpID: "auth.test", rpName: "tapedb test", origin: "https://auth.test" }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
    ],
  });
}

const tapedb = defineTapeDB({
  schema: schema({ note: model({ text: t.string() }) }),
  devClaims: true,
  auth: (env) => auth(env as TapeDBAuthEnv),
});

export const WorkspaceRoom = tapedb.WorkspaceRoom;
export const AuthRoom = tapedb.AuthRoom;
export default {
  async fetch(request: Request, env: Parameters<typeof tapedb.worker.fetch>[1], ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/_test/outbox") return Response.json(outbox);
    if (url.pathname === "/_test/admin") {
      // Which user the admin plugin treats as an admin; set after sign-up.
      adminId = ((await request.json()) as { id: string }).id;
      return Response.json({ ok: true });
    }
    return tapedb.worker.fetch(request, env, ctx);
  },
};
