import { auth as generatedAuth } from "tapedb-generated-auth";
import type { TapeDBAuthEnv } from "../../src/auth";
import { tapedbAuth } from "../../src/auth";
import { betterAuth } from "better-auth";
import { studio } from "../../src/studio";
import { defineTapeDB } from "../../src/worker";
import { schema, model, t } from "../../src/schema";
const tapedb = defineTapeDB({
  schema: schema({
    note: model({ text: t.string(), author: t.belongsTo("$users") }),
  }),
  devClaims: true,
  studio,
  auth(env, request) {
    if (
      (env as TapeDBAuthEnv & { TEST_AUTH_EMAIL?: string }).TEST_AUTH_EMAIL ===
      "true"
    )
      return generatedAuth(env, request);
    if (!env.AUTH) throw Error("Missing AUTH");
    const database = env.AUTH.get(env.AUTH.idFromName("auth"));
    return betterAuth({
      secret: "test-only-auth-secret-at-least-thirty-two-characters",
      baseURL: "https://auth.test",
      database: tapedbAuth({ database }),
      emailAndPassword: { enabled: true },
    });
  },
});
export const WorkspaceRoom = tapedb.WorkspaceRoom;
export const AuthRoom = tapedb.AuthRoom;
export default {
  async fetch(
    request: Request,
    env: Parameters<typeof tapedb.worker.fetch>[1],
    ctx: ExecutionContext,
  ) {
    if (new URL(request.url).pathname === "/_test/stale-profile") {
      const { workspace, user } = (await request.json()) as {
        workspace: string;
        user: string;
      };
      const room = env.WORKSPACE.getByName(workspace);
      await room.eraseAuthSubject(user);
      await room.syncAuthUsers([
        { id: user, name: "Stale profile", image: null },
      ]);
      return Response.json({ ok: true });
    }
    return tapedb.worker.fetch(request, env, ctx);
  },
};
