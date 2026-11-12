-- Whiteboard world elements. Viewports are persisted per user by the host.
CREATE TABLE IF NOT EXISTS "whiteboard_elements" (
 id TEXT PRIMARY KEY NOT NULL,
 board_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 data TEXT NOT NULL,
 z REAL NOT NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 updated_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "whiteboard_elements_board_id"
 ON "whiteboard_elements" ("board_id");
CREATE INDEX IF NOT EXISTS "whiteboard_elements_updated_seq"
 ON "whiteboard_elements" ("updated_seq");
