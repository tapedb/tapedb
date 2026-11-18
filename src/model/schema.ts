/**
 * `schema()` and `model()`: the public way to describe a database.
 *
 * A schema compiles to the same registry, permissions and migrations the
 * engine already runs on, so the Worker accepts it unchanged. It also keeps a
 * small relation graph that the client uses to turn `include`, `connect` and
 * friends into engine queries and ops.
 */

import type { FileRules } from "../engine/file-access";
import { WORKSPACE_ROLE_LEVELS, type WorkspaceRole } from "../claims";
import type { AttributeDefinition, DeleteRule, LinkDefinition } from "../engine/registry";
import type { PermissionDecision, PermissionOverrides } from "../engine/tx-permissions";
import type { QueryWhere } from "../engine/query-types";
import { defineSchema, type EntityConfig, type TapeDBSchema } from "../schema";
import {
  t,
  BelongsTo,
  EnumField,
  Field,
  HasMany,
  type KindInput,
  type KindOutput,
  type ModelMember,
  type ScalarKind,
} from "./fields";
import { toEngineWhere, type Where } from "./where";

// ---- Access ----------------------------------------------------------------

export type RoleName =
  | "guest"
  | "user"
  | "member"
  | "editor"
  | "moderator"
  | "admin"
  | "owner";

const ROLE_LEVELS: Record<RoleName, WorkspaceRole> = {
  guest: WORKSPACE_ROLE_LEVELS.GUEST,
  user: WORKSPACE_ROLE_LEVELS.USER,
  member: WORKSPACE_ROLE_LEVELS.MEMBER,
  editor: WORKSPACE_ROLE_LEVELS.EDITOR,
  moderator: WORKSPACE_ROLE_LEVELS.MODERATOR,
  admin: WORKSPACE_ROLE_LEVELS.ADMIN,
  owner: WORKSPACE_ROLE_LEVELS.OWNER,
};

export interface AccessAuth {
  /** The caller's subject, from your identity provider. */
  sub: string;
  role: WorkspaceRole;
  workspaceId: string;
}

export interface CheckContext<F extends Fields = Fields> {
  auth: AccessAuth;
  /** The stored row, for update, delete and read. */
  row?: Partial<Row<F>> & { id: string };
  /** The incoming values, for create and update. */
  data?: Record<string, unknown>;
  /** Field names this write sets. */
  changed?: string[];
}

export interface RoleDecision {
  readonly decision: "role";
  readonly level: WorkspaceRole;
}
export interface FilterDecision<F extends Fields = Fields> {
  readonly decision: "filter";
  readonly build: (context: { auth: AccessAuth }) => Where<F> | Where<F>[];
}
export interface CheckDecision<F extends Fields = Fields> {
  readonly decision: "check";
  readonly test: (context: CheckContext<F>) => boolean;
}

/** A minimum role, checked before any SQL. */
export function role(name: RoleName): RoleDecision {
  const level = ROLE_LEVELS[name];
  if (level === undefined) throw new Error(`Unknown role "${name}".`);
  return { decision: "role", level };
}

/**
 * `read` only: the rows the caller may see, as a filter compiled into SQL. An
 * array is OR of its filters.
 */
export function filter<F extends Fields = Fields>(
  build: (context: { auth: AccessAuth }) => Where<F> | Where<F>[]
): FilterDecision<F> {
  return { decision: "filter", build };
}

/** A predicate over the caller and the row. Throwing denies. */
export function check<F extends Fields = Fields>(
  test: (context: CheckContext<F>) => boolean
): CheckDecision<F> {
  return { decision: "check", test };
}

// ---- File rules ------------------------------------------------------------

/** A file as file rules see it. */
export interface FileInfo {
  path: string;
  /** Bytes; null for a write whose size is not known yet (a multipart start). */
  size: number | null;
  contentType: string | null;
  /** The uploader's claim subject. */
  uploadedBy: string;
}

export interface FileCheckContext {
  auth: AccessAuth;
  /** For read and delete, the stored file; for write, the incoming one. */
  file: FileInfo;
  /** For write, the stored file it would replace, if any. */
  existing?: FileInfo;
}

export interface FileCheckDecision {
  readonly decision: "check";
  readonly test: (context: FileCheckContext) => boolean;
}

export interface AttachedToDecision<K extends string = string> {
  readonly decision: "attachedTo";
  readonly model: K;
  readonly locate: (path: string) => string | null | undefined;
}

/** A file rule: a predicate over the caller and the file. Throwing denies. */
export function fileCheck(test: (context: FileCheckContext) => boolean): FileCheckDecision {
  return { decision: "check", test };
}

/**
 * A file rule: the file belongs to a row and follows its rules. `locate`
 * maps a path to the row's id (null when the path names none, which denies).
 * Reading the file needs the row to be readable by the caller; writing or
 * deleting it needs the caller to be allowed to update the row.
 *
 *   files: { read: attachedTo("task", (path) => path.split("/")[1]) }
 */
export function attachedTo<K extends string>(
  model: K,
  locate: (path: string) => string | null | undefined
): AttachedToDecision<K> {
  return { decision: "attachedTo", model, locate };
}

export type FileRuleDecision<K extends string = string> = RoleDecision | FileCheckDecision | AttachedToDecision<K>;

/** Who may read, write and delete each file. Defaults: read member, write and delete editor. */
export interface FileAccess<K extends string = string> {
  read?: FileRuleDecision<K>;
  write?: FileRuleDecision<K>;
  delete?: FileRuleDecision<K>;
}

export interface SchemaOptions<K extends string = string> {
  files?: FileAccess<K>;
}

export interface Access<F extends Fields = Fields> {
  read?: RoleDecision | FilterDecision<F> | CheckDecision<F>;
  create?: RoleDecision | CheckDecision<F>;
  update?: RoleDecision | CheckDecision<F>;
  delete?: RoleDecision | CheckDecision<F>;
}

// ---- Models ----------------------------------------------------------------

export type Fields = Record<string, ModelMember>;

export interface ModelOptions {
  /** An existing table to map this model onto. Default: the key in snake_case. */
  table?: string;
}

export class Model<F extends Fields = Fields> {
  constructor(
    readonly fields: F,
    readonly options: ModelOptions = {},
    readonly rules: Access<F> = {}
  ) {}

  /** Who may read, create, update and delete rows of this model. */
  access(rules: Access<F>): Model<F> {
    return new Model(this.fields, this.options, rules);
  }
}

export function model<F extends Fields>(fields: F, options: ModelOptions = {}): Model<F> {
  return new Model(fields, options);
}

// ---- Inferred types --------------------------------------------------------

type Keys<F, Tag> = { [K in keyof F]: F[K] extends Tag ? K : never }[keyof F] & string;

export type ScalarKeys<F> = Keys<F, Field>;
export type BelongsToKeys<F> = Keys<F, BelongsTo>;
export type HasManyKeys<F> = Keys<F, HasMany>;
export type RelationKeys<F> = BelongsToKeys<F> | HasManyKeys<F>;

type OutputOf<S> = S extends EnumField<infer V, infer O, boolean>
  ? V | (O extends true ? null : never)
  : S extends Field<infer K, infer O, boolean>
    ? KindOutput[K] | (S extends { personalSubject: string } ? null : O extends true ? null : never)
    : never;

type ForeignKeyOf<S> = S extends BelongsTo<string, infer O>
  ? string | (O extends true ? null : never)
  : never;

/** A stored row: its fields, the foreign keys of its `belongsTo` relations, and the system fields. */
export type Row<F> = { id: string; createdAt: number; updatedAt: number; $erased?: string[] } & {
  [K in ScalarKeys<F>]: OutputOf<F[K]>;
} & {
  [K in BelongsToKeys<F> as `${K}Id`]: ForeignKeyOf<F[K]>;
};

/** Fields filterable and sortable: scalars except json, foreign keys and `id`. */
export type FilterKeys<F> =
  | "id"
  | { [K in ScalarKeys<F>]: F[K] extends { personalSubject: string } ? never : F[K] extends Field<"json", boolean, boolean> ? never : K }[ScalarKeys<F>]
  | `${BelongsToKeys<F>}Id`;

type InputOf<S> = S extends EnumField<infer V, infer O, boolean>
  ? V | (O extends true ? null : never)
  : S extends Field<infer K, infer O, boolean>
    ? KindInput[K] | (O extends true ? null : never)
    : never;

type RequiredScalarKeys<F> = {
  [K in ScalarKeys<F>]: F[K] extends Field<ScalarKind, false, false> ? K : never;
}[ScalarKeys<F>];
type OptionalScalarKeys<F> = Exclude<ScalarKeys<F>, RequiredScalarKeys<F>>;

/**
 * Rows a write may create alongside the row it addresses, typed at every
 * depth. Relation keys resolve lazily (as property types of a mapped object),
 * so models that point at each other do not expand the graph up front. The
 * key that links a nested row to the row creating it is filled in by the
 * write, so every relation is optional here; the engine still validates
 * every op.
 */
type NestedCreate<F, M extends Models> = { id?: string } & {
  [K in RequiredScalarKeys<F>]: InputOf<F[K]>;
} & {
  [K in OptionalScalarKeys<F>]?: InputOf<F[K]>;
} & {
  [K in BelongsToKeys<F>]?: BelongsToInput<F[K], M>;
} & {
  [K in HasManyKeys<F>]?: HasManyInput<F[K], M>;
} & {
  [K in BelongsToKeys<F> as `${K}Id`]?: string | null;
};

type BelongsToInput<F, M extends Models> =
  | { connect: string }
  | { create: NestedCreate<TargetFieldsOf<F, M>, M> }
  | { disconnect: true }
  | null;

type RequiredBelongsToKeys<F> = {
  [K in BelongsToKeys<F>]: F[K] extends BelongsTo<string, false> ? K : never;
}[BelongsToKeys<F>];

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (
  value: infer I
) => void
  ? I
  : never;

/**
 * A required belongsTo must be set on create, as `{ connect }` or as its key.
 * Each key's two forms are boxed before the union of keys becomes an
 * intersection, so "board or boardId" stays a choice instead of becoming both.
 */
type RequiredParents<F> = [RequiredBelongsToKeys<F>] extends [never]
  ? unknown
  : Unbox<
      UnionToIntersection<
        {
          [K in RequiredBelongsToKeys<F>]: {
            box: { [P in K]: { connect: string } } | { [P in `${K}Id`]: string };
          };
        }[RequiredBelongsToKeys<F>]
      >
    >;

type Unbox<T> = T extends { box: infer B } ? B : never;
type HasManyInput<F, M extends Models> = {
  connect?: string[];
  disconnect?: string[];
  /** Rows created with this one, carrying its key. */
  create?: NestedCreate<TargetFieldsOf<F, M>, M> | NestedCreate<TargetFieldsOf<F, M>, M>[];
};

export type CreateData<F, M extends Models = Models> = { id?: string } & RequiredParents<F> & {
  [K in RequiredScalarKeys<F>]: InputOf<F[K]>;
} & {
  [K in OptionalScalarKeys<F>]?: InputOf<F[K]>;
} & {
  [K in BelongsToKeys<F>]?: BelongsToInput<F[K], M>;
} & {
  [K in BelongsToKeys<F> as `${K}Id`]?: string | null;
} & {
  [K in HasManyKeys<F>]?: HasManyInput<F[K], M>;
};

export type UpdateData<F, M extends Models = Models> = {
  [K in ScalarKeys<F>]?: InputOf<F[K]>;
} & {
  [K in BelongsToKeys<F>]?: BelongsToInput<F[K], M>;
} & {
  [K in BelongsToKeys<F> as `${K}Id`]?: string | null;
} & {
  [K in HasManyKeys<F>]?: HasManyInput<F[K], M>;
};

export type Models = Record<string, Model>;
export type FieldsOf<M> = M extends Model<infer F> ? F : never;

type TargetOf<S> = S extends BelongsTo<infer T, boolean> ? T : S extends HasMany<infer T> ? T : never;
type TargetFields<S, M extends Models> = TargetOf<S> extends keyof M ? FieldsOf<M[TargetOf<S>]> : Fields;

/** The fields of the model a relation points at. */
export type TargetFieldsOf<S, M extends Models> = TargetFields<S, M>;

/**
 * The columns every row carries. They are readable, sortable, filterable and
 * groupable, and the engine writes them: no create or update accepts them.
 */
export type SystemKey = "createdAt" | "updatedAt" | "updatedSeq";
export type OrderBy<F> =
  | Partial<Record<FilterKeys<F> | SystemKey, "asc" | "desc">>
  | Partial<Record<FilterKeys<F> | SystemKey, "asc" | "desc">>[];

export interface IncludeArgs<M extends Models, F extends Fields> {
  where?: Where<F, M>;
  orderBy?: OrderBy<F>;
  take?: number;
  include?: Include<M, F>;
  select?: Select<M, F>;
}

export type Include<M extends Models, F extends Fields> = {
  [K in RelationKeys<F>]?: true | IncludeArgs<M, TargetFields<F[K], M>>;
};

/**
 * Fields to return instead of the whole row. Relations listed here are
 * included, and may carry their own `select`.
 */
export type Select<M extends Models, F extends Fields> = {
  [K in keyof Row<F>]?: boolean;
} & {
  [K in RelationKeys<F>]?: boolean | IncludeArgs<M, TargetFields<F[K], M>>;
};

type Included<M extends Models, S, A> = (A extends { select: infer Sel }
  ? Selected<M, TargetFields<S, M>, Sel>
  : Row<TargetFields<S, M>>) &
  (A extends { include: infer I } ? WithInclude<M, TargetFields<S, M>, I> : unknown);

type RelationOutput<M extends Models, S, A> = S extends HasMany
  ? Included<M, S, A>[]
  : S extends BelongsTo<string, infer O>
    ? Included<M, S, A> | (O extends true ? null : never)
    : never;

/** A row plus whatever `include` asked for, at every level. */
export type WithInclude<M extends Models, F extends Fields, I> = I extends object
  ? {
      [K in keyof I & RelationKeys<F>]: RelationOutput<M, F[K], I[K]>;
    }
  : unknown;

/** Exactly the fields a `select` named, and the relations it included. */
export type Selected<M extends Models, F extends Fields, S> = {
  [K in keyof S & keyof Row<F> as S[K] extends false | undefined ? never : K]: Row<F>[K];
} & {
  [K in keyof S & RelationKeys<F> as S[K] extends false | undefined ? never : K]: RelationOutput<
    M,
    F[K],
    S[K]
  >;
};

// ---- Aggregates -------------------------------------------------------------

type NumberKeys<F> = {
  [K in ScalarKeys<F>]: F[K] extends Field<"number", boolean, boolean> ? K : never;
}[ScalarKeys<F>];

/** Fields a group can be keyed by: anything filterable, and the timestamps. */
export type GroupKeys<F> = FilterKeys<F> | SystemKey;

/** Fields with an order, so a minimum and maximum: not booleans or json. */
type OrderedKeys<F> =
  | Exclude<GroupKeys<F>, { [K in ScalarKeys<F>]: F[K] extends Field<"boolean", boolean, boolean> ? K : never }[ScalarKeys<F>]>;

type Flags<K extends PropertyKey> = { [P in K]?: boolean };

export interface AggregateMeasures<F> {
  /** `true` counts rows; an object counts rows (`_all`) and non-null values per field. */
  _count?: true | ({ _all?: boolean } & Flags<Exclude<keyof Row<F>, { [K in ScalarKeys<F>]: F[K] extends { personalSubject: string } ? K : never }[ScalarKeys<F>] | "$erased">>);
  _sum?: Flags<NumberKeys<F>>;
  _avg?: Flags<NumberKeys<F>>;
  _min?: Flags<OrderedKeys<F>>;
  _max?: Flags<OrderedKeys<F>>;
}

type On<S> = { [K in keyof S]: S[K] extends false | undefined ? never : K }[keyof S];

/** What a set of measures returns. */
export type AggregateOutput<F, A> = (A extends { _count: infer C }
  ? { _count: C extends true ? number : { [K in On<C>]: number } }
  : unknown) &
  (A extends { _sum: infer S } ? { _sum: { [K in On<S>]: number | null } } : unknown) &
  (A extends { _avg: infer S } ? { _avg: { [K in On<S>]: number | null } } : unknown) &
  (A extends { _min: infer S } ? { _min: { [K in On<S> & keyof Row<F>]: Row<F>[K] | null } } : unknown) &
  (A extends { _max: infer S } ? { _max: { [K in On<S> & keyof Row<F>]: Row<F>[K] | null } } : unknown);

/** One `groupBy` row: the key fields, then the measures. */
export type GroupRow<F, A> = (A extends { by: ReadonlyArray<infer K> }
  ? { [P in K & keyof Row<F>]: Row<F>[P] }
  : unknown) &
  AggregateOutput<F, A>;

// ---- The schema ------------------------------------------------------------

export interface RelationInfo {
  kind: "belongsTo" | "hasMany";
  target: string;
  /** Engine link api name shared by both sides. */
  link: string;
  /** belongsTo: the foreign-key attribute on this model. */
  foreignKey?: string;
  optional?: boolean;
}

export interface ModelInfo {
  key: string;
  scalars: Record<string, { kind: ScalarKind; optional: boolean; hasDefault: boolean; defaultValue: unknown }>;
  relations: Record<string, RelationInfo>;
  /** Attributes a filter may name: id, non-json scalars, foreign keys. */
  filterable: Set<string>;
}

export interface Schema<M extends Models = Models> extends TapeDBSchema {
  readonly models: M;
  readonly graph: Record<string, ModelInfo>;
}

const DELETE_RULES: Record<string, DeleteRule> = {
  setNull: "SET NULL",
  cascade: "CASCADE",
  restrict: "RESTRICT",
};

// Validate literal schemas without expanding the recursive client row types.
// Widened/dynamic names remain runtime-validated, as they were before.
type MatchingParents<F, Owner extends string> = {
  [P in BelongsToKeys<F>]: F[P] extends BelongsTo<Owner, boolean> ? P : never;
}[BelongsToKeys<F>];
type IsUnion<T, Whole = T> = T extends Whole ? [Whole] extends [T] ? false : true : never;
type InverseOf<R> = R extends HasMany ? Exclude<R["inverse"], undefined> : never;
type InverseError<R, F, Owner extends string> =
  string extends InverseOf<R> ? never :
  [InverseOf<R>] extends [never]
    ? [MatchingParents<F, Owner>] extends [never] ? "has no matching belongsTo" :
      true extends IsUnion<MatchingParents<F, Owner>> ? "needs an explicit inverse" : never
    : InverseOf<R> extends MatchingParents<F, Owner> ? never : "has an invalid inverse";
type SubjectError<R, F> = R extends { personalSubject: infer S extends string }
  ? string extends S ? never : S extends "self" ? never :
    S extends keyof F
      ? F[S] extends Field<"string", boolean, boolean>
        ? F[S] extends { personalSubject: string } ? "needs a non-personal string subject" : never
        : "needs a non-personal string subject"
      : S extends `${BelongsToKeys<F>}Id` ? never : "refers to a missing personal subject"
  : never;
type MemberError<R, M extends Models, Owner extends string, F> =
  R extends BelongsTo | HasMany
    ? string extends TargetOf<R> ? never : TargetOf<R> extends "$users" ? R extends HasMany ? "must use belongsTo for $users" : never : TargetOf<R> extends keyof M
      ? R extends HasMany ? InverseError<R, FieldsOf<M[TargetOf<R>]>, Owner> : never
      : "refers to a missing model"
    : SubjectError<R, F>;
type SchemaErrors<M extends Models> = string extends keyof M ? never : {
  [K in keyof M & string]: {
    [P in keyof FieldsOf<M[K]> & string]: MemberError<FieldsOf<M[K]>[P], M, K, FieldsOf<M[K]>> extends infer E extends string
      ? `${K}.${P} ${E}` : never;
  }[keyof FieldsOf<M[K]> & string];
}[keyof M & string];
type ValidSchema<M extends Models> = [SchemaErrors<M>] extends [never]
  ? unknown : { readonly __schemaError: SchemaErrors<M> };

const usersModel=()=>model({name:t.string().personal({subject:"self"}),image:t.string().personal({subject:"self"}).optional()},{table:"tapedb_users"}).access({
 read:role("guest"),
 create:check(({auth})=>auth.sub==='__tapedb_auth' && auth.role===WORKSPACE_ROLE_LEVELS.DEVELOPER),
 update:check(({auth})=>auth.sub==='__tapedb_auth' && auth.role===WORKSPACE_ROLE_LEVELS.DEVELOPER),
 delete:check(({auth})=>auth.sub==='__tapedb_auth' && auth.role===WORKSPACE_ROLE_LEVELS.DEVELOPER),
});
type ModelTargets<M extends Models> = {[K in keyof M]:TargetOf<FieldsOf<M[K]>[keyof FieldsOf<M[K]>]>}[keyof M];
type WithUsers<M extends Models> = "$users" extends ModelTargets<M> ? M & {"$users":ReturnType<typeof usersModel>} : M;

/**
 * Compiles models into the engine schema plus the client's relation graph.
 * Throws on anything the engine would only discover later: a relation to a
 * model that does not exist, an ambiguous inverse, a reserved name.
 */
export function schema<M extends Models>(
  models: M & ValidSchema<NoInfer<M>>,
  options: SchemaOptions<Extract<keyof M, string>> = {}
): Schema<WithUsers<M>> {
  if(Object.hasOwn(models,"$users"))throw new Error("$users is managed by built-in auth.");
  const usesUsers=Object.values(models).some(definition=>Object.values(definition.fields).some(member=>member instanceof BelongsTo && member.target==='$users'));
  const allModels:Models=usesUsers?{...models,"$users":usersModel()}:models;
  const entities: Record<string, EntityConfig> = {};
  const links: LinkDefinition[] = [];
  const graph: Record<string, ModelInfo> = {};
  const permissions: PermissionOverrides = {};

  for (const [key, definition] of Object.entries(allModels)) {
    if (key!=="$users" && !/^[A-Za-z][A-Za-z0-9]*$/.test(key)) {
      throw new Error(`Model name "${key}" must be letters and digits, starting with a letter.`);
    }
    if (!(definition instanceof Model)) {
      throw new Error(`"${key}" is not a model(). Wrap its fields in model({ ... }).`);
    }
    const info: ModelInfo = { key, scalars: {}, relations: {}, filterable: new Set(["id"]) };
    const attributes: EntityConfig = {};

    for (const [name, member] of Object.entries(definition.fields)) {
      if (["id", "createdAt", "updatedAt", "updatedSeq"].includes(name)) {
        throw new Error(`"${key}.${name}" is a system field and cannot be declared.`);
      }
      if (member instanceof Field) {
        const subject = "personalSubject" in member ? String(member.personalSubject) : undefined;
        if (subject && subject !== "self" && !(subject in definition.fields) &&
          !Object.entries(definition.fields).some(([field, value]) => value instanceof BelongsTo && `${field}Id` === subject))
          throw new Error(`Personal field ${key}.${name} refers to missing subject ${subject}.`);
        if (subject && subject !== "self" && subject in definition.fields) {
          const owner = definition.fields[subject];
          if (!(owner instanceof Field) || owner.kind !== "string" || "personalSubject" in owner)
            throw new Error(`Personal field ${key}.${name} requires a non-personal string subject.`);
        }
        attributes[name] = {
          type: member.kind,
          // A field with a default is filled in by create, so the engine never
          // sees it missing; it stays required for writes that bypass create.
          optional: subject ? true : member.isOptional,
          ...(subject ? { personal: { subject, required: !member.isOptional, ...(member.hasDefault ? { defaultValue: storedDefault(member.kind, member.defaultValue) } : {}) } } : {}),
          indexed: member.isIndexed || undefined,
          unique: member.isUnique || undefined,
          ...(member instanceof EnumField ? { values: member.values } : {}),
          ...(member.hasDefault && !subject ? { default: storedDefault(member.kind, member.defaultValue) } : {}),
        } as AttributeDefinition;
        info.scalars[name] = {
          kind: member.kind,
          optional: member.isOptional,
          hasDefault: member.hasDefault,
          defaultValue: member.defaultValue,
        };
        if (member.kind !== "json" && !subject) info.filterable.add(name);
      } else if (member instanceof BelongsTo) {
        if (!(member.target in allModels)) {
          throw new Error(`"${key}.${name}" belongs to "${member.target}", which is not a model.`);
        }
        const foreignKey = `${name}Id`;
        if (foreignKey in definition.fields) {
          throw new Error(`"${key}.${foreignKey}" clashes with the key "${key}.${name}" stores.`);
        }
        attributes[foreignKey] = {
          type: "string",
          optional: member.isOptional,
          indexed: true,
          // defineSchema fills in the table; only the delete rule is ours.
          references: { table: "", column: "id", onDelete: DELETE_RULES[member.onDelete] },
        };
        info.relations[name] = {
          kind: "belongsTo",
          target: member.target,
          link: `${key}.${name}`,
          foreignKey,
          optional: member.isOptional,
        };
        info.filterable.add(foreignKey);
      } else if (member instanceof HasMany) {
        if (!(member.target in allModels)) {
          throw new Error(`"${key}.${name}" has many "${member.target}", which is not a model.`);
        }
        // Resolved below, once every belongsTo is known.
        info.relations[name] = { kind: "hasMany", target: member.target, link: "" };
      } else {
        throw new Error(`"${key}.${name}" is not a field. Use t.string(), t.belongsTo(), ...`);
      }
    }

    entities[key] = attributes;
    graph[key] = info;
    const overrides = accessOverrides(key, definition.rules, graph);
    if (overrides) permissions[key] = overrides;
  }

  // Pair every hasMany with its belongsTo, then emit one engine link per pair.
  // A belongsTo with no hasMany still needs a link: its inverse label is
  // private, so include cannot reach it.
  const pairedInverse = new Map<string, string>();
  for (const info of Object.values(graph)) {
    for (const [name, relation] of Object.entries(info.relations)) {
      if (relation.kind !== "hasMany") continue;
      const member = (allModels[info.key] as Model).fields[name] as HasMany;
      const candidates = Object.entries(graph[relation.target].relations).filter(
        ([, other]) => other.kind === "belongsTo" && other.target === info.key
      );
      const chosen = member.inverse
        ? candidates.filter(([field]) => field === member.inverse)
        : candidates;
      if (chosen.length !== 1) {
        throw new Error(
          chosen.length === 0
            ? `"${info.key}.${name}" has no matching belongsTo("${info.key}") on "${relation.target}".`
            : `"${info.key}.${name}" matches several belongsTo fields on "${relation.target}"; name one with { inverse }.`
        );
      }
      const [inverseField, inverse] = chosen[0];
      if (pairedInverse.has(inverse.link)) {
        throw new Error(`"${inverse.link}" is the inverse of two hasMany fields.`);
      }
      pairedInverse.set(inverse.link, name);
      relation.link = inverse.link;
      relation.foreignKey = `${inverseField}Id`;
    }
  }

  for (const info of Object.values(graph)) {
    for (const [name, relation] of Object.entries(info.relations)) {
      if (relation.kind !== "belongsTo") continue;
      links.push({
        apiName: relation.link,
        kind: "one-to-many",
        forward: {
          namespace: relation.target,
          label: pairedInverse.get(relation.link) ?? `__${info.key}_${name}`,
          has: "many",
        },
        reverse: { namespace: info.key, label: name, has: "one" },
        foreignKey: { namespace: info.key, attribute: relation.foreignKey! },
      });
    }
  }

  const tables: Record<string, string> = {};
  for (const [key, definition] of Object.entries(allModels)) {
    if (definition.options.table !== undefined) tables[key] = definition.options.table;
  }

  const files = options.files;
  for (const [action, rule] of Object.entries(files ?? {})) {
    if (!["read", "write", "delete"].includes(action)) {
      throw new Error(`files.${action} is not a file action; use read, write or delete.`);
    }
    if (rule?.decision === "attachedTo" && !(rule.model in allModels)) {
      throw new Error(`files.${action} is attached to "${rule.model}", which is not a model.`);
    }
    if ((rule as { decision?: string } | undefined)?.decision === "filter") {
      throw new Error(`files.${action}: filter() is for model reads; use fileCheck() or attachedTo().`);
    }
  }

  const compiled = defineSchema({ entities, links, permissions, tables });
  return { ...compiled, ...(files && Object.keys(files).length > 0 ? { files: files as unknown as FileRules } : {}), models:allModels, graph } as Schema<WithUsers<M>>;
}

/** A default in the form the column stores it. */
function storedDefault(kind: ScalarKind, value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case "boolean":
      return value ? 1 : 0;
    case "date":
      return value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number(value);
    case "json":
      return JSON.stringify(value);
    case "number":
      return Number(value);
    default:
      return String(value);
  }
}

function accessOverrides(
  key: string,
  rules: Access,
  graph: Record<string, ModelInfo>
): Partial<Record<"view" | "create" | "update" | "delete", PermissionDecision>> | undefined {
  const out: Partial<Record<"view" | "create" | "update" | "delete", PermissionDecision>> = {};
  for (const [action, decision] of Object.entries(rules) as [keyof Access, Access[keyof Access]][]) {
    if (decision === undefined) continue;
    const engineAction = action === "read" ? "view" : action;
    if (decision.decision === "role") {
      out[engineAction] = decision.level;
    } else if (decision.decision === "filter") {
      if (action !== "read") throw new Error(`"${key}.${action}": filter() is only valid for read.`);
      const build = decision.build;
      out.view = {
        where: (auth) => {
          const result = build({ auth });
          const branches = Array.isArray(result) ? result : [result];
          return branches.map((branch) => toEngineWhere(graph[key], branch as Where<Fields>)) as QueryWhere[];
        },
      };
    } else {
      const test = decision.test;
      out[engineAction] = (context) =>
        test({ auth: context.auth, row: context.data as never, data: context.next, changed: context.changed });
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
