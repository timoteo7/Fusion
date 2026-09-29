/*
FNXC:NodeWorktreeIsolation 2026-07-25-22:10 (no lane runs in the shared checkout — regression):
Operator requirement: Plan Review, Code Review, and every other node run in the TASK-SPECIFIC worktree;
the shared main checkout is for merge only. Before this, read-only graph gates fell back to
`this.rootDir` because a pre-execution task has no worktree yet. That is what let two tasks share one
path (the reported FN-1398/FN-1403 Plan Review session collision) and what let reviewers read a checkout
that other tasks and the operator mutate underneath them.

Invariant under test across the node surfaces that previously degraded to the root:
 - Plan Review (no worktree yet) acquires and runs in a task worktree;
 - a custom read-only gate (no worktree yet) does the same — this is not Plan-Review-special;
 - an existing usable worktree is REUSED, not re-acquired;
 - workspace Plan Review acquires every configured child checkout and runs from the task directory.
*/
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TaskDetail } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedExecSync,
  mockedExistsSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const ROOT = "/tmp/test";

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  const now = new Date().toISOString();
  return {
    id: "FN-1403",
    title: "Isolation",
    description: "Desc",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    worktree: undefined,
    branch: undefined,
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

const PLAN_REVIEW_NODE = {
  id: "plan-review-step",
  kind: "prompt",
  config: { name: "Plan Review", prompt: "Review the plan.", toolMode: "readonly", reviewKind: "plan" },
};
const CUSTOM_READONLY_GATE = {
  id: "custom-gate",
  kind: "prompt",
  config: { name: "Custom Gate", prompt: "Check something.", toolMode: "readonly" },
};

describe("every workflow node runs in the task worktree, never the shared checkout", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockReturnValue("" as any);
  });

  it.each([
    ["Plan Review", PLAN_REVIEW_NODE],
    ["a custom read-only gate", CUSTOM_READONLY_GATE],
  ])("acquires a task worktree for %s when the task has none", async (_label, node) => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    mockedExistsSync.mockReturnValue(false);

    const captured: { worktreePath?: string } = {};
    vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
      captured.worktreePath = args[2];
      return { success: true, output: "APPROVE" };
    });

    const live = makeTask();
    store.getTask.mockResolvedValue(live as any);
    await (executor as any).runGraphCustomNode(node, live, { reviewerInlineFixes: false }, undefined);

    expect(captured.worktreePath).not.toBe(ROOT);
    // FN-258 pins native worktrees to `.fusion/worktrees/<taskId>`; the older generated
    // `.worktrees/<name>` shape no longer describes where a node runs.
    expect(captured.worktreePath).toBe(`${ROOT}/.fusion/worktrees/fn-1403`);
  });

  it("reuses an existing usable worktree instead of acquiring another", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    const existing = `${ROOT}/.worktrees/existing`;
    mockedExistsSync.mockReturnValue(true);

    const acquireSpy = vi.spyOn(executor as any, "ensureGraphCustomNodeWorktree");
    const captured: { worktreePath?: string } = {};
    vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
      captured.worktreePath = args[2];
      return { success: true, output: "APPROVE" };
    });

    const live = makeTask({ worktree: existing, branch: "fusion/fn-1403" });
    store.getTask.mockResolvedValue(live as any);
    await (executor as any).runGraphCustomNode(PLAN_REVIEW_NODE, live, {}, undefined);

    expect(captured.worktreePath).toBe(existing);
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  it("uses a task directory and workspace boundary for workspace Plan Review", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    (executor as any).workspaceConfig = { repos: ["apps/web"] };
    mockedExistsSync.mockReturnValue(true);

    const acquiredPath = `${ROOT}/.fusion/worktrees/fn-1403/apps/web`;
    const acquiredTask = makeTask({
      workspaceWorktrees: { "apps/web": { worktreePath: acquiredPath, branch: "fusion/fn-1403-apps-web" } },
    });
    const acquireSpy = vi.spyOn(executor as any, "ensureGraphCustomNodeWorktree").mockResolvedValue(acquiredTask);
    const captured: { worktreePath?: string; boundary?: unknown } = {};
    vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
      captured.worktreePath = args[2];
      captured.boundary = args[5]?.sessionBoundary;
      return { success: true, output: "APPROVE" };
    });

    const live = makeTask();
    store.getTask.mockResolvedValueOnce(live as any).mockResolvedValueOnce(live as any).mockResolvedValue(acquiredTask as any);
    await (executor as any).runGraphCustomNode(PLAN_REVIEW_NODE, live, {}, undefined);

    expect(captured.worktreePath).toBe(`${ROOT}/.fusion/worktrees/fn-1403`);
    expect(captured.boundary).toMatchObject({ kind: "workspace-task-dir", writableRoot: `${ROOT}/.fusion/worktrees/fn-1403`, projectRoot: ROOT });
    expect(acquireSpy).toHaveBeenCalledTimes(1);
  });
});

/*
FNXC:AcquisitionPathInvariant 2026-09-25-00:00 (FUSI-032, class A):
The 5-of-12 `missing-mock-call-other` seed failures were one defect with two
leak shapes: a test's `existsSync` override returns TRUTHY for the task-pinned
acquisition path, so acquisition routes into warm-reuse instead of fresh
acquisition. `resetExecutorMocks()`'s documented default makes any path containing a
`worktrees/` segment read absent, which keeps acquisition on the fresh branch.

The invariant owned here is BEHAVIORAL, not textual: a fixture default must not
be able to SILENTLY change which acquisition branch runs. Part 1 pins the fresh
branch (it is reached and lands on the pinned path). Part 2 proves that making
the pinned path truthy — in EITHER leak shape — observably changes that outcome,
so a future silent default flip is caught. Part 2 is the ratchet: it only means
something if the two branches actually differ, which is why it asserts a
*difference* rather than re-asserting the happy path.
*/
describe("class A — a fixture existsSync default cannot silently divert task-worktree acquisition", () => {
  const PINNED = `${ROOT}/.fusion/worktrees/fn-1403`;

  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockReturnValue("" as any);
  });

  it("resetExecutorMocks() makes the task-pinned acquisition path read absent", () => {
    // The documented acquisition default is `! /[\\/]worktrees[\\/]/`, so any path containing a
    // `worktrees/` SEGMENT reads absent. The FN-258 pinned path matches that segment. If this ever
    // changes, the whole class-A reasoning below changes with it, so pin it explicitly.
    expect(mockedExistsSync(PINNED)).toBe(false);
    expect(mockedExistsSync(`${ROOT}/worktrees/fn-1403`)).toBe(false);
  });

  it.each([
    ["coding prompt", PLAN_REVIEW_NODE],
    ["custom read-only gate", CUSTOM_READONLY_GATE],
  ])("fresh acquisition is reached and the %s lands on the pinned task path", async (_label, node) => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    // Acquisition-path default: nothing on disk yet, so the node must acquire one.
    const captured: { worktreePath?: string } = {};
    vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
      captured.worktreePath = args[2];
      return { success: true, output: "APPROVE" };
    });

    const live = makeTask();
    store.getTask.mockResolvedValue(live as any);
    await (executor as any).runGraphCustomNode(node, live, { reviewerInlineFixes: false }, undefined);

    expect(captured.worktreePath).toBe(PINNED);
  });

  it.each([
    // Leak shape 1: a file-level absolute-truthy override.
    ["absolute-truthy override", () => mockedExistsSync.mockReturnValue(true)],
    // Leak shape 2: a bare `path !== "<x>"` predicate, which is truthy for the pinned path.
    ["bare `path !== x` predicate", () => mockedExistsSync.mockImplementation((p: unknown) => p !== "/tmp/unrelated")],
  ])("a truthy pinned path from a %s is a LOUD branch change, never a silent warm-reuse", async (_label, leak) => {
    leak();
    expect(mockedExistsSync(PINNED)).toBe(true); // the leak really landed

    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    const captured: { worktreePath?: string } = {};
    vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
      captured.worktreePath = args[2];
      return { success: true, output: "APPROVE" };
    });

    const live = makeTask();
    store.getTask.mockResolvedValue(live as any);

    // With the pinned path reading present, warm-reuse cannot confirm a branch: the real
    // `getRegisteredWorktreeBranches` probe returns [] on the non-git test rootDir, so
    // `pinnedWorktreeBranchMatches` refuses. That refusal is the POINT: the mis-default is
    // loud (the run fails) rather than silently landing the node somewhere else. A silent
    // success on a NON-acquired path here would mean the default flip went unnoticed.
    await expect(
      (executor as any).runGraphCustomNode(PLAN_REVIEW_NODE, live, { reviewerInlineFixes: false }, undefined),
    ).rejects.toThrow(/pinned branch probe returned no registered worktrees/);
    expect(captured.worktreePath).toBeUndefined();
  });
});
