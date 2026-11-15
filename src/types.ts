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

  /** Original buckets and optional namespace while moving workspaces. */
  DATA_FROM?: R2Bucket;
  FILES_FROM?: R2Bucket;
  WORKSPACE_FROM?: DurableObjectNamespace<WorkspaceRoom>;
  /** Original jurisdiction during a move: eu, fedramp, or none. */
  TAPEDB_MOVE_FROM?: string;
  ENVIRONMENT?: string;
  /**
   * Restricts every workspace's Durable Object to a Cloudflare jurisdiction
   * ("eu" or "fedramp"): it runs and stores data only there. Use `tapedb move`
   * to relocate existing workspaces. The R2 buckets use the same jurisdiction.
   */
  TAPEDB_JURISDICTION?: string;

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
  /** Requires this token (x-tapedb-dev-token) on the development claim route; for deployed test Workers. */
  TAPEDB_DEV_CLAIMS_TOKEN?: string;
}
