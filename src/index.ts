/**
 * tapedb: a typed database for Cloudflare.
 *
 * Describe models with `schema()`, and `tapedb init` provisions a Durable
 * Object class and two R2 buckets in your account. Each workspace is one
 * SQLite database in one Durable Object, with its transaction log shipped to
 * R2. Read and write through `createClient()`: reads can be awaited or kept
 * live, writes are optimistic and survive going offline.
 *
 * This entry is React-free and has zero runtime dependencies. Hooks live in
 * `tapedb/react`, the Worker in `tapedb/worker`, the CLI in `tapedb/cli`.
 */

export { createClient, Query, PageQuery, Write } from "./model/client";
export type {
  Client,
  ClientConfig,
  BroadcastTopic,
  ExportRecord,
  FilesClient,
  FindArgs,
  LiveState,
  ModelClient,
  Page,
  PageArgs,
  PresenceRoom,
  Result,
  WriteResult,
} from "./model/client";

export { schema, model, t, role, filter, check } from "./schema";
export type {
  Access,
  AccessAuth,
  CheckContext,
  CreateData,
  DeleteBehaviour,
  FieldFilter,
  Include,
  OrderBy,
  Row,
  ScalarKind,
  Schema,
  UpdateData,
  Where,
} from "./schema";

export { id } from "./client/id";
export { BulkWriteError } from "./client/data-client";
export type { StoredFile } from "./client/data-client";
export type { PresencePeer, QueryError, TopicSender, WriteRejection } from "./client/types";
export type { StorageObject } from "./client/storage-client";

export type { Env } from "./types";
export { WORKSPACE_ROLE_LEVELS, hasRole, hasRoleLevel } from "./claims";
export type { RoleClaim, WorkspaceRole } from "./claims";
