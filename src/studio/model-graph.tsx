/**
 * The studio's model graph, in React Flow.
 *
 * This file is not shipped as source: `scripts/gen-studio-graph.mjs` bundles it
 * into `model-graph.gen.ts` as a string, and the studio serves that string inside
 * its own page. That keeps the studio one HTML response with no build step for
 * the consumer and no network at runtime, which is the same arrangement the query
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
  MarkerType,
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

// Geometry lives here because the layout needs it: a column is stacked from the
// heights of the nodes already in it, so those heights have to be known before
// anything is positioned.
const NODE_WIDTH = 264;
const HEADER_HEIGHT = 36;
const FIELD_HEIGHT = 22;
const BODY_PADDING = 8;
const COLUMN_GAP = 190;
const ROW_GAP = 48;

function heightOf(fieldCount: number): number {
  return HEADER_HEIGHT + BODY_PADDING * 2 + fieldCount * FIELD_HEIGHT;
}

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
        overflow: "hidden",
        font: "12.5px/1.4 var(--mono)",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0, top: "50%" }} />
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
          height: HEADER_HEIGHT,
          padding: "0 12px",
          boxSizing: "border-box",
          borderBottom: "1px solid var(--line)",
          background: "var(--surface-2)",
          color: "var(--text)",
          font: "500 13px/1.4 var(--display)",
          letterSpacing: "0.01em",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model.name}</span>
        <span style={{ color: "var(--text-3)", font: "10.5px var(--mono)", flex: "none" }}>
          {model.fields.length}
        </span>
      </div>
      <div style={{ padding: `${BODY_PADDING}px 0`, boxSizing: "border-box" }}>
        {model.fields.map((field) => {
          const isKey = field.flags.includes("key") || field.flags.includes("fk");
          return (
            <div
              key={field.name}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                height: FIELD_HEIGHT,
                padding: "0 12px",
                boxSizing: "border-box",
                color: isKey ? "var(--text)" : "var(--text-2)",
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {field.name}
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 6, flex: "none" }}>
                {field.flags
                  .filter((flag) => flag !== "key")
                  .map((flag) => (
                    <span
                      key={flag}
                      style={{
                        color: flag === "fk" ? "var(--accent)" : "var(--text-3)",
                        font: "10px var(--mono)",
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
          );
        })}
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0, top: "50%" }} />
    </div>
  );
}

const NODE_TYPES = { model: ModelNodeView };

function Graph({ doc, open }: { doc: SchemaDocument; open: (model: string) => void }) {
  const { nodes, edges } = useMemo(() => {
    const relations = relationsOf(doc);
    const depth = depthsOf(doc, relations);

    const foreignKeys = new Map<string, Set<string>>();
    const degree = new Map<string, number>();
    for (const relation of relations) {
      const set = foreignKeys.get(relation.child) ?? new Set<string>();
      set.add(relation.field);
      foreignKeys.set(relation.child, set);
      degree.set(relation.child, (degree.get(relation.child) ?? 0) + 1);
      degree.set(relation.parent, (degree.get(relation.parent) ?? 0) + 1);
    }

    const fieldsOf = (namespace: Namespace) =>
      Object.entries(namespace.attributes).map(([name, attribute]) => ({
        name,
        type: attribute.type,
        flags: flagsOf(name, attribute, foreignKeys.get(namespace.apiName) ?? new Set()),
      }));

    // One bucket per depth, richest node first: the tables everything points at
    // end up near the vertical middle rather than the top.
    const columns = new Map<number, Namespace[]>();
    for (const namespace of doc.namespaces) {
      const level = depth.get(namespace.apiName) ?? 0;
      columns.set(level, [...(columns.get(level) ?? []), namespace]);
    }
    for (const [level, members] of columns) {
      columns.set(
        level,
        [...members].sort(
          (a, b) => (degree.get(b.apiName) ?? 0) - (degree.get(a.apiName) ?? 0) || a.apiName.localeCompare(b.apiName)
        )
      );
    }

    // Each column is stacked from a cursor advanced by the real height of what
    // was placed before it, then centred against the tallest column. Placing a
    // node from its own height alone is what produced the overlaps.
    const totals = new Map<number, number>();
    for (const [level, members] of columns) {
      const height = members.reduce((sum, member) => sum + heightOf(member.attributes ? Object.keys(member.attributes).length : 0), 0);
      totals.set(level, height + ROW_GAP * Math.max(members.length - 1, 0));
    }
    const tallest = Math.max(...[...totals.values()], 0);

    const nodes: Array<Node> = [];
    for (const level of [...columns.keys()].sort((a, b) => a - b)) {
      const members = columns.get(level) ?? [];
      let cursor = (tallest - (totals.get(level) ?? 0)) / 2;
      for (const namespace of members) {
        const fields = fieldsOf(namespace);
        nodes.push({
          id: namespace.apiName,
          type: "model",
          position: { x: level * (NODE_WIDTH + COLUMN_GAP), y: cursor },
          data: { name: namespace.apiName, fields },
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
        } satisfies Node);
        cursor += heightOf(fields.length) + ROW_GAP;
      }
    }

    const edges: Array<Edge> = relations.map((relation) => ({
      id: `${relation.child}.${relation.field}->${relation.parent}`,
      source: relation.child,
      target: relation.parent,
      type: "smoothstep",
      label: relation.field,
      labelShowBg: true,
      labelBgPadding: [5, 3] as [number, number],
      labelBgBorderRadius: 3,
      labelBgStyle: { fill: "var(--ground)", fillOpacity: 0.92 },
      labelStyle: { fill: "var(--text-2)", font: "10.5px var(--mono)" },
      style: { stroke: "var(--line-strong)", strokeWidth: 1.2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "var(--line-strong)", width: 14, height: 14 },
    }));

    return { nodes, edges };
  }, [doc]);

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
    <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0 }}>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      fitView
      fitViewOptions={{ padding: 0.26 }}
      minZoom={0.2}
      maxZoom={1.6}
      nodesConnectable={false}
      edgesFocusable={false}
      onNodeClick={(_, node) => open(node.id)}
      style={{ background: "var(--ground)" }}
    >
      <Background color="var(--line)" gap={20} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
    </div>
    <div
      data-graph-legend="true"
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        height: 56,
        padding: "0 16px",
        boxSizing: "border-box",
        borderTop: "1px solid var(--line)",
        background: "var(--surface)",
        color: "var(--text-3)",
        font: "11.5px/1.45 var(--display)",
      }}
    >
      <span style={{ minWidth: 0 }}>
        One node per model, one edge per foreign key. The arrow points at the row being referenced, so
        many rows to one. Click a node to open that model.
      </span>
      <span style={{ flex: "none", color: "var(--text-2)", font: "11px var(--mono)" }}>
        {nodes.length} models · {edges.length} relations
      </span>
    </div>
    </div>
  );
}

/** Mounted when the Graph tool opens; unmounted when it closes. */
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
