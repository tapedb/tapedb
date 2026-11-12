CREATE TABLE IF NOT EXISTS "kanban_attachments" (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES "kanban_tasks" ("id") ON DELETE RESTRICT,
  object_key TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  uploaded_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "kanban_attachments_task_id" ON "kanban_attachments" ("task_id");
CREATE INDEX IF NOT EXISTS "kanban_attachments_updated_seq" ON "kanban_attachments" ("updated_seq");
