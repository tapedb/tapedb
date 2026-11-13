/**
 * Transaction contract shared by the client and the workspace engine.
 *
 * This module is intentionally dependency-free: it describes the wire shape
 * only. Validation, permission checks, SQL compilation and execution live in
 * the engine's transaction pipeline.
 *
 * Op names match the familiar `transact(tx.ns[id].update/merge/link/...)` API.
 * `namespace` and `link` are registry API names (camelCase), never SQL table
 * names. All ids are client-generated strings (UUIDv7).
 */

export type TxOpKind = "update" | "merge" | "link" | "unlink" | "delete";

export interface TxOpBase {
  op: TxOpKind;
  /** Namespace API name, e.g. "documents" or "boards". */
  namespace: string;
  /** Entity id (UUID string). */
  id: string;
}

/** Replaces the supplied attributes; omitted attributes keep their value. */
export interface TxUpdateOp extends TxOpBase {
  op: "update";
  values: Record<string, unknown>;
}

/** Creates the row if missing, otherwise applies a shallow merge. */
export interface TxMergeOp extends TxOpBase {
  op: "merge";
  values: Record<string, unknown>;
}

/** Links the source entity to a target through a registered link. */
export interface TxLinkOp extends TxOpBase {
  op: "link";
  /** Link API name, e.g. "folderDocuments". */
  link: string;
  targetId: string;
}

/** Removes a link created by `link`. */
export interface TxUnlinkOp extends TxOpBase {
  op: "unlink";
  link: string;
  targetId: string;
}

/** Deletes the row; FK rules decide whether dependent rows cascade or null. */
export interface TxDeleteOp extends TxOpBase {
  op: "delete";
}

export type TxOp = TxUpdateOp | TxMergeOp | TxLinkOp | TxUnlinkOp | TxDeleteOp;

export interface TxEnvelope {
  /** Server-visible transaction id. */
  txId: string;
  /** Client id used to dedupe retries of the same optimistic write. */
  clientTxId?: string;
  /**
   * Sent on a retry only: the highest sequence the client had observed when it
   * created this transaction. Any earlier attempt that was applied got a
   * sequence above it, so the server can tell whether its idempotency keys
   * reach back far enough to answer the retry, and refuses it with
   * `dedupe_expired` when they do not instead of applying it a second time.
   */
  basisSeq?: number;
  ops: TxOp[];
}

export interface TxResult {
  txId: string;
  /** `_tx_log.seq` assigned to this transaction. */
  seq: number;
  /** Number of ops that changed a row. */
  applied: number;
}

export type TxErrorCode =
  | "invalid_envelope"
  | "invalid_op"
  | "unknown_namespace"
  | "unknown_attribute"
  | "unknown_link"
  | "invalid_value"
  | "not_found"
  | "conflict"
  | "duplicate_tx"
  | "dedupe_expired"
  | "unique_violation"
  | "foreign_key_violation"
  | "permission_denied"
  | "storage_error";

/** Plain-object form of a transaction error, suitable for JSON responses. */
export interface TxErrorShape {
  code: TxErrorCode;
  message: string;
  txId?: string;
  opIndex?: number;
}

export interface TxErrorOptions {
  txId?: string;
  opIndex?: number;
}

export class TxError extends Error {
  readonly code: TxErrorCode;
  readonly txId?: string;
  readonly opIndex?: number;

  constructor(
    code: TxErrorCode,
    message: string,
    options: TxErrorOptions = {}
  ) {
    super(message);
    this.name = "TxError";
    this.code = code;
    this.txId = options.txId;
    this.opIndex = options.opIndex;
  }

  toJSON(): TxErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.txId === undefined ? {} : { txId: this.txId }),
      ...(this.opIndex === undefined ? {} : { opIndex: this.opIndex }),
    };
  }
}
