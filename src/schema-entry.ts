/**
 * `@tapedb/tapedb/schema`: everything a schema file imports, and nothing else.
 *
 *   import { schema, model, t, role, filter, check, fileCheck, attachedTo, sqlQuery } from "@tapedb/tapedb/schema";
 */

export { schema, model, t, role, filter, check, fileCheck, attachedTo, sqlQuery } from "./schema";
/** A vector field's value and its one codec: `f32le:v1:<base64>`. */
export { encodeVector, decodeVector, VECTOR_TAG, VECTOR_MAX_DIMENSIONS } from "./schema";
export type {
  ModelOptions,
  SchemaExtension,
  ExtensionModels,
  Access,
  AccessAuth,
  FileAccess,
  FileCheckContext,
  FileInfo,
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
  SqlQuery,
  SqlQueries,
  SqlQueryOptions,
  QueryParams,
  QueryColumns,
  QueryParamValues,
  QueryRow,
} from "./schema";
