/**
 * `defineTapeDB({ vectorize })`, validated once when the Worker is defined.
 *
 * The option names the binding; the schema says what is indexed. Everything
 * that can be wrong about that pairing is refused here, at deploy time, rather
 * than on the first write:
 *
 * - the model must exist, and the field must be a `t.vector({ dimensions })`
 *   attribute — a string, a relation or a missing attribute is an error, not an
 *   empty index;
 * - the declared dimension count must be the one slice 1 validated (an integer
 *   from 1 to 1,536) — the index is provisioned from it, and a mismatch is only
 *   discovered as a wall of rejected upserts otherwise;
 * - a filter field must be a flat scalar (`string`, `number` or `boolean`): the
 *   provider filters on equality against a metadata index, and a `json`, `date`
 *   or vector attribute has no such index;
 * - a filter field must not be personal: metadata is stored at the provider, so
 *   a personal value there would be a copy outside the workspace's erasure;
 * - at most ten filter fields, because the provider allows ten metadata indexes
 *   per index and vectors written before one exists are never retroactively
 *   indexed into it;
 * - the codec tag this build writes must be the one it reads, because the
 *   digest records the tag: indexing under a tag the build cannot decode would
 *   write digests nothing can compare.
 *
 * Nothing here touches the network. The live index is checked separately, once,
 * before the first drain (`vectorIndexMatches`), because `describe()` needs the
 * binding and the binding is only available in a running room.
 */

import { assertVectorDimensions, encodeVector, decodeVector, VECTOR_TAG } from "../../model/vector";
import { NAMESPACES, toSnakeCase, type AttributeDefinition } from "../registry";

/**
 * The most filter attributes one index may declare: the provider allows ten
 * metadata indexes per index, and an eleventh has nowhere to live.
 */
export const VECTORIZE_MAX_FILTER_FIELDS = 10;

/** Scalar kinds a metadata filter may hold. */
export const VECTORIZE_FILTER_TYPES = ["string", "number", "boolean"] as const;
export type VectorizeFilterType = (typeof VECTORIZE_FILTER_TYPES)[number];

/** `defineTapeDB({ vectorize })`. @experimental */
export interface VectorizeOptions {
  /**
   * The Vectorize binding's name in `Env` — `VECTORIZE` for
   * `"vectorize": [{ "binding": "VECTORIZE", ... }]` in `wrangler.jsonc`. The
   * binding is read by that name at drain time, so a deployment that does not
   * configure this needs neither the binding nor the option.
   */
  index: string;
  /** The model whose rows are indexed, by API name. */
  model: string;
  /** The `t.vector({ dimensions })` attribute mirrored into the index. */
  field: string;
  /**
   * Attributes copied into the vector's metadata and usable as equality
   * filters. At most ten, all flat scalars, none personal.
   */
  filterFields?: readonly string[];
  /**
   * Optional embedding binding, so a caller can search with words instead of a
   * vector it computed itself. `binding` names a Workers AI binding in `Env`;
   * `model` is a `@cf/baai/bge-*` model whose output length must be the field's
   * declared dimensions. Without it the caller supplies the vector, which is
   * what a RAG pipeline does anyway when it embeds its corpus.
   */
  embed?: { binding: string; model?: string };
  /**
   * Text attributes indexed for keyword recall, so a search with words also
   * matches exact terms the embedding blurs (a part number, an acronym, a
   * name). Requires `embed`: keyword recall is applied to a text query.
   * At most five, all strings, none personal.
   */
  keywordFields?: readonly string[];
}

/** The embedding models whose output length this build can check. */
export const EMBEDDING_MODEL_DIMENSIONS: Readonly<Record<string, number>> = Object.freeze({
  "@cf/baai/bge-small-en-v1.5": 384,
  "@cf/baai/bge-base-en-v1.5": 768,
  "@cf/baai/bge-large-en-v1.5": 1024,
  "@cf/baai/bge-m3": 1024,
});

/** Used when `vectorize.embed.model` is omitted. */
export const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

/** One filter attribute, resolved against the schema. */
export interface VectorizeFilterField {
  /** The API name, e.g. `archived`. */
  attribute: string;
  /** The stored column, e.g. `archived`. */
  column: string;
  type: VectorizeFilterType;
}

/** A validated `vectorize` option: immutable, and per deployment. */
export interface ConfiguredVectorize {
  /** The binding name in `Env`. */
  readonly binding: string;
  /** The model's API name. */
  readonly model: string;
  /** The model's table. */
  readonly table: string;
  /** The vector attribute's API name. */
  readonly field: string;
  /** The vector attribute's column. */
  readonly column: string;
  /** Declared dimensions, as slice 1 validated them. */
  readonly dimensions: number;
  /** Filter attributes, in the order they were declared. */
  readonly filters: readonly VectorizeFilterField[];
  /** The codec tag this build writes and reads. */
  readonly codec: string;
  /** The embedding binding a text query is sent through, or null. */
  readonly embed: { readonly binding: string; readonly model: string } | null;
  /** Columns mirrored into the workspace's FTS5 table, in declaration order. */
  readonly keywordFields: readonly { readonly attribute: string; readonly column: string }[];
}

function invalid(message: string): never {
  throw new Error(message);
}

/**
 * Validates the option against the configured schema and returns this
 * deployment's resolved settings, or `null` when the deployment does not ask
 * for vector search. Called from `defineTapeDB` after `configureRegistry`, so
 * `NAMESPACES` is the deployment's own schema.
 */
export function resolveVectorize(options: VectorizeOptions | undefined): ConfiguredVectorize | null {
  if (options === undefined || options === null) return null;
  if (typeof options !== "object") invalid("vectorize must be an object.");

  const binding = options.index;
  if (typeof binding !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding)) {
    invalid(
      `vectorize.index must name the binding in Env, such as "VECTORIZE"; ${JSON.stringify(binding)} is not a binding name.`
    );
  }

  const model = typeof options.model === "string" ? NAMESPACES[options.model] : undefined;
  if (model === undefined) {
    invalid(
      `vectorize.model names ${JSON.stringify(options.model)}, which is not a model in this schema.`
    );
  }

  const field = options.field;
  if (typeof field !== "string") invalid("vectorize.field must name a t.vector({ dimensions }) attribute.");
  const vectorAttribute: AttributeDefinition | undefined = model.attributes[field];
  if (vectorAttribute === undefined) {
    invalid(`vectorize.field names ${JSON.stringify(field)}, which ${model.apiName} does not have.`);
  }
  if (vectorAttribute.type !== "vector") {
    invalid(
      `vectorize.field must name a t.vector({ dimensions }) attribute; ${model.apiName}.${field} is a ${vectorAttribute.type}.`
    );
  }
  if (vectorAttribute.personal !== undefined) {
    invalid(`vectorize.field cannot be a personal attribute: an embedding at the provider is a copy nothing erases.`);
  }
  // The same validator slice 1 runs on the schema: one declaration, one answer.
  const dimensions = assertVectorDimensions(vectorAttribute.dimensions);

  const declared = options.filterFields ?? [];
  if (!Array.isArray(declared)) invalid("vectorize.filterFields must be an array of attribute names.");
  if (declared.length > VECTORIZE_MAX_FILTER_FIELDS) {
    invalid(
      `vectorize.filterFields names ${declared.length} attributes; an index takes at most ${VECTORIZE_MAX_FILTER_FIELDS}, one per metadata index the provider allows.`
    );
  }

  const filters: VectorizeFilterField[] = [];
  const seen = new Set<string>();
  for (const [index, attribute] of declared.entries()) {
    const where = `vectorize.filterFields[${index}]`;
    if (typeof attribute !== "string") invalid(`${where} must be an attribute name.`);
    if (seen.has(attribute)) invalid(`${where} repeats ${JSON.stringify(attribute)}.`);
    seen.add(attribute);
    if (attribute === field) {
      invalid(`${where} names the vector attribute itself; a vector is not filter metadata.`);
    }
    const definition = model.attributes[attribute];
    if (definition === undefined) {
      invalid(`${where} names ${JSON.stringify(attribute)}, which ${model.apiName} does not have.`);
    }
    if (definition.personal !== undefined) {
      invalid(
        `${where} names a personal attribute; its value would be stored at the provider, outside the workspace's erasure.`
      );
    }
    if (!(VECTORIZE_FILTER_TYPES as readonly string[]).includes(definition.type)) {
      invalid(
        `${where} names a ${definition.type} attribute; a metadata filter is an equality on a flat string, number or boolean.`
      );
    }
    filters.push({
      attribute,
      column: toSnakeCase(attribute),
      type: definition.type as VectorizeFilterType,
    });
  }

  const codec = assertReadableCodec();

  // An embedding binding, when the deployment wants `search({ text })`.
  let embed: { binding: string; model: string } | null = null;
  if (options.embed !== undefined) {
    const binding = options.embed?.binding;
    if (typeof binding !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding)) {
      invalid(
        `vectorize.embed.binding must name a Workers AI binding in Env, such as "AI"; ${JSON.stringify(binding)} is not a binding name.`
      );
    }
    const embeddingModel = options.embed.model ?? DEFAULT_EMBEDDING_MODEL;
    if (typeof embeddingModel !== "string" || embeddingModel.trim() === "") {
      invalid("vectorize.embed.model must name an embedding model.");
    }
    const known = EMBEDDING_MODEL_DIMENSIONS[embeddingModel];
    if (known !== undefined && known !== dimensions) {
      invalid(
        `vectorize.embed.model "${embeddingModel}" produces ${known} values, but ${model.apiName}.${field} declares ${dimensions} dimensions. An embedding of another length cannot be searched in this index.`
      );
    }
    embed = { binding, model: embeddingModel };
  }

  // Keyword recall: a text query's lexical half, so it needs text.
  const keywordFields: Array<{ attribute: string; column: string }> = [];
  const declaredKeywords = options.keywordFields ?? [];
  if (!Array.isArray(declaredKeywords)) {
    invalid("vectorize.keywordFields must be an array of attribute names.");
  }
  if (declaredKeywords.length > 0 && options.embed === undefined) {
    invalid(
      "vectorize.keywordFields needs vectorize.embed: keyword recall is applied to a text query, and without an embedding binding there are no words to apply it to."
    );
  }
  if (declaredKeywords.length > 5) {
    invalid(`vectorize.keywordFields names ${declaredKeywords.length} attributes; at most five are indexed for keyword recall.`);
  }
  for (const [index, attribute] of declaredKeywords.entries()) {
    const where = `vectorize.keywordFields[${index}]`;
    if (typeof attribute !== "string") invalid(`${where} must be an attribute name.`);
    if (keywordFields.some((entry) => entry.attribute === attribute)) {
      invalid(`${where} repeats ${JSON.stringify(attribute)}.`);
    }
    const definition = model.attributes[attribute];
    if (definition === undefined) invalid(`${where} names ${JSON.stringify(attribute)}, which ${model.apiName} does not have.`);
    if (definition.type !== "string") {
      invalid(`${where} names a ${definition.type} attribute; keyword recall indexes text, so a string is what it takes.`);
    }
    if (definition.personal !== undefined) {
      invalid(`${where} names a personal attribute; its plaintext would sit in an FTS index outside the personal runtime.`);
    }
    keywordFields.push({ attribute, column: toSnakeCase(attribute) });
  }

  return Object.freeze({
    binding,
    model: model.apiName,
    table: model.table,
    field,
    column: toSnakeCase(field),
    dimensions,
    filters: Object.freeze(filters),
    codec,
    embed,
    keywordFields: Object.freeze(keywordFields),
  });
}

/**
 * The codec tag, after proving this build decodes what it encodes. A build
 * whose codec and decoder disagree would index digests no later read can
 * compare, so it refuses to start rather than writing them.
 */
function assertReadableCodec(): string {
  const sample = encodeVector([0.5, -0.25], 2);
  const back = decodeVector(sample, 2);
  if (!sample.startsWith(VECTOR_TAG) || encodeVector(back, 2) !== sample) {
    invalid(
      `the vector codec this build writes (${VECTOR_TAG}) is not the one it reads; refusing to index with a tag the digest cannot compare.`
    );
  }
  return VECTOR_TAG;
}

/**
 * Whether a live index can hold this configuration: the dimensions it reports
 * must be the ones the schema declares. An index of another shape would accept
 * nothing, or accept float32 of the wrong length into a mismatched space, so
 * the drain stops and the queue stays visible instead.
 */
export function vectorIndexMatches(
  config: ConfiguredVectorize,
  description: { dimensions?: number; metric?: string }
): { ok: true } | { ok: false; reason: string } {
  if (description.dimensions !== undefined && description.dimensions !== config.dimensions) {
    return {
      ok: false,
      reason: `the index holds ${description.dimensions} dimensions; ${config.model}.${config.field} declares ${config.dimensions}.`,
    };
  }
  if (description.metric !== undefined && description.metric !== "cosine") {
    return {
      ok: false,
      reason: `the index is ${description.metric}; v3 indexes are cosine.`,
    };
  }
  return { ok: true };
}
