/**
 * Transaction validation.
 *
 * Validation happens before any mutation so a bad op cannot leave a partial
 * row behind. It normalises wire values into SQLite bindings:
 *
 * - `date` (epoch ms number or ISO-8601 string) -> epoch ms number
 * - `boolean` -> 1/0
 * - `json` / `any` -> JSON text
 * - `createdAt` / `updatedAt` are accepted but ignored; the engine owns them
 * - `id` and `updatedSeq` / `updated_seq` are reserved and rejected
 */

import {
  findNamespace,
  LINKS,
  toSnakeCase,
  type AttributeDefinition,
  type LinkDefinition,
  type NamespaceDefinition,
} from "./registry";
import type { SqlValue } from "./tx-sql";
import { TxError, type TxOpKind } from "./tx-types";
import { canonicalVectorValue } from "../model/vector";

const ID_PATTERN = /^[A-Za-z0-9_:|.-]{1,128}$/;
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const RESERVED_ATTRIBUTES = new Set(["id", "updatedSeq", "updated_seq"]);
const ENGINE_MANAGED_ATTRIBUTES = new Set(["createdAt", "updatedAt"]);
const OP_KINDS = new Set<TxOpKind>([
  "insert",
  "patch",
  "upsert",
  "patchMany",
  "deleteMany",
  "update",
  "merge",
  "link",
  "unlink",
  "delete",
]);

export interface ValidatedValuesOp {
  kind: "insert" | "patch" | "upsert" | "update" | "merge";
  namespace: string;
  id: string;
  /** Values keyed by SQLite column name. */
  values: Record<string, SqlValue>;
  /** `upsert` only: the values for the row when it does not exist yet. */
  createValues?: Record<string, SqlValue>;
}

/** A bulk write, before the engine resolves which rows it touches. */
export interface ValidatedBulkOp {
  kind: "patchMany" | "deleteMany";
  namespace: string;
  /** Client-shaped query filter; compiled when the rows are resolved. */
  where: Record<string, unknown>;
  /** `patchMany` only: values keyed by SQLite column name. */
  values?: Record<string, SqlValue>;
  /** Resume after this id. */
  after?: string;
}

export interface ValidatedDeleteOp {
  kind: "delete";
  namespace: string;
  id: string;
}

export interface ValidatedLinkOp {
  kind: "link" | "unlink";
  namespace: string;
  id: string;
  link: string;
  targetId: string;
  /** Namespace that owns the foreign key. */
  childNamespace: string;
  /** Row whose foreign key is written. */
  childId: string;
  /** Row the foreign key points at. */
  parentId: string;
  foreignKeyAttribute: string;
  foreignKeyColumn: string;
}

export type ValidatedOp =
  | ValidatedBulkOp
  | ValidatedValuesOp
  | ValidatedDeleteOp
  | ValidatedLinkOp;

export interface ValidatedTx {
  txId: string;
  clientTxId?: string;
  /** When the client first issued this transaction (ms). Retries carry the original time. */
  issuedAt?: number;
  ops: ValidatedOp[];
  /** Original ops array, used for the stable log hash. */
  rawOps: unknown[];
  /**
   * The ops as the log stores them: index-aligned with `ops`, with every vector
   * value in its `f32le:v1:<base64>` form rather than the `number[]` a client
   * sent. The tape carries the stored value verbatim, which is what keeps an
   * embedding byte-identical through a replay (and why a log part holds 60 of
   * them instead of 15).
   */
  logOps: unknown[];
}

interface ValidationContext {
  txId: string;
  opIndex: number;
}

export function validateEnvelope(value: unknown): ValidatedTx {
  if (!isPlainObject(value)) {
    throw new TxError("invalid_envelope", "Transaction must be an object.");
  }

  const txId = value.txId;
  if (typeof txId !== "string" || txId.trim().length === 0) {
    throw new TxError(
      "invalid_envelope",
      "Transaction id must be a non-empty string."
    );
  }

  const clientTxId = value.clientTxId;
  if (
    clientTxId !== undefined &&
    (typeof clientTxId !== "string" || clientTxId.trim().length === 0)
  ) {
    throw new TxError(
      "invalid_envelope",
      "clientTxId must be a non-empty string when present.",
      { txId }
    );
  }

  const issuedAt = value.issuedAt;
  if (issuedAt !== undefined && (typeof issuedAt !== "number" || !Number.isFinite(issuedAt))) {
    throw new TxError("invalid_envelope", "issuedAt must be a timestamp in milliseconds when present.", { txId });
  }

  const rawOps = value.ops;
  if (!Array.isArray(rawOps) || rawOps.length < 1) {
    throw new TxError(
      "invalid_envelope",
      "Transaction must contain at least one op.",
      { txId }
    );
  }

  const ops = rawOps.map((op, opIndex) => validateOp(op, { txId, opIndex }));

  return {
    txId,
    ...(clientTxId === undefined ? {} : { clientTxId }),
    ...(issuedAt === undefined ? {} : { issuedAt }),
    ops,
    rawOps,
    logOps: rawOps.map((op, index) => loggableOp(op, ops[index]!)),
  };
}

/** The vector attributes of a namespace, cached: most schemas have none. */
const VECTOR_ATTRIBUTES = new WeakMap<NamespaceDefinition, string[]>();

function vectorAttributes(namespace: NamespaceDefinition): string[] {
  const cached = VECTOR_ATTRIBUTES.get(namespace);
  if (cached !== undefined) return cached;
  const found = Object.entries(namespace.attributes)
    .filter(([, definition]) => definition.type === "vector")
    .map(([attribute]) => attribute);
  VECTOR_ATTRIBUTES.set(namespace, found);
  return found;
}

/**
 * One op as the log stores it. Only a vector value differs: the client sends
 * `number[]`, and the log carries the string the row holds, so replaying it
 * cannot re-encode the value into different bytes.
 *
 * A namespace with no vector field takes the fastest path: the op it came in
 * as, untouched.
 */
function loggableOp(op: unknown, validated: ValidatedOp): unknown {
  if (!isPlainObject(op)) return op;
  const namespace = findNamespace(validated.namespace);
  if (namespace === undefined) return op;
  const vectors = vectorAttributes(namespace);
  if (vectors.length === 0) return op;

  let logged: Record<string, unknown> | null = null;
  for (const key of ["values", "create"] as const) {
    const raw = op[key];
    if (!isPlainObject(raw)) continue;
    let replaced = raw;
    for (const attribute of vectors) {
      if (!(attribute in raw)) continue;
      const column = toSnakeCase(attribute);
      const stored =
        key === "values"
          ? (validated as ValidatedValuesOp | ValidatedBulkOp).values?.[column]
          : (validated as ValidatedValuesOp).createValues?.[column];
      if (stored === undefined) continue;
      replaced = { ...replaced, [attribute]: stored };
    }
    if (replaced === raw) continue;
    logged ??= { ...op };
    logged[key] = replaced;
  }
  return logged ?? op;
}

function validateOp(value: unknown, context: ValidationContext): ValidatedOp {
  if (!isPlainObject(value)) {
    throw invalidOp("Op must be an object.", context);
  }

  const kind = value.op;
  if (typeof kind !== "string" || !OP_KINDS.has(kind as TxOpKind)) {
    throw invalidOp("Op kind is not recognised.", context);
  }
  const opKind = kind as TxOpKind;

  const namespaceName = value.namespace;
  if (typeof namespaceName !== "string" || namespaceName.length === 0) {
    throw invalidOp("Op namespace is required.", context);
  }

  if (opKind === "patchMany" || opKind === "deleteMany") {
    const namespace = findNamespace(namespaceName);
    if (!namespace) {
      throw new TxError(
        "unknown_namespace",
        `Unknown namespace "${namespaceName}".`,
        { txId: context.txId, opIndex: context.opIndex }
      );
    }
    if (!isPlainObject(value.where)) {
      throw invalidOp(`"${opKind}" needs a "where" object.`, context);
    }
    if (value.after !== undefined && (typeof value.after !== "string" || !ID_PATTERN.test(value.after))) {
      throw invalidOp(`"${opKind}" "after" must be a row id.`, context);
    }
    return {
      kind: opKind,
      namespace: namespaceName,
      where: value.where,
      ...(value.after !== undefined ? { after: value.after } : {}),
      ...(opKind === "patchMany"
        ? { values: validateValues(namespace, value.values, context) }
        : {}),
    } as ValidatedOp;
  }

  const namespace = findNamespace(namespaceName);
  if (!namespace) {
    throw new TxError(
      "unknown_namespace",
      `Unknown namespace "${namespaceName}".`,
      { txId: context.txId, opIndex: context.opIndex }
    );
  }

  const id = value.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw invalidOp("Op id must match [A-Za-z0-9_:|.-]{1,128}.", context);
  }

  switch (opKind) {
    case "insert":
    case "patch":
    case "update":
    case "merge":
      return {
        kind: opKind,
        namespace: namespaceName,
        id,
        values: validateValues(namespace, value.values, context),
      };
    case "upsert":
      return {
        kind: "upsert",
        namespace: namespaceName,
        id,
        values: validateValues(namespace, value.values, context),
        createValues: validateValues(namespace, value.create, context),
      };
    case "delete":
      return { kind: "delete", namespace: namespaceName, id };
    case "link":
    case "unlink":
      return validateLinkOp(opKind, value, namespaceName, id, context);
  }
}

function validateValues(
  namespace: NamespaceDefinition,
  value: unknown,
  context: ValidationContext
): Record<string, SqlValue> {
  if (!isPlainObject(value)) {
    throw invalidOp("update/merge values must be a plain object.", context);
  }

  const normalised: Record<string, SqlValue> = {};

  for (const [attribute, attributeValue] of Object.entries(value)) {
    if (RESERVED_ATTRIBUTES.has(attribute)) {
      throw new TxError(
        "unknown_attribute",
        `Attribute "${attribute}" is reserved.`,
        { txId: context.txId, opIndex: context.opIndex }
      );
    }

    const definition = namespace.attributes[attribute];
    if (!definition) {
      throw new TxError(
        "unknown_attribute",
        `Unknown attribute "${attribute}" on namespace "${namespace.apiName}".`,
        { txId: context.txId, opIndex: context.opIndex }
      );
    }

    const normalisedValue = normaliseValue(
      attribute,
      definition,
      attributeValue,
      context
    );

    // The engine sets these columns itself; accept them on the wire but do not
    // let a client claim them.
    if (ENGINE_MANAGED_ATTRIBUTES.has(attribute)) continue;

    normalised[toSnakeCase(attribute)] = normalisedValue;
  }

  return normalised;
}

function validateLinkOp(
  kind: "link" | "unlink",
  value: Record<string, unknown>,
  namespaceName: string,
  id: string,
  context: ValidationContext
): ValidatedLinkOp {
  const linkName = value.link;
  if (typeof linkName !== "string" || linkName.length === 0) {
    throw invalidOp("link/unlink requires a link api name.", context);
  }

  const link = (LINKS as Record<string, LinkDefinition>)[linkName];
  if (!link) {
    throw new TxError("unknown_link", `Unknown link "${linkName}".`, {
      txId: context.txId,
      opIndex: context.opIndex,
    });
  }

  const targetId = value.targetId;
  if (typeof targetId !== "string" || !ID_PATTERN.test(targetId)) {
    throw invalidOp(
      "link/unlink target id must match [A-Za-z0-9_:|.-]{1,128}.",
      context
    );
  }

  const forwardMatch = namespaceName === link.forward.namespace;
  const reverseMatch = namespaceName === link.reverse.namespace;
  if (!forwardMatch && !reverseMatch) {
    throw invalidOp(
      `Link "${linkName}" does not connect namespace "${namespaceName}".`,
      context
    );
  }

  const childNamespace = findNamespace(link.foreignKey.namespace);
  if (!childNamespace) {
    throw new TxError(
      "unknown_namespace",
      `Unknown link child namespace "${link.foreignKey.namespace}".`,
      { txId: context.txId, opIndex: context.opIndex }
    );
  }

  const foreignKeyAttribute = link.foreignKey.attribute;
  if (!childNamespace.attributes[foreignKeyAttribute]) {
    throw new TxError(
      "unknown_link",
      `Link "${linkName}" has an unregistered foreign key.`,
      { txId: context.txId, opIndex: context.opIndex }
    );
  }

  // For a self-referential link (folderChildren, blockChildren) both labels
  // share one namespace, so the api name is interpreted in its forward
  // direction: source is the parent, target is the child.
  const useForward = forwardMatch;
  const childId = useForward ? targetId : id;
  const parentId = useForward ? id : targetId;

  return {
    kind,
    namespace: namespaceName,
    id,
    link: linkName,
    targetId,
    childNamespace: childNamespace.apiName,
    childId,
    parentId,
    foreignKeyAttribute,
    foreignKeyColumn: toSnakeCase(foreignKeyAttribute),
  };
}

/**
 * True when `value` is acceptable for the attribute under today's registry.
 * Recovery uses it to drop an old value a later type change no longer fits.
 */
export function acceptsValue(namespaceName: string, attribute: string, value: unknown): boolean {
  const definition = findNamespace(namespaceName)?.attributes[attribute];
  if (!definition) return false;
  try {
    normaliseValue(attribute, definition, value, { txId: "recovery", opIndex: 0 });
    return true;
  } catch {
    return false;
  }
}

function normaliseValue(
  attribute: string,
  definition: AttributeDefinition,
  value: unknown,
  context: ValidationContext
): SqlValue {
  if (value === null) {
    if (!definition.optional) {
      throw invalidValue(
        `Attribute "${attribute}" is required and cannot be null.`,
        context
      );
    }
    return null;
  }

  switch (definition.type) {
    case "string":
      if (typeof value !== "string") {
        throw invalidValue(
          `Attribute "${attribute}" must be a string.`,
          context
        );
      }
      if (definition.values !== undefined && !definition.values.includes(value)) {
        throw invalidValue(
          `Attribute "${attribute}" must be one of: ${definition.values.join(", ")}.`,
          context
        );
      }
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw invalidValue(
          `Attribute "${attribute}" must be a finite number.`,
          context
        );
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") {
        throw invalidValue(
          `Attribute "${attribute}" must be a boolean.`,
          context
        );
      }
      return value ? 1 : 0;
    case "date":
      return normaliseDate(attribute, value, context);
    case "vector":
      return normaliseVector(attribute, definition, value, context);
    case "json":
    case "any":
      assertJsonSerialisable(attribute, value, context, new Set<object>());
      return JSON.stringify(value);
  }
}

/**
 * A vector field's stored value: `f32le:v1:<base64>`, from the `number[]` a
 * write supplies or from the string a log entry, export or backup carries.
 *
 * Every refusal here happens before the transaction opens, so a bad embedding
 * leaves no row, receipt or log entry behind.
 */
function normaliseVector(
  attribute: string,
  definition: AttributeDefinition,
  value: unknown,
  context: ValidationContext
): string {
  const dimensions = definition.dimensions;
  if (dimensions === undefined) {
    throw invalidValue(
      `Attribute "${attribute}" is a vector field without declared dimensions.`,
      context
    );
  }
  try {
    return canonicalVectorValue(value, dimensions);
  } catch (error) {
    throw invalidValue(
      `Attribute "${attribute}" ${error instanceof Error ? error.message : String(error)}`,
      context
    );
  }
}

function normaliseDate(
  attribute: string,
  value: unknown,
  context: ValidationContext
): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && ISO_DATE_PATTERN.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  throw invalidValue(
    `Attribute "${attribute}" must be epoch milliseconds or an ISO-8601 date.`,
    context
  );
}

function assertJsonSerialisable(
  attribute: string,
  value: unknown,
  context: ValidationContext,
  seen: Set<object>
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidValue(
        `Attribute "${attribute}" contains a non-finite number.`,
        context
      );
    }
    return;
  }

  if (Array.isArray(value)) {
    enterObject(value, attribute, context, seen);
    for (const item of value) {
      assertJsonSerialisable(attribute, item, context, seen);
    }
    seen.delete(value);
    return;
  }

  if (isPlainObject(value)) {
    enterObject(value, attribute, context, seen);
    for (const item of Object.values(value)) {
      assertJsonSerialisable(attribute, item, context, seen);
    }
    seen.delete(value);
    return;
  }

  throw invalidValue(
    `Attribute "${attribute}" must be JSON-serialisable.`,
    context
  );
}

function enterObject(
  value: object,
  attribute: string,
  context: ValidationContext,
  seen: Set<object>
): void {
  if (seen.has(value)) {
    throw invalidValue(
      `Attribute "${attribute}" contains a circular value.`,
      context
    );
  }
  seen.add(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isEngineManagedAttribute(attribute: string): boolean {
  return ENGINE_MANAGED_ATTRIBUTES.has(attribute);
}

/**
 * Columns that must be supplied when a row is inserted. Engine-managed
 * timestamps are excluded because `tx-apply` always writes them.
 */
export function requiredColumns(namespace: NamespaceDefinition): string[] {
  return Object.entries(namespace.attributes)
    .filter(
      ([attribute, definition]) =>
        !definition.optional && !ENGINE_MANAGED_ATTRIBUTES.has(attribute)
    )
    .map(([attribute]) => toSnakeCase(attribute));
}

/** True for an unresolved bulk write. `expandBulkOps` replaces these. */
export function isBulkOp(op: ValidatedOp): op is ValidatedBulkOp {
  return op.kind === "patchMany" || op.kind === "deleteMany";
}

export function isLinkOp(op: ValidatedOp): op is ValidatedLinkOp {
  return op.kind === "link" || op.kind === "unlink";
}

function invalidOp(message: string, context: ValidationContext): TxError {
  return new TxError("invalid_op", message, {
    txId: context.txId,
    opIndex: context.opIndex,
  });
}

function invalidValue(message: string, context: ValidationContext): TxError {
  return new TxError("invalid_value", message, {
    txId: context.txId,
    opIndex: context.opIndex,
  });
}
