import {
  MANIFEST_VERSION,
  putManifest,
  readManifest,
  type WorkspaceManifest,
} from "../r2-keys";
import type { SqlExecutor, SqlValue } from "./sql";
import { DurabilityError } from "./types";

const textEncoder = new TextEncoder();

export const FALLBACK_ENGINE_VERSION = "1";
const MANIFEST_WRITE_ATTEMPTS = 2;

interface EngineVersionRow extends Record<string, SqlValue> {
  value: string;
}

export function readEngineVersion(sql: SqlExecutor): string {
  const row = sql
    .exec<EngineVersionRow>(
      `SELECT value FROM "_engine_meta" WHERE "key" = 'engine_version'`
    )
    .toArray()[0];
  return row?.value ?? FALLBACK_ENGINE_VERSION;
}

export interface ManifestWriteResult {
  manifest: WorkspaceManifest;
  created: boolean;
}

/**
 * Conditional manifest write shared by the flusher and the snapshotter.
 *
 * `build` is called with the current manifest (or null when absent) so callers
 * can merge monotonic fields such as `logSeq`. On a precondition failure the
 * manifest is re-read and the write retried once; a second failure surfaces as
 * `DurabilityError("manifest_conflict")` rather than overwriting another writer.
 */
export async function commitManifest(
  bucket: R2Bucket,
  workspaceId: string,
  build: (current: WorkspaceManifest | null) => WorkspaceManifest
): Promise<ManifestWriteResult> {
  for (let attempt = 0; attempt < MANIFEST_WRITE_ATTEMPTS; attempt += 1) {
    const current = await readManifest(bucket, workspaceId);
    const manifest = build(current?.manifest ?? null);
    const written = await putManifest(
      bucket,
      workspaceId,
      manifest,
      current?.etag
    );
    if (written) {
      return { manifest, created: current === null };
    }
  }

  throw new DurabilityError(
    "manifest_conflict",
    `Could not write the manifest for workspace ${workspaceId}; another writer kept winning the ETag race.`
  );
}

export function manifestCreatedAt(now: number): string {
  return new Date(now).toISOString();
}

/** UTF-8 byte length, used when estimating NDJSON chunk sizes. */
export function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

/** Fixed boundary for receipts already lost before an upgrade or restore. */
export function readReceiptFloor(sql: SqlExecutor): number {
  const row = sql.exec<{ value: string }>(`SELECT value FROM "_engine_meta" WHERE "key" = 'receipts_since'`).toArray()[0];
  return row === undefined ? 0 : Number(row.value);
}
