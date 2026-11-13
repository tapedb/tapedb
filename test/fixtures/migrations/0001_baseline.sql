-- Workspace engine baseline.
-- Owned by Atlas (target: workspace). Bundled into the Worker by
-- scripts/engine/generate-workspace-migrations.ts; do not edit the generated
-- TypeScript copy.
--
-- Entity tables mirror the production the original schema 
-- minus `documentEdits` (Yjs lives in the document Durable Object).
-- Every entity row carries id, created_at, updated_at and updated_seq.
-- The engine tables (_migrations, _tx_log, _tx_state, _flush_state,
-- _snapshot_state, _engine_meta, $files) are engine-owned.

-- ---------------------------------------------------------------------------
-- Engine tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "_migrations" (
  id TEXT PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "_tx_log" (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  client_tx_id TEXT UNIQUE,
  ops TEXT NOT NULL,
  ops_hash TEXT NOT NULL,
  user_id TEXT,
  role INTEGER,
  at INTEGER NOT NULL,
  schema_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "_tx_state" (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  high_water_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "_flush_state" (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_seq INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  last_flush_at INTEGER,
  last_segment_from INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "_snapshot_state" (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  base_seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'idle',
  started_at INTEGER,
  completed_at INTEGER,
  manifest_key TEXT
);

CREATE TABLE IF NOT EXISTS "_engine_meta" (
  "key" TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO "_tx_state" (id, high_water_seq)
VALUES (1, 0);

INSERT OR IGNORE INTO "_flush_state" (id, last_seq, attempts, updated_at)
VALUES (1, 0, 0, 0);

INSERT OR IGNORE INTO "_engine_meta" ("key", value) VALUES
  ('engine_version', '1'),
  ('schema_version', '0001_baseline');

CREATE TABLE IF NOT EXISTS "$files" (
  id TEXT PRIMARY KEY NOT NULL,
  path TEXT NOT NULL UNIQUE,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Documents: folders, documents, blocks, versions, embeddings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "folders" (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  "order" REAL,
  parent_id TEXT REFERENCES "folders" ("id") ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "documents" (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT,
  show_title_in_document INTEGER,
  show_table_of_contents INTEGER,
  show_cover_page INTEGER,
  cover_page_date TEXT,
  "order" REAL,
  folder_id TEXT REFERENCES "folders" ("id") ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "blocks" (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  "order" REAL NOT NULL,
  checked INTEGER,
  language TEXT,
  preview_mode INTEGER,
  document_id TEXT REFERENCES "documents" ("id") ON DELETE CASCADE,
  parent_id TEXT REFERENCES "blocks" ("id") ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "versions" (
  id TEXT PRIMARY KEY NOT NULL,
  snapshot TEXT NOT NULL,
  version_number REAL NOT NULL,
  document_id TEXT REFERENCES "documents" ("id") ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "embeddings" (
  id TEXT PRIMARY KEY NOT NULL,
  vector TEXT NOT NULL,
  model TEXT NOT NULL,
  block_id TEXT REFERENCES "blocks" ("id") ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Kanban: boards, sprints, columns, tasks, assignees
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "kanban_boards" (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "kanban_sprints" (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  status TEXT,
  goal TEXT,
  start_at INTEGER,
  end_at INTEGER,
  "order" REAL NOT NULL,
  board_id TEXT REFERENCES "kanban_boards" ("id") ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "kanban_columns" (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  "limit" REAL,
  is_done INTEGER,
  "order" REAL NOT NULL,
  board_id TEXT REFERENCES "kanban_boards" ("id") ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "kanban_tasks" (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT,
  fibonacci REAL,
  status TEXT,
  tags TEXT,
  checklist TEXT,
  "order" REAL NOT NULL,
  due_at INTEGER,
  start_at INTEGER,
  progress REAL,
  column_id TEXT REFERENCES "kanban_columns" ("id") ON DELETE SET NULL,
  sprint_id TEXT REFERENCES "kanban_sprints" ("id") ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "task_assignees" (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT REFERENCES "kanban_tasks" ("id") ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "favorites" (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  "order" REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Git and CI
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "git_branches" (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT REFERENCES "kanban_tasks" ("id") ON DELETE CASCADE,
  task_title TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  commit_sha TEXT,
  url TEXT,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "pull_requests" (
  id TEXT PRIMARY KEY NOT NULL,
  branch_id TEXT REFERENCES "git_branches" ("id") ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  pr_number REAL NOT NULL,
  pr_title TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  status TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "ci_status" (
  id TEXT PRIMARY KEY NOT NULL,
  branch_id TEXT REFERENCES "git_branches" ("id") ON DELETE CASCADE,
  workflow_name TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  run_number REAL NOT NULL,
  run_url TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Calendar
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "webcal_subscriptions" (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  color TEXT,
  is_active INTEGER,
  etag TEXT,
  last_modified TEXT,
  last_fetched_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "webcal_events" (
  id TEXT PRIMARY KEY NOT NULL,
  uid TEXT NOT NULL,
  occurrence_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  all_day INTEGER,
  timezone TEXT,
  url TEXT,
  subscription_id TEXT REFERENCES "webcal_subscriptions" ("id") ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Canvas and diagrams
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "canvas_elements" (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT REFERENCES "documents" ("id") ON DELETE CASCADE,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

-- workspace_id is a platform id, not a workspace-row FK.
CREATE TABLE IF NOT EXISTS "moscow_diagrams" (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  document_id TEXT,
  payload TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

-- workspace_id is a platform id, not a workspace-row FK.
CREATE TABLE IF NOT EXISTS "cover_page_templates" (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Foreign-key and indexed-attribute indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "folders_parent_id"
  ON "folders" ("parent_id");

CREATE INDEX IF NOT EXISTS "documents_folder_id"
  ON "documents" ("folder_id");

CREATE INDEX IF NOT EXISTS "blocks_document_id"
  ON "blocks" ("document_id");

CREATE INDEX IF NOT EXISTS "blocks_parent_id"
  ON "blocks" ("parent_id");

CREATE INDEX IF NOT EXISTS "versions_document_id"
  ON "versions" ("document_id");

CREATE UNIQUE INDEX IF NOT EXISTS "embeddings_block_id"
  ON "embeddings" ("block_id");

CREATE INDEX IF NOT EXISTS "kanban_sprints_board_id"
  ON "kanban_sprints" ("board_id");

CREATE INDEX IF NOT EXISTS "kanban_columns_board_id"
  ON "kanban_columns" ("board_id");

CREATE INDEX IF NOT EXISTS "kanban_tasks_column_id"
  ON "kanban_tasks" ("column_id");

CREATE INDEX IF NOT EXISTS "kanban_tasks_sprint_id"
  ON "kanban_tasks" ("sprint_id");

CREATE INDEX IF NOT EXISTS "task_assignees_task_id"
  ON "task_assignees" ("task_id");

CREATE INDEX IF NOT EXISTS "task_assignees_user_id"
  ON "task_assignees" ("user_id");

CREATE INDEX IF NOT EXISTS "git_branches_task_id"
  ON "git_branches" ("task_id");

CREATE INDEX IF NOT EXISTS "git_branches_repository_id"
  ON "git_branches" ("repository_id");

CREATE INDEX IF NOT EXISTS "git_branches_created_by"
  ON "git_branches" ("created_by");

CREATE INDEX IF NOT EXISTS "pull_requests_branch_id"
  ON "pull_requests" ("branch_id");

CREATE INDEX IF NOT EXISTS "pull_requests_task_id"
  ON "pull_requests" ("task_id");

CREATE INDEX IF NOT EXISTS "ci_status_branch_id"
  ON "ci_status" ("branch_id");

CREATE INDEX IF NOT EXISTS "webcal_events_uid"
  ON "webcal_events" ("uid");

CREATE INDEX IF NOT EXISTS "webcal_events_occurrence_key"
  ON "webcal_events" ("occurrence_key");

CREATE INDEX IF NOT EXISTS "webcal_events_subscription_id"
  ON "webcal_events" ("subscription_id");

CREATE INDEX IF NOT EXISTS "canvas_elements_document_id"
  ON "canvas_elements" ("document_id");

CREATE INDEX IF NOT EXISTS "moscow_diagrams_workspace_id"
  ON "moscow_diagrams" ("workspace_id");

CREATE INDEX IF NOT EXISTS "moscow_diagrams_document_id"
  ON "moscow_diagrams" ("document_id");

CREATE INDEX IF NOT EXISTS "cover_page_templates_workspace_id"
  ON "cover_page_templates" ("workspace_id");

-- ---------------------------------------------------------------------------
-- Change-tracking indexes (one per entity table)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "folders_updated_seq"
  ON "folders" ("updated_seq");

CREATE INDEX IF NOT EXISTS "documents_updated_seq"
  ON "documents" ("updated_seq");

CREATE INDEX IF NOT EXISTS "blocks_updated_seq"
  ON "blocks" ("updated_seq");

CREATE INDEX IF NOT EXISTS "versions_updated_seq"
  ON "versions" ("updated_seq");

CREATE INDEX IF NOT EXISTS "embeddings_updated_seq"
  ON "embeddings" ("updated_seq");

CREATE INDEX IF NOT EXISTS "kanban_boards_updated_seq"
  ON "kanban_boards" ("updated_seq");

CREATE INDEX IF NOT EXISTS "kanban_sprints_updated_seq"
  ON "kanban_sprints" ("updated_seq");

CREATE INDEX IF NOT EXISTS "kanban_columns_updated_seq"
  ON "kanban_columns" ("updated_seq");

CREATE INDEX IF NOT EXISTS "kanban_tasks_updated_seq"
  ON "kanban_tasks" ("updated_seq");

CREATE INDEX IF NOT EXISTS "task_assignees_updated_seq"
  ON "task_assignees" ("updated_seq");

CREATE INDEX IF NOT EXISTS "favorites_updated_seq"
  ON "favorites" ("updated_seq");

CREATE INDEX IF NOT EXISTS "git_branches_updated_seq"
  ON "git_branches" ("updated_seq");

CREATE INDEX IF NOT EXISTS "pull_requests_updated_seq"
  ON "pull_requests" ("updated_seq");

CREATE INDEX IF NOT EXISTS "ci_status_updated_seq"
  ON "ci_status" ("updated_seq");

CREATE INDEX IF NOT EXISTS "webcal_subscriptions_updated_seq"
  ON "webcal_subscriptions" ("updated_seq");

CREATE INDEX IF NOT EXISTS "webcal_events_updated_seq"
  ON "webcal_events" ("updated_seq");

CREATE INDEX IF NOT EXISTS "canvas_elements_updated_seq"
  ON "canvas_elements" ("updated_seq");

CREATE INDEX IF NOT EXISTS "moscow_diagrams_updated_seq"
  ON "moscow_diagrams" ("updated_seq");

CREATE INDEX IF NOT EXISTS "cover_page_templates_updated_seq"
  ON "cover_page_templates" ("updated_seq");
