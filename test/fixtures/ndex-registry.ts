/**
 * Registry mapping InstantDB-style API names to workspace SQLite tables.
 *
 * DDL is owned by Atlas (`migrations/workspace`). This registry is the runtime
 * contract used by query compilation, validation and permissions. Registry
 * tests assert every table and column here exists in the workspace migrations.
 *
 * Mirrors the production schema minus
 * `documentEdits`; Yjs updates live in the document Durable Object.
 */

export type AttributeType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "json"
  | "any";

export type DeleteRule = "CASCADE" | "SET NULL" | "RESTRICT";

export interface AttributeReference {
  table: string;
  column: string;
  onDelete?: DeleteRule;
}

export interface AttributeDefinition {
  type: AttributeType;
  optional?: boolean;
  indexed?: boolean;
  unique?: boolean;
  references?: AttributeReference;
}

export interface NamespaceDefinition {
  apiName: string;
  table: string;
  attributes: Record<string, AttributeDefinition>;
}

export interface OneToManyLink {
  apiName: string;
  kind: "one-to-many";
  forward: { namespace: string; label: string; has: "many" };
  reverse: { namespace: string; label: string; has: "one" };
  foreignKey: { namespace: string; attribute: string };
}

export interface OneToOneLink {
  apiName: string;
  kind: "one-to-one";
  forward: { namespace: string; label: string; has: "one" };
  reverse: { namespace: string; label: string; has: "one" };
  foreignKey: { namespace: string; attribute: string; unique: true };
}

export type LinkDefinition = OneToManyLink | OneToOneLink;

/**
 * Engine-owned tables. `_files` is the file-metadata table; the rest
 * hold migration state, the transaction log, flush/snapshot bookkeeping and
 * engine metadata.
 */
export const ENGINE_TABLES = {
  migrations: "_migrations",
  txLog: "_tx_log",
  txState: "_tx_state",
  flushState: "_flush_state",
  snapshotState: "_snapshot_state",
  engineMeta: "_engine_meta",
  files: "_files",
} as const;

export const NAMESPACES = {
  folders: {
    apiName: "folders",
    table: "folders",
    attributes: {
      name: { type: "string" },
      icon: { type: "string", optional: true },
      color: { type: "string", optional: true },
      order: { type: "number", optional: true },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
      parentId: {
        type: "string",
        optional: true,
        indexed: true,
        references: {
          table: "folders",
          column: "id",
          onDelete: "SET NULL",
        },
      },
    },
  },
  documents: {
    apiName: "documents",
    table: "documents",
    attributes: {
      title: { type: "string" },
      content: { type: "string" },
      type: { type: "string", optional: true },
      showTitleInDocument: { type: "boolean", optional: true },
      showTableOfContents: { type: "boolean", optional: true },
      showCoverPage: { type: "boolean", optional: true },
      coverPageDate: { type: "string", optional: true },
      order: { type: "number", optional: true },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
      folderId: {
        type: "string",
        optional: true,
        indexed: true,
        references: {
          table: "folders",
          column: "id",
          onDelete: "SET NULL",
        },
      },
    },
  },
  blocks: {
    apiName: "blocks",
    table: "blocks",
    attributes: {
      type: { type: "string" },
      content: { type: "string" },
      order: { type: "number" },
      checked: { type: "boolean", optional: true },
      language: { type: "string", optional: true },
      previewMode: { type: "boolean", optional: true },
      documentId: {
        type: "string",
        optional: true,
        indexed: true,
        references: {
          table: "documents",
          column: "id",
          onDelete: "CASCADE",
        },
      },
      parentId: {
        type: "string",
        optional: true,
        indexed: true,
        references: {
          table: "blocks",
          column: "id",
          onDelete: "CASCADE",
        },
      },
    },
  },
  versions: {
    apiName: "versions",
    table: "versions",
    attributes: {
      snapshot: { type: "string" },
      versionNumber: { type: "number" },
      createdAt: { type: "date" },
      documentId: {
        type: "string",
        optional: true,
        indexed: true,
        references: {
          table: "documents",
          column: "id",
          onDelete: "CASCADE",
        },
      },
    },
  },
  embeddings: {
    apiName: "embeddings",
    table: "embeddings",
    attributes: {
      vector: { type: "any" },
      model: { type: "string" },
      blockId: {
        type: "string",
        optional: true,
        indexed: true,
        unique: true,
        references: {
          table: "blocks",
          column: "id",
          onDelete: "CASCADE",
        },
      },
    },
  },
  kanbanBoards: {
    apiName: "kanbanBoards",
    table: "kanban_boards",
    attributes: {
      name: { type: "string" },
      description: { type: "string", optional: true },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
    },
  },
  kanbanSprints: {
    apiName: "kanbanSprints",
    table: "kanban_sprints",
    attributes: {
      name: { type: "string" },
      status: { type: "string", optional: true },
      goal: { type: "string", optional: true },
      startAt: { type: "date", optional: true },
      endAt: { type: "date", optional: true },
      order: { type: "number" },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
      boardId: {
        type: "string",
        optional: true,
        indexed: true,
        references: {
          table: "kanban_boards",
          column: "id",
          onDelete: "CASCADE",
        },
      },
    },
  },
  kanbanColumns: {
    apiName: "kanbanColumns",
    table: "kanban_columns",
    attributes: {
      name: { type: "string" },
      color: { type: "string", optional: true },
      limit: { type: "number", optional: true },
      isDone: { type: "boolean", optional: true },
      order: { type: "number" },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
      boardId: {
        type: "string",
        optional: true,
        indexed: true,
        references: {
          table: "kanban_boards",
          column: "id",
          onDelete: "CASCADE",
        },
      },
    },
  },
  kanbanTasks: {
    apiName: "kanbanTasks",
    table: "kanban_tasks",
    attributes: {
      title: { type: "string" },
      description: { type: "string", optional: true },
      priority: { type: "string", optional: true },
      fibonacci: { type: "number", optional: true },
      status: { type: "string", optional: true },
      tags: { type: "any", optional: true },
      checklist: { type: "any", optional: true },
      order: { type: "number" },
      dueAt: { type: "date", optional: true },
      startAt: { type: "date", optional: true },
      progress: { type: "number", optional: true },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
      columnId: {
        type: "string",
        optional: true,
        indexed: true,
        references: {
          table: "kanban_columns",
          column: "id",
          onDelete: "SET NULL",
        },
      },
      sprintId: {
        type: "string",
        optional: true,
        indexed: true,
        references: {
          table: "kanban_sprints",
          column: "id",
          onDelete: "SET NULL",
        },
      },
    },
  },
  kanbanAttachments: {
    apiName: "kanbanAttachments",
    table: "kanban_attachments",
    attributes: {
      taskId: {
        type: "string",
        indexed: true,
        references: {
          table: "kanban_tasks",
          column: "id",
          onDelete: "RESTRICT",
        },
      },
      objectKey: { type: "string" },
      name: { type: "string" },
      size: { type: "number" },
      contentType: { type: "string" },
      uploadedBy: { type: "string", optional: true },
      createdAt: { type: "date" },
    },
  },
  taskAssignees: {
    apiName: "taskAssignees",
    table: "task_assignees",
    attributes: {
      taskId: {
        type: "string",
        optional: true,
        indexed: true,
        references: {
          table: "kanban_tasks",
          column: "id",
          onDelete: "CASCADE",
        },
      },
      userId: { type: "string", indexed: true },
      createdAt: { type: "date" },
    },
  },
  favorites: {
    apiName: "favorites",
    table: "favorites",
    attributes: {
      type: { type: "string" },
      targetId: { type: "string" },
      order: { type: "number", optional: true },
      createdAt: { type: "date" },
    },
  },
  gitBranches: {
    apiName: "gitBranches",
    table: "git_branches",
    attributes: {
      taskId: {
        type: "string",
        optional: true,
        indexed: true,
        references: {
          table: "kanban_tasks",
          column: "id",
          onDelete: "CASCADE",
        },
      },
      taskTitle: { type: "string" },
      branchName: { type: "string" },
      repositoryId: { type: "string", indexed: true },
      createdBy: { type: "string", indexed: true },
      createdAt: { type: "date" },
      status: { type: "string" },
      commitSha: { type: "string", optional: true },
      url: { type: "string", optional: true },
    },
  },
  pullRequests: {
    apiName: "pullRequests",
    table: "pull_requests",
    attributes: {
      branchId: {
        type: "string",
        optional: true,
        indexed: true,
        references: {
          table: "git_branches",
          column: "id",
          onDelete: "CASCADE",
        },
      },
      taskId: { type: "string", indexed: true },
      prNumber: { type: "number" },
      prTitle: { type: "string" },
      prUrl: { type: "string" },
      status: { type: "string" },
      author: { type: "string" },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
    },
  },
  ciStatus: {
    apiName: "ciStatus",
    table: "ci_status",
    attributes: {
      branchId: {
        type: "string",
        optional: true,
        indexed: true,
        references: {
          table: "git_branches",
          column: "id",
          onDelete: "CASCADE",
        },
      },
      workflowName: { type: "string" },
      status: { type: "string" },
      conclusion: { type: "string", optional: true },
      runNumber: { type: "number" },
      runUrl: { type: "string" },
      startedAt: { type: "date" },
      completedAt: { type: "date", optional: true },
    },
  },
  webcalSubscriptions: {
    apiName: "webcalSubscriptions",
    table: "webcal_subscriptions",
    attributes: {
      name: { type: "string" },
      url: { type: "string" },
      color: { type: "string", optional: true },
      isActive: { type: "boolean", optional: true },
      etag: { type: "string", optional: true },
      lastModified: { type: "string", optional: true },
      lastFetchedAt: { type: "date", optional: true },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
    },
  },
  webcalEvents: {
    apiName: "webcalEvents",
    table: "webcal_events",
    attributes: {
      uid: { type: "string", indexed: true },
      occurrenceKey: { type: "string", indexed: true },
      title: { type: "string" },
      description: { type: "string", optional: true },
      location: { type: "string", optional: true },
      startAt: { type: "date" },
      endAt: { type: "date", optional: true },
      allDay: { type: "boolean", optional: true },
      timezone: { type: "string", optional: true },
      url: { type: "string", optional: true },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
      subscriptionId: {
        type: "string",
        optional: true,
        indexed: true,
        references: {
          table: "webcal_subscriptions",
          column: "id",
          onDelete: "CASCADE",
        },
      },
    },
  },
  canvasElements: {
    apiName: "canvasElements",
    table: "canvas_elements",
    attributes: {
      documentId: {
        type: "string",
        optional: true,
        indexed: true,
        references: {
          table: "documents",
          column: "id",
          onDelete: "CASCADE",
        },
      },
      data: { type: "any" },
      createdAt: { type: "date" },
    },
  },
  moscowDiagrams: {
    apiName: "moscowDiagrams",
    table: "moscow_diagrams",
    attributes: {
      workspaceId: { type: "string", indexed: true },
      documentId: { type: "string", optional: true, indexed: true },
      payload: { type: "any" },
      createdBy: { type: "string" },
      createdAt: { type: "date" },
      updatedAt: { type: "date", optional: true },
    },
  },
  coverPageTemplates: {
    apiName: "coverPageTemplates",
    table: "cover_page_templates",
    attributes: {
      workspaceId: { type: "string", indexed: true },
      name: { type: "string" },
      content: { type: "string" },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
    },
  },
  whiteboardElements: {
    apiName: "whiteboardElements",
    table: "whiteboard_elements",
    attributes: {
      boardId: { type: "string", indexed: true },
      kind: { type: "string" },
      data: { type: "any" },
      z: { type: "number" },
      createdAt: { type: "date" },
      updatedAt: { type: "date", optional: true },
    },
  },
  diagramNodes: {
    apiName: "diagramNodes",
    table: "diagram_nodes",
    attributes: {
      diagramId: { type: "string", indexed: true },
      nodeId: { type: "string" },
      order: { type: "number" },
      type: { type: "string", optional: true },
      shape: { type: "string" },
      label: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
      width: { type: "number", optional: true },
      height: { type: "number", optional: true },
      parentId: { type: "string", optional: true },
      extra: { type: "any", optional: true },
      createdAt: { type: "date" },
      updatedAt: { type: "date", optional: true },
    },
  },
  diagramEdges: {
    apiName: "diagramEdges",
    table: "diagram_edges",
    attributes: {
      diagramId: { type: "string", indexed: true },
      edgeId: { type: "string" },
      order: { type: "number" },
      source: { type: "string" },
      target: { type: "string" },
      sourceHandle: { type: "string", optional: true },
      targetHandle: { type: "string", optional: true },
      type: { type: "string", optional: true },
      label: { type: "string", optional: true },
      extra: { type: "any", optional: true },
      createdAt: { type: "date" },
      updatedAt: { type: "date", optional: true },
    },
  },
  diagramSettings: {
    apiName: "diagramSettings",
    table: "diagram_settings",
    attributes: {
      diagramId: { type: "string", indexed: true, unique: true },
      settings: { type: "any" },
      createdAt: { type: "date" },
      updatedAt: { type: "date", optional: true },
    },
  },
} as const satisfies Record<string, NamespaceDefinition>;

export const LINKS = {
  folderDocuments: {
    apiName: "folderDocuments",
    kind: "one-to-many",
    forward: { namespace: "folders", label: "documents", has: "many" },
    reverse: { namespace: "documents", label: "folder", has: "one" },
    foreignKey: { namespace: "documents", attribute: "folderId" },
  },
  folderChildren: {
    apiName: "folderChildren",
    kind: "one-to-many",
    forward: { namespace: "folders", label: "children", has: "many" },
    reverse: { namespace: "folders", label: "parent", has: "one" },
    foreignKey: { namespace: "folders", attribute: "parentId" },
  },
  documentBlocks: {
    apiName: "documentBlocks",
    kind: "one-to-many",
    forward: { namespace: "documents", label: "blocks", has: "many" },
    reverse: { namespace: "blocks", label: "document", has: "one" },
    foreignKey: { namespace: "blocks", attribute: "documentId" },
  },
  blockChildren: {
    apiName: "blockChildren",
    kind: "one-to-many",
    forward: { namespace: "blocks", label: "children", has: "many" },
    reverse: { namespace: "blocks", label: "parent", has: "one" },
    foreignKey: { namespace: "blocks", attribute: "parentId" },
  },
  documentCanvasElements: {
    apiName: "documentCanvasElements",
    kind: "one-to-many",
    forward: { namespace: "documents", label: "canvasElements", has: "many" },
    reverse: { namespace: "canvasElements", label: "document", has: "one" },
    foreignKey: { namespace: "canvasElements", attribute: "documentId" },
  },
  documentVersions: {
    apiName: "documentVersions",
    kind: "one-to-many",
    forward: { namespace: "documents", label: "versions", has: "many" },
    reverse: { namespace: "versions", label: "document", has: "one" },
    foreignKey: { namespace: "versions", attribute: "documentId" },
  },
  blockEmbeddings: {
    apiName: "blockEmbeddings",
    kind: "one-to-one",
    forward: { namespace: "blocks", label: "embedding", has: "one" },
    reverse: { namespace: "embeddings", label: "block", has: "one" },
    foreignKey: {
      namespace: "embeddings",
      attribute: "blockId",
      unique: true,
    },
  },
  boardColumns: {
    apiName: "boardColumns",
    kind: "one-to-many",
    forward: { namespace: "kanbanBoards", label: "columns", has: "many" },
    reverse: { namespace: "kanbanColumns", label: "board", has: "one" },
    foreignKey: { namespace: "kanbanColumns", attribute: "boardId" },
  },
  boardSprints: {
    apiName: "boardSprints",
    kind: "one-to-many",
    forward: { namespace: "kanbanBoards", label: "sprints", has: "many" },
    reverse: { namespace: "kanbanSprints", label: "board", has: "one" },
    foreignKey: { namespace: "kanbanSprints", attribute: "boardId" },
  },
  columnTasks: {
    apiName: "columnTasks",
    kind: "one-to-many",
    forward: { namespace: "kanbanColumns", label: "tasks", has: "many" },
    reverse: { namespace: "kanbanTasks", label: "column", has: "one" },
    foreignKey: { namespace: "kanbanTasks", attribute: "columnId" },
  },
  sprintTasks: {
    apiName: "sprintTasks",
    kind: "one-to-many",
    forward: { namespace: "kanbanSprints", label: "tasks", has: "many" },
    reverse: { namespace: "kanbanTasks", label: "sprint", has: "one" },
    foreignKey: { namespace: "kanbanTasks", attribute: "sprintId" },
  },
  taskGitBranches: {
    apiName: "taskGitBranches",
    kind: "one-to-many",
    forward: { namespace: "kanbanTasks", label: "branches", has: "many" },
    reverse: { namespace: "gitBranches", label: "task", has: "one" },
    foreignKey: { namespace: "gitBranches", attribute: "taskId" },
  },
  branchPullRequests: {
    apiName: "branchPullRequests",
    kind: "one-to-many",
    forward: { namespace: "gitBranches", label: "pullRequests", has: "many" },
    reverse: { namespace: "pullRequests", label: "branch", has: "one" },
    foreignKey: { namespace: "pullRequests", attribute: "branchId" },
  },
  branchCiStatus: {
    apiName: "branchCiStatus",
    kind: "one-to-many",
    forward: { namespace: "gitBranches", label: "ciStatuses", has: "many" },
    reverse: { namespace: "ciStatus", label: "branch", has: "one" },
    foreignKey: { namespace: "ciStatus", attribute: "branchId" },
  },
  taskAssigneeLinks: {
    apiName: "taskAssigneeLinks",
    kind: "one-to-many",
    forward: { namespace: "kanbanTasks", label: "taskAssignees", has: "many" },
    reverse: { namespace: "taskAssignees", label: "task", has: "one" },
    foreignKey: { namespace: "taskAssignees", attribute: "taskId" },
  },
  webcalSubscriptionEvents: {
    apiName: "webcalSubscriptionEvents",
    kind: "one-to-many",
    forward: { namespace: "webcalSubscriptions", label: "events", has: "many" },
    reverse: { namespace: "webcalEvents", label: "subscription", has: "one" },
    foreignKey: { namespace: "webcalEvents", attribute: "subscriptionId" },
  },
} as const satisfies Record<string, LinkDefinition>;

export type NamespaceApiName = keyof typeof NAMESPACES;
export type LinkApiName = keyof typeof LINKS;

export function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

export function columnFor(
  namespace: NamespaceDefinition,
  attribute: string
): string | undefined {
  return namespace.attributes[attribute] ? toSnakeCase(attribute) : undefined;
}

export function findNamespace(
  apiName: string
): NamespaceDefinition | undefined {
  return (NAMESPACES as Record<string, NamespaceDefinition>)[apiName];
}

export function tableFor(apiName: string): string | undefined {
  return findNamespace(apiName)?.table;
}

export function namespaceTables(): string[] {
  return Object.values(NAMESPACES).map((namespace) => namespace.table);
}

export function allWorkspaceTables(): string[] {
  return [...Object.values(ENGINE_TABLES), ...namespaceTables()];
}
