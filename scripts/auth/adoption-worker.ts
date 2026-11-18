// Generic adoption fixture: it contains no deployed app source or account metadata.
import { betterAuth } from "better-auth";
import { tapedbAuth } from "../../src/auth";
import { defineTapeDB, AuthRoom as BaseAuthRoom } from "../../src/worker";
import type { TapeDBAuthEnv } from "../../src/auth";
import { model, schema, t } from "../../src/schema";
export class AuthRoom extends BaseAuthRoom {
  private state: DurableObjectState;
  private bindings: TapeDBAuthEnv;
  constructor(state: DurableObjectState, env: TapeDBAuthEnv) {
    super(state, env);
    this.state = state;
    this.bindings = env;
  }
  async configure(tables: Parameters<BaseAuthRoom["configure"]>[0]) {
    await super.configure(tables);
    await this.state.blockConcurrencyWhile(async () => {
      if (await this.state.storage.get("adopted")) return;
      const now = new Date().toISOString();
      const user = (await this.execute({
        action: "create",
        model: "user",
        data: {
          id: crypto.randomUUID(),
          email: "owner@local.test",
          name: "Test owner",
          emailVerified: 0,
          image: null,
          createdAt: now,
          updatedAt: now,
        },
      })) as { id: string };
      const objects = await this.bindings.DATA.list({
        prefix: "ws/",
        delimiter: "/",
      });
      for (const prefix of objects.delimitedPrefixes)
        await this.adoptWorkspace(prefix.slice(3, -1), user.id);
      await this.state.storage.put("adopted", true);
    });
  }
}
function auth(env: TapeDBAuthEnv) {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: "https://adoption.test",
    database: tapedbAuth({ database: env.AUTH!.getByName("auth") }),
    emailAndPassword: { enabled: true },
  });
}
const app = defineTapeDB({
  schema: schema({ note: model({ text: t.string() }) }),
  auth,
});
export const WorkspaceRoom = app.WorkspaceRoom;
export default {
  async fetch(request: Request, env: TapeDBAuthEnv, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/_test/adoption") {
      const context = await auth(env).$context;
      const owner = await context.adapter.findOne<{
        id: string;
        emailVerified: boolean;
      }>({
        model: "user",
        where: [{ field: "email", value: "owner@local.test" }],
      });
      return Response.json({
        owner,
        workspaces: await env.AUTH!.getByName("auth").workspaces(owner!.id),
      });
    }
    return app.worker.fetch(request, env, ctx);
  },
};
