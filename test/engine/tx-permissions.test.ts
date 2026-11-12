import { useNdexFixture } from "../fixtures/registry";
useNdexFixture();

import { describe, expect, test } from "bun:test";

import {
  WORKSPACE_ROLE_LEVELS,
  type RoleClaim,
  type WorkspaceRole,
} from "../../src/claims";
import {
  assertOpPermission,
  assertPermission,
  minimumRole,
} from "../../src/engine/tx-permissions";
import { TxError } from "../../src/engine/tx-types";
import type {
  ValidatedDeleteOp,
  ValidatedLinkOp,
  ValidatedValuesOp,
} from "../../src/engine/tx-validate";

function claim(role: WorkspaceRole): RoleClaim {
  return {
    sub: "user-1",
    workspaceId: "workspace-1",
    role,
    exp: Math.floor(Date.now() / 1000) + 60,
    iat: Math.floor(Date.now() / 1000),
  };
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

describe("permissions", () => {
  test("uses view=MEMBER, create/update=EDITOR, delete=MODERATOR defaults", () => {
    expect(minimumRole("folders", "view")).toBe(WORKSPACE_ROLE_LEVELS.MEMBER);
    expect(minimumRole("folders", "create")).toBe(WORKSPACE_ROLE_LEVELS.EDITOR);
    expect(minimumRole("folders", "update")).toBe(WORKSPACE_ROLE_LEVELS.EDITOR);
    expect(minimumRole("folders", "delete")).toBe(
      WORKSPACE_ROLE_LEVELS.MODERATOR
    );
  });

  test("enforces the default matrix", () => {
    const member = claim(WORKSPACE_ROLE_LEVELS.MEMBER);
    expect(() => assertPermission(member, "folders", "view")).not.toThrow();
    expectCode(
      () => assertPermission(member, "folders", "create"),
      "permission_denied"
    );
    expectCode(
      () => assertPermission(member, "folders", "update"),
      "permission_denied"
    );
    expectCode(
      () => assertPermission(member, "folders", "delete"),
      "permission_denied"
    );

    const editor = claim(WORKSPACE_ROLE_LEVELS.EDITOR);
    expect(() => assertPermission(editor, "folders", "create")).not.toThrow();
    expect(() => assertPermission(editor, "folders", "update")).not.toThrow();
    expectCode(
      () => assertPermission(editor, "folders", "delete"),
      "permission_denied"
    );

    const moderator = claim(WORKSPACE_ROLE_LEVELS.MODERATOR);
    expect(() =>
      assertPermission(moderator, "folders", "delete")
    ).not.toThrow();
  });

  test("allows editors to create and delete taskAssignees", () => {
    const editor = claim(WORKSPACE_ROLE_LEVELS.EDITOR);
    expect(() =>
      assertPermission(editor, "taskAssignees", "create")
    ).not.toThrow();
    expect(() =>
      assertPermission(editor, "taskAssignees", "delete")
    ).not.toThrow();

    const member = claim(WORKSPACE_ROLE_LEVELS.MEMBER);
    expectCode(
      () => assertPermission(member, "taskAssignees", "create"),
      "permission_denied"
    );
    expectCode(
      () => assertPermission(member, "taskAssignees", "delete"),
      "permission_denied"
    );
  });

  test("authorizes ops on their namespace and action", () => {
    const editor = claim(WORKSPACE_ROLE_LEVELS.EDITOR);
    const update: ValidatedValuesOp = {
      kind: "update",
      namespace: "folders",
      id: "f",
      values: { name: "Inbox" },
    };
    expect(() => assertOpPermission(editor, update)).not.toThrow();

    const member = claim(WORKSPACE_ROLE_LEVELS.MEMBER);
    expectCode(() => assertOpPermission(member, update), "permission_denied");

    const remove: ValidatedDeleteOp = {
      kind: "delete",
      namespace: "folders",
      id: "f",
    };
    expectCode(() => assertOpPermission(editor, remove), "permission_denied");
    expect(() =>
      assertOpPermission(claim(WORKSPACE_ROLE_LEVELS.MODERATOR), remove)
    ).not.toThrow();
  });

  test("authorizes link/unlink on the FK-owning child namespace", () => {
    const editor = claim(WORKSPACE_ROLE_LEVELS.EDITOR);
    const link: ValidatedLinkOp = {
      kind: "link",
      namespace: "kanbanTasks",
      id: "task-1",
      link: "taskAssigneeLinks",
      targetId: "assignee-1",
      childNamespace: "taskAssignees",
      childId: "assignee-1",
      parentId: "task-1",
      foreignKeyAttribute: "taskId",
      foreignKeyColumn: "task_id",
    };
    expect(() => assertOpPermission(editor, link)).not.toThrow();

    const member = claim(WORKSPACE_ROLE_LEVELS.MEMBER);
    expectCode(() => assertOpPermission(member, link), "permission_denied");
  });

  test("unknown namespaces are denied", () => {
    expectCode(
      () =>
        assertPermission(
          claim(WORKSPACE_ROLE_LEVELS.DEVELOPER),
          "notANamespace",
          "view"
        ),
      "permission_denied"
    );
  });
});
