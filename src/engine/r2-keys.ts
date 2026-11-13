/**
 * Single source of truth for the `tapedb-data` key layout.
 *
 * Layout:
 *   ws/{workspaceId}/manifest.json
 *   ws/{workspaceId}/log/{fromSeq}-{toSeq}.ndjson
 *   ws/{workspaceId}/snapshots/{seq}.sqlite.gz
 *   ws/{workspaceId}/docs/{docId}/{version}.yjs
 *   ws/{workspaceId}/$files/{path}
 *   ws/{workspaceId}/exports/{exportId}.zip
 *   users/{userId}/avatar/{fileId}.{ext}
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const EXTENSION_PATTERN = /^[A-Za-z0-9]{1,10}$/;

export const MANIFEST_VERSION = 2 as const;

export interface ManifestChunk {
  /** R2 key relative to the workspace prefix (e.g. `log/1-42.ndjson`). */
  key: string;
  rows: number;
  bytes: number;
  sha256: string;
}

export interface ManifestTable {
  name: string;
  chunks: ManifestChunk[];
}

export interface WorkspaceManifest {
  version: typeof MANIFEST_VERSION;
  workspaceId: string;
  /** Sequence the snapshot/base state covers. */
  baseSeq: number;
  /** Highest sequence included in the manifest. */
  logSeq: number;
  /** ISO 8601 timestamp for when the manifest was written. */
  createdAt: string;
  engineVersion: string;
  /** The app schema the snapshot was taken under; absent before it was recorded. */
  schemaVersion?: string;
  /** Missing historical receipts only exist in snapshots from older engines. */
  dedupeFloorSeq?: number;
  tables: ManifestTable[];
  totalRows: number;
  totalBytes: number;
}

export function isWorkspaceId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function assertWorkspaceId(value: string): string {
  if (!isWorkspaceId(value)) {
    throw new Error("Workspace id must be a UUID.");
  }
  return value;
}

function assertSafeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT_PATTERN.test(value)) {
    throw new Error(`${label} must match [A-Za-z0-9][A-Za-z0-9._~-]{0,127}.`);
  }
  return value;
}

function assertNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

export function workspacePrefix(workspaceId: string): string {
  return `ws/${assertWorkspaceId(workspaceId)}`;
}

export function manifestKey(workspaceId: string): string {
  return `${workspacePrefix(workspaceId)}/manifest.json`;
}

export function logSegmentKey(
  workspaceId: string,
  fromSeq: number,
  toSeq: number
): string {
  assertNonNegativeInteger(fromSeq, "fromSeq");
  assertNonNegativeInteger(toSeq, "toSeq");
  if (toSeq < fromSeq) {
    throw new Error("toSeq must be greater than or equal to fromSeq.");
  }
  return `${workspacePrefix(workspaceId)}/log/${fromSeq}-${toSeq}.ndjson`;
}

export function snapshotKey(workspaceId: string, seq: number): string {
  assertNonNegativeInteger(seq, "seq");
  return `${workspacePrefix(workspaceId)}/snapshots/${seq}.sqlite.gz`;
}

export function yjsSnapshotKey(
  workspaceId: string,
  documentId: string,
  version: number
): string {
  const doc = assertSafeSegment(documentId, "documentId");
  assertPositiveInteger(version, "version");
  return `${workspacePrefix(workspaceId)}/docs/${doc}/${version}.yjs`;
}

/** Encodes each path segment so `$files/{path}` stays a single R2 key. */
export function encodeFilePath(path: string): string {
  if (path.startsWith("/") || path.includes("\\")) {
    throw new Error("File path must be relative and use forward slashes.");
  }

  const segments = path.split("/");
  if (segments.length === 0) {
    throw new Error("File path is empty.");
  }

  return segments
    .map((segment) => {
      if (segment === "" || segment === "." || segment === "..") {
        throw new Error("File path contains an unsafe segment.");
      }
      return encodeURIComponent(segment);
    })
    .join("/");
}

export function workspaceFileKey(workspaceId: string, path: string): string {
  return `${workspacePrefix(workspaceId)}/$files/${encodeFilePath(path)}`;
}

export function exportKey(workspaceId: string, exportId: string): string {
  return `${workspacePrefix(workspaceId)}/exports/${assertSafeSegment(
    exportId,
    "exportId"
  )}.zip`;
}

export function avatarKey(
  userId: string,
  fileId: string,
  extension: string
): string {
  const user = assertSafeSegment(userId, "userId");
  const file = assertSafeSegment(fileId, "fileId");
  if (!EXTENSION_PATTERN.test(extension)) {
    throw new Error("extension must be 1-10 alphanumeric characters.");
  }
  return `users/${user}/avatar/${file}.${extension}`;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isManifestChunk(value: unknown): value is ManifestChunk {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.key) &&
    isNonNegativeInteger(candidate.rows) &&
    isNonNegativeInteger(candidate.bytes) &&
    typeof candidate.sha256 === "string" &&
    SHA256_PATTERN.test(candidate.sha256)
  );
}

function isManifestTable(value: unknown): value is ManifestTable {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.name) &&
    Array.isArray(candidate.chunks) &&
    candidate.chunks.every(isManifestChunk)
  );
}

export function isWorkspaceManifest(
  value: unknown
): value is WorkspaceManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== MANIFEST_VERSION ||
    !isNonEmptyString(candidate.workspaceId) ||
    !isWorkspaceId(candidate.workspaceId) ||
    !isNonNegativeInteger(candidate.baseSeq) ||
    !isNonNegativeInteger(candidate.logSeq) ||
    candidate.baseSeq > candidate.logSeq ||
    !isNonEmptyString(candidate.createdAt) ||
    !isNonEmptyString(candidate.engineVersion) ||
    !Array.isArray(candidate.tables) ||
    !candidate.tables.every(isManifestTable) ||
    !isNonNegativeInteger(candidate.totalRows) ||
    (candidate.dedupeFloorSeq !== undefined && (!isNonNegativeInteger(candidate.dedupeFloorSeq) || candidate.dedupeFloorSeq > candidate.baseSeq)) ||
    (candidate.dedupeFloorSeq !== undefined && Array.isArray(candidate.tables) && !candidate.tables.some((table: { name?: string }) => table?.name === "_tx_receipts")) ||
    !isNonNegativeInteger(candidate.totalBytes)
  ) {
    return false;
  }

  const tableNames = candidate.tables.map((table) => table.name);
  return new Set(tableNames).size === tableNames.length;
}

/**
 * Writes the manifest with a conditional PUT.
 *
 * - With an ETag, the write only succeeds if the stored object still matches.
 * - Without one, the write only succeeds if the object does not exist yet.
 *
 * Returns null when the precondition failed, so the caller can re-read and
 * retry instead of overwriting another writer.
 */
export async function putManifest(
  bucket: R2Bucket,
  workspaceId: string,
  manifest: WorkspaceManifest,
  etag?: string
): Promise<R2Object | null> {
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  return bucket.put(manifestKey(workspaceId), body, {
    onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

export async function readManifest(
  bucket: R2Bucket,
  workspaceId: string
): Promise<{ manifest: WorkspaceManifest; etag: string } | null> {
  const object = await bucket.get(manifestKey(workspaceId));
  if (!object) return null;

  const parsed: unknown = await object.json();
  if (!isWorkspaceManifest(parsed)) {
    throw new Error("Stored manifest has an invalid shape.");
  }
  return { manifest: parsed, etag: object.etag };
}
