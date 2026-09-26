import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  existsSyncMock,
  rmdirSyncMock,
  removeWorktreeMock,
  ActiveSessionWorktreeRemovalErrorMock,
} = vi.hoisted(() => {
  class ActiveSessionWorktreeRemovalErrorMock extends Error {
    constructor() {
      super("cannot remove active-session worktree");
      this.name = "ActiveSessionWorktreeRemovalError";
    }
  }
  return {
    existsSyncMock: vi.fn(),
    rmdirSyncMock: vi.fn(),
    removeWorktreeMock: vi.fn(),
    ActiveSessionWorktreeRemovalErrorMock,
  };
});

vi.mock("node:fs", () => ({ existsSync: existsSyncMock, rmdirSync: rmdirSyncMock }));
vi.mock("../worktree/worktree-backend.js", () => ({
  ActiveSessionWorktreeRemovalError: ActiveSessionWorktreeRemovalErrorMock,
  RemovalReason: { CompletionLandedCleanup: "completion-landed-cleanup" },
  removeWorktree: removeWorktreeMock,
}));

import { POST_MERGE_VERIFICATION_GROUP_ID } from "@fusion/core";
import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";
import { cleanupLandedTaskWorktree, cleanupLandedWorkspaceTaskWorktrees } from "../merge/post-landing-worktree-cleanup.js";

/**
 * FNXC:PostMergeEvidenceFake 2026-09-26-06:05:
 * FN-9370 made a confirmed merge NOT sufficient to finalize. `getRequiredPostMergeEvidenceBlocker`
 * (packages/core/src/merge/confirmed-merge-reconciliation.ts:40) refuses completion while an enabled
 * gate-mode post-merge group has no APPROVE result. This fake's store exposes `getTaskWorkflowSelection`,
 * which is the guard's own trigger, and the built-in group is `defaultOn: true` — so a task with no
 * post-merge evidence is legitimately blocked. That is correct shipped behaviour, so the FIXTURE declares
 * its evidence position rather than the assertion being relaxed.
 *
 * Option (a) from the spec: declare the evidence satisfied, which keeps the guard on the exercised path
 * and proves finalization still completes once evidence exists. Option (b) (declare no gate enabled) would
 * have exercised only the guard's early-out and left FN-9370 untested in this file.
 *
 * The group id is imported from @fusion/core rather than pasted, so a future rename of the built-in
 * post-merge group cannot silently strand this fake on a literal.
 */
const APPROVED_POST_MERGE_EVIDENCE = [
  {
    workflowStepId: POST_MERGE_VERIFICATION_GROUP_ID,
    workflowStepName: "Post-merge verification",
    phase: "post-merge" as const,
    source: "optional-group" as const,
    status: "passed" as const,
    verdict: "APPROVE" as const,
  },
];

function createFinalizationStore(options: { column?: string; worktree?: string | null } = {}) {
  const task: any = {
    id: "FN-251",
    column: options.column ?? "in-review",
    status: null,
    error: null,
    blockedBy: null,
    overlapBlockedBy: null,
    mergeRetries: 0,
    worktree: options.worktree === undefined ? "/repo/.worktrees/fn-251" : options.worktree,
    steps: [],
    /* FNXC:PostMergeEvidenceFake 2026-09-26-06:05: an explicit enable list keeps the fixture's
       position independent of the built-in `defaultOn` flag; `undefined` would also enable the gate
       today, but only by falling back to a default that a future edit could change. */
    enabledWorkflowSteps: [POST_MERGE_VERIFICATION_GROUP_ID],
    workflowStepResults: [...APPROVED_POST_MERGE_EVIDENCE],
    mergeDetails: { mergeConfirmed: true, commitSha: "abc123" },
  };
  const callOrder: string[] = [];
  const updateTask = vi.fn(async (_id: string, patch: Record<string, unknown>) => {
    if (patch.worktree === null) callOrder.push("cleanup");
    Object.assign(task, patch);
    return task;
  });
  /* FNXC:PostMergeEvidenceFence 2026-09-26-06:05: accepts the third MoveTaskOptions argument the
     finalizer's conditional move passes; the existing assertions below already expect it. */
  const moveTask = vi.fn(async (_id: string, column: string, _options?: unknown) => {
    callOrder.push("move");
    task.column = column;
    return task;
  });
  /*
  FNXC:PostMergeEvidenceFence 2026-09-26-06:05:
  FN-9370 moved terminal finalization onto a conditional fence: `moveTaskIf` re-reads the live row,
  re-evaluates the post-merge evidence guard under that read, and moves only if the predicate passes.
  This fake had only `moveTask`, so the finalizer threw `store.moveTaskIf is not a function` and every
  completion path in this file failed before asserting anything. Modelled on the real contract in
  packages/core/src/task-store/moves.ts:284 (`{ task, moved }` is the applied/skip signal; a refused
  predicate returns `moved: false` WITHOUT moving and WITHOUT recording a call). The predicate is
  awaited and honoured rather than stubbed true, so the refusal cases below genuinely exercise the fence.
  */
  const moveTaskIf = vi.fn(async (
    _id: string,
    toColumn: string,
    predicate: (live: unknown) => boolean | Promise<boolean>,
    options?: unknown,
  ) => {
    if (!await predicate(task) || task.column === toColumn) {
      return { task, moved: false };
    }
    return { task: await moveTask(_id, toColumn, options), moved: true };
  });
  /*
  FNXC:PostMergeEvidenceFence 2026-09-26-06:05:
  The post-move reconciliation is applied through `updateTaskAtomic` (read -> updater -> apply). The
  updater is run for real against the live row; a null/undefined patch is a no-op, matching
  updateTaskAtomicImpl in packages/core/src/task-store/task-mutation-ops.ts:380.
  */
  const updateTaskAtomic = vi.fn(async (
    _id: string,
    updater: (current: unknown) => Record<string, unknown> | null | undefined | Promise<Record<string, unknown> | null | undefined>,
  ) => {
    const updates = await updater(task);
    if (!updates || Object.values(updates).every((value) => value === undefined)) return task;
    Object.assign(task, updates);
    return task;
  });
  const logEntry = vi.fn().mockResolvedValue(task);
  return {
    task,
    callOrder,
    updateTask,
    moveTask,
    moveTaskIf,
    updateTaskAtomic,
    logEntry,
    store: {
      getTask: vi.fn(async () => task),
      getSettings: vi.fn(async () => ({})),
      getTaskWorkflowSelection: vi.fn(() => undefined),
      getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
      getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
      updateTask,
      moveTask,
      moveTaskIf,
      updateTaskAtomic,
      logEntry,
      recordRunAuditEvent: vi.fn(),
    },
  };
}

function createStore(options: { withSettings?: boolean } = {}) {
  const updateTask = vi.fn().mockResolvedValue({ id: "FN-251" });
  const logEntry = vi.fn().mockResolvedValue({ id: "FN-251" });
  const getSettings = vi.fn().mockResolvedValue({});
  return {
    store: {
      updateTask,
      logEntry,
      ...(options.withSettings === false ? {} : { getSettings }),
    },
    updateTask,
    logEntry,
    getSettings,
  };
}

describe("cleanupLandedTaskWorktree", () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
    rmdirSyncMock.mockReset();
    removeWorktreeMock.mockReset();
    removeWorktreeMock.mockResolvedValue({ removed: true, classification: "removed" });
  });

  it.each([
    { name: "has no worktree pointer", worktreePath: undefined, rootDir: "/repo" },
    { name: "has no root directory", worktreePath: "/repo/.worktrees/fn-251", rootDir: undefined },
  ])("returns nothing-to-remove when it $name", async ({ worktreePath, rootDir }) => {
    const { store, updateTask } = createStore();

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath,
      rootDir,
      source: "test",
    })).resolves.toEqual({ outcome: "nothing-to-remove", removed: false });

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("clears a stale worktree pointer when the path is already absent", async () => {
    const { store, updateTask } = createStore();
    existsSyncMock.mockReturnValue(false);

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "test",
    })).resolves.toEqual({ outcome: "nothing-to-remove", removed: false });

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledWith("FN-251", { worktree: null });
  });

  it("clears only the worktree pointer after removal", async () => {
    const { store, updateTask, getSettings } = createStore();
    const fence = { assertOwned: vi.fn() };

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      landedSha: "abc123",
      source: "workflow-graph-merge-finalize",
      fence,
    })).resolves.toEqual({ outcome: "removed", removed: true });

    expect(getSettings).toHaveBeenCalledOnce();
    expect(removeWorktreeMock).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-251",
      taskId: "FN-251",
      reason: "completion-landed-cleanup",
      postLandingProof: { landedSha: "abc123", source: "workflow-graph-merge-finalize" },
    }));
    expect(fence.assertOwned).toHaveBeenCalledWith("finalization");
    expect(updateTask).toHaveBeenCalledWith("FN-251", { worktree: null });
  });

  it("does not report removal until a rejected pointer clear converges", async () => {
    const { store, updateTask, logEntry } = createStore();
    updateTask.mockRejectedValueOnce(new Error("transient task-store failure"));

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "test",
    })).resolves.toEqual({ outcome: "nothing-to-remove", removed: false });

    expect(logEntry).toHaveBeenCalledWith(
      "FN-251",
      "Post-landing worktree cleanup pointer clear pending",
      expect.stringContaining("/repo/.worktrees/fn-251"),
    );
    expect(removeWorktreeMock).toHaveBeenCalledOnce();

    existsSyncMock.mockReturnValue(false);
    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "self-healing-completion-convergence",
    })).resolves.toEqual({ outcome: "nothing-to-remove", removed: false });

    expect(removeWorktreeMock).toHaveBeenCalledOnce();
    expect(updateTask).toHaveBeenCalledTimes(2);
    expect(updateTask).toHaveBeenLastCalledWith("FN-251", { worktree: null });
  });

  it("keeps an active-session worktree while recording the preservation", async () => {
    const { store, updateTask, logEntry } = createStore();
    removeWorktreeMock.mockRejectedValueOnce(new ActiveSessionWorktreeRemovalErrorMock());

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "test",
    })).resolves.toEqual({
      outcome: "preserved-active-session",
      removed: false,
      preservedReason: "active-session",
    });

    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith(
      "FN-251",
      "Post-landing worktree cleanup preserved",
      expect.stringContaining("/repo/.worktrees/fn-251: active-session"),
    );
  });

  it.each([
    {
      name: "deliverable content",
      error: new Error("preserving /repo/.worktrees/fn-251: uncommitted or ignored content present"),
      outcome: "preserved-deliverable",
      preservedReason: "deliverable",
    },
    {
      name: "an unverifiable checkout",
      error: new Error("preserving /repo/.worktrees/fn-251: status probe failed (broken registration)"),
      outcome: "preserved-unverifiable",
      preservedReason: "unverifiable",
    },
  ])("keeps $name and writes a durable log entry", async ({ error, outcome, preservedReason }) => {
    const { store, updateTask, logEntry } = createStore();
    removeWorktreeMock.mockRejectedValueOnce(error);

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "test",
    })).resolves.toEqual({ outcome, removed: false, preservedReason });

    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith(
      "FN-251",
      "Post-landing worktree cleanup preserved",
      expect.stringContaining(`/repo/.worktrees/fn-251: ${preservedReason}`),
    );
  });

  it.each([
    "workflow-graph-merge-finalize",
    "merge-confirmed-fast-path",
    "self-healing",
    "direct-ai-merge",
  ])("cleans before the complete-column move for %s", async (source) => {
    const { store, task, callOrder, updateTask, moveTask } = createFinalizationStore();
    removeWorktreeMock.mockImplementationOnce(async () => {
      callOrder.push("remove");
      return { removed: true, classification: "removed" };
    });

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: source as never,
    });

    expect(result.outcome).toBe("done");
    expect(callOrder).toEqual(expect.arrayContaining(["remove", "cleanup", "move"]));
    expect(callOrder.indexOf("remove")).toBeLessThan(callOrder.indexOf("move"));
    expect(callOrder.indexOf("cleanup")).toBeLessThan(callOrder.indexOf("move"));
    expect(updateTask).toHaveBeenCalledWith(task.id, { worktree: null });
    expect(moveTask).toHaveBeenCalledWith(task.id, "done", expect.any(Object));
    expect(task.worktree).toBeNull();
  });

  it.each([
    new Error("preserving /repo/.worktrees/fn-251: uncommitted or ignored content present"),
    new Error("preserving /repo/.worktrees/fn-251: status probe failed (broken registration)"),
  ])("finalizes a durable landing when cleanup preserves content", async (error) => {
    const { store, task, moveTask } = createFinalizationStore();
    removeWorktreeMock.mockRejectedValueOnce(error);

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result.outcome).toBe("done");
    expect(moveTask).toHaveBeenCalledWith(task.id, "done", expect.any(Object));
    expect(task.worktree).toBe("/repo/.worktrees/fn-251");
  });

  it("skips cleanup without a root directory but still completes", async () => {
    const { store, task, moveTask } = createFinalizationStore();

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      source: "workflow-graph-merge-finalize",
    });

    expect(result.outcome).toBe("done");
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(moveTask).toHaveBeenCalledWith(task.id, "done", expect.any(Object));
  });

  it("does no git work for a workspace-shaped task without a singular worktree", async () => {
    const { store, task, moveTask } = createFinalizationStore({ worktree: null });
    task.workspaceWorktrees = [{ repoRelPath: "packages/a", worktreePath: "/repo/.worktrees/a" }];

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result.outcome).toBe("done");
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(moveTask).toHaveBeenCalledWith(task.id, "done", expect.any(Object));
  });

  it("keeps an active-session worktree while still moving the task to complete", async () => {
    const { store, task, moveTask, logEntry } = createFinalizationStore();
    removeWorktreeMock.mockRejectedValueOnce(new ActiveSessionWorktreeRemovalErrorMock());

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result.outcome).toBe("done");
    expect(task.worktree).toBe("/repo/.worktrees/fn-251");
    expect(moveTask).toHaveBeenCalledWith(task.id, "done", expect.any(Object));
    expect(logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("active-session"));
  });

  it("still completes when clearing a removed worktree pointer fails", async () => {
    const { store, task, updateTask, moveTask, logEntry } = createFinalizationStore();
    const update = updateTask.getMockImplementation()!;
    let rejectPointerClear = true;
    updateTask.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
      if (patch.worktree === null && rejectPointerClear) {
        rejectPointerClear = false;
        throw new Error("transient task-store failure");
      }
      return await update(id, patch);
    });

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result.outcome).toBe("done");
    expect(task.worktree).toBe("/repo/.worktrees/fn-251");
    expect(moveTask).toHaveBeenCalledWith(task.id, "done", expect.any(Object));
    expect(logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("pointer is pending"));
  });

  it("reclaims an already-complete task through the convergence path", async () => {
    const { store, task, moveTask, updateTask } = createFinalizationStore({ column: "done" });

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result.outcome).toBe("already-done");
    expect(updateTask).toHaveBeenCalledWith(task.id, { worktree: null });
    expect(moveTask).not.toHaveBeenCalled();
  });

  /*
  FNXC:PostMergeEvidenceGuard 2026-09-26-06:05:
  FN-9370's guard is the reason every case above now carries approved post-merge evidence. Without an
  assertion of its REFUSAL path, a future change that disabled or short-circuited the guard would leave
  this file fully green while merged work reached `done` without the required post-landing Full Suite
  evidence. This case is the guard's own coverage, and it is the one place the fake is deliberately
  left in the shape the spec called incomplete.
  */
  it("refuses to finalize while an enabled post-merge gate has not approved", async () => {
    const { store, task, moveTask, updateTask } = createFinalizationStore();
    task.workflowStepResults = [];

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result.outcome).toBe("blocked");
    expect(result.reason).toBe(
      `required post-merge evidence gate '${POST_MERGE_VERIFICATION_GROUP_ID}' has not reported`,
    );
    // A refused finalization must not half-apply: no completion move, no worktree pointer clear.
    expect(moveTask).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalledWith(task.id, { worktree: null });
    expect(task.column).toBe("in-review");
  });

  it("refuses to finalize when the post-merge gate reported a non-approving verdict", async () => {
    const { store, task, moveTask } = createFinalizationStore();
    task.workflowStepResults = [
      { ...APPROVED_POST_MERGE_EVIDENCE[0], verdict: "REVISE" },
    ];

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result.outcome).toBe("blocked");
    expect(result.reason).toBe(
      `required post-merge evidence gate '${POST_MERGE_VERIFICATION_GROUP_ID}' is not approved`,
    );
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("refuses to finalize when the post-merge gate itself failed", async () => {
    const { store, task, moveTask } = createFinalizationStore();
    task.workflowStepResults = [
      { ...APPROVED_POST_MERGE_EVIDENCE[0], status: "failed" },
    ];

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result.outcome).toBe("blocked");
    expect(result.reason).toBe(
      `required post-merge evidence gate '${POST_MERGE_VERIFICATION_GROUP_ID}' is not approved`,
    );
    expect(moveTask).not.toHaveBeenCalled();
  });

  /*
  FNXC:PostMergeEvidenceGuard 2026-09-26-06:05:
  An explicitly DISABLED gate is not required evidence. This is the boundary case of the guard's
  `isWorkflowOptionalGroupEnabled` check and is distinct from option (b) above: the default fixture
  keeps the gate ENABLED and approved, while this case proves that a task which never opted in is not
  blocked by a gate it does not owe evidence for.
  */
  it("finalizes without post-merge evidence when the gate was explicitly disabled", async () => {
    const { store, task, moveTask } = createFinalizationStore();
    task.enabledWorkflowSteps = [];
    task.workflowStepResults = [];

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result.outcome).toBe("done");
    expect(moveTask).toHaveBeenCalledWith(task.id, "done", expect.any(Object));
  });

  it("accepts APPROVE_WITH_NOTES as satisfying the post-merge gate", async () => {
    const { store, task, moveTask } = createFinalizationStore();
    task.workflowStepResults = [
      { ...APPROVED_POST_MERGE_EVIDENCE[0], verdict: "APPROVE_WITH_NOTES" },
    ];

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result.outcome).toBe("done");
    expect(moveTask).toHaveBeenCalledWith(task.id, "done", expect.any(Object));
  });

  it("uses empty settings when a minimal store has no settings reader", async () => {
    const { store, getSettings } = createStore({ withSettings: false });

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "test",
    })).resolves.toEqual({ outcome: "removed", removed: true });

    expect(getSettings).not.toHaveBeenCalled();
    expect(removeWorktreeMock).toHaveBeenCalledWith(expect.objectContaining({ settings: {} }));
  });
});

describe("cleanupLandedWorkspaceTaskWorktrees", () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
    rmdirSyncMock.mockReset();
    removeWorktreeMock.mockReset();
    removeWorktreeMock.mockResolvedValue({ removed: true, classification: "removed" });
  });

  function workspaceTask(workspaceWorktrees: Record<string, { worktreePath: string; branch: string }>) {
    return { id: "FN-268", workspaceWorktrees } as any;
  }

  it("proof-cleans every repository once and retires the empty task directory", async () => {
    const { store } = createStore();
    const task = workspaceTask({
      api: { worktreePath: "/workspace/.fusion/worktrees/fn-268/api", branch: "fusion/fn-268" },
      "apps/web": { worktreePath: "/workspace/.fusion/worktrees/fn-268/apps/web", branch: "fusion/fn-268" },
    });

    await expect(cleanupLandedWorkspaceTaskWorktrees({
      store: store as never,
      task,
      workspaceRootDir: "/workspace",
      landedShas: { api: "api-sha", "apps/web": "web-sha" },
      source: "workspace-finalize",
    })).resolves.toEqual(expect.objectContaining({
      removedRepoRels: ["api", "apps/web"],
      preserved: [],
      taskDirectoryRemoved: true,
      removed: true,
    }));

    expect(removeWorktreeMock).toHaveBeenCalledTimes(2);
    expect(removeWorktreeMock).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: "/workspace/api",
      postLandingProof: { landedSha: "api-sha", source: "workspace-finalize" },
    }));
    expect(removeWorktreeMock).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: "/workspace/apps/web",
      postLandingProof: { landedSha: "web-sha", source: "workspace-finalize" },
    }));
    expect(rmdirSyncMock).toHaveBeenCalledWith("/workspace/.fusion/worktrees/fn-268");
  });

  it("preserves active and deliverable checkout paths without retiring their task directory", async () => {
    const { store, logEntry } = createStore();
    const task = workspaceTask({
      api: { worktreePath: "/workspace/.fusion/worktrees/fn-268/api", branch: "fusion/fn-268" },
      web: { worktreePath: "/workspace/.fusion/worktrees/fn-268/web", branch: "fusion/fn-268" },
    });
    removeWorktreeMock.mockRejectedValueOnce(new Error("preserving /workspace/.fusion/worktrees/fn-268/api: uncommitted content present"));
    removeWorktreeMock.mockRejectedValueOnce(new ActiveSessionWorktreeRemovalErrorMock());

    const result = await cleanupLandedWorkspaceTaskWorktrees({
      store: store as never,
      task,
      workspaceRootDir: "/workspace",
      source: "workspace-finalize",
    });

    expect(result).toEqual(expect.objectContaining({ taskDirectoryRemoved: false, removed: false }));
    expect(result.preserved).toEqual(expect.arrayContaining([
      expect.objectContaining({ repoRel: "api", reason: "deliverable" }),
      expect.objectContaining({ repoRel: "web", reason: "active-session" }),
    ]));
    expect(rmdirSyncMock).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith("FN-268", "Post-landing worktree cleanup preserved", expect.stringContaining("deliverable"));
  });

  it("settles absent paths and removes a duplicate recorded path only once", async () => {
    const { store } = createStore();
    const shared = "/workspace/.fusion/worktrees/fn-268/shared";
    const task = workspaceTask({
      api: { worktreePath: shared, branch: "fusion/fn-268" },
      web: { worktreePath: shared, branch: "fusion/fn-268" },
      absent: { worktreePath: "/workspace/.fusion/worktrees/fn-268/absent", branch: "fusion/fn-268" },
    });
    existsSyncMock.mockImplementation((path: string) => path !== "/workspace/.fusion/worktrees/fn-268/absent");

    const result = await cleanupLandedWorkspaceTaskWorktrees({
      store: store as never,
      task,
      workspaceRootDir: "/workspace",
      source: "workspace-finalize",
    });

    expect(removeWorktreeMock).toHaveBeenCalledTimes(1);
    expect(result.removedRepoRels).toEqual(["api", "web"]);
    expect(result.preserved).toEqual([]);
    expect(result.taskDirectoryRemoved).toBe(true);
  });

  it("does not remove a legacy-layout task directory", async () => {
    const { store } = createStore();
    const task = workspaceTask({
      api: { worktreePath: "/workspace/api/.worktrees/fn-268", branch: "fusion/fn-268" },
    });

    const result = await cleanupLandedWorkspaceTaskWorktrees({
      store: store as never,
      task,
      workspaceRootDir: "/workspace",
      source: "workspace-finalize",
    });

    expect(result).toEqual(expect.objectContaining({ removedRepoRels: ["api"], taskDirectoryRemoved: false, removed: true }));
    expect(rmdirSyncMock).not.toHaveBeenCalled();
  });
});
