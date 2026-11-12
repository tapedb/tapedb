/**
 * tapedb — a log-structured database for Cloudflare Durable Objects.
 *
 * This entry is React-free and has zero runtime dependencies. The React hooks
 * live behind `tapedb/react`; the Worker surface behind `tapedb/worker`; the
 * provisioning CLI behind `tapedb/cli`.
 */

export { defineSchema } from "./schema";
export type { EntityConfig, SchemaConfig, TapeDBSchema } from "./schema";

export { i } from "./client/schema";
export { id } from "./client/id";
export * from "./client";

export type { Env } from "./types";
export { WORKSPACE_ROLE_LEVELS, hasRole, hasRoleLevel } from "./claims";
export type { RoleClaim, WorkspaceRole } from "./claims";
