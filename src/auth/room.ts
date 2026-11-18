import { isWorkspaceId } from "../engine/r2-keys";
import { DurableObject } from "cloudflare:workers";
import { durableObjectSqlExecutor } from "../engine/tx-sql";
import { AuthMembers } from "./members";
import type { WorkspaceRole } from "../claims";
import { AuthSqlStore } from "./sql-store";
import type { AuthCommand, AuthTables } from "./types";

/** One dedicated SQLite object for the app's users, sessions and credentials.
 * Bind AUTH to this class and always address it with idFromName("auth").
 * Only trusted Worker code can call these RPC methods; there is no HTTP API.
 */
export class AuthRoom extends DurableObject<unknown> {
  private readonly database: AuthSqlStore;
  private readonly members: AuthMembers;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    const sql = durableObjectSqlExecutor(ctx.storage);
    this.database = new AuthSqlStore(sql);
    this.members = new AuthMembers(sql);
  }

  /** Trusted migration only: preserve an existing workspace id during auth adoption. */
  async adoptWorkspace(workspace: string, user: string): Promise<void> {
    if (!isWorkspaceId(workspace)) throw Error("invalid_workspace_id");
    if (!(await this.database.profile(user))) throw Error("user_not_found");
    this.members.adopt(workspace, user);
  }
  async prepareUserErasure(user: string) {
    return this.members.prepareErasure(user);
  }
  async finishUserErasure(user: string) {
    this.members.finishErasure(user);
  }
  async createWorkspace(user: string) {
    if (this.members.isErasing(user)) throw Error("user_erasing");
    if (!(await this.database.profile(user))) throw Error("user_not_found");
    return this.members.create(user);
  }
  async getRole(workspace: string, user: string) {
    return this.members.isErasing(user)
      ? null
      : this.members.role(workspace, user);
  }
  async workspaces(user: string) {
    return this.members.workspaces(user);
  }
  async listMembers(actor: string, workspace: string) {
    const members = this.members.list(actor, workspace);
    return Promise.all(
      members.map(async (member) => ({
        ...((await this.members.isErasing(String(member.id)))
          ? Promise.resolve(null)
          : this.database.profile(String(member.id))),
        ...member,
      })),
    );
  }
  async setMember(
    actor: string,
    workspace: string,
    user: string,
    role: WorkspaceRole | null,
  ) {
    if (role !== null && !(await this.database.profile(user)))
      throw Error("user_not_found");
    this.members.set(actor, workspace, user, role);
  }
  async workspaceProfiles(workspace: string, user: string) {
    if (this.members.role(workspace, user) === null)
      throw Error("membership_forbidden");
    return (
      await Promise.all(
        this.members
          .ids(workspace)
          .map((member) =>
            this.members.isErasing(String(member.id))
              ? Promise.resolve(null)
              : this.database.profile(String(member.id)),
          ),
      )
    ).filter(
      (profile): profile is NonNullable<typeof profile> => profile !== null,
    );
  }
  async profile(user: string) {
    return this.database.profile(user);
  }

  async configure(tables: AuthTables): Promise<void> {
    await this.database.configure(tables);
  }

  async execute(command: AuthCommand): Promise<unknown> {
    return this.database.execute(command);
  }
}
