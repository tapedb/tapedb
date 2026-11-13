import type { WorkspaceRoom } from "./engine/workspace-room";

/**
 * Worker bindings and vars. `tapedb init` writes exactly these.
 *
 * Three resources: one Durable Object namespace, two R2 buckets. There is no
 * D1 and no identity database: the engine consumes a verified claim and never
 * reads a session.
 */
export interface Env {
  /** The database room. One instance per workspace. */
  WORKSPACE: DurableObjectNamespace<WorkspaceRoom>;
  /** Transaction log segments and snapshots. */
  DATA: R2Bucket;
  /** Uploaded files. Optional unless `db.$files` is used. */
  FILES?: R2Bucket;

  ENVIRONMENT?: string;
  SERVICE_VERSION?: string;
  ENABLE_SMOKE?: string;
  ALLOWED_ORIGINS?: string;

  /** Shared HS256 secret used to verify role claims. */
  TAPEDB_CLAIM_SECRET: string;
  /** Optional expected `iss` claim; checked only when set. */
  TAPEDB_CLAIM_ISSUER?: string;
  /** Optional expected `aud` claim; checked only when set. */
  TAPEDB_CLAIM_AUDIENCE?: string;

  /**
   * Enables the development claim issuer. Set to `"true"` by `tapedb dev` on
   * the command line and never written to `wrangler.jsonc`, so a plain
   * `wrangler deploy` has no dev claim route.
   */
  TAPEDB_DEV_CLAIMS?: string;
}
