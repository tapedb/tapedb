import type { SqlExecutor } from "../engine/tx-sql";
import {
  WORKSPACE_ROLE_LEVELS,
  isRoleLevel,
  type WorkspaceRole,
} from "../claims";

/** Trusted server-side membership operations; every change is checked atomically. */
export class AuthMembers {
  constructor(private sql: SqlExecutor) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS __tapedb_workspaces (id TEXT PRIMARY KEY NOT NULL, createdAt INTEGER NOT NULL)",
    );
    sql.exec("CREATE TABLE IF NOT EXISTS __tapedb_erasing_users (user TEXT PRIMARY KEY NOT NULL)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS __tapedb_erasure_jobs (user TEXT NOT NULL, workspace TEXT NOT NULL, PRIMARY KEY(user,workspace))",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS __tapedb_members (workspace TEXT NOT NULL REFERENCES __tapedb_workspaces(id) ON DELETE CASCADE, user TEXT NOT NULL, role INTEGER NOT NULL CHECK(role BETWEEN 0 AND 6), PRIMARY KEY(workspace,user))",
    );
  }
  create(user: string): { id: string; role: WorkspaceRole } {
    if (!user) throw Error("not_signed_in");
    if (this.isErasing(user)) throw Error("user_erasing");
    return this.sql.transactionSync(() => {
      const id = crypto.randomUUID();
      this.sql.exec(
        "INSERT INTO __tapedb_workspaces(id,createdAt) VALUES(?,?)",
        id,
        Date.now(),
      );
      this.sql.exec(
        "INSERT INTO __tapedb_members(workspace,user,role) VALUES(?,?,?)",
        id,
        user,
        WORKSPACE_ROLE_LEVELS.OWNER,
      );
      return { id, role: WORKSPACE_ROLE_LEVELS.OWNER };
    });
  }
  /** Trusted migration only. There is intentionally no public adoption route. */
  adopt(workspace: string, user: string): void {
    this.sql.transactionSync(() => {
      if (
        this.sql.one("SELECT id FROM __tapedb_workspaces WHERE id=?", workspace)
      )
        throw Error("workspace_already_registered");
      if (!user || this.isErasing(user)) throw Error("user_erasing");
      this.sql.exec(
        "INSERT INTO __tapedb_workspaces(id,createdAt) VALUES(?,?)",
        workspace,
        Date.now(),
      );
      this.sql.exec(
        "INSERT INTO __tapedb_members(workspace,user,role) VALUES(?,?,6)",
        workspace,
        user,
      );
    });
  }
  isErasing(user: string) {
    return Boolean(
      this.sql.one(
        "SELECT user FROM __tapedb_erasing_users WHERE user=?",
        user,
      ),
    );
  }
  prepareErasure(user: string): string[] {
    return this.sql.transactionSync(() => {
      const workspaces = this.workspaces(user);
      for (const workspace of workspaces) {
        if (
          workspace.role === WORKSPACE_ROLE_LEVELS.OWNER &&
          Number(
            this.sql.one(
              "SELECT COUNT(*) AS n FROM __tapedb_members m WHERE workspace=? AND role=6 AND NOT EXISTS(SELECT 1 FROM __tapedb_erasing_users e WHERE e.user=m.user)",
              workspace.id,
            )?.n,
          ) < (this.isErasing(user) ? 1 : 2)
        )
          throw Error(
            "Transfer workspace ownership before erasing your account.",
          );
      }
      this.sql.exec("INSERT OR IGNORE INTO __tapedb_erasing_users(user) VALUES(?)",user);
      for (const workspace of workspaces)
        this.sql.exec(
          "INSERT OR IGNORE INTO __tapedb_erasure_jobs(user,workspace) VALUES(?,?)",
          user,
          workspace.id,
        );
      return this.sql
        .all(
          "SELECT workspace FROM __tapedb_erasure_jobs WHERE user=? ORDER BY workspace",
          user,
        )
        .map((row) => String(row.workspace));
    });
  }
  finishErasure(user: string) {
    this.sql.exec("DELETE FROM __tapedb_members WHERE user=?", user);
  }
  role(workspace: string, user: string): WorkspaceRole | null {
    const row = this.sql.one(
      "SELECT role FROM __tapedb_members WHERE workspace=? AND user=?",
      workspace,
      user,
    );
    return row ? (row.role as WorkspaceRole) : null;
  }
  workspaces(user: string) {
    return this.sql.all(
      "SELECT workspace AS id,role FROM __tapedb_members WHERE user=? ORDER BY workspace",
      user,
    );
  }
  ids(workspace: string) {
    return this.sql.all(
      "SELECT user AS id FROM __tapedb_members WHERE workspace=? ORDER BY user",
      workspace,
    );
  }
  list(actor: string, workspace: string) {
    if ((this.role(workspace, actor) ?? -1) < WORKSPACE_ROLE_LEVELS.ADMIN)
      throw Error("membership_forbidden");
    return this.sql.all(
      "SELECT user AS id,role FROM __tapedb_members WHERE workspace=? ORDER BY user",
      workspace,
    );
  }
  set(
    actor: string,
    workspace: string,
    user: string,
    role: WorkspaceRole | null,
  ): void {
    this.sql.transactionSync(() => {
      if (
        this.isErasing(actor) ||
        this.role(workspace, actor) !== WORKSPACE_ROLE_LEVELS.OWNER
      )
        throw Error("membership_forbidden");
      if (
        role !== null &&
        (!isRoleLevel(role) || role > WORKSPACE_ROLE_LEVELS.OWNER)
      )
        throw Error("invalid_role");
      if (this.isErasing(user)) throw Error("user_erasing");
      const prior = this.role(workspace, user);
      if (
        prior === WORKSPACE_ROLE_LEVELS.OWNER &&
        role !== WORKSPACE_ROLE_LEVELS.OWNER
      ) {
        const owners = this.sql.one(
          "SELECT COUNT(*) AS n FROM __tapedb_members m WHERE workspace=? AND role=? AND NOT EXISTS(SELECT 1 FROM __tapedb_erasing_users e WHERE e.user=m.user)",
          workspace,
          WORKSPACE_ROLE_LEVELS.OWNER,
        );
        if (Number(owners?.n) <= 1) throw Error("last_owner");
      }
      if (role === null)
        this.sql.exec(
          "DELETE FROM __tapedb_members WHERE workspace=? AND user=?",
          workspace,
          user,
        );
      else
        this.sql.exec(
          "INSERT INTO __tapedb_members(workspace,user,role) VALUES(?,?,?) ON CONFLICT(workspace,user) DO UPDATE SET role=excluded.role",
          workspace,
          user,
          role,
        );
    });
  }
}
