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

export type TxOpKind =
  | "insert"
  | "patch"
  | "upsert"
  | "patchMany"
  | "deleteMany"
  | "update"
  | "merge"
  | "link"
  | "unlink"
  | "delete";

export interface TxOpBase {
  op: TxOpKind;
  /** Namespace API name, e.g. "documents" or "boards". */
  namespace: string;
  /** Entity id (UUID string). */
  id: string;
}

/** Creates the row. Fails with `unique_violation` when the id already exists. */
export interface TxInsertOp extends TxOpBase {
  op: "insert";
  values: Record<string, unknown>;
}

/** Writes the supplied attributes. Fails with `not_found` when the row is missing. */
export interface TxPatchOp extends TxOpBase {
  op: "patch";
  values: Record<string, unknown>;
}

/** Upsert: creates the row if missing, otherwise writes the supplied attributes. */
export interface TxUpdateOp extends TxOpBase {
  op: "update";
  values: Record<string, unknown>;
}

/** Same as `update`: an upsert of the supplied attributes. Kept for old clients. */
/**
 * Creates the row from `create` when it is missing, otherwise writes `values`.
 * The engine decides inside the transaction, so the choice cannot race.
 */
export interface TxUpsertOp extends TxOpBase {
  op: "upsert";
  values: Record<string, unknown>;
  create: Record<string, unknown>;
}

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

/**
 * Writes every row matching `where`. The engine resolves the rows inside the
 * transaction and logs what it resolved, so a replay changes the same rows as
 * the original — re-running the filter later could not promise that.
 */
export interface TxPatchManyOp {
  op: "patchMany";
  namespace: string;
  where: Record<string, unknown>;
  values: Record<string, unknown>;
  /** Resume after this id: the `more` cursor of the previous batch. */
  after?: string;
}

/** Deletes every row matching `where`. Resolved and logged like `patchMany`. */
export interface TxDeleteManyOp {
  op: "deleteMany";
  namespace: string;
  where: Record<string, unknown>;
  after?: string;
}

export type TxOp =
  | TxPatchManyOp
  | TxDeleteManyOp
  | TxInsertOp
  | TxPatchOp
  | TxUpsertOp
  | TxUpdateOp
  | TxMergeOp
  | TxLinkOp
  | TxUnlinkOp
  | TxDeleteOp;

export interface TxEnvelope {
  /** Server-visible transaction id. */
  txId: string;
  /** Client id used to dedupe retries of the same optimistic write. */
  clientTxId?: string;
  /**
   * When the client first issued the transaction (ms), resent unchanged on
   * every retry. A retry issued before the retry window is refused with
   * `retry_expired`, since its receipt may be gone.
   */
  issuedAt?: number;
  ops: TxOp[];
}

export interface TxResult {
  txId: string;
  /** Rows a bulk op matched, keyed by its index in the envelope. */
  matched?: Record<number, number>;
  /**
   * For a bulk op that matched more rows than one batch holds: the cursor to
   * send back as its `after`, keyed by its index in the envelope.
   */
  more?: Record<number, string>;
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
  | "unique_violation"
  | "foreign_key_violation"
  | "permission_denied"
  | "retry_expired"
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
