/**
 * The query editor's translator, and import and export, bundled into the studio page (see
 * scripts/gen-studio-runner.mjs): a call as written in app code becomes the
 * engine request the client would send for it.
 */

import { plan, READ_METHODS, WRITE_METHODS, type Plan } from "../model/plan";
import { parseCall } from "./call";
import { graphFromSchemaDocument, type SchemaDocument } from "./graph";

export interface Prepared {
  model: string;
  method: string;
  plan: Plan;
}

const METHODS: readonly string[] = [...READ_METHODS, ...WRITE_METHODS];

export function prepare(source: string, schema: SchemaDocument): Prepared {
  const call = parseCall(source);
  const graph = graphFromSchemaDocument(schema);
  const model = graph[call.model];
  if (!model) {
    throw new Error(`There is no model "${call.model}". Models: ${Object.keys(graph).join(", ")}.`);
  }
  if (!METHODS.includes(call.method)) {
    throw new Error(`"${call.method}" is not a method here. Use ${METHODS.join(", ")}.`);
  }
  return { model: call.model, method: call.method, plan: plan(graph, model, call.method, call.args) };
}

export { READ_METHODS, WRITE_METHODS };
export { toCsv, toJson, readTable, planImport } from "./table-io";
