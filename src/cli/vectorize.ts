/**
 * Vectorize provisioning: the deployment's index, created and validated before
 * the Worker that uses it is uploaded.
 *
 * The deployment declares what it indexes once, in `wrangler.jsonc`:
 *
 * ```jsonc
 * "tapedb": {
 *   "vectorize": {
 *     "model": "note",
 *     "field": "embedding",
 *     "filterFields": ["archived"]
 *   }
 * }
 * ```
 *
 * `tapedb deploy` reads the project's schema, validates that declaration
 * against it, derives the index's name from the deployment's identity, creates
 * the index and one metadata index per declared filter, and records what it
 * created under `tapedb.vectorize.index` / `tapedb.vectorize.ownership` so the
 * next deploy can prove the index is still this deployment's.
 *
 * The name is derived, never guessed: a repeat deploy, two concurrent deploys
 * and a retry after a failed upload all converge on the same resource. An index
 * whose shape or ownership does not match is refused before any traffic reaches
 * it, because a mismatched index accepts nothing or ranks in the wrong space
 * while every ordinary read and write still looks healthy.
 */

import type { TapeDBSchema } from "../schema";
import type { AttributeDefinition } from "../engine/registry";
import type { CommandResult, DeployConfig, WranglerCommand } from "./onboarding";

/** The binding name the Worker reads the index by. */
export const VECTORIZE_DEFAULT_BINDING = "VECTORIZE";
/** The only metric this engine searches with. */
export const VECTORIZE_METRIC = "cosine" as const;
/** The provider's ceiling on metadata indexes per index, and so on filters. */
export const VECTORIZE_MAX_FILTERS = 10;
/** The provider's ceiling on an index name. */
const INDEX_NAME_MAX = 64;

/** What the deployment declares in `wrangler.jsonc`. */
export interface VectorizeDeclaration {
  /** The binding name in `Env`. Defaults to `VECTORIZE`. */
  binding?: string;
  /** The model whose rows are indexed, by API name. */
  model: string;
  /** The `t.vector({ dimensions })` attribute. */
  field: string;
  /** Flat scalar attributes copied into metadata and usable as filters. */
  filterFields?: string[];
}

/** One metadata index, as the provider describes it. */
export interface VectorizeMetadataIndex {
  property: string;
  type: "string" | "number" | "boolean";
}

/**
 * What this deployment created. Written into `wrangler.jsonc` after a
 * successful provision and required on every later one: an index that exists
 * without a record cannot be proven to be this deployment's, and adopting it
 * silently would let one deployment index into another's.
 */
export interface VectorizeOwnership {
  index: string;
  account: string;
  worker: string;
  model: string;
  field: string;
  dimensions: number;
  metric: typeof VECTORIZE_METRIC;
  filters: VectorizeMetadataIndex[];
  created_at: string;
}

/** The declared configuration plus, after the first deploy, its record. */
export type VectorizeDeploymentConfig = VectorizeDeclaration &
  Partial<Pick<VectorizeOwnership, "index">> & { ownership?: VectorizeOwnership };

/** The ownership facts a deploy can compare, without the record's timestamp. */
export type VectorizeFacts = Omit<VectorizeOwnership, "created_at">;

/** A validated declaration: what provisioning acts on. */
export interface ResolvedVectorize {
  binding: string;
  model: string;
  field: string;
  dimensions: number;
  filters: VectorizeMetadataIndex[];
}

/** The project schema, validated against the declaration. */
export function resolveVectorizeDeclaration(
  declaration: VectorizeDeclaration,
  schema: TapeDBSchema
): ResolvedVectorize {
  if (declaration === null || typeof declaration !== "object") {
    throw new Error("tapedb.vectorize must be an object naming a model and a vector field.");
  }
  const binding = declaration.binding ?? VECTORIZE_DEFAULT_BINDING;
  if (typeof binding !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding)) {
    throw new Error(
      `tapedb.vectorize.binding must be an environment binding name such as "VECTORIZE"; ${JSON.stringify(binding)} is not one.`
    );
  }
  const model = typeof declaration.model === "string" ? declaration.model : "";
  const namespace = schema.registry.namespaces.find((entry) => entry.apiName === model);
  if (!namespace) {
    throw new Error(
      `tapedb.vectorize.model names ${JSON.stringify(declaration.model)}, which is not a model in tapedb.schema.ts.`
    );
  }
  const field = typeof declaration.field === "string" ? declaration.field : "";
  const attribute: AttributeDefinition | undefined = namespace.attributes[field];
  if (!attribute) {
    throw new Error(`tapedb.vectorize.field names ${JSON.stringify(field)}, which ${model} does not have.`);
  }
  if (attribute.type !== "vector") {
    throw new Error(
      `tapedb.vectorize.field must name a t.vector({ dimensions }) attribute; ${model}.${field} is a ${attribute.type}.`
    );
  }
  const dimensions = attribute.dimensions;
  if (typeof dimensions !== "number" || !Number.isInteger(dimensions) || dimensions < 1 || dimensions > 1_536) {
    throw new Error(
      `t.vector() on ${model}.${field} declares ${JSON.stringify(dimensions)} dimensions; an index takes an integer from 1 to 1,536.`
    );
  }

  const declaredFilters = declaration.filterFields ?? [];
  if (!Array.isArray(declaredFilters)) {
    throw new Error("tapedb.vectorize.filterFields must be an array of attribute names.");
  }
  if (declaredFilters.length > VECTORIZE_MAX_FILTERS) {
    throw new Error(
      `tapedb.vectorize.filterFields names ${declaredFilters.length} attributes; an index takes at most ${VECTORIZE_MAX_FILTERS}, one per metadata index the provider allows.`
    );
  }
  const filters: VectorizeMetadataIndex[] = [];
  const seen = new Set<string>();
  for (const [index, property] of declaredFilters.entries()) {
    const where = `tapedb.vectorize.filterFields[${index}]`;
    if (typeof property !== "string") throw new Error(`${where} must be an attribute name.`);
    if (seen.has(property)) throw new Error(`${where} repeats ${JSON.stringify(property)}.`);
    seen.add(property);
    if (property === field) {
      throw new Error(`${where} names the vector attribute itself; a vector is not filter metadata.`);
    }
    const definition: AttributeDefinition | undefined = namespace.attributes[property];
    if (!definition) throw new Error(`${where} names ${JSON.stringify(property)}, which ${model} does not have.`);
    if (definition.personal !== undefined) {
      throw new Error(
        `${where} names a personal attribute; its value would be stored at the provider, outside the workspace's erasure.`
      );
    }
    if (definition.type !== "string" && definition.type !== "number" && definition.type !== "boolean") {
      throw new Error(
        `${where} names a ${definition.type} attribute; a metadata filter is an equality on a flat string, number or boolean.`
      );
    }
    filters.push({ property, type: definition.type });
  }

  return { binding, model, field, dimensions, filters };
}

/**
 * The index name, derived from deployment identity so that a repeat deploy, a
 * concurrent deploy and a retry after a failed upload all name one resource.
 */
export function deriveVectorizeIndexName(worker: string, model: string): string {
  const raw = `tapedb-${worker}-${model}`.toLowerCase();
  const name = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (name.length <= INDEX_NAME_MAX) return name;
  // Keep the tail: the worker name's distinguishing suffix (an environment)
  // and the model matter more than the shared prefix.
  return name.slice(-INDEX_NAME_MAX).replace(/^-+/, "");
}

/** What one provision did, for the deploy's own output. */
export interface ProvisionedVectorize {
  index: string;
  created: boolean;
  dimensions: number;
  filters: VectorizeMetadataIndex[];
}

export interface ProvisionVectorizeArgs {
  /** The project root, for resolving the schema's path only. */
  root: string;
  /** The configuration this deploy is using: the top level, or one environment. */
  selected: DeployConfig;
  command: WranglerCommand;
  account: string;
  worker: string;
  /** `TAPEDB_JURISDICTION`, when the deployment restricts residency. */
  jurisdiction?: string;
  schema: TapeDBSchema;
  log?: (line: string) => void;
}

/**
 * Creates the index and its metadata indexes, or validates an existing one.
 * Throws with an actionable message on any mismatch; the caller deploys
 * nothing in that case.
 */
export async function provisionVectorize(args: ProvisionVectorizeArgs): Promise<ProvisionedVectorize | null> {
  const record = args.selected.tapedb?.vectorize;
  if (record === undefined) return null;
  const log = args.log ?? ((line: string) => console.log(line));

  // Residency first: creating an index outside the deployment's jurisdiction is
  // the one mistake that cannot be undone by redeploying.
  if (args.jurisdiction === "eu" || args.jurisdiction === "fedramp") {
    throw new Error(
      `Refusing to enable vector search: this deployment is restricted to ${args.jurisdiction} (TAPEDB_JURISDICTION) and Cloudflare Vectorize cannot meet that residency. Deploy without vector search, or without TAPEDB_JURISDICTION.`
    );
  }

  const resolved = resolveVectorizeDeclaration(record, args.schema);
  const index = deriveVectorizeIndexName(args.worker, resolved.model);
  if (record.index !== undefined && record.index !== index) {
    throw new Error(
      `tapedb.vectorize.index records ${JSON.stringify(record.index)} but this deployment derives ${JSON.stringify(index)}. A renamed index would leave the old one behind; remove the record to provision the derived name, or restore the worker name it came from.`
    );
  }

  const described = describeIndex(args.command, index);
  let created = false;
  let raced = false;
  if (described === null) {
    const outcome = createIndex(args.command, index, resolved);
    created = outcome === "created";
    // A concurrent deploy of this same identity created it between our read and
    // our create. That is convergence; the shape check below still runs.
    raced = outcome === "exists";
    if (created) {
      log(`  Vectorize: created ${index} (${resolved.dimensions} dimensions, ${VECTORIZE_METRIC}).`);
    }
  } else {
    assertShape(index, described, resolved);
  }
  if (!created) {
    const live = describeIndex(args.command, index);
    if (live === null) {
      throw new Error(
        `Vectorize index ${index} disappeared while it was being provisioned. Retry the deploy; nothing was uploaded.`
      );
    }
    assertShape(index, live, resolved);
  }

  // Metadata indexes must exist before the vectors they index: a vector
  // written first is never retroactively indexed into a later metadata index.
  const existingMetadata = created ? [] : listMetadataIndexes(args.command, index);
  for (const filter of resolved.filters) {
    const present = existingMetadata.find((entry) => entry.property === filter.property);
    if (present !== undefined) {
      if (present.type !== filter.type) {
        throw new Error(
          `Vectorize index ${index} holds a ${present.type} metadata index for ${filter.property}, but ${resolved.model}.${filter.property} is a ${filter.type}. A metadata index cannot change type in place; create a new index with an explicit rebuild.`
        );
      }
      continue;
    }
    createMetadataIndex(args.command, index, filter);
    existingMetadata.push(filter);
    log(`  Vectorize: metadata index ${filter.property} (${filter.type}).`);
  }

  // An index this deploy created, one it lost a creation race for, or one the
  // config names explicitly is this deployment's. Anything else is refused.
  const declared = record.index === index;
  assertOwnership(record.ownership, created || raced || declared, {
    index,
    account: args.account,
    worker: args.worker,
    model: resolved.model,
    field: resolved.field,
    dimensions: resolved.dimensions,
    metric: VECTORIZE_METRIC,
    filters: resolved.filters,
  });
  if (record.ownership === undefined) {
    record.index = index;
    record.ownership = {
      index,
      account: args.account,
      worker: args.worker,
      model: resolved.model,
      field: resolved.field,
      dimensions: resolved.dimensions,
      metric: VECTORIZE_METRIC,
      filters: resolved.filters,
      created_at: new Date().toISOString(),
    };
    log(`  Vectorize: recorded ownership of ${index} in wrangler.jsonc.`);
  }
  if (!created) log(`  Vectorize: kept ${index}.`);

  // The Worker reads the index through this binding; it is part of the deploy.
  const bindings = args.selected.vectorize ?? [];
  const existing = bindings.find((entry) => entry?.binding === resolved.binding);
  if (existing !== undefined && existing.index_name !== index) {
    throw new Error(
      `wrangler.jsonc binds ${resolved.binding} to ${JSON.stringify(existing.index_name)}, but this deployment provisions ${JSON.stringify(index)}. Remove that binding; tapedb deploy writes the derived one.`
    );
  }
  if (existing === undefined) {
    args.selected.vectorize = [...bindings, { binding: resolved.binding, index_name: index }];
  }

  return { index, created, dimensions: resolved.dimensions, filters: resolved.filters };
}

/** The index's shape, or null when the account does not have it. */
export function describeIndex(
  command: WranglerCommand,
  index: string
): { dimensions?: number; metric?: string } | null {
  const result = command(["vectorize", "get", index, "--json"], true);
  if (result.status !== 0) {
    if (missingIndex(result)) return null;
    throw new Error(`Could not read Vectorize index ${index}. ${output(result)}`);
  }
  const parsed = parseJson(result.stdout);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Vectorize answered for ${index} with something that is not JSON. ${output(result)}`);
  }
  const record = parsed as { dimensions?: unknown; config?: { dimensions?: unknown; metric?: unknown }; metric?: unknown };
  const dimensions = Number(record.dimensions ?? record.config?.dimensions);
  const metric = record.metric ?? record.config?.metric;
  return {
    dimensions: Number.isFinite(dimensions) ? dimensions : undefined,
    metric: typeof metric === "string" ? metric : undefined,
  };
}

/** Whether a failed `vectorize get` only says this account does not have it. */
function missingIndex(result: CommandResult): boolean {
  const text = result.stdout + result.stderr;
  return /\bcode:\s*30\d\d\b/i.test(text) || /not found/i.test(text) || /does not exist/i.test(text);
}

function createIndex(
  command: WranglerCommand,
  index: string,
  resolved: ResolvedVectorize
): "created" | "exists" {
  const result = command(
    ["vectorize", "create", index, "--dimensions", String(resolved.dimensions), "--metric", VECTORIZE_METRIC],
    true
  );
  if (result.status === 0) return "created";
  // A concurrent deploy may have created it first, and that is convergence, not
  // failure: re-read it and let the shape check decide.
  if (describeIndex(command, index) !== null) return "exists";
  throw new Error(`Could not create Vectorize index ${index}. ${output(result)}`);
}

function listMetadataIndexes(command: WranglerCommand, index: string): VectorizeMetadataIndex[] {
  const result = command(["vectorize", "list-metadata-indexes", index, "--json"], true);
  if (result.status !== 0) {
    throw new Error(`Could not read the metadata indexes of ${index}. ${output(result)}`);
  }
  const parsed = parseJson(result.stdout);
  const entries = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { metadataIndexes?: unknown[] }).metadataIndexes)
      ? (parsed as { metadataIndexes: unknown[] }).metadataIndexes
      : [];
  const indexes: VectorizeMetadataIndex[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { propertyName?: unknown; property?: unknown; name?: unknown; type?: unknown };
    const property = record.propertyName ?? record.property ?? record.name;
    const type = record.type;
    if (typeof property !== "string") continue;
    if (type !== "string" && type !== "number" && type !== "boolean") continue;
    indexes.push({ property, type });
  }
  return indexes;
}

function createMetadataIndex(command: WranglerCommand, index: string, filter: VectorizeMetadataIndex): void {
  command(
    ["vectorize", "create-metadata-index", index, "--property-name", filter.property, "--type", filter.type],
    true
  );
}

/** Refuses an index whose shape cannot hold this deployment's vectors. */
function assertShape(
  index: string,
  described: { dimensions?: number; metric?: string },
  resolved: ResolvedVectorize
): void {
  if (described.dimensions !== undefined && described.dimensions !== resolved.dimensions) {
    throw new Error(
      `Vectorize index ${index} holds ${described.dimensions} dimensions, but ${resolved.model}.${resolved.field} declares ${resolved.dimensions}. Nothing was deployed; use the index this deployment derives, or change the field's dimensions with an explicit rebuild.`
    );
  }
  if (described.metric !== undefined && described.metric !== VECTORIZE_METRIC) {
    throw new Error(
      `Vectorize index ${index} uses ${described.metric}; this engine searches with ${VECTORIZE_METRIC}. Nothing was deployed; a metric cannot change in place, so this needs a new index and an explicit rebuild.`
    );
  }
}

/** Refuses an index this deployment cannot prove it owns. */
function assertOwnership(
  record: VectorizeOwnership | undefined,
  knownToBeOurs: boolean,
  actual: VectorizeFacts
): void {
  if (record === undefined) {
    if (!knownToBeOurs) {
      throw new Error(
        `Vectorize index ${actual.index} already exists in this account, and wrangler.jsonc has no ownership record for it. It was not created by this deployment, and indexing into it could write over another project's vectors. If it is yours, record it by adding "index": "${actual.index}" under tapedb.vectorize and deploy again; otherwise delete it with \`npx wrangler vectorize delete ${actual.index}\` or deploy under a name that derives a different index.`
      );
    }
    return;
  }
  const differences: string[] = [];
  if (record.account !== actual.account) differences.push(`account ${record.account} vs ${actual.account}`);
  if (record.worker !== actual.worker) differences.push(`worker ${record.worker} vs ${actual.worker}`);
  if (record.dimensions !== actual.dimensions) {
    differences.push(`dimensions ${record.dimensions} vs ${actual.dimensions}`);
  }
  if (record.metric !== actual.metric) differences.push(`metric ${record.metric} vs ${actual.metric}`);
  if (record.field !== actual.field) differences.push(`field ${record.field} vs ${actual.field}`);
  if (record.model !== actual.model) differences.push(`model ${record.model} vs ${actual.model}`);
  const recordedFilters = record.filters.map((entry) => `${entry.property}:${entry.type}`).join(",");
  const actualFilters = actual.filters.map((entry) => `${entry.property}:${entry.type}`).join(",");
  if (recordedFilters !== actualFilters) differences.push(`filters ${recordedFilters || "none"} vs ${actualFilters || "none"}`);
  if (differences.length > 0) {
    throw new Error(
      `Vectorize index ${actual.index} does not match the ownership recorded in wrangler.jsonc (${differences.join("; ")}). Nothing was deployed. If the index was recreated, remove tapedb.vectorize.ownership so this deploy records it again.`
    );
  }
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Wrangler sometimes prefixes JSON with a status line; take the document.
  const start = Math.min(
    ...[trimmed.indexOf("{"), trimmed.indexOf("[")].filter((index) => index >= 0)
  );
  if (!Number.isFinite(start)) return null;
  try {
    return JSON.parse(trimmed.slice(start));
  } catch {
    return null;
  }
}

function output(result: CommandResult): string {
  const text = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ");
  return text.length > 0 ? text : `wrangler exited ${result.status ?? "without a status"}.`;
}
