import type { Env } from "../types";
import { authRoom } from "./server";
/** Better Auth deleteUser.beforeDelete hook. Transfer sole ownership first.
 * A durable job keeps the affected workspaces available if an erasure is retried.
 */
export async function eraseAuthUser(env: Env, userId: string): Promise<void> {
  const room = authRoom(env);
  const workspaces = await room.prepareUserErasure(userId);
  const namespace = env.TAPEDB_JURISDICTION
    ? env.WORKSPACE.jurisdiction(
        env.TAPEDB_JURISDICTION as DurableObjectJurisdiction,
      )
    : env.WORKSPACE;
  for (const workspace of workspaces) {
    await namespace
      .get(namespace.idFromName(workspace))
      .eraseAuthSubject(userId);
  }
  await room.finishUserErasure(userId);
}
