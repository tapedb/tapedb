import { useLegacyFixture } from "../fixtures/registry";
useLegacyFixture();

import { describe, expect, test } from "bun:test";

import {
  buildSelectSql,
  compileQuery,
  type CompiledNode,
} from "../../src/engine/query-compile";
import { TxError } from "../../src/engine/tx-types";

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

function node(
  compiled: ReturnType<typeof compileQuery>,
  index = 0
): CompiledNode {
  const selected = compiled.nodes[index];
  if (!selected) throw new Error("Expected a compiled node.");
  return selected;
}

describe("compileQuery", () => {
  test("compiles a namespace with options and one nested link level", () => {
    const compiled = compileQuery({
      kanbanBoards: {
        $: {
          where: { name: "Board" },
          order: { createdAt: "asc" },
          limit: 50,
        },
        columns: {
          tasks: {},
        },
      },
    });

    const board = node(compiled);
    expect(board).toMatchObject({
      namespace: "kanbanBoards",
      table: "kanban_boards",
      depth: 0,
      limit: 50,
    });
    expect(board.children).toHaveLength(1);
    expect(board.children[0]).toMatchObject({
      label: "columns",
      target: "kanbanColumns",
      direction: "forward",
      multiplicity: "many",
      foreignKeyColumn: "board_id",
    });

    const column = board.children[0]?.node;
    expect(column).toBeDefined();
    if (!column) throw new Error("unreachable");
    expect(column.depth).toBe(1);
    expect(column.children[0]).toMatchObject({
      label: "tasks",
      target: "kanbanTasks",
      direction: "forward",
      multiplicity: "many",
      foreignKeyColumn: "column_id",
    });
    expect(column.children[0]?.node.depth).toBe(2);
  });

  test("builds parameterised SQL with quoted identifiers", () => {
    const compiled = compileQuery({
      kanbanBoards: {
        $: {
          where: { name: "Board", createdAt: { $gte: 2 } },
          order: { createdAt: "desc" },
          limit: 5,
        },
      },
    });

    const { sql, params } = buildSelectSql(node(compiled));

    expect(sql).toContain('FROM "kanban_boards"');
    expect(sql).toContain('("name" = ?)');
    expect(sql).toContain('("created_at" >= ?)');
    expect(sql).toContain('ORDER BY "created_at" DESC');
    expect(sql.endsWith("LIMIT ?")).toBe(true);
    expect(params).toEqual(["Board", 2, 5]);
  });

  test("adds an IN predicate for link hydration", () => {
    const compiled = compileQuery({ documents: { blocks: {} } });
    const child = node(compiled).children[0];
    if (!child) throw new Error("unreachable");

    const { sql, params } = buildSelectSql(child.node, {
      column: "document_id",
      ids: ["d1", "d2"],
    });

    // One parameter however many parents: a Durable Object binds at most 100.
    expect(sql).toContain('("document_id" IN (SELECT value FROM json_each(?)))');
    // A nested level carries no implicit LIMIT: one LIMIT over `fk IN (...)` is
    // shared by every parent, which silently truncates the later parents.
    expect(sql.endsWith("LIMIT ?")).toBe(false);
    expect(params).toEqual(['["d1","d2"]']);
  });

  test("keeps an explicit limit on a nested level", () => {
    const compiled = compileQuery({
      documents: { blocks: { $: { limit: 5 } } },
    });
    const child = node(compiled).children[0];
    if (!child) throw new Error("unreachable");

    expect(child.node.explicitLimit).toBe(true);
    expect(child.node.limit).toBe(5);
    expect(node(compiled).explicitLimit).toBe(false);
  });

  test("compiles reverse links and one-to-one links", () => {
    const reverse = compileQuery({
      kanbanTasks: {
        $: { where: { id: "t1" } },
        column: { board: {} },
      },
    });
    const task = node(reverse);
    expect(task.children[0]).toMatchObject({
      label: "column",
      target: "kanbanColumns",
      direction: "reverse",
      multiplicity: "one",
      foreignKeyColumn: "column_id",
    });
    expect(task.children[0]?.node.children[0]).toMatchObject({
      label: "board",
      target: "kanbanBoards",
      direction: "reverse",
      multiplicity: "one",
      foreignKeyColumn: "board_id",
    });

    const oneToOne = compileQuery({ blocks: { embedding: {} } });
    const block = node(oneToOne);
    expect(block.children[0]).toMatchObject({
      label: "embedding",
      target: "embeddings",
      direction: "forward",
      multiplicity: "one",
      foreignKeyColumn: "block_id",
    });

    const oneToOneReverse = compileQuery({ embeddings: { block: {} } });
    expect(node(oneToOneReverse).children[0]).toMatchObject({
      label: "block",
      target: "blocks",
      direction: "reverse",
      multiplicity: "one",
      foreignKeyColumn: "block_id",
    });
  });

  test("normalises boolean and date comparison values", () => {
    const boolean = compileQuery({
      blocks: { $: { where: { checked: true } } },
    });
    // No implicit LIMIT: a read without one returns every match.
    expect(buildSelectSql(node(boolean)).params).toEqual([1]);

    const date = compileQuery({
      kanbanTasks: {
        $: { where: { dueAt: "2026-01-01T00:00:00.000Z" } },
      },
    });
    expect(buildSelectSql(node(date)).params[0]).toBe(
      Date.parse("2026-01-01T00:00:00.000Z")
    );
  });

  test("supports $ne, $in and comparison operators", () => {
    const compiled = compileQuery({
      kanbanTasks: {
        $: {
          where: {
            status: { $ne: "done", $in: ["todo", "done"] },
            order: { $gt: 1, $lte: 4 },
          },
        },
      },
    });

    const { sql, params } = buildSelectSql(node(compiled));
    expect(sql).toContain('("status" IS NULL OR "status" <> ?)');
    expect(sql).toContain('("status" IN (SELECT value FROM json_each(?)))');
    expect(sql).toContain('("order" > ?)');
    expect(sql).toContain('("order" <= ?)');
    expect(params).toEqual(["done", '["todo","done"]', 1, 4]);
  });

  test("compiles an empty $in to a false predicate", () => {
    const compiled = compileQuery({
      kanbanTasks: { $: { where: { status: { $in: [] } } } },
    });
    expect(buildSelectSql(node(compiled)).sql).toContain("(0 = 1)");
  });

  test("rejects unknown namespaces, attributes, links and options", () => {
    expectCode(() => compileQuery({ nope: {} }), "unknown_namespace");
    expectCode(
      () => compileQuery({ folders: { $: { where: { nope: 1 } } } }),
      "unknown_attribute"
    );
    expectCode(
      () => compileQuery({ folders: { $: { order: { nope: "asc" } } } }),
      "unknown_attribute"
    );
    expectCode(() => compileQuery({ folders: { nope: {} } }), "unknown_link");
    expectCode(
      () => compileQuery({ folders: { $: { select: {} } } }),
      "invalid_op"
    );
  });

  test("rejects unsupported operators and non-scalar filters", () => {
    expectCode(
      () =>
        compileQuery({
          kanbanTasks: { $: { where: { title: { $regex: "x" } } } },
        }),
      "invalid_value"
    );
    expectCode(
      () => compileQuery({ kanbanTasks: { $: { where: { tags: "x" } } } }),
      "invalid_value"
    );
    expectCode(
      () =>
        compileQuery({
          kanbanTasks: { $: { order: { tags: "asc" } } },
        }),
      "invalid_value"
    );
  });

  test("compiles links at any depth; enforces limits and array shape", () => {
    const deep = compileQuery({ folders: { children: { children: { children: {} } } } });
    expect(deep.nodes[0]?.children[0]?.node.children[0]?.node.children[0]?.node.depth).toBe(3);
    expectCode(
      () => compileQuery({ folders: { $: { limit: 0 } } }),
      "invalid_value"
    );
    expect(compileQuery({ folders: { $: { limit: 50_000 } } }).nodes[0]?.limit).toBe(50_000);
    expectCode(() => compileQuery({ folders: { $: { limit: 1.5 } } }), "invalid_value");
    expectCode(() => compileQuery({ folders: { children: [] } }), "invalid_op");
  });

  test("rejects a non-object query document", () => {
    expectCode(() => compileQuery([]), "invalid_op");
  });
});
