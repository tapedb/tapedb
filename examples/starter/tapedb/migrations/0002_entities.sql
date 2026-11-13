CREATE TABLE IF NOT EXISTS "board" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  "updated_seq" INTEGER NOT NULL DEFAULT 0,
  "name" TEXT,
  "owner_id" TEXT,
  "archived" INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS "board_owner_id_idx" ON "board" ("owner_id");

CREATE TABLE IF NOT EXISTS "column" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  "updated_seq" INTEGER NOT NULL DEFAULT 0,
  "name" TEXT,
  "position" REAL DEFAULT 0,
  "board_id" TEXT REFERENCES "board"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "column_position_idx" ON "column" ("position");

CREATE INDEX IF NOT EXISTS "column_board_id_idx" ON "column" ("board_id");

CREATE TABLE IF NOT EXISTS "task" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  "updated_seq" INTEGER NOT NULL DEFAULT 0,
  "title" TEXT,
  "done" INTEGER DEFAULT 0,
  "due" INTEGER,
  "column_id" TEXT REFERENCES "column"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "task_column_id_idx" ON "task" ("column_id");