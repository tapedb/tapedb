/** Shared types for the workspace durability modules. */

import type { DeploymentConfig } from "../config";

export type SnapshotStatus = "idle" | "running" | "completed" | "failed";

export interface FlushState {
  lastSeq: number;
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  lastFlushAt: number | null;
  lastSegmentFrom: number | null;
  updatedAt: number;
  /** True when `_tx_log` has at least one row after `lastSeq`. */
  hasPending: boolean;
}

export interface SnapshotState {
  baseSeq: number;
  status: SnapshotStatus;
  startedAt: number | null;
  completedAt: number | null;
  manifestKey: string | null;
}

export interface LogSegment {
  fromSeq: number;
  toSeq: number;
  rows: number;
  ndjson: string;
  /**
   * Entries whose ops are in parts: their line says `opsParts` and carries no
   * ops, and the flusher uploads the parts to `logOpsKey(seq)` first.
   */
  refs: Array<{ seq: number; first: string }>;
}

export interface FlushOptions {
  /** Maximum transactions in one segment. Defaults to 5000. */
  maxRows?: number;
  /** Maximum NDJSON bytes in one segment. Defaults to 1 MiB. */
  maxBytes?: number;
}

export interface FlushResult {
  flushed: boolean;
  fromSeq?: number;
  toSeq?: number;
  rows?: number;
  key?: string;
  /** Set when the flush failed. */
  error?: string;
  code?: DurabilityErrorCode;
}

export interface SnapshotOptions {
  /** Rows per chunk before gzip. Defaults to 500. */
  chunkRows?: number;
  /** Uncompressed NDJSON bytes per chunk. Defaults to 1 MiB. */
  chunkBytes?: number;
  /** Snapshot prefixes to keep, including the one just written. Defaults to 2. */
  retention?: number;
  /**
   * Covered replay-log sequences retained below a snapshot. Transaction
   * receipts are kept independently. Defaults to `LOG_RETENTION_SEQ`.
   */
  retainLogSequences?: number;
}

export interface SnapshotResult {
  snapshotted: boolean;
  baseSeq?: number;
  logSeq?: number;
  manifestKey?: string;
  tables?: number;
  chunks?: number;
  rows?: number;
  bytes?: number;
  error?: string;
  /** Pruning is best-effort; failures are reported but do not fail the snapshot. */
  warnings?: string[];
}

export interface DurabilityOptions {
  /** The deployment this pass runs for; absent means the unconfigured default. */
  config?: DeploymentConfig;
  flush?: FlushOptions;
  snapshot?: SnapshotOptions;
}

export interface HistoryPruneResult {
  /** R2 objects deleted. */
  objects: number;
  /** Local replay-log rows deleted. */
  localRows: number;
  /** Transaction receipts whose operation hash was removed; their IDs remain. */
  receipts: number;
  /** When the oldest remaining history becomes due, or null. */
  nextAt: number | null;
}

export interface DurabilityTickResult {
  flushed: boolean;
  /** Why a due flush failed; it is retried with backoff. */
  flushError?: string;
  snapshot: SnapshotResult | null;
  /** Set when history was pruned by age on this pass. */
  history: HistoryPruneResult | null;
}

export type DurabilityErrorCode =
  | "r2_write_failed"
  | "manifest_conflict"
  | "snapshot_failed"
  | "invalid_state";

export class DurabilityError extends Error {
  readonly code: DurabilityErrorCode;

  constructor(code: DurabilityErrorCode, message: string) {
    super(message);
    this.name = "DurabilityError";
    this.code = code;
  }
}
