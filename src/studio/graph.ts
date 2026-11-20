/**
 * The client's relation graph, rebuilt from a workspace's schema document
 * (GET /schema), so the studio translates `db.<model>.<method>(...)` exactly
 * as the client does, for the schema the workspace runs.
 */

import type { ModelInfo } from "../model/schema";
import type { ScalarKind } from "../model/fields";

export interface SchemaDocument {
  namespaces: Array<{
    apiName: string;
    attributes: Record<string, { type: string; optional: boolean; default: unknown; personal?: { required: boolean } | null }>;
  }>;
  links: Array<{
    apiName: string;
    forward: { namespace: string; label: string };
    reverse: { namespace: string; label: string };
    foreignKey: { namespace: string; attribute: string };
  }>;
}

const SYSTEM = new Set(["id", "createdAt", "updatedAt", "updatedSeq"]);

export function graphFromSchemaDocument(document: SchemaDocument): Record<string, ModelInfo> {
  const graph: Record<string, ModelInfo> = {};
  const foreignKeys = new Set(document.links.map((link) => `${link.foreignKey.namespace}.${link.foreignKey.attribute}`));

  for (const namespace of document.namespaces) {
    const info: ModelInfo = { key: namespace.apiName, scalars: {}, relations: {}, filterable: new Set(["id"]) };
    for (const [name, attribute] of Object.entries(namespace.attributes)) {
      if (SYSTEM.has(name) || foreignKeys.has(`${namespace.apiName}.${name}`)) continue;
      const kind = attribute.type as ScalarKind;
      const stored = attribute.default;
      const hasDefault = stored !== null && stored !== undefined;
      info.scalars[name] = {
        kind,
        optional: attribute.personal ? !attribute.personal.required : attribute.optional,
        hasDefault,
        defaultValue: !hasDefault ? undefined : kind === "json" && typeof stored === "string" ? JSON.parse(stored) : stored,
      };
      if (kind !== "json" && kind !== "vector" && !attribute.personal) info.filterable.add(name);
    }
    graph[namespace.apiName] = info;
  }

  for (const link of document.links) {
    const child = graph[link.reverse.namespace];
    const parent = graph[link.forward.namespace];
    if (!child || !parent) continue;
    const attribute = document.namespaces.find((n) => n.apiName === link.reverse.namespace)?.attributes[link.foreignKey.attribute];
    child.relations[link.reverse.label] = {
      kind: "belongsTo",
      target: link.forward.namespace,
      link: link.apiName,
      foreignKey: link.foreignKey.attribute,
      optional: attribute?.optional ?? false,
    };
    child.filterable.add(link.foreignKey.attribute);
    // A belongsTo with no hasMany gets a private inverse label, which include cannot reach.
    if (!link.forward.label.startsWith("__")) {
      parent.relations[link.forward.label] = {
        kind: "hasMany",
        target: link.reverse.namespace,
        link: link.apiName,
        foreignKey: link.foreignKey.attribute,
      };
    }
  }
  return graph;
}
