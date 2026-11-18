import type { Env } from "../types";
import type { EmailBinding } from "../email";
export interface TapeDBAuthEnv extends Env {
  BETTER_AUTH_SECRET?: string;
  EMAIL_FROM?: string;
  EMAIL?: EmailBinding;
}

/** Auth data lives in one dedicated database, never in a customer workspace. */
export interface AuthField {
  source?: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  references?: { model: string; field: string; onDelete?: string };
}
export type AuthTables = Record<
  string,
  { model?: string; fields: Record<string, AuthField> }
>;
export interface AuthWhere {
  field: string;
  operator: string;
  value: unknown;
  connector?: string;
  mode?: string;
}
export interface AuthCommand {
  action:
    | "create"
    | "findOne"
    | "findMany"
    | "count"
    | "update"
    | "updateMany"
    | "delete"
    | "deleteMany"
    | "consumeOne"
    | "incrementOne";
  model: string;
  data?: Record<string, unknown>;
  where?: AuthWhere[];
  select?: string[];
  limit?: number;
  offset?: number;
  sortBy?: { field: string; direction: "asc" | "desc" };
  increment?: Record<string, number>;
}
/** RPC surface implemented by the dedicated AuthRoom. */
export interface AuthDatabase {
  configure(tables: AuthTables): Promise<void>;
  execute(command: AuthCommand): Promise<unknown>;
}
