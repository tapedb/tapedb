/** Auth scaffolding is generated only when the app opts in. */
export const AUTH_FILE = `import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { magicLink } from "better-auth/plugins";
import { tapedbAuth, authDatabase, eraseAuthUser, type TapeDBAuthEnv } from "@tapedb/tapedb/auth";
import { mailer } from "@tapedb/tapedb/email";
import type { TapeDBAuthServer } from "@tapedb/tapedb/worker";

export function auth(env: TapeDBAuthEnv, request: Request): TapeDBAuthServer {
  if (!env.AUTH || !env.BETTER_AUTH_SECRET) throw new Error("AUTH and BETTER_AUTH_SECRET are required.");
  const development = env.ENVIRONMENT !== "production" && env.TAPEDB_DEV_CLAIMS === "true";
  const email = mailer({ from: env.EMAIL_FROM ?? "", binding: env.EMAIL, development });
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: new URL(request.url).origin,
    rateLimit: { enabled: env.ENVIRONMENT === "production", storage: "database" },
    database: tapedbAuth({ database: authDatabase(env) }),
    user: { deleteUser: { enabled: true, beforeDelete: async (user) => { try { await eraseAuthUser(env,user.id); } catch(error) { if(error instanceof Error && error.message.includes("Transfer workspace ownership")) throw new APIError("FORBIDDEN",{message:"Transfer workspace ownership before erasing your account."}); throw error; } } } },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => { await email.send({ to: user.email, subject: "Reset your password", text: url }); },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => { await email.send({ to: user.email, subject: "Verify your email", text: url }); },
    },
    plugins: [magicLink({ sendMagicLink: async ({ email: to, url }) => { await email.send({ to, subject: "Your sign-in link", text: url }); } })],
  });
}
`;
export const AUTH_WORKER_FILE = `import { studio } from "@tapedb/tapedb/studio";
import { defineTapeDB } from "@tapedb/tapedb/worker";
import schema from "./tapedb.schema";
import { migrations } from "./tapedb/migrations.gen";
import { auth } from "./auth";
import { authPage } from "./tapedb/auth-page.gen";
const tapedb = defineTapeDB({ schema, migrations, auth, authPage, studio, audit: true });
export const WorkspaceRoom = tapedb.WorkspaceRoom;
export const AuthRoom = tapedb.AuthRoom;
export default tapedb.worker;
`;
