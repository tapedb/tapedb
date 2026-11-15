/**
 * Field and relation builders: the `t` in `model({ title: t.string() })`.
 *
 * Every builder is immutable: a modifier returns a new builder, so a shared
 * base field cannot be changed by one model's `.optional()`. The type
 * parameters carry what the client needs to infer rows and inputs.
 */

export type ScalarKind = "string" | "number" | "boolean" | "date" | "json";

/** The TypeScript type a stored value comes back as. */
export interface KindOutput {
  string: string;
  number: number;
  boolean: boolean;
  /** Epoch milliseconds. */
  date: number;
  json: unknown;
}

/** What a write accepts for each kind. */
export interface KindInput {
  string: string;
  number: number;
  boolean: boolean;
  date: number | Date | string;
  json: unknown;
}

export type DeleteBehaviour = "setNull" | "cascade" | "restrict";

export class Field<
  K extends ScalarKind = ScalarKind,
  O extends boolean = boolean,
  D extends boolean = boolean,
> {
  readonly tag = "field" as const;

  constructor(
    readonly kind: K,
    readonly isOptional: O,
    readonly hasDefault: D,
    readonly defaultValue: unknown = undefined,
    readonly isIndexed = false,
    readonly isUnique = false
  ) {}

  /** Encrypt this value under the named subject's erasable key. */
  personal(this: Field<K, O, D> & (K extends "string" | "json" ? unknown : never), options: { subject: string }): PersonalField<Extract<K, "string" | "json">, O, D> {
    if (this.isIndexed || this.isUnique) throw new Error("Personal fields cannot be indexed or unique.");
    if (!options.subject) throw new Error("A personal field needs its subject field, or self.");
    return new PersonalField(this.kind as Extract<K, "string" | "json">, this.isOptional, this.hasDefault, options.subject, this.defaultValue);
  }

  /** The field may be null, and may be left out of `create`. */
  optional(): Field<K, true, D> {
    return new Field(this.kind, true, this.hasDefault, this.defaultValue, this.isIndexed, this.isUnique);
  }

  /** Filled in by `create` when the field is left out. */
  default(value: KindInput[K]): Field<K, O, true> {
    return new Field(this.kind, this.isOptional, true, value, this.isIndexed, this.isUnique);
  }

  /** Adds an index, for filters and sorts on this field. */
  index(): Field<K, O, D> {
    return new Field(this.kind, this.isOptional, this.hasDefault, this.defaultValue, true, this.isUnique);
  }

  /** Adds a unique index. */
  unique(): Field<K, O, D> {
    return new Field(this.kind, this.isOptional, this.hasDefault, this.defaultValue, this.isIndexed, true);
  }
}

export class PersonalField<K extends "string" | "json" = "string" | "json", O extends boolean = boolean, D extends boolean = boolean> extends Field<K, O, D> {
  constructor(kind: K, optional: O, hasDefault: D, readonly personalSubject: string, defaultValue?: unknown) {
    super(kind, optional, hasDefault, defaultValue);
  }
  override optional(): PersonalField<K, true, D> { return new PersonalField(this.kind, true, this.hasDefault, this.personalSubject, this.defaultValue); }
  override default(value: KindInput[K]): PersonalField<K, O, true> { return new PersonalField(this.kind, this.isOptional, true, this.personalSubject, value); }
  override index(this: never): never { throw new Error("Personal fields cannot be indexed."); }
  override unique(this: never): never { throw new Error("Personal fields cannot be unique."); }
}

export interface BelongsToOptions {
  /** What happens to this row when the row it points at is deleted. Default `setNull`. */
  onDelete?: DeleteBehaviour;
}

/**
 * This model holds the foreign key. A field `board` stores `boardId`.
 */
export class BelongsTo<T extends string = string, O extends boolean = boolean> {
  readonly tag = "belongsTo" as const;

  constructor(
    readonly target: T,
    readonly isOptional: O,
    readonly onDelete: DeleteBehaviour = "setNull"
  ) {}

  /** The key may be null: the row can exist without a parent. */
  optional(): BelongsTo<T, true> {
    return new BelongsTo(this.target, true, this.onDelete);
  }
}

export interface HasManyOptions {
  /**
   * The `belongsTo` field on the target that points back here. Needed only
   * when the target has more than one `belongsTo` to this model.
   */
  inverse?: string;
}

/** The inverse of a `belongsTo`. Stores nothing; named in `include`. */
export class HasMany<T extends string = string> {
  readonly tag = "hasMany" as const;

  constructor(
    readonly target: T,
    readonly inverse?: string
  ) {}
}

export type AnyField = Field<ScalarKind, boolean, boolean>;
export type ModelMember = AnyField | BelongsTo | HasMany;

export const t = {
  string: () => new Field("string", false, false),
  number: () => new Field("number", false, false),
  boolean: () => new Field("boolean", false, false),
  /** Stored as epoch milliseconds; accepts a `Date`, milliseconds or an ISO string. */
  date: () => new Field("date", false, false),
  /** Any JSON value. Not filterable or sortable. */
  json: () => new Field("json", false, false),
  belongsTo: <T extends string>(target: T, options: BelongsToOptions = {}) =>
    new BelongsTo(target, false, options.onDelete ?? "setNull"),
  hasMany: <T extends string>(target: T, options: HasManyOptions = {}) =>
    new HasMany(target, options.inverse),
};
