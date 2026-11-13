import { useLegacyFixture } from "../fixtures/registry";
useLegacyFixture();

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  WORKSPACE_ROLE_LEVELS,
  type RoleClaim,
  type WorkspaceRole,
} from "../../src/claims";
import {
  executeQuery,
  executeQueryWithPageInfo,
  fromStoredValue,
} from "../../src/engine/query-execute";
import type { SqlExecutor, SqlRow, SqlValue } from "../../src/engine/tx-sql";
import { TxError } from "../../src/engine/tx-types";

const WORKSPACE = "0190a5b2-7c3d-4e8f-9a0b-1c2d3e4f5a6b";
const NOW = 1_700_000_000_000;
const MIGRATIONS_DIR = resolve(
  import.meta.dir,
  "../fixtures/migrations/"
);

const SCHEMA = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"))
  .join("\n");

interface TestStore {
  db: Database;
  sql: SqlExecutor;
}

function createStore(): TestStore {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  const sql: SqlExecutor = {
    exec(query, ...params) {
      return db.prepare(query).run(...params).changes;
    },
    all<T extends SqlRow = SqlRow>(query: string, ...params): T[] {
      return db.query(query).all(...params) as T[];
    },
    one<T extends SqlRow = SqlRow>(query: string, ...params): T | undefined {
      const row = db.query(query).get(...params);
      return row === null ? undefined : (row as T);
    },
    transactionSync<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };

  return { db, sql };
}

type SeedValue = string | number | null;

function insert(
  db: Database,
  table: string,
  row: Record<string, SeedValue>
): void {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO "${table}" (${columns
      .map((column) => `"${column}"`)
      .join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
  ).run(...columns.map((column) => row[column] as SeedValue));
}

function seed(db: Database): void {
  insert(db, "folders", {
    id: "f1",
    name: "Inbox",
    created_at: NOW,
    updated_at: NOW,
    updated_seq: 0,
  });
  insert(db, "folders", {
    id: "f2",
    name: "Archive",
    parent_id: "f1",
    created_at: NOW,
    updated_at: NOW,
    updated_seq: 0,
  });

  insert(db, "documents", {
    id: "d1",
    title: "Doc",
    content: "",
    type: "note",
    show_title_in_document: 1,
    show_table_of_contents: 0,
    show_cover_page: 0,
    order: 1,
    folder_id: "f1",
    created_at: NOW,
    updated_at: NOW,
    updated_seq: 5,
  });

  insert(db, "blocks", {
    id: "b1",
    type: "text",
    content: "hello",
    order: 1,
    checked: 1,
    preview_mode: 0,
    document_id: "d1",
    created_at: NOW,
    updated_at: NOW,
    updated_seq: 1,
  });
  insert(db, "blocks", {
    id: "b2",
    type: "text",
    content: "world",
    order: 2,
    checked: 0,
    preview_mode: 0,
    document_id: "d1",
    created_at: NOW,
    updated_at: NOW,
    updated_seq: 1,
  });
  insert(db, "blocks", {
    id: "b3",
    type: "text",
    content: "child",
    order: 3,
    checked: 0,
    parent_id: "b1",
    document_id: "d1",
    created_at: NOW,
    updated_at: NOW,
    updated_seq: 1,
  });

  insert(db, "embeddings", {
    id: "e1",
    vector: JSON.stringify([0.1, 0.2, 0.3]),
    model: "text-embedding",
    block_id: "b1",
    created_at: NOW,
    updated_at: NOW,
    updated_seq: 1,
  });

  insert(db, "kanban_boards", {
    id: "board1",
    name: "Board",
    description: "Primary",
    created_at: NOW,
    updated_at: NOW,
    updated_seq: 0,
  });
  insert(db, "kanban_boards", {
    id: "board2",
    name: "Other",
    created_at: NOW,
    updated_at: NOW,
    updated_seq: 0,
  });

  insert(db, "kanban_columns", {
    id: "c1",
    name: "Todo",
    limit: 5,
    is_done: 0,
    order: 1,
    board_id: "board1",
    created_at: NOW,
    updated_at: NOW,
    updated_seq: 0,
  });
  insert(db, "kanban_columns", {
    id: "c2",
    name: "Doing",
    is_done: 1,
    order: 2,
    board_id: "board1",
    created_at: NOW,
    updated_at: NOW,
    updated_seq: 0,
  });
  insert(db, "kanban_columns", {
    id: "c3",
    name: "Other column",
    order: 1,
    board_id: "board2",
    created_at: NOW,
    updated_at: NOW,
    updated_seq: 0,
  });

  const tasks: Array<[string, string, string, number]> = [
    ["t1", "c1", "todo", 1],
    ["t2", "c1", "done", 2],
    ["t3", "c2", "todo", 3],
    ["t4", "c2", "blocked", 4],
  ];
  for (const [id, columnId, status, order] of tasks) {
    insert(db, "kanban_tasks", {
      id,
      title: `Task ${id}`,
      status,
      order,
      column_id: columnId,
      created_at: NOW,
      updated_at: NOW,
      updated_seq: 0,
      ...(id === "t1"
        ? {
            description: "First task",
            priority: "high",
            progress: 0.5,
            tags: JSON.stringify(["alpha", "beta"]),
            checklist: JSON.stringify([{ text: "step", done: true }]),
            due_at: NOW + 1_000,
          }
        : {}),
    });
  }
}

function claim(role: WorkspaceRole): RoleClaim {
  return {
    sub: "user-1",
    workspaceId: WORKSPACE,
    role,
    exp: Math.floor(Date.now() / 1000) + 60,
    iat: Math.floor(Date.now() / 1000),
  };
}

function read(
  store: TestStore,
  query: unknown,
  role: WorkspaceRole = WORKSPACE_ROLE_LEVELS.MEMBER
): Record<string, unknown[]> {
  return executeQuery(store.sql, claim(role), { query });
}

const MEMBER = () => claim(WORKSPACE_ROLE_LEVELS.MEMBER);

function ids(rows: unknown[]): string[] {
  return (rows as Array<{ id: string }>).map((row) => row.id);
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TxError);
    expect((error as TxError).code).toBe(code);
    return;
  }
  throw new Error(`Expected TxError ${code}.`);
}

describe("executeQuery", () => {
  let store: TestStore;

  beforeEach(() => {
    store = createStore();
    seed(store.db);
  });

  test("hydrates nested children and converts stored values", () => {
    const data = read(store, {
      kanbanBoards: {
        $: { where: { name: "Board" } },
        columns: {
          $: { order: { order: "asc" } },
          tasks: {},
        },
      },
    });

    const boards = data.kanbanBoards as Array<Record<string, unknown>>;
    expect(boards).toHaveLength(1);

    const board = boards[0] as Record<string, unknown>;
    expect(board.id).toBe("board1");
    expect(board.description).toBe("Primary");
    expect(board.createdAt).toBe(NOW);
    expect(board.updatedSeq).toBe(0);

    const columns = board.columns as Array<Record<string, unknown>>;
    expect(columns.map((column) => column.name)).toEqual(["Todo", "Doing"]);
    expect(columns[0]?.isDone).toBe(false);
    expect(columns[1]?.isDone).toBe(true);

    const tasks = columns[0]?.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(2);

    const first = tasks.find((task) => task.id === "t1");
    expect(first).toBeDefined();
    expect(first?.tags).toEqual(["alpha", "beta"]);
    expect(first?.checklist).toEqual([{ text: "step", done: true }]);
    expect(first?.dueAt).toBe(NOW + 1_000);
    expect(first?.progress).toBeCloseTo(0.5);
  });

  test("traverses reverse links from task to column to board", () => {
    const data = read(store, {
      kanbanTasks: {
        $: { where: { id: "t1" } },
        column: { board: {} },
      },
    });

    const task = (data.kanbanTasks as Array<Record<string, unknown>>)[0];
    expect(task?.id).toBe("t1");

    const column = task?.column as Record<string, unknown>;
    expect(column.id).toBe("c1");
    expect(column.name).toBe("Todo");

    const board = column.board as Record<string, unknown>;
    expect(board.id).toBe("board1");
    expect(board.name).toBe("Board");
  });

  test("returns one-to-one links as objects or null", () => {
    const forward = read(store, {
      blocks: { $: { where: { id: "b1" } }, embedding: {} },
    });
    const block = (forward.blocks as Array<Record<string, unknown>>)[0];
    const embedding = block?.embedding as Record<string, unknown>;
    expect(embedding.id).toBe("e1");
    expect(embedding.vector).toEqual([0.1, 0.2, 0.3]);
    expect(embedding.model).toBe("text-embedding");

    const missing = read(store, {
      blocks: { $: { where: { id: "b2" } }, embedding: {} },
    });
    const withoutEmbedding = (
      missing.blocks as Array<Record<string, unknown>>
    )[0];
    expect(withoutEmbedding?.embedding).toBeNull();

    const reverse = read(store, {
      embeddings: { $: { where: { id: "e1" } }, block: {} },
    });
    const linked = (reverse.embeddings as Array<Record<string, unknown>>)[0];
    expect((linked?.block as Record<string, unknown>).id).toBe("b1");
  });

  test("reports truncation per namespace instead of capping silently", () => {
    for (let index = 0; index < 150; index += 1) {
      insert(store.db, "kanban_tasks", {
        id: `bulk-${index}`,
        title: `Bulk ${index}`,
        status: "todo",
        order: index,
        created_at: NOW,
        updated_at: NOW,
        updated_seq: 0,
      });
    }

    const capped = executeQueryWithPageInfo(store.sql, MEMBER(), {
      query: { kanbanTasks: {} },
    });
    expect(capped.data.kanbanTasks).toHaveLength(100);
    expect(capped.pageInfo.kanbanTasks).toEqual({
      limit: 100,
      returned: 100,
      hasMore: true,
    });

    const uncapped = executeQueryWithPageInfo(store.sql, MEMBER(), {
      query: { kanbanTasks: { $: { limit: 1000 } } },
    });
    expect(uncapped.data.kanbanTasks).toHaveLength(154);
    expect(uncapped.pageInfo.kanbanTasks).toEqual({
      limit: 1000,
      returned: 154,
      hasMore: false,
    });
  });

  test("resolves a one-to-one reverse link for every parent, not just the first 100", () => {
    // 150 documents each pointing at their own folder: the reverse lookup is
    // `folders.id IN (<150 ids>)`. A shared LIMIT would resolve 100 of them and
    // report `folder: null` for the rest - fabricated dangling links.
    for (let index = 0; index < 150; index += 1) {
      insert(store.db, "folders", {
        id: `cap-folder-${index}`,
        name: `Folder ${index}`,
        created_at: NOW,
        updated_at: NOW,
        updated_seq: 0,
      });
      insert(store.db, "documents", {
        id: `cap-doc-${index}`,
        title: `Doc ${index}`,
        content: "Body",
        folder_id: `cap-folder-${index}`,
        created_at: NOW,
        updated_at: NOW,
        updated_seq: 0,
      });
    }

    const data = read(store, {
      documents: {
        $: {
          limit: 1000,
          where: {
            id: {
              $in: Array.from(
                { length: 150 },
                (_, index) => `cap-doc-${index}`
              ),
            },
          },
        },
        folder: {},
      },
    });

    const documents = data.documents as Array<Record<string, unknown>>;
    expect(documents).toHaveLength(150);
    const unresolved = documents.filter((document) => document.folder === null);
    expect(unresolved).toEqual([]);
  });

  test("applies a nested limit per parent instead of sharing one LIMIT", () => {
    for (const board of ["b1", "b2", "b3", "b4"]) {
      insert(store.db, "kanban_boards", {
        id: board,
        name: board,
        created_at: NOW,
        updated_at: NOW,
        updated_seq: 0,
      });
      for (let index = 0; index < 3; index += 1) {
        insert(store.db, "kanban_columns", {
          id: `${board}-c${index}`,
          name: `${board}-c${index}`,
          order: index,
          board_id: board,
          created_at: NOW,
          updated_at: NOW,
          updated_seq: 0,
        });
      }
    }

    const data = read(store, {
      kanbanBoards: {
        $: {
          where: { id: { $in: ["b1", "b2", "b3", "b4"] } },
          limit: 4,
        },
        columns: { $: { limit: 2 } },
      },
    });

    const boards = data.kanbanBoards as Array<Record<string, unknown>>;
    expect(boards).toHaveLength(4);
    for (const board of boards) {
      // One shared LIMIT over `fk IN (...)` would starve the later parents.
      expect((board.columns as Array<Record<string, unknown>>).length).toBe(2);
    }
  });

  test("$ne also matches rows where the attribute is null or absent", () => {
    // the original documents $ne as returning entities that do not match the
    // value, "including entities where the field is null or undefined".
    insert(store.db, "kanban_tasks", {
      id: "t5",
      title: "Task t5",
      status: null,
      order: 5,
      column_id: "c1",
      created_at: NOW,
      updated_at: NOW,
      updated_seq: 0,
    });

    expect(
      ids(
        read(store, {
          kanbanTasks: { $: { where: { status: { $ne: "done" } } } },
        }).kanbanTasks
      ).sort()
    ).toEqual(["t1", "t3", "t4", "t5"]);
  });

  test("applies equality, comparison, order and limit", () => {
    expect(
      ids(
        read(store, { kanbanTasks: { $: { where: { status: "todo" } } } })
          .kanbanTasks
      ).sort()
    ).toEqual(["t1", "t3"]);
    expect(
      ids(
        read(store, {
          kanbanTasks: { $: { where: { status: { $ne: "done" } } } },
        }).kanbanTasks
      ).sort()
    ).toEqual(["t1", "t3", "t4"]);
    expect(
      ids(
        read(store, {
          kanbanTasks: {
            $: { where: { status: { $in: ["todo", "done"] } } },
          },
        }).kanbanTasks
      ).sort()
    ).toEqual(["t1", "t2", "t3"]);
    expect(
      ids(
        read(store, {
          kanbanTasks: { $: { where: { order: { $gt: 1 } } } },
        }).kanbanTasks
      ).sort()
    ).toEqual(["t2", "t3", "t4"]);
    expect(
      ids(
        read(store, {
          kanbanTasks: { $: { where: { order: { $gte: 2 } } } },
        }).kanbanTasks
      ).sort()
    ).toEqual(["t2", "t3", "t4"]);
    expect(
      ids(
        read(store, {
          kanbanTasks: { $: { where: { order: { $lt: 2 } } } },
        }).kanbanTasks
      )
    ).toEqual(["t1"]);
    expect(
      ids(
        read(store, {
          kanbanTasks: { $: { where: { order: { $lte: 2 } } } },
        }).kanbanTasks
      ).sort()
    ).toEqual(["t1", "t2"]);

    expect(
      ids(
        read(store, {
          kanbanTasks: {
            $: { order: { order: "desc" }, limit: 2 },
          },
        }).kanbanTasks
      )
    ).toEqual(["t4", "t3"]);
    expect(
      ids(
        read(store, {
          kanbanTasks: { $: { order: { order: "asc" }, limit: 2 } },
        }).kanbanTasks
      )
    ).toEqual(["t1", "t2"]);

    expect(
      read(store, {
        kanbanTasks: { $: { where: { status: { $in: [] } } } },
      }).kanbanTasks
    ).toEqual([]);

    expect(
      ids(
        read(store, {
          kanbanTasks: { $: { where: { description: null } } },
        }).kanbanTasks
      ).sort()
    ).toEqual(["t2", "t3", "t4"]);
  });

  test("converts booleans and nested document blocks", () => {
    const data = read(store, {
      documents: {
        $: { where: { id: "d1" } },
        blocks: { $: { order: { order: "asc" } } },
      },
    });

    const document = (data.documents as Array<Record<string, unknown>>)[0];
    expect(document?.showTitleInDocument).toBe(true);
    expect(document?.showTableOfContents).toBe(false);
    expect(document?.showCoverPage).toBe(false);

    const blocks = document?.blocks as Array<Record<string, unknown>>;
    expect(blocks.map((block) => block.id)).toEqual(["b1", "b2", "b3"]);
    expect(blocks[0]?.checked).toBe(true);
    expect(blocks[1]?.checked).toBe(false);
    expect(blocks[0]?.previewMode).toBe(false);
  });

  test("rejects invalid queries before touching SQL", () => {
    expectCode(() => read(store, { nope: {} }), "unknown_namespace");
    expectCode(
      () => read(store, { folders: { $: { where: { nope: 1 } } } }),
      "unknown_attribute"
    );
    expectCode(() => read(store, { folders: { nope: {} } }), "unknown_link");
    expectCode(
      () =>
        read(store, {
          folders: { children: { children: { children: {} } } },
        }),
      "invalid_op"
    );
    expectCode(
      () => read(store, { kanbanTasks: { $: { where: { tags: "x" } } } }),
      "invalid_value"
    );
    expectCode(
      () =>
        executeQuery(store.sql, claim(WORKSPACE_ROLE_LEVELS.MEMBER), {
          query: {},
          extra: true,
        }),
      "invalid_op"
    );
  });

  test("denies GUEST/USER view and allows MEMBER view", () => {
    expectCode(
      () => read(store, { documents: {} }, WORKSPACE_ROLE_LEVELS.GUEST),
      "permission_denied"
    );
    expectCode(
      () => read(store, { documents: {} }, WORKSPACE_ROLE_LEVELS.USER),
      "permission_denied"
    );

    const data = read(store, { documents: {} }, WORKSPACE_ROLE_LEVELS.MEMBER);
    expect(data.documents).toHaveLength(1);
  });

  test("maps driver failures to storage_error", () => {
    const broken: SqlExecutor = {
      ...store.sql,
      all() {
        throw new Error("disk full");
      },
    };

    expectCode(
      () =>
        executeQuery(broken, claim(WORKSPACE_ROLE_LEVELS.MEMBER), {
          query: { folders: {} },
        }),
      "storage_error"
    );
  });

  test("converts individual stored values", () => {
    expect(fromStoredValue("boolean", 1)).toBe(true);
    expect(fromStoredValue("boolean", 0)).toBe(false);
    expect(fromStoredValue("date", NOW)).toBe(NOW);
    expect(fromStoredValue("json", JSON.stringify({ a: 1 }))).toEqual({ a: 1 });
    expect(fromStoredValue("string", "x")).toBe("x");
    expect(fromStoredValue("number", 2.5)).toBe(2.5);
    expect(fromStoredValue("json", null)).toBeNull();
  });
});
