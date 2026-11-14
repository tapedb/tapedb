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
import { ENGINE_MIGRATIONS } from "../../src/engine/migrations-bundle";
import { opsHash } from "../../src/engine/tx-hash";
import { runTransaction } from "../../src/engine/tx-pipeline";
import type { SqlExecutor, SqlRow } from "../../src/engine/tx-sql";
import { TxError, type TxEnvelope } from "../../src/engine/tx-types";
import { retryWindowMs } from "../../src/engine/durability/retention";

const WORKSPACE = "workspace-1";
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
  for (const migration of ENGINE_MIGRATIONS) db.exec(migration.sql);

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

function claim(role: WorkspaceRole = WORKSPACE_ROLE_LEVELS.EDITOR): RoleClaim {
  return {
    sub: "user-1",
    workspaceId: WORKSPACE,
    role,
    exp: Math.floor(Date.now() / 1000) + 60,
    iat: Math.floor(Date.now() / 1000),
  };
}

function run(
  store: TestStore,
  envelope: TxEnvelope,
  role: WorkspaceRole = WORKSPACE_ROLE_LEVELS.EDITOR
) {
  return runTransaction(store.sql, WORKSPACE, claim(role), envelope);
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

function all<T extends SqlRow = SqlRow>(
  store: TestStore,
  query: string,
  ...params: (string | number | null)[]
): T[] {
  return store.db.query(query).all(...params) as T[];
}

function one<T extends SqlRow = SqlRow>(
  store: TestStore,
  query: string,
  ...params: (string | number | null)[]
): T | undefined {
  return store.db.query(query).get(...params) as T | undefined;
}

function txId(): string {
  return `tx-${Math.random().toString(36).slice(2)}`;
}

describe("transaction pipeline", () => {
  let store: TestStore;

  beforeEach(() => {
    store = createStore();
  });

  test("inserts, updates and merges while advancing engine columns", () => {
    const inserted = run(store, {
      txId: "t1",
      ops: [
        {
          op: "update",
          namespace: "folders",
          id: "f1",
          values: { name: "Inbox", icon: null },
        },
      ],
    });

    expect(inserted).toEqual({ txId: "t1", seq: 1, applied: 1 });

    const created = one<{
      name: string;
      created_at: number;
      updated_at: number;
      updated_seq: number;
    }>(store, `SELECT * FROM "folders" WHERE "id" = 'f1'`);
    expect(created?.name).toBe("Inbox");
    expect(created?.created_at).toBeGreaterThan(0);
    expect(created?.updated_at).toBeGreaterThan(0);
    expect(created?.updated_seq).toBe(1);

    const updated = run(store, {
      txId: "t2",
      ops: [
        {
          op: "update",
          namespace: "folders",
          id: "f1",
          values: { name: "Archive" },
        },
      ],
    });
    expect(updated.seq).toBe(2);

    const afterUpdate = one<{
      name: string;
      created_at: number;
      updated_at: number;
      updated_seq: number;
    }>(store, `SELECT * FROM "folders" WHERE "id" = 'f1'`);
    expect(afterUpdate?.name).toBe("Archive");
    expect(afterUpdate?.created_at).toBe(created?.created_at);
    expect(afterUpdate?.updated_seq).toBe(2);

    const merged = run(store, {
      txId: "t3",
      ops: [
        {
          op: "merge",
          namespace: "documents",
          id: "d1",
          values: { title: "Doc", content: "Body" },
        },
      ],
    });
    expect(merged).toEqual({ txId: "t3", seq: 3, applied: 1 });

    run(store, {
      txId: "t4",
      ops: [
        {
          op: "merge",
          namespace: "documents",
          id: "d1",
          values: { title: "Renamed" },
        },
      ],
    });

    const document = one<{
      title: string;
      content: string;
      updated_seq: number;
    }>(store, `SELECT * FROM "documents" WHERE "id" = 'd1'`);
    expect(document?.title).toBe("Renamed");
    expect(document?.content).toBe("Body");
    expect(document?.updated_seq).toBe(4);

    const state = one<{ high_water_seq: number }>(
      store,
      `SELECT high_water_seq FROM "_tx_state" WHERE "id" = 1`
    );
    expect(state?.high_water_seq).toBe(4);

    const log = all<{
      seq: number;
      client_tx_id: string | null;
      ops: string;
      ops_hash: string;
      user_id: string;
      role: number;
      at: number;
      schema_version: string;
    }>(store, `SELECT * FROM "_tx_log" ORDER BY seq`);

    expect(log).toHaveLength(4);
    expect(log[0].seq).toBe(1);
    expect(log[0].client_tx_id).toBeNull();
    // The writer's identity is not kept: nothing reads it (data minimisation).
    expect(log.map((row) => [row.user_id, row.role])).toEqual(log.map(() => [null, null]));
    expect(log[0].schema_version).toBe("0001_baseline");
    expect(log[0].at).toBeGreaterThan(0);

    const loggedOps = JSON.parse(log[0].ops) as unknown;
    expect(loggedOps).toEqual([
      {
        op: "update",
        namespace: "folders",
        id: "f1",
        values: { name: "Inbox", icon: null },
      },
    ]);
    expect(log[0].ops_hash).toBe(opsHash(loggedOps));
  });

  test("the receipt-time migration dates existing receipts from their log row, or now", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    const upTo = ENGINE_MIGRATIONS.findIndex((migration) => migration.id === "tapedb_0004_receipt_time");
    for (const migration of ENGINE_MIGRATIONS.slice(0, upTo)) db.exec(migration.sql);
    db.exec(`INSERT INTO "_tx_log" (seq, client_tx_id, ops, ops_hash, at, schema_version) VALUES (1, 'logged', '[]', 'h', 1234, 'v')`);
    db.exec(`INSERT INTO "_tx_receipts" (id, seq, ops_hash) VALUES ('logged', 1, 'h'), ('pruned', 7, 'h')`);
    const before = Date.now() - 1000;
    db.exec(ENGINE_MIGRATIONS[upTo].sql);
    const rows = db.query(`SELECT id, at FROM "_tx_receipts" ORDER BY id`).all() as Array<{ id: string; at: number }>;
    expect(rows[0]).toEqual({ id: "logged", at: 1234 });
    expect(rows[1].id).toBe("pruned");
    expect(rows[1].at).toBeGreaterThanOrEqual(before);
  });

  test("records when each receipt was written, and refuses a retry older than the retry window", () => {
    const op = { op: "update", namespace: "folders", id: "f1", values: { name: "Inbox" } };
    const before = Date.now();
    run(store, { txId: "t1", clientTxId: "client-w", issuedAt: before, ops: [op] } as TxEnvelope);
    const receipt = one<{ at: number }>(store, `SELECT at FROM "_tx_receipts" WHERE id = 'client-w'`);
    expect(receipt!.at).toBeGreaterThanOrEqual(before);

    // Inside the window: deduplicated, receipt or not in question.
    expect(run(store, { txId: "t1-r", clientTxId: "client-w", issuedAt: before, ops: [op] } as TxEnvelope)).toMatchObject({ seq: 1, applied: 0 });

    // A retry whose receipt has expired, first issued before the window.
    const window = retryWindowMs();
    store.db.exec(`DELETE FROM "_tx_receipts"`);
    expectCode(
      () => run(store, { txId: "t2", clientTxId: "client-old", issuedAt: Date.now() - window - 1, ops: [op] } as TxEnvelope),
      "retry_expired"
    );
    expect(all(store, `SELECT * FROM "_tx_log"`)).toHaveLength(1);

    // A recent first attempt with no receipt is new, and applies.
    expect(run(store, { txId: "t3", clientTxId: "client-new", issuedAt: Date.now() - 1000, ops: [op] } as TxEnvelope)).toMatchObject({ seq: 2, applied: 1 });
    expectCode(() => run(store, { txId: "t4", clientTxId: "client-x", issuedAt: "yesterday", ops: [op] } as unknown as TxEnvelope), "invalid_envelope");
  });

  test("deduplicates clientTxId with an order-independent ops hash", () => {
    const first = run(store, {
      txId: "t1",
      clientTxId: "client-1",
      ops: [
        {
          op: "update",
          namespace: "folders",
          id: "f1",
          values: { name: "Inbox", icon: "inbox" },
        },
      ],
    });
    expect(first.seq).toBe(1);

    const retry = run(store, {
      txId: "t1-retry",
      clientTxId: "client-1",
      ops: [
        {
          op: "update",
          namespace: "folders",
          id: "f1",
          values: { icon: "inbox", name: "Inbox" },
        },
      ],
    });
    expect(retry).toEqual({ txId: "t1-retry", seq: 1, applied: 0 });

    const log = all(store, `SELECT * FROM "_tx_log"`);
    expect(log).toHaveLength(1);

    expectCode(
      () =>
        run(store, {
          txId: "t1-conflict",
          clientTxId: "client-1",
          ops: [
            {
              op: "update",
              namespace: "folders",
              id: "f1",
              values: { name: "Different" },
            },
          ],
        }),
      "conflict"
    );

    expect(all(store, `SELECT * FROM "_tx_log"`)).toHaveLength(1);
    const state = one<{ high_water_seq: number }>(
      store,
      `SELECT high_water_seq FROM "_tx_state" WHERE "id" = 1`
    );
    expect(state?.high_water_seq).toBe(1);
  });

  test("rolls back when insert is missing a required attribute", () => {
    expectCode(
      () =>
        run(store, {
          txId: "t1",
          ops: [
            {
              op: "update",
              namespace: "folders",
              id: "f1",
              values: { icon: "only-optional" },
            },
          ],
        }),
      "invalid_op"
    );

    expect(all(store, `SELECT * FROM "folders"`)).toHaveLength(0);
    expect(all(store, `SELECT * FROM "_tx_log"`)).toHaveLength(0);
    const state = one<{ high_water_seq: number }>(
      store,
      `SELECT high_water_seq FROM "_tx_state" WHERE "id" = 1`
    );
    expect(state?.high_water_seq).toBe(0);
  });

  test("rolls back log, state and earlier ops on a constraint failure", () => {
    run(store, {
      txId: "seed-folder",
      ops: [
        {
          op: "update",
          namespace: "folders",
          id: "f1",
          values: { name: "Before" },
        },
      ],
    });
    run(store, {
      txId: "seed-doc",
      ops: [
        {
          op: "update",
          namespace: "documents",
          id: "d1",
          values: { title: "Doc", content: "Body" },
        },
      ],
    });
    run(store, {
      txId: "seed-block-1",
      ops: [
        {
          op: "update",
          namespace: "blocks",
          id: "b1",
          values: {
            type: "paragraph",
            content: "",
            order: 0,
            documentId: "d1",
          },
        },
      ],
    });
    run(store, {
      txId: "seed-block-2",
      ops: [
        {
          op: "update",
          namespace: "blocks",
          id: "b2",
          values: {
            type: "paragraph",
            content: "",
            order: 1,
            documentId: "d1",
          },
        },
      ],
    });
    run(store, {
      txId: "seed-embedding-1",
      ops: [
        {
          op: "update",
          namespace: "embeddings",
          id: "e1",
          values: { vector: [0.1], model: "m", blockId: "b1" },
        },
      ],
    });
    run(store, {
      txId: "seed-embedding-2",
      ops: [
        {
          op: "update",
          namespace: "embeddings",
          id: "e2",
          values: { vector: [0.2], model: "m", blockId: "b2" },
        },
      ],
    });

    const stateBefore = one<{ high_water_seq: number }>(
      store,
      `SELECT high_water_seq FROM "_tx_state" WHERE "id" = 1`
    );
    const logBefore = all(store, `SELECT * FROM "_tx_log"`).length;

    expectCode(
      () =>
        run(store, {
          txId: "failing",
          ops: [
            {
              op: "update",
              namespace: "folders",
              id: "f1",
              values: { name: "Should roll back" },
            },
            {
              op: "update",
              namespace: "embeddings",
              id: "e3",
              values: { vector: [], model: "m", blockId: "b1" },
            },
          ],
        }),
      "unique_violation"
    );

    const folder = one<{ name: string }>(
      store,
      `SELECT name FROM "folders" WHERE "id" = 'f1'`
    );
    expect(folder?.name).toBe("Before");
    expect(all(store, `SELECT * FROM "embeddings"`)).toHaveLength(2);
    expect(all(store, `SELECT * FROM "_tx_log"`)).toHaveLength(logBefore);
    const stateAfter = one<{ high_water_seq: number }>(
      store,
      `SELECT high_water_seq FROM "_tx_state" WHERE "id" = 1`
    );
    expect(stateAfter?.high_water_seq).toBe(stateBefore?.high_water_seq);
  });

  test("unlink only clears a link the child still holds", () => {
    run(store, {
      txId: "seed-stale",
      ops: [
        {
          op: "update",
          namespace: "folders",
          id: "f1",
          values: { name: "One" },
        },
        {
          op: "update",
          namespace: "folders",
          id: "f2",
          values: { name: "Two" },
        },
        {
          op: "update",
          namespace: "documents",
          id: "d1",
          values: { title: "Doc", content: "Body" },
        },
      ],
    });

    // Another client moves the document to f2 first.
    run(store, {
      txId: "link-f2-stale",
      ops: [
        {
          op: "link",
          namespace: "folders",
          id: "f2",
          link: "folderDocuments",
          targetId: "d1",
        },
      ],
    });

    // A queued unlink against the previous parent must be a no-op, not a
    // silent detach of the link the other client just created.
    const stale = run(store, {
      txId: "unlink-stale",
      ops: [
        {
          op: "unlink",
          namespace: "folders",
          id: "f1",
          link: "folderDocuments",
          targetId: "d1",
        },
      ],
    });

    expect(stale.applied).toBe(0);
    expect(
      one(store, `SELECT folder_id FROM "documents" WHERE "id" = 'd1'`)
        ?.folder_id
    ).toBe("f2");
  });

  test("links, unlinks, enforces FK rules and applies delete semantics", () => {
    run(store, {
      txId: "seed-folders",
      ops: [
        {
          op: "update",
          namespace: "folders",
          id: "f1",
          values: { name: "One" },
        },
        {
          op: "update",
          namespace: "folders",
          id: "f2",
          values: { name: "Two" },
        },
      ],
    });
    run(store, {
      txId: "seed-docs",
      ops: [
        {
          op: "update",
          namespace: "documents",
          id: "d1",
          values: { title: "Doc 1", content: "Body" },
        },
        {
          op: "update",
          namespace: "documents",
          id: "d2",
          values: { title: "Doc 2", content: "Body" },
        },
      ],
    });
    run(store, {
      txId: "seed-block",
      ops: [
        {
          op: "update",
          namespace: "blocks",
          id: "b1",
          values: {
            type: "paragraph",
            content: "",
            order: 0,
            documentId: "d1",
          },
        },
      ],
    });

    const forward = run(store, {
      txId: "link-forward",
      ops: [
        {
          op: "link",
          namespace: "folders",
          id: "f1",
          link: "folderDocuments",
          targetId: "d1",
        },
      ],
    });
    expect(forward.applied).toBe(1);

    let document = one<{ folder_id: string | null; updated_seq: number }>(
      store,
      `SELECT folder_id, updated_seq FROM "documents" WHERE "id" = 'd1'`
    );
    expect(document?.folder_id).toBe("f1");
    expect(document?.updated_seq).toBe(forward.seq);

    // Linking the same pair again is idempotent.
    expect(
      run(store, {
        txId: "link-again",
        ops: [
          {
            op: "link",
            namespace: "folders",
            id: "f1",
            link: "folderDocuments",
            targetId: "d1",
          },
        ],
      }).applied
    ).toBe(1);

    const reverse = run(store, {
      txId: "link-reverse",
      ops: [
        {
          op: "link",
          namespace: "documents",
          id: "d1",
          link: "folderDocuments",
          targetId: "f2",
        },
      ],
    });
    expect(reverse.applied).toBe(1);
    document = one<{ folder_id: string | null; updated_seq: number }>(
      store,
      `SELECT folder_id, updated_seq FROM "documents" WHERE "id" = 'd1'`
    );
    expect(document?.folder_id).toBe("f2");
    expect(document?.updated_seq).toBe(reverse.seq);

    const unlink = run(store, {
      txId: "unlink",
      ops: [
        {
          op: "unlink",
          namespace: "documents",
          id: "d1",
          link: "folderDocuments",
          targetId: "f2",
        },
      ],
    });
    expect(unlink.applied).toBe(1);
    document = one(
      store,
      `SELECT folder_id FROM "documents" WHERE "id" = 'd1'`
    );
    expect(document?.folder_id).toBeNull();

    // Link FKs are nullable, so unlink clears the column instead of failing.
    expect(
      run(store, {
        txId: "unlink-block",
        ops: [
          {
            op: "unlink",
            namespace: "blocks",
            id: "b1",
            link: "documentBlocks",
            targetId: "d1",
          },
        ],
      }).applied
    ).toBe(1);
    expect(
      one(store, `SELECT document_id FROM "blocks" WHERE "id" = 'b1'`)
        ?.document_id
    ).toBeNull();

    // Restore the link so the delete-semantics assertions below still cover
    // cascade deletes.
    run(store, {
      txId: "relink-block",
      ops: [
        {
          op: "link",
          namespace: "blocks",
          id: "b1",
          link: "documentBlocks",
          targetId: "d1",
        },
      ],
    });

    // A link to a missing child is not_found, not a silent no-op.
    expectCode(
      () =>
        run(store, {
          txId: "link-missing-child",
          ops: [
            {
              op: "link",
              namespace: "folders",
              id: "f1",
              link: "folderDocuments",
              targetId: "missing-doc",
            },
          ],
        }),
      "not_found"
    );

    // One-to-one links rely on the unique index.
    run(store, {
      txId: "seed-blocks",
      ops: [
        {
          op: "update",
          namespace: "blocks",
          id: "b2",
          values: {
            type: "paragraph",
            content: "",
            order: 1,
            documentId: "d1",
          },
        },
      ],
    });
    run(store, {
      txId: "seed-embeddings",
      ops: [
        {
          op: "update",
          namespace: "embeddings",
          id: "e1",
          values: { vector: [], model: "m", blockId: "b1" },
        },
        {
          op: "update",
          namespace: "embeddings",
          id: "e2",
          values: { vector: [], model: "m", blockId: "b2" },
        },
      ],
    });
    expectCode(
      () =>
        run(store, {
          txId: "one-to-one-conflict",
          ops: [
            {
              op: "link",
              namespace: "blocks",
              id: "b2",
              link: "blockEmbeddings",
              targetId: "e1",
            },
          ],
        }),
      "unique_violation"
    );

    const deleteResult = run(
      store,
      {
        txId: "delete-doc",
        ops: [{ op: "delete", namespace: "documents", id: "d1" }],
      },
      WORKSPACE_ROLE_LEVELS.MODERATOR
    );
    expect(deleteResult.applied).toBe(1);
    expect(
      all(store, `SELECT * FROM "blocks" WHERE "document_id" = 'd1'`)
    ).toHaveLength(0);

    const missingDelete = run(
      store,
      {
        txId: "delete-missing",
        ops: [{ op: "delete", namespace: "documents", id: "nope" }],
      },
      WORKSPACE_ROLE_LEVELS.MODERATOR
    );
    expect(missingDelete.applied).toBe(0);
  });

  test("denies unauthorized transactions before writing anything", () => {
    expectCode(
      () =>
        run(
          store,
          {
            txId: "t1",
            ops: [
              {
                op: "update",
                namespace: "folders",
                id: "f1",
                values: { name: "Inbox" },
              },
            ],
          },
          WORKSPACE_ROLE_LEVELS.MEMBER
        ),
      "permission_denied"
    );

    expect(all(store, `SELECT * FROM "folders"`)).toHaveLength(0);
    expect(all(store, `SELECT * FROM "_tx_log"`)).toHaveLength(0);
  });

  test("rolls back a foreign key failure", () => {
    expectCode(
      () =>
        run(store, {
          txId: "t1",
          ops: [
            {
              op: "update",
              namespace: "blocks",
              id: "b1",
              values: {
                type: "paragraph",
                content: "",
                order: 0,
                documentId: "missing-doc",
              },
            },
          ],
        }),
      "foreign_key_violation"
    );

    expect(all(store, `SELECT * FROM "blocks"`)).toHaveLength(0);
    expect(all(store, `SELECT * FROM "_tx_log"`)).toHaveLength(0);
    const state = one<{ high_water_seq: number }>(
      store,
      `SELECT high_water_seq FROM "_tx_state" WHERE "id" = 1`
    );
    expect(state?.high_water_seq).toBe(0);
  });

  test("rejects a claim for another workspace", () => {
    expectCode(
      () =>
        runTransaction(store.sql, "other-workspace", claim(), {
          txId: txId(),
          ops: [
            {
              op: "update",
              namespace: "folders",
              id: "f1",
              values: { name: "Inbox" },
            },
          ],
        }),
      "permission_denied"
    );
  });

  test("creates unlinked kanban rows, then links them across transactions", () => {
    run(store, {
      txId: "seed-board",
      ops: [
        {
          op: "update",
          namespace: "kanbanBoards",
          id: "board-1",
          values: { name: "Board" },
        },
      ],
    });
    run(store, {
      txId: "seed-column",
      ops: [
        {
          op: "update",
          namespace: "kanbanColumns",
          id: "col-1",
          values: { name: "Todo", order: 0 },
        },
      ],
    });
    run(store, {
      txId: "seed-task",
      ops: [
        {
          op: "update",
          namespace: "kanbanTasks",
          id: "task-1",
          values: { title: "Task", order: 0 },
        },
      ],
    });

    // The rows exist before either link is applied.
    expect(
      one(store, `SELECT board_id FROM "kanban_columns" WHERE "id" = 'col-1'`)
        ?.board_id
    ).toBeNull();
    expect(
      one(store, `SELECT column_id FROM "kanban_tasks" WHERE "id" = 'task-1'`)
        ?.column_id
    ).toBeNull();

    const linkColumn = run(store, {
      txId: "link-board-column",
      ops: [
        {
          op: "link",
          namespace: "kanbanBoards",
          id: "board-1",
          link: "boardColumns",
          targetId: "col-1",
        },
      ],
    });
    expect(linkColumn.applied).toBe(1);

    const linkTask = run(store, {
      txId: "link-column-task",
      ops: [
        {
          op: "link",
          namespace: "kanbanColumns",
          id: "col-1",
          link: "columnTasks",
          targetId: "task-1",
        },
      ],
    });
    expect(linkTask.applied).toBe(1);

    expect(
      one(store, `SELECT board_id FROM "kanban_columns" WHERE "id" = 'col-1'`)
        ?.board_id
    ).toBe("board-1");
    expect(
      one(store, `SELECT column_id FROM "kanban_tasks" WHERE "id" = 'task-1'`)
        ?.column_id
    ).toBe("col-1");
  });

  test("links a column created in the same transaction after its update op", () => {
    const result = run(store, {
      txId: "create-and-link",
      ops: [
        {
          op: "update",
          namespace: "kanbanBoards",
          id: "board-1",
          values: { name: "Board" },
        },
        {
          op: "update",
          namespace: "kanbanColumns",
          id: "col-1",
          values: { name: "Todo", order: 0 },
        },
        {
          op: "link",
          namespace: "kanbanBoards",
          id: "board-1",
          link: "boardColumns",
          targetId: "col-1",
        },
      ],
    });

    expect(result.applied).toBe(3);
    expect(
      one(store, `SELECT board_id FROM "kanban_columns" WHERE "id" = 'col-1'`)
        ?.board_id
    ).toBe("board-1");
  });

  test("returns conflict when a clientTxId is reused with different ops", () => {
    run(store, {
      txId: "seed-folders",
      ops: [
        {
          op: "update",
          namespace: "folders",
          id: "f1",
          values: { name: "One" },
        },
        {
          op: "update",
          namespace: "folders",
          id: "f2",
          values: { name: "Two" },
        },
      ],
    });

    const first = run(
      store,
      {
        txId: "delete-f1",
        clientTxId: "client-conflict",
        ops: [{ op: "delete", namespace: "folders", id: "f1" }],
      },
      WORKSPACE_ROLE_LEVELS.MODERATOR
    );
    expect(first.applied).toBe(1);

    const logBefore = all(store, `SELECT * FROM "_tx_log"`).length;
    const stateBefore = one<{ high_water_seq: number }>(
      store,
      `SELECT high_water_seq FROM "_tx_state" WHERE "id" = 1`
    );

    expectCode(
      () =>
        run(
          store,
          {
            txId: "delete-f2",
            clientTxId: "client-conflict",
            ops: [{ op: "delete", namespace: "folders", id: "f2" }],
          },
          WORKSPACE_ROLE_LEVELS.MODERATOR
        ),
      "conflict"
    );

    expect(all(store, `SELECT * FROM "_tx_log"`)).toHaveLength(logBefore);
    expect(
      one<{ high_water_seq: number }>(
        store,
        `SELECT high_water_seq FROM "_tx_state" WHERE "id" = 1`
      )?.high_water_seq
    ).toBe(stateBefore?.high_water_seq);
    // The conflicting transaction rolled back, so f2 is still present.
    expect(
      one(store, `SELECT 1 AS present FROM "folders" WHERE "id" = 'f2'`)
    ).toBeDefined();
  });

  test("repairs a high-water mark that is behind the transaction log", () => {
    run(store, {
      txId: "seed-folder",
      ops: [
        {
          op: "update",
          namespace: "folders",
          id: "f1",
          values: { name: "Inbox" },
        },
      ],
    });

    // Simulate a recovery/legacy state where the log already has seq 2 but
    // `_tx_state` still says 1. The next transaction must not collide.
    store.db.exec(
      `INSERT INTO "_tx_log" (seq, ops, ops_hash, at, schema_version)
       VALUES (2, '[]', 'legacy-hash', 1, '0001_baseline')`
    );
    store.db.exec(`UPDATE "_tx_state" SET high_water_seq = 1 WHERE "id" = 1`);

    const next = run(store, {
      txId: "after-repair",
      ops: [
        {
          op: "update",
          namespace: "folders",
          id: "f2",
          values: { name: "Later" },
        },
      ],
    });

    expect(next.seq).toBe(3);
    expect(
      one<{ high_water_seq: number }>(
        store,
        `SELECT high_water_seq FROM "_tx_state" WHERE "id" = 1`
      )?.high_water_seq
    ).toBe(3);
    expect(
      one<{ max_seq: number }>(
        store,
        `SELECT MAX(seq) AS max_seq FROM "_tx_log"`
      )?.max_seq
    ).toBe(3);
  });

  test("unlink clears an optional link foreign key", () => {
    run(store, {
      txId: "seed-board-column",
      ops: [
        {
          op: "update",
          namespace: "kanbanBoards",
          id: "board-1",
          values: { name: "Board" },
        },
        {
          op: "update",
          namespace: "kanbanColumns",
          id: "col-1",
          values: { name: "Todo", order: 0 },
        },
        {
          op: "link",
          namespace: "kanbanBoards",
          id: "board-1",
          link: "boardColumns",
          targetId: "col-1",
        },
      ],
    });
    expect(
      one(store, `SELECT board_id FROM "kanban_columns" WHERE "id" = 'col-1'`)
        ?.board_id
    ).toBe("board-1");

    const unlink = run(store, {
      txId: "unlink-board-column",
      ops: [
        {
          op: "unlink",
          namespace: "kanbanBoards",
          id: "board-1",
          link: "boardColumns",
          targetId: "col-1",
        },
      ],
    });
    expect(unlink.applied).toBe(1);
    expect(
      one(store, `SELECT board_id FROM "kanban_columns" WHERE "id" = 'col-1'`)
        ?.board_id
    ).toBeNull();
  });
});

test("persists whiteboard JSON through insert, retry, update and delete", () => {
  const store = createStore();
  try {
    const shape = {
      x: 10,
      y: 20,
      width: 100,
      height: 60,
      shape: "rectangle",
      fill: "red",
    };
    const envelope: TxEnvelope = {
      txId: "whiteboard-add",
      clientTxId: "whiteboard-idempotent",
      ops: [
        {
          op: "update",
          namespace: "whiteboardElements",
          id: "shape-1",
          values: { boardId: "board-1", kind: "shape", data: shape, z: 0 },
        },
      ],
    };
    const result = run(store, envelope);
    expect(result.applied).toBe(1);
    run(store, { ...envelope, txId: "whiteboard-retry" });
    expect(
      store.db.query("SELECT COUNT(*) AS count FROM whiteboard_elements").get()
    ).toEqual({ count: 1 });
    expect(
      JSON.parse(
        (
          store.db.query("SELECT data FROM whiteboard_elements").get() as {
            data: string;
          }
        ).data
      )
    ).toEqual(shape);
    run(store, {
      txId: "whiteboard-update",
      ops: [
        {
          op: "update",
          namespace: "whiteboardElements",
          id: "shape-1",
          values: { data: { ...shape, x: 30 } },
        },
      ],
    });
    expect(
      JSON.parse(
        (
          store.db.query("SELECT data FROM whiteboard_elements").get() as {
            data: string;
          }
        ).data
      ).x
    ).toBe(30);
    expectCode(
      () =>
        run(store, {
          txId: "whiteboard-invalid",
          ops: [
            {
              op: "update",
              namespace: "whiteboardElements",
              id: "shape-bad",
              values: { kind: "shape" },
            },
          ],
        }),
      "invalid_op"
    );
    run(
      store,
      {
        txId: "whiteboard-delete",
        ops: [{ op: "delete", namespace: "whiteboardElements", id: "shape-1" }],
      },
      WORKSPACE_ROLE_LEVELS.MODERATOR
    );
    expect(
      store.db.query("SELECT COUNT(*) AS count FROM whiteboard_elements").get()
    ).toEqual({ count: 0 });
  } finally {
    store.db.close();
  }
});
