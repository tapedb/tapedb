import { WORKSPACE_ROLE_LEVELS } from "tapedb";
import { defineSchema } from "tapedb";

/**
 * One schema, two artifacts: the engine registry and the client schema are both
 * generated from this object, so they cannot drift.
 */
export const schema = defineSchema({
  entities: {
    boards: {
      name: { type: "string" },
      ownerId: { type: "string", optional: true, indexed: true },
    },
    columns: {
      name: { type: "string" },
      boardId: { type: "string", optional: true, indexed: true },
    },
    tasks: {
      title: { type: "string" },
      done: { type: "boolean", optional: true },
      columnId: { type: "string", optional: true, indexed: true },
    },
  },
  links: [
    {
      apiName: "boardColumns",
      kind: "one-to-many",
      forward: { namespace: "boards", label: "columns", has: "many" },
      reverse: { namespace: "columns", label: "board", has: "one" },
      foreignKey: { namespace: "columns", attribute: "boardId" },
    },
    {
      apiName: "columnTasks",
      kind: "one-to-many",
      forward: { namespace: "columns", label: "tasks", has: "many" },
      reverse: { namespace: "tasks", label: "column", has: "one" },
      foreignKey: { namespace: "tasks", attribute: "columnId" },
    },
  ],
  permissions: {
    boards: {
      // Anyone in the workspace may read; only the owner may edit or delete.
      view: WORKSPACE_ROLE_LEVELS.MEMBER,
      create: WORKSPACE_ROLE_LEVELS.EDITOR,
      update: ({ auth, data }) => data?.ownerId === auth.sub,
      delete: ({ auth, data }) => data?.ownerId === auth.sub,
    },
    columns: {
      view: WORKSPACE_ROLE_LEVELS.MEMBER,
      create: WORKSPACE_ROLE_LEVELS.EDITOR,
      update: WORKSPACE_ROLE_LEVELS.EDITOR,
      delete: WORKSPACE_ROLE_LEVELS.EDITOR,
    },
    tasks: {
      view: WORKSPACE_ROLE_LEVELS.MEMBER,
      create: WORKSPACE_ROLE_LEVELS.EDITOR,
      update: WORKSPACE_ROLE_LEVELS.EDITOR,
      delete: WORKSPACE_ROLE_LEVELS.EDITOR,
    },
  },
});
