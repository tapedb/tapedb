/**
 * Field and relation builders: the `t` in `model({ title: t.string() })`.
 *
 * Every builder is immutable: a modifier returns a new builder, so a shared
 * base field cannot be changed by one model's `.optional()`. The type
 * parameters carry what the client needs to infer rows and inputs.
 */

import { assertVectorDimensions } from "./vector";

export type ScalarKind = "string" | "number" | "boolean" | "date" | "json" | "vector";

/** The TypeScript type a stored value comes back as. */
export interface KindOutput {
  string: string;
  number: number;
  boolean: boolean;
  /** Epoch milliseconds. */
  date: number;
  json: unknown;
  /**
   * The stored form, `f32le:v1:<base64>`. A read returns it only when a
   * `select` names the field; pass it to `decodeVector()` for the numbers.
   */
  vector: string;
}

/** What a write accepts for each kind. */
export interface KindInput {
  string: string;
  number: number;
  boolean: boolean;
  date: number | Date | string;
  json: unknown;
  /** The embedding, as the numbers the model produced. */
  vector: number[];
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
  personal<S extends string>(this: Field<K, O, D> & (K extends "string" | "json" ? unknown : never), options: { subject: S }): PersonalField<Extract<K, "string" | "json">, O, D, S> {
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

/**
 * A string with a closed set of values.
 *
 * The column is TEXT and the migration snapshot does not record the set, so
 * adding or removing a value needs no migration: it changes what the engine
 * accepts, not the table. The type narrows to the union, so the editor catches a
 * typo before the engine has to.
 *
 * An enum is not personal: the set is public, and encrypting it would break the
 * comparison the check depends on.
 */
export class EnumField<
  V extends string = string,
  O extends boolean = boolean,
  D extends boolean = boolean,
> extends Field<"string", O, D> {
  constructor(
    readonly values: readonly V[],
    isOptional: O,
    hasDefault: D,
    defaultValue?: V,
    isIndexed = false,
    isUnique = false
  ) {
    super("string", isOptional, hasDefault, defaultValue, isIndexed, isUnique);
  }

  /** The set is public and the check needs plaintext, so an enum cannot be personal. */
  override personal(): never {
    throw new Error("t.enum() cannot be personal: its values are public and the engine compares them as text.");
  }

  override optional(): EnumField<V, true, D> {
    return new EnumField<V, true, D>(this.values, true, this.hasDefault, this.defaultValue as V | undefined, this.isIndexed, this.isUnique);
  }

  override default(value: V): EnumField<V, O, true> {
    if (!this.values.includes(value)) {
      throw new Error(`Default "${String(value)}" is not one of: ${this.values.join(", ")}.`);
    }
    return new EnumField<V, O, true>(this.values, this.isOptional, true, value, this.isIndexed, this.isUnique);
  }

  override index(): EnumField<V, O, D> {
    return new EnumField<V, O, D>(this.values, this.isOptional, this.hasDefault, this.defaultValue as V | undefined, true, this.isUnique);
  }

  override unique(): EnumField<V, O, D> {
    return new EnumField<V, O, D>(this.values, this.isOptional, this.hasDefault, this.defaultValue as V | undefined, this.isIndexed, true);
  }
}

/**
 * An embedding: a fixed-length list of numbers, stored as one string.
 *
 * The value is `f32le:v1:<base64>` (see `src/model/vector.ts`), so it survives
 * every JSON row pipeline byte for byte. A write supplies `number[]`; the
 * engine checks the length, converts to float32, refuses a non-finite or
 * all-zero vector, and stores the string. Reads leave it out unless a `select`
 * names it.
 */
export class VectorField<
  O extends boolean = boolean,
> extends Field<"vector", O, false> {
  constructor(
    /** The declared length: an integer from 1 to 1,536. */
    readonly dimensions: number,
    isOptional: O
  ) {
    super("vector", isOptional, false);
  }

  /** The field may be null, and may be left out of `create`. */
  override optional(): VectorField<true> {
    return new VectorField(this.dimensions, true);
  }

  /** An embedding is supplied per row: there is no sensible one for all rows. */
  override default(): never {
    throw new Error("t.vector() cannot have a default: every row carries its own embedding.");
  }

  /** A column of base64 is not a filter or sort key. */
  override index(): never {
    throw new Error("t.vector() cannot be indexed: embeddings are not filterable or sortable.");
  }

  override unique(): never {
    throw new Error("t.vector() cannot be unique.");
  }

  override personal(): never {
    throw new Error("t.vector() cannot be personal: the codec needs the plaintext bytes.");
  }
}

export class PersonalField<K extends "string" | "json" = "string" | "json", O extends boolean = boolean, D extends boolean = boolean, S extends string = string> extends Field<K, O, D> {
  constructor(kind: K, optional: O, hasDefault: D, readonly personalSubject: S, defaultValue?: unknown) {
    super(kind, optional, hasDefault, defaultValue);
  }
  override optional(): PersonalField<K, true, D, S> { return new PersonalField(this.kind, true, this.hasDefault, this.personalSubject, this.defaultValue); }
  override default(value: KindInput[K]): PersonalField<K, O, true, S> { return new PersonalField(this.kind, this.isOptional, true, this.personalSubject, value); }
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
export class HasMany<T extends string = string, I extends string | undefined = string | undefined> {
  readonly tag = "hasMany" as const;

  constructor(
    readonly target: T,
    readonly inverse?: I
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
  /**
   * An embedding: `dimensions` numbers, 1 to 1,536. Stored as one
   * `f32le:v1:<base64>` string; supplied as `number[]`. Optional per field.
   */
  vector: (options: { dimensions: number }) => {
    if (typeof options !== "object" || options === null) {
      throw new Error(
        "t.vector() takes { dimensions }: an integer from 1 to 1,536."
      );
    }
    return new VectorField(assertVectorDimensions(options.dimensions), false);
  },
  /**
   * A string with a closed set of values. Stored as TEXT, checked on every
   * write, narrowed to the union in `Row` and `CreateData`.
   */
  enum: <const V extends readonly string[]>(values: V) => {
    if (values.length === 0) throw new Error("t.enum() needs at least one value.");
    const seen = new Set<string>();
    for (const value of values) {
      if (typeof value !== "string" || value.length === 0) {
        throw new Error("t.enum() takes non-empty strings.");
      }
      if (seen.has(value)) throw new Error(`t.enum() repeats "${value}".`);
      seen.add(value);
    }
    return new EnumField<V[number]>([...values] as V[number][], false, false);
  },
  belongsTo: <T extends string>(target: T, options: BelongsToOptions = {}) =>
    new BelongsTo(target, false, options.onDelete ?? "setNull"),
  hasMany: <T extends string, const O extends HasManyOptions = {}>(target: T, options: O = {} as O) =>
    new HasMany<T, "inverse" extends keyof O ? O["inverse"] : undefined>(target, options.inverse as "inverse" extends keyof O ? O["inverse"] : undefined),
};
