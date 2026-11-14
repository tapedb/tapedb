/**
 * The client's copy of the schema: entities and links keyed by label.
 *
 * `schema()` builds it so the runtime can resolve a relation label to its
 * engine link. Internal: the public schema API is `schema()` / `model()` / `t`.
 */

import type {
  AttributeDefinition,
  AttributeType,
  EntityDefinition,
  LinkDefinition,
  SchemaDefinition,
} from "./types";

interface AttributeFlags {
  optional?: boolean;
  indexed?: boolean;
  unique?: boolean;
}

function createAttribute<T>(
  type: AttributeType,
  flags: AttributeFlags = {}
): AttributeDefinition<T> {
  return {
    type,
    isOptional: flags.optional ?? false,
    isIndexed: flags.indexed ?? false,
    isUnique: flags.unique ?? false,
    optional() {
      return createAttribute<T>(type, { ...flags, optional: true });
    },
    indexed() {
      return createAttribute<T>(type, { ...flags, indexed: true });
    },
    unique() {
      return createAttribute<T>(type, { ...flags, unique: true });
    },
  };
}

export function entity<
  TAttrs extends Record<string, AttributeDefinition<unknown>>,
>(attrs: TAttrs): EntityDefinition {
  return { type: "entity", attrs };
}

export function schema(definition: SchemaDefinition): SchemaDefinition {
  return definition;
}

/** Internal builders for the client schema. */
export const i = {
  schema,
  entity,
  string: (): AttributeDefinition<string> => createAttribute<string>("string"),
  number: (): AttributeDefinition<number> => createAttribute<number>("number"),
  boolean: (): AttributeDefinition<boolean> =>
    createAttribute<boolean>("boolean"),
  date: (): AttributeDefinition<Date> => createAttribute<Date>("date"),
  json: <T = unknown>(): AttributeDefinition<T> => createAttribute<T>("json"),
  any: <T = unknown>(): AttributeDefinition<T> => createAttribute<T>("any"),
} as const;

export type I = typeof i;

export interface ResolvedLink {
  apiName: string;
  direction: "forward" | "reverse";
  forward: LinkDefinition["forward"];
  reverse: LinkDefinition["reverse"];
}

/**
 * Resolves the label used in `tx[namespace][id].link({ label: targetId })`
 * to the registered engine link api name.
 *
 * The schema declares both sides of a link; a label is only valid on the
 * namespace named by that side's `on`.
 */
export function resolveLink(
  definition: SchemaDefinition | undefined,
  namespace: string,
  label: string
): ResolvedLink {
  if (!definition) {
    throw new Error(
      "tapedb-data: link/unlink requires init({ schema }) so the link label can be resolved."
    );
  }

  for (const [apiName, link] of Object.entries(definition.links)) {
    if (link.forward.on === namespace && link.forward.label === label) {
      return {
        apiName,
        direction: "forward",
        forward: link.forward,
        reverse: link.reverse,
      };
    }
    if (link.reverse.on === namespace && link.reverse.label === label) {
      return {
        apiName,
        direction: "reverse",
        forward: link.forward,
        reverse: link.reverse,
      };
    }
  }

  throw new Error(
    `tapedb-data: unknown link label "${label}" on namespace "${namespace}".`
  );
}

/** Looks up a link by the engine api name (used for optimistic cache edits). */
export function findLinkByApiName(
  definition: SchemaDefinition | undefined,
  apiName: string
): LinkDefinition | undefined {
  return definition?.links[apiName];
}
