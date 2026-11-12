import { useNdexFixture } from "../fixtures/registry";
useNdexFixture();

import { describe, expect, test } from "bun:test";

import { compileQuery } from "../../src/engine/query-compile";
import {
  diffEntityList,
  diffQueryResults,
  queryMatchesTouched,
  queryReferencesNamespace,
  touchedNamespaces,
  touchedNamespacesFromEnvelope,
} from "../../src/engine/subscriptions";

describe("touchedNamespaces", () => {
  test("restricting a delete does not rewrite attachment rows", () => {
    expect(
      touchedNamespaces([{ kind: "delete", namespace: "kanbanTasks" }]).has(
        "kanbanAttachments"
      )
    ).toBe(false);
  });
  test("collects the op namespace for update, merge and delete", () => {
    // `blocks` delete also reaches embeddings, whose FK cascades from blocks.
    expect(
      touchedNamespaces([
        { kind: "update", namespace: "folders" },
        { kind: "merge", namespace: "documents" },
        { kind: "delete", namespace: "blocks" },
      ])
    ).toEqual(new Set(["folders", "documents", "blocks", "embeddings"]));
  });

  test("a delete touches the namespaces whose rows the FKs rewrite", () => {
    // folders -> documents (SET NULL) -> blocks/versions/canvasElements
    // (CASCADE) -> embeddings (CASCADE).
    expect(
      [...touchedNamespaces([{ kind: "delete", namespace: "folders" }])].sort()
    ).toEqual([
      "blocks",
      "canvasElements",
      "documents",
      "embeddings",
      "folders",
      "versions",
    ]);

    expect(
      [
        ...touchedNamespaces([{ kind: "delete", namespace: "kanbanBoards" }]),
      ].sort()
    ).toEqual([
      "ciStatus",
      "gitBranches",
      "kanbanBoards",
      "kanbanColumns",
      "kanbanSprints",
      "kanbanTasks",
      "pullRequests",
      "taskAssignees",
    ]);
  });

  test("link and unlink touch the source and the FK-owning namespace", () => {
    // folderDocuments: folders (source) -> documents (owns folderId).
    expect(
      touchedNamespaces([
        { kind: "link", namespace: "folders", link: "folderDocuments" },
      ])
    ).toEqual(new Set(["folders", "documents"]));

    expect(
      touchedNamespaces([
        { kind: "unlink", namespace: "folders", link: "folderDocuments" },
      ])
    ).toEqual(new Set(["folders", "documents"]));
  });

  test("accepts raw wire ops and explicit childNamespace", () => {
    expect(
      touchedNamespacesFromEnvelope({
        txId: "t1",
        ops: [
          { op: "update", namespace: "kanbanTasks", id: "t" },
          {
            op: "link",
            namespace: "kanbanTasks",
            link: "columnTasks",
            childNamespace: "kanbanTasks",
            id: "t",
            targetId: "c",
          },
          { op: "delete", namespace: "favorites", id: "f" },
        ],
      })
    ).toEqual(new Set(["kanbanTasks", "favorites"]));
  });

  test("ignores malformed ops and unknown links", () => {
    expect(
      touchedNamespaces([
        { kind: "update" },
        { kind: "link", namespace: "folders", link: "notARealLink" },
        { kind: "delete", namespace: "" },
      ])
    ).toEqual(new Set(["folders"]));

    expect(touchedNamespacesFromEnvelope(null)).toEqual(new Set());
    expect(touchedNamespacesFromEnvelope({ ops: "nope" })).toEqual(new Set());
  });
});

describe("query matching", () => {
  test("matches a top-level namespace", () => {
    const compiled = compileQuery({ kanbanBoards: {} });
    expect(queryMatchesTouched(compiled, new Set(["kanbanBoards"]))).toBe(true);
    expect(queryMatchesTouched(compiled, new Set(["folders"]))).toBe(false);
  });

  test("matches a nested traversal up to two levels", () => {
    const compiled = compileQuery({
      kanbanBoards: { $: {}, columns: { tasks: {} } },
    });

    expect(queryReferencesNamespace(compiled, "kanbanTasks")).toBe(true);
    expect(queryMatchesTouched(compiled, new Set(["kanbanTasks"]))).toBe(true);
    expect(queryMatchesTouched(compiled, new Set(["documents"]))).toBe(false);
  });

  test("an empty touched set never matches", () => {
    const compiled = compileQuery({ folders: {} });
    expect(queryMatchesTouched(compiled, new Set())).toBe(false);
  });
});

describe("diffEntityList", () => {
  test("classifies added, updated and removed entities by id", () => {
    const diff = diffEntityList(
      [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      [
        { id: "a", name: "A" },
        { id: "b", name: "B2" },
        { id: "c", name: "C" },
      ]
    );

    expect(diff).not.toBeNull();
    expect(diff?.added).toEqual([{ id: "c", name: "C" }]);
    expect(diff?.updated).toEqual([{ id: "b", name: "B2" }]);
    expect(diff?.removed).toEqual([]);
  });

  test("reports removed entity ids", () => {
    const diff = diffEntityList([{ id: "a" }, { id: "b" }], [{ id: "a" }]);
    expect(diff?.removed).toEqual(["b"]);
  });

  test("detects nested entity changes", () => {
    const diff = diffEntityList(
      [{ id: "a", columns: [{ id: "c", tasks: [{ id: "t", title: "Old" }] }] }],
      [{ id: "a", columns: [{ id: "c", tasks: [{ id: "t", title: "New" }] }] }]
    );

    expect(diff?.updated).toHaveLength(1);
    expect(diff?.updated[0]).toEqual({
      id: "a",
      columns: [{ id: "c", tasks: [{ id: "t", title: "New" }] }],
    });
  });

  test("returns an empty diff when nothing changed", () => {
    expect(diffEntityList([{ id: "a", n: 1 }], [{ id: "a", n: 1 }])).toEqual({
      added: [],
      updated: [],
      removed: [],
    });
  });

  test("refuses shapes it cannot index safely", () => {
    expect(diffEntityList("nope", [])).toBeNull();
    expect(diffEntityList([], "nope")).toBeNull();
    expect(diffEntityList([{ name: "no id" }], [])).toBeNull();
    expect(diffEntityList([{ id: "a" }, { id: "a" }], [])).toBeNull();
  });
});

describe("diffQueryResults", () => {
  test("emits one diff per changed top-level namespace", () => {
    const diffs = diffQueryResults(
      {
        folders: [{ id: "f1", name: "Inbox" }],
        documents: [{ id: "d1", title: "Doc" }],
      },
      {
        folders: [{ id: "f1", name: "Inbox" }],
        documents: [{ id: "d1", title: "Renamed" }],
      }
    );

    expect(diffs).not.toBeNull();
    expect(diffs).toHaveLength(1);
    expect(diffs?.[0]).toEqual({
      namespace: "documents",
      added: [],
      updated: [{ id: "d1", title: "Renamed" }],
      removed: [],
    });
  });

  test("returns an empty list for identical results", () => {
    expect(
      diffQueryResults({ folders: [{ id: "f1" }] }, { folders: [{ id: "f1" }] })
    ).toEqual([]);
  });

  test("falls back when a namespace or shape cannot be diffed", () => {
    expect(
      diffQueryResults({ folders: [] }, { folders: [], documents: [] })
    ).toBeNull();
    expect(diffQueryResults({ folders: [] }, { folders: "nope" })).toBeNull();
  });
});
