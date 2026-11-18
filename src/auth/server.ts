import type { Env } from "../types";
import type { ClaimIdentity } from "../mint";
import { apiError, json } from "../http";
import { isWorkspaceId } from "../engine/r2-keys";
import { isRoleLevel, WORKSPACE_ROLE_LEVELS } from "../claims";
/** Structural Better Auth surface; the Worker entry never imports Better Auth. */
export interface TapeDBAuthServer {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(input: {
      headers: Headers;
    }): Promise<{ user: { id: string } } | null>;
  };
}
export function authRoom(env: Env) {
  if (!env.AUTH) throw Error("AUTH binding is required with built-in auth");
  const namespace = env.TAPEDB_JURISDICTION
    ? env.AUTH.jurisdiction(
        env.TAPEDB_JURISDICTION as DurableObjectJurisdiction,
      )
    : env.AUTH;
  return namespace.get(namespace.idFromName("auth"));
}
export function authIdentity(
  auth: TapeDBAuthServer,
  request: Request,
  env: Env,
  projectUsers = false,
): ClaimIdentity {
  let session: ReturnType<TapeDBAuthServer["api"]["getSession"]> | undefined;
  return {
    async getSubject() {
      const found = await (session ??= auth.api.getSession({
        headers: request.headers,
      }));
      return found ? { sub: found.user.id } : null;
    },
    async getRole(workspace, user) {
      const room = authRoom(env);
      const role = await room.getRole(workspace, user);
      if (role !== null && projectUsers) {
        const namespace = env.TAPEDB_JURISDICTION
          ? env.WORKSPACE.jurisdiction(
              env.TAPEDB_JURISDICTION as DurableObjectJurisdiction,
            )
          : env.WORKSPACE;
        await namespace
          .get(namespace.idFromName(workspace))
          .syncAuthUsers(await room.workspaceProfiles(workspace, user));
      }
      return role;
    },
  };
}
export async function authManagement(
  request: Request,
  env: Env,
  auth: TapeDBAuthServer,
): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return apiError(401, "not_signed_in", "Sign in first.");
  const url = new URL(request.url),
    room = authRoom(env),
    actor = session.user.id;
  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin)
      return apiError(403, "invalid_origin", "Use the app's own origin.");
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    )
      return apiError(415, "json_required", "Use application/json.");
  }
  try {
    if (url.pathname === "/_tapedb/workspaces") {
      if (request.method === "GET")
        return json({ workspaces: await room.workspaces(actor) });
      if (request.method === "POST")
        return json(await room.createWorkspace(actor), 201);
    }
    if (url.pathname === "/_tapedb/auth/members") {
      const workspace = url.searchParams.get("workspaceId");
      if (!workspace || !isWorkspaceId(workspace))
        return apiError(
          400,
          "invalid_workspace_id",
          "workspaceId must be a UUID.",
        );
      if (request.method === "GET")
        return json({ members: await room.listMembers(actor, workspace) });
      if (request.method === "POST") {
        const body = (await request.json()) as {
          userId?: unknown;
          role?: unknown;
        };
        if (
          !body ||
          typeof body.userId !== "string" ||
          !body.userId ||
          body.userId.length > 256 ||
          (body.role !== null &&
            (!isRoleLevel(body.role) ||
              body.role > WORKSPACE_ROLE_LEVELS.OWNER))
        )
          return apiError(
            400,
            "invalid_membership",
            "Provide userId and a role from 0 to 6, or null to remove.",
          );
        await room.setMember(actor, workspace, body.userId, body.role as never);
        return json({ ok: true });
      }
    }
    return apiError(405, "method_not_allowed", "Use GET or POST.");
  } catch (error) {
    const code = error instanceof Error ? error.message : "auth_unavailable";
    if (code.includes("membership_forbidden"))
      return apiError(
        403,
        "membership_forbidden",
        "Only workspace owners can change membership; admins can list it.",
      );
    if (code.includes("last_owner"))
      return apiError(
        409,
        "last_owner",
        "Add another owner before removing the last owner.",
      );
    if (code.includes("user_not_found"))
      return apiError(404, "user_not_found", "This user has not signed up.");
    if (error instanceof SyntaxError)
      return apiError(400, "invalid_body", "Provide a JSON object.");
    throw error;
  }
}
