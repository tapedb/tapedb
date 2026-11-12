-- Diagram records: nodes, edges and per-diagram settings.
--
-- Mirrors the production diagram schema. Rows are scoped by a scalar
-- diagram_id, like
-- kanbanColumns.board_id; the diagram itself has no entity table.
-- Every table carries id, created_at, updated_at and updated_seq.

CREATE TABLE IF NOT EXISTS "diagram_nodes" (
  id TEXT PRIMARY KEY NOT NULL,
  diagram_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  "order" REAL NOT NULL,
  type TEXT,
  shape TEXT NOT NULL,
  label TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL,
  height REAL,
  parent_id TEXT,
  extra TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS "diagram_nodes_diagram_id"
  ON "diagram_nodes" ("diagram_id");

CREATE INDEX IF NOT EXISTS "diagram_nodes_updated_seq"
  ON "diagram_nodes" ("updated_seq");

CREATE TABLE IF NOT EXISTS "diagram_edges" (
  id TEXT PRIMARY KEY NOT NULL,
  diagram_id TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  "order" REAL NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  source_handle TEXT,
  target_handle TEXT,
  type TEXT,
  label TEXT,
  extra TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS "diagram_edges_diagram_id"
  ON "diagram_edges" ("diagram_id");

CREATE INDEX IF NOT EXISTS "diagram_edges_updated_seq"
  ON "diagram_edges" ("updated_seq");

CREATE TABLE IF NOT EXISTS "diagram_settings" (
  id TEXT PRIMARY KEY NOT NULL,
  diagram_id TEXT NOT NULL,
  settings TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS "diagram_settings_diagram_id"
  ON "diagram_settings" ("diagram_id");

CREATE INDEX IF NOT EXISTS "diagram_settings_updated_seq"
  ON "diagram_settings" ("updated_seq");
