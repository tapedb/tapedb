import { useNdexFixture } from "../fixtures/registry";
useNdexFixture();

import { describe, expect, test } from "bun:test";

import { findNamespace } from "../fixtures/registry";
import { TxError } from "../../src/engine/tx-types";
import { isLinkOp, requiredColumns, validateEnvelope } from "../../src/engine/tx-validate";

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

function envelope(
  ops: unknown[],
  extra: Record<string, unknown> = {}
): unknown {
  return { txId: "tx-1", ops, ...extra };
}

describe("validateEnvelope", () => {
  test("accepts a minimal update op", () => {
    const tx = validateEnvelope(
      envelope([
        {
          op: "update",
          namespace: "folders",
          id: "folder-1",
          values: { name: "Inbox" },
        },
      ])
    );

    expect(tx.txId).toBe("tx-1");
    expect(tx.ops).toHaveLength(1);
    expect(tx.ops[0]).toMatchObject({
      kind: "update",
      namespace: "folders",
      id: "folder-1",
      values: { name: "Inbox" },
    });
  });

  test("rejects non-object envelopes and bad ids", () => {
    expectCode(() => validateEnvelope(null), "invalid_envelope");
    expectCode(() => validateEnvelope([]), "invalid_envelope");
    expectCode(() => validateEnvelope({ ops: [] }), "invalid_envelope");
    expectCode(
      () => validateEnvelope({ txId: "  ", ops: [] }),
      "invalid_envelope"
    );
    expectCode(
      () => validateEnvelope({ txId: "t", ops: [], clientTxId: "" }),
      "invalid_envelope"
    );
  });

  test("requires at least one op", () => {
    expectCode(() => validateEnvelope(envelope([])), "invalid_envelope");
    const op = {
      op: "delete",
      namespace: "folders",
      id: "f",
    };
    expect(
      validateEnvelope(envelope(Array.from({ length: 101 }, () => op))).ops
    ).toHaveLength(101);
  });

  test("rejects unknown kinds, namespaces and ids", () => {
    expectCode(
      () =>
        validateEnvelope(
          envelope([
            { op: "replace", namespace: "folders", id: "f", values: {} },
          ])
        ),
      "invalid_op"
    );
    expectCode(
      () =>
        validateEnvelope(
          envelope([{ op: "delete", namespace: "nope", id: "f" }])
        ),
      "unknown_namespace"
    );
    expectCode(
      () =>
        validateEnvelope(
          envelope([{ op: "delete", namespace: "folders", id: "bad id" }])
        ),
      "invalid_op"
    );
    expectCode(
      () =>
        validateEnvelope(
          envelope([
            { op: "delete", namespace: "folders", id: "x".repeat(129) },
          ])
        ),
      "invalid_op"
    );
  });

  test("requires plain-object values for update and merge", () => {
    expectCode(
      () =>
        validateEnvelope(
          envelope([
            { op: "update", namespace: "folders", id: "f", values: null },
          ])
        ),
      "invalid_op"
    );
    expectCode(
      () =>
        validateEnvelope(
          envelope([{ op: "merge", namespace: "folders", id: "f", values: [] }])
        ),
      "invalid_op"
    );
  });

  test("rejects reserved and unknown attributes", () => {
    expectCode(
      () =>
        validateEnvelope(
          envelope([
            {
              op: "update",
              namespace: "folders",
              id: "f",
              values: { id: "other" },
            },
          ])
        ),
      "unknown_attribute"
    );
    expectCode(
      () =>
        validateEnvelope(
          envelope([
            {
              op: "update",
              namespace: "folders",
              id: "f",
              values: { updatedSeq: 3 },
            },
          ])
        ),
      "unknown_attribute"
    );
    expectCode(
      () =>
        validateEnvelope(
          envelope([
            {
              op: "update",
              namespace: "folders",
              id: "f",
              values: { updated_seq: 3 },
            },
          ])
        ),
      "unknown_attribute"
    );
    expectCode(
      () =>
        validateEnvelope(
          envelope([
            {
              op: "update",
              namespace: "folders",
              id: "f",
              values: { notAnAttribute: true },
            },
          ])
        ),
      "unknown_attribute"
    );
  });

  test("converts dates, booleans and JSON values", () => {
    const tx = validateEnvelope(
      envelope([
        {
          op: "merge",
          namespace: "kanbanColumns",
          id: "c",
          values: { name: "Done", order: 1, isDone: true },
        },
        {
          op: "merge",
          namespace: "kanbanSprints",
          id: "s",
          values: {
            name: "Sprint",
            order: 0,
            startAt: "2026-10-22T12:00:00.000Z",
          },
        },
        {
          op: "merge",
          namespace: "kanbanTasks",
          id: "t",
          values: {
            title: "Task",
            order: 0,
            tags: [{ label: "a" }],
            checklist: { items: [] },
          },
        },
      ])
    );

    expect(tx.ops[0]).toMatchObject({
      values: { name: "Done", order: 1, is_done: 1 },
    });
    expect(tx.ops[1]).toMatchObject({
      values: {
        name: "Sprint",
        order: 0,
        start_at: Date.parse("2026-10-22T12:00:00.000Z"),
      },
    });
    expect(tx.ops[2]).toMatchObject({
      values: {
        title: "Task",
        order: 0,
        tags: JSON.stringify([{ label: "a" }]),
        checklist: JSON.stringify({ items: [] }),
      },
    });
  });

  test("accepts engine timestamps but does not expose them as client values", () => {
    const tx = validateEnvelope(
      envelope([
        {
          op: "update",
          namespace: "folders",
          id: "f",
          values: {
            name: "Inbox",
            createdAt: 1,
            updatedAt: "2026-10-22T00:00:00.000Z",
          },
        },
      ])
    );

    expect(tx.ops[0]).toMatchObject({ values: { name: "Inbox" } });
    const values = (tx.ops[0] as { values: Record<string, unknown> }).values;
    expect(values).not.toHaveProperty("created_at");
    expect(values).not.toHaveProperty("updated_at");
  });

  test("accepts null only for optional attributes", () => {
    const tx = validateEnvelope(
      envelope([
        {
          op: "merge",
          namespace: "kanbanTasks",
          id: "t",
          values: { title: "Task", order: 0, description: null },
        },
      ])
    );
    expect(tx.ops[0]).toMatchObject({
      values: { title: "Task", order: 0, description: null },
    });

    expectCode(
      () =>
        validateEnvelope(
          envelope([
            {
              op: "merge",
              namespace: "folders",
              id: "f",
              values: { name: null },
            },
          ])
        ),
      "invalid_value"
    );
  });

  test("rejects wrong primitive types and non-finite numbers", () => {
    expectCode(
      () =>
        validateEnvelope(
          envelope([
            {
              op: "update",
              namespace: "folders",
              id: "f",
              values: { name: 3 },
            },
          ])
        ),
      "invalid_value"
    );
    expectCode(
      () =>
        validateEnvelope(
          envelope([
            {
              op: "update",
              namespace: "folders",
              id: "f",
              values: { order: Number.POSITIVE_INFINITY },
            },
          ])
        ),
      "invalid_value"
    );
    expectCode(
      () =>
        validateEnvelope(
          envelope([
            {
              op: "update",
              namespace: "folders",
              id: "f",
              values: { createdAt: "not-a-date" },
            },
          ])
        ),
      "invalid_value"
    );
    expectCode(
      () =>
        validateEnvelope(
          envelope([
            {
              op: "update",
              namespace: "kanbanTasks",
              id: "t",
              values: { tags: () => undefined },
            },
          ])
        ),
      "invalid_value"
    );
  });
});

describe("validateEnvelope links", () => {
  test("resolves a forward link to the child foreign key", () => {
    const tx = validateEnvelope(
      envelope([
        {
          op: "link",
          namespace: "folders",
          id: "parent",
          link: "folderDocuments",
          targetId: "child",
        },
      ])
    );

    const op = tx.ops[0];
    expect(isLinkOp(op)).toBe(true);
    expect(op).toMatchObject({
      kind: "link",
      namespace: "folders",
      id: "parent",
      link: "folderDocuments",
      targetId: "child",
      childNamespace: "documents",
      childId: "child",
      parentId: "parent",
      foreignKeyAttribute: "folderId",
      foreignKeyColumn: "folder_id",
    });
  });

  test("resolves a reverse link to the source foreign key", () => {
    const tx = validateEnvelope(
      envelope([
        {
          op: "link",
          namespace: "documents",
          id: "child",
          link: "folderDocuments",
          targetId: "parent",
        },
      ])
    );

    expect(tx.ops[0]).toMatchObject({
      childNamespace: "documents",
      childId: "child",
      parentId: "parent",
    });
  });

  test("interprets a self-referential link in its forward direction", () => {
    const tx = validateEnvelope(
      envelope([
        {
          op: "unlink",
          namespace: "folders",
          id: "parent",
          link: "folderChildren",
          targetId: "child",
        },
      ])
    );

    expect(tx.ops[0]).toMatchObject({
      kind: "unlink",
      childNamespace: "folders",
      childId: "child",
      parentId: "parent",
      foreignKeyColumn: "parent_id",
    });
  });

  test("rejects unknown links, bad targets and wrong source namespaces", () => {
    expectCode(
      () =>
        validateEnvelope(
          envelope([
            {
              op: "link",
              namespace: "folders",
              id: "f",
              link: "nope",
              targetId: "d",
            },
          ])
        ),
      "unknown_link"
    );
    expectCode(
      () =>
        validateEnvelope(
          envelope([
            {
              op: "link",
              namespace: "folders",
              id: "f",
              link: "folderDocuments",
              targetId: "bad target",
            },
          ])
        ),
      "invalid_op"
    );
    expectCode(
      () =>
        validateEnvelope(
          envelope([
            {
              op: "link",
              namespace: "kanbanTasks",
              id: "t",
              link: "folderDocuments",
              targetId: "d",
            },
          ])
        ),
      "invalid_op"
    );
  });
});

describe("requiredColumns", () => {
  test("lists non-optional attributes except engine timestamps", () => {
    const documents = findNamespace("documents");
    if (!documents) throw new Error("missing documents namespace");
    expect(requiredColumns(documents)).toEqual(["title", "content"]);

    const folders = findNamespace("folders");
    if (!folders) throw new Error("missing folders namespace");
    expect(requiredColumns(folders)).toEqual(["name"]);
  });
});
