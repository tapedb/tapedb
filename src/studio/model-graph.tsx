/**
 * The studio's model graph, in React Flow.
 *
 * This file is not shipped as source: `scripts/gen-studio-graph.mjs` bundles it
 * into `graph.gen.ts` as a string, and the studio serves that string inside its
 * own page. That keeps the studio one HTML response with no build step for the
 * consumer and no network at runtime, which is the same arrangement the query
 * runner already uses.
 *
 * The component knows nothing about a particular schema: it is mounted with the
 * engine's schema document and a callback, so the diagram is whatever the
 * workspace defines.
 */

import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";

export interface Attribute {
  type: string;
  optional?: boolean;
  unique?: boolean;
  indexed?: boolean;
  personal?: { subject: string };
}

export interface Namespace {
  apiName: string;
  attributes: Record<string, Attribute>;
}

export interface Link {
  forward: { namespace: string };
  reverse: { namespace: string };
  foreignKey?: { namespace: string; attribute: string };
}

export interface SchemaDocument {
  namespaces: Namespace[];
  links?: Link[];
}

interface ModelNode extends Record<string, unknown> {
  name: string;
  fields: Array<{ name: string; type: string; flags: string[] }>;
}

const NODE_WIDTH = 260;
const COLUMN_GAP = 110;
const ROW_GAP = 26;
const FIELD_HEIGHT = 22;

function flagsOf(name: string, attribute: Attribute, foreignKeys: Set<string>): string[] {
  const flags: string[] = [];
  if (name === "id") flags.push("key");
  if (foreignKeys.has(name)) flags.push("fk");
  if (attribute.unique) flags.push("unique");
  else if (attribute.indexed) flags.push("index");
  if (attribute.personal) flags.push("personal");
  if (attribute.optional) flags.push("null");
  return flags;
}

/** Which models point at which, and through which field. */
function relationsOf(doc: SchemaDocument): Array<{ child: string; parent: string; field: string }> {
  const names = new Set(doc.namespaces.map((namespace) => namespace.apiName));
  const relations: Array<{ child: string; parent: string; field: string }> = [];
  for (const link of doc.links ?? []) {
    const field = link.foreignKey?.attribute;
    const child = link.foreignKey?.namespace;
    if (!field || !child) continue;
    const parent = link.forward.namespace === child ? link.reverse.namespace : link.forward.namespace;
    if (!names.has(child) || !names.has(parent) || child === parent) continue;
    relations.push({ child, parent, field });
  }
  return relations;
}

/** Depth by foreign key, so parents sit left of the rows that point at them. */
function depthsOf(doc: SchemaDocument, relations: Array<{ child: string; parent: string }>): Map<string, number> {
  const depth = new Map<string, number>(doc.namespaces.map((namespace) => [namespace.apiName, 0]));
  // Relaxation with a cap: a cycle must not spin here.
  for (let pass = 0; pass < doc.namespaces.length + 1; pass += 1) {
    let moved = false;
    for (const relation of relations) {
      const parent = depth.get(relation.parent) ?? 0;
      const child = depth.get(relation.child) ?? 0;
      if (child <= parent) {
        depth.set(relation.child, parent + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return depth;
}

function ModelNodeView({ data, selected }: NodeProps) {
  const model = data as unknown as ModelNode;
  return (
    <div
      style={{
        width: NODE_WIDTH,
        border: `1px solid ${selected ? "var(--accent)" : "var(--line-strong)"}`,
        borderRadius: "var(--panel)",
        background: "var(--surface)",
        boxShadow: selected ? "inset 2px 0 0 var(--accent)" : "none",
        overflow: "hidden",
        font: "13px/1.4 var(--mono)",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid var(--line)",
          background: "var(--surface-2)",
          color: "var(--text)",
          font: "500 13px/1.4 var(--display)",
          letterSpacing: "0.01em",
        }}
      >
        <span>{model.name}</span>
        <span style={{ color: "var(--text-3)", font: "11px var(--mono)" }}>{model.fields.length}</span>
      </div>
      <div style={{ padding: "4px 0" }}>
        {model.fields.map((field) => (
          <div
            key={field.name}
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 10,
              height: FIELD_HEIGHT,
              padding: "0 12px",
              color: field.flags.includes("key") ? "var(--text)" : "var(--text-2)",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{field.name}</span>
            <span style={{ display: "flex", gap: 6, flex: "none" }}>
              {field.flags.map((flag) => (
                <span
                  key={flag}
                  style={{
                    color: flag === "key" || flag === "fk" ? "var(--accent)" : "var(--text-3)",
                    font: "10.5px var(--mono)",
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                  }}
                >
                  {flag}
                </span>
              ))}
              <span style={{ color: "var(--text-3)", font: "10.5px var(--mono)" }}>{field.type}</span>
            </span>
          </div>
        ))}
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const NODE_TYPES = { model: ModelNodeView };

function Graph({ doc, open }: { doc: SchemaDocument; open: (model: string) => void }) {
  const { nodes, edges } = useMemo(() => {
    const relations = relationsOf(doc);
    const depth = depthsOf(doc, relations);
    const foreignKeys = new Map<string, Set<string>>();
    for (const relation of relations) {
      const set = foreignKeys.get(relation.child) ?? new Set<string>();
      set.add(relation.field);
      foreignKeys.set(relation.child, set);
    }

    const perColumn = new Map<number, number>();
    const nodes: Array<Node> = doc.namespaces.map((namespace) => {
      const level = depth.get(namespace.apiName) ?? 0;
      const row = perColumn.get(level) ?? 0;
      perColumn.set(level, row + 1);
      const fields = Object.entries(namespace.attributes).map(([name, attribute]) => ({
        name,
        type: attribute.type,
        flags: flagsOf(name, attribute, foreignKeys.get(namespace.apiName) ?? new Set()),
      }));
      return {
        id: namespace.apiName,
        type: "model",
        position: {
          x: level * (NODE_WIDTH + COLUMN_GAP),
          y: row * (Math.max(fields.length, 3) * FIELD_HEIGHT + 120 + ROW_GAP),
        },
        data: { name: namespace.apiName, fields },
      } satisfies Node;
    });

    const edges: Array<Edge> = relations.map((relation) => ({
      id: `${relation.child}.${relation.field}->${relation.parent}`,
      source: relation.child,
      target: relation.parent,
      type: "smoothstep",
      animated: false,
      label: `${relation.field}  many → 1`,
      labelStyle: { fill: "var(--text-3)", font: "10.5px var(--mono)" },
      labelBgStyle: { fill: "var(--ground)" },
      style: { stroke: "var(--line-strong)", strokeWidth: 1.2 },
    }));

    return { nodes, edges };
  }, [doc]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      fitView
      minZoom={0.2}
      maxZoom={1.6}
      nodesConnectable={false}
      onNodeClick={(_, node) => open(node.id)}
      proOptions={{ hideAttribution: false }}
      style={{ background: "var(--ground)" }}
    >
      <Background color="var(--line)" gap={18} size={1} />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
        nodeColor="var(--line-strong)"
        maskColor="color-mix(in srgb, var(--ground) 70%, transparent)"
      />
    </ReactFlow>
  );
}

/** Mounted by the studio page when the graph tab opens; unmounted when it closes. */
function mount(container: HTMLElement, doc: SchemaDocument, open: (model: string) => void): () => void {
  const root = createRoot(container);
  root.render(<Graph doc={doc} open={open} />);
  return () => root.unmount();
}

declare global {
  interface Window {
    TAPEDB_GRAPH?: { mount: typeof mount };
  }
}

// The page is the only place that mounts this, but a test or a type check may
// import the module outside a browser, so the global is set only where it exists.
if (typeof window !== "undefined") window.TAPEDB_GRAPH = { mount };
