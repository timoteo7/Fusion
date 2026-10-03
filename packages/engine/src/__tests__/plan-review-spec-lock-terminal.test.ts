import { describe, expect, it, vi } from "vitest";
import type { Task, TaskDetail, WorkflowIr, WorkflowStepResult } from "@fusion/core";
import { PLAN_LOCK_UNAVAILABLE_DIAGNOSTIC, PLAN_REVIEW_GROUP_ID } from "@fusion/core";
import "./executor-test-helpers.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { WorkflowGraphExecutor, PLAN_LOCK_UNAVAILABLE_DIAGNOSTIC_CONTEXT_KEY, PLAN_LOCK_UNAVAILABLE_HOLD_VALUE } from "../workflows/workflow-graph-executor.js";
import { isPlanLockUnavailableDiagnostic } from "../errors/transient-error-detector.js";

/*
FNXC:PlanReviewReplan 2026-09-30-15:33 (FUSI-029):
FUSI-025 measured a non-mission task whose plan was approved 20 times in ~67 min (~4.7 min apart),
each cycle a full LLM session, with `error` and `planReviewReplanCount` both left untouched. These
tests pin the terminal behavior that stops it. The symptom is a LOOP, so the assertions here are
about what does NOT happen (no fix request, no fabricated REVISE, no replan traversal, one
invalidation per card) plus the terminal park that replaces it.
*/

const DIAGNOSTIC = `${PLAN_LOCK_UNAVAILABLE_DIAGNOSTIC} mission-missing (mission).`;

/** A plan-review group wired to the built-in `plan-review --failure--> plan-replan` edge the loop used to traverse. */
function planReviewIr(): WorkflowIr {
  return {
    version: "v2",
    name: "plan-review-spec-lock-terminal",
    columns: [{ id: "todo", name: "Todo", traits: [] }, { id: "done", name: "Done", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      {
        id: PLAN_REVIEW_GROUP_ID,
        kind: "optional-group",
        config: {
          name: "Plan Review",
          reviewKind: "plan",
          defaultOn: true,
          template: { nodes: [{ id: "review", kind: "prompt", config: { prompt: "review" } }], edges: [] },
        },
      },
      { id: "execute", kind: "prompt", config: { prompt: "execute" } },
      { id: "plan-replan", kind: "prompt", config: { prompt: "replan" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: PLAN_REVIEW_GROUP_ID },
      { from: PLAN_REVIEW_GROUP_ID, to: "execute", condition: "success" },
      { from: PLAN_REVIEW_GROUP_ID, to: "plan-replan", condition: "failure" },
      { from: "execute", to: "end" },
      { from: "plan-replan", to: "end" },
    ],
  };
}

const task = (): TaskDetail => ({ id: "FN-123", enabledWorkflowSteps: [PLAN_REVIEW_GROUP_ID] } as TaskDetail);

/**
 * The reviewer APPROVED. The spec-lock seam then rewrites that approval into a failed row carrying
 * the parser diagnostic and no verdict, which is exactly the state the graph used to misread as a
 * plan defect. The writer returns that terminal row as the authoritative receipt.
 *
 * The pre-dispatch `pending` row passes through untouched, mirroring the real store.
 */
function approvedThenSpecLockRejectedWriter(results: WorkflowStepResult[]) {
  return async (_id: string, result: WorkflowStepResult) => {
    const persisted = result.status === "pending"
      ? result
      : { ...result, status: "failed" as const, verdict: undefined, output: DIAGNOSTIC, notes: DIAGNOSTIC };
    results.push(persisted);
    return { scopeCurrent: true, persisted: true, disposition: "applied" as const, persistedResult: persisted };
  };
}

/** The terminal (non-pending) rows only: the invalidations an operator would see accumulate. */
const terminalRows = (results: WorkflowStepResult[]): WorkflowStepResult[] => results.filter((entry) => entry.status !== "pending");

describe("Plan Review spec-lock unavailability is terminal", () => {
  it("recognizes the durable diagnostic the spec-lock seam persists", () => {
    expect(isPlanLockUnavailableDiagnostic(DIAGNOSTIC)).toBe(true);
    expect(isPlanLockUnavailableDiagnostic("Plan Review failed before execution. Re-run triage.")).toBe(false);
    expect(isPlanLockUnavailableDiagnostic(undefined)).toBe(false);
    expect(isPlanLockUnavailableDiagnostic(null)).toBe(false);
  });

  it("holds terminally instead of fabricating a REVISE or requesting a replan", async () => {
    const executed: string[] = [];
    const results: WorkflowStepResult[] = [];
    const requestPreMergeOptionalStepFix = vi.fn(async () => true);
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async (node) => { executed.push(node.id); return { outcome: "success" as const, value: "APPROVE" }; } },
      recordWorkflowStepResult: approvedThenSpecLockRejectedWriter(results),
      requestPreMergeOptionalStepFix,
    });

    const result = await executor.run(task(), { experimentalFeatures: { workflowGraphExecutor: true } }, planReviewIr());

    expect(result.outcome).toBe("failure");
    expect(result.context?.[`node:${PLAN_REVIEW_GROUP_ID}:value`]).toBe(PLAN_LOCK_UNAVAILABLE_HOLD_VALUE);
    // The defect: a fabricated REVISE reached the remediation seam and replanned the card.
    expect(requestPreMergeOptionalStepFix).not.toHaveBeenCalled();
    // The defect: the graph traversed into the replan node (or straight through to execution).
    expect(executed).toEqual(["review"]);
    // No reviewer verdict exists in the persisted row, and none was invented for routing.
    expect(terminalRows(results).at(-1)?.verdict).toBeUndefined();
    expect(results.every((entry) => entry.verdict !== "REVISE")).toBe(true);
  });

  it("carries the parser diagnostic to the failure handler so the park names it", async () => {
    const results: WorkflowStepResult[] = [];
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success" as const, value: "APPROVE" }) },
      recordWorkflowStepResult: approvedThenSpecLockRejectedWriter(results),
    });

    const result = await executor.run(task(), { experimentalFeatures: { workflowGraphExecutor: true } }, planReviewIr());

    expect(result.context?.["node:plan-lock-unavailable-diagnostic"]).toBe(DIAGNOSTIC);
  });

  it("dispatches one reviewer and invalidates once per run, so no cycle repeats inside a run", async () => {
    const executed: string[] = [];
    const results: WorkflowStepResult[] = [];
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async (node) => { executed.push(node.id); return { outcome: "success" as const, value: "APPROVE" }; } },
      recordWorkflowStepResult: approvedThenSpecLockRejectedWriter(results),
    });

    const result = await executor.run(task(), { experimentalFeatures: { workflowGraphExecutor: true } }, planReviewIr());

    // The measured symptom was 20 invalidations for one card at a ~4.7 min cadence, one full
    // session each. One run must dispatch the reviewer once and persist one failed row; the
    // repeated cycling came from the engine RE-dispatching the card, which only a terminal park
    // (not a fabricated REVISE) can stop.
    expect(executed).toEqual(["review"]);
    const terminal = terminalRows(results);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ status: "failed", verdict: undefined, output: DIAGNOSTIC, notes: DIAGNOSTIC });
    expect(result.context?.[`node:${PLAN_REVIEW_GROUP_ID}:value`]).toBe(PLAN_LOCK_UNAVAILABLE_HOLD_VALUE);
  });
});

function parkedTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  const now = new Date().toISOString();
  return {
    id: "FN-029",
    title: "Expose merge policy in config read output",
    description: "Non-mission task whose plan could not be locked.",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Preflight", status: "pending" }],
    currentStep: 0,
    log: [],
    worktree: "/tmp/fn-029",
    branch: "fusion/fn-029",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

/** A store that tracks the live row so the park's durable effect is observable. */
function trackingStore(initial: TaskDetail) {
  const store = createMockStore();
  let live = initial;
  const atomicWrites: Record<string, unknown>[] = [];
  store.getTask.mockImplementation(async () => live as never);
  store.updateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => {
    live = { ...live, ...updates } as TaskDetail;
    return live as never;
  });
  (store as unknown as { updateTaskAtomic: unknown }).updateTaskAtomic =
    async (_id: string, compute: (current: Task) => Record<string, unknown> | null) => {
      const patch = compute(live);
      if (patch) {
        atomicWrites.push(patch);
        live = { ...live, ...patch } as TaskDetail;
      }
      return live;
    };
  store.moveTask.mockImplementation(async (_id: string, column: string) => {
    live = { ...live, column } as TaskDetail;
  });
  return { store, getLive: () => live, atomicWrites };
}

describe("spec-lock unavailability parks the card terminally", () => {
  it("writes status failed with a non-null error naming the diagnostic and the remedy", async () => {
    resetExecutorMocks();
    const initial = parkedTask();
    const { store, getLive, atomicWrites } = trackingStore(initial);
    const executor = new TaskExecutor(store as never, "/tmp/test");

    await (executor as never as {
      handleGraphFailure(task: TaskDetail, result: unknown): Promise<void>;
    }).handleGraphFailure(initial, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["start", "plan-review", "plan-review::review"],
      context: {
        "node:plan-review:value": PLAN_LOCK_UNAVAILABLE_HOLD_VALUE,
        [PLAN_LOCK_UNAVAILABLE_DIAGNOSTIC_CONTEXT_KEY]: DIAGNOSTIC,
      },
    });

    // Acceptance #4: the card must be visible to error-based detection, which needs error != null.
    const live = getLive();
    expect(live.status).toBe("failed");
    expect(String(live.error)).toContain("mission-missing");
    expect(String(live.error)).toContain("PROMPT.md");
    // Acceptance #2: the terminal park is a single write, so invalidations cannot accumulate.
    expect(atomicWrites).toHaveLength(1);
    expect(atomicWrites[0]).toMatchObject({ status: "failed" });
    // No remediation is scheduled and no retry is armed, so nothing re-dispatches the reviewer.
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalledWith(initial.id, expect.objectContaining({ graphResumeRetryCount: expect.anything() }), expect.anything());
  });

  it("is not routed to the bounded in-place Plan Review provider retry", async () => {
    resetExecutorMocks();
    const initial = parkedTask();
    const { store, getLive } = trackingStore(initial);
    const executor = new TaskExecutor(store as never, "/tmp/test");

    await (executor as never as {
      handleGraphFailure(task: TaskDetail, result: unknown): Promise<void>;
    }).handleGraphFailure(initial, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["start", "plan-review", "plan-review::review"],
      context: { "node:plan-review:value": PLAN_LOCK_UNAVAILABLE_HOLD_VALUE },
    });

    // The provider hold would increment this and leave error null — the exact shape that hid the
    // loop from every error-based detection in FUSI-025.
    expect(getLive().graphResumeRetryCount).toBeUndefined();
    expect(getLive().status).toBe("failed");
  });

  it("refuses a replan through the compatibility seam without touching the card", async () => {
    resetExecutorMocks();
    const initial = parkedTask({ column: "in-review", postReviewFixCount: 0 } as Partial<TaskDetail>);
    const { store, getLive } = trackingStore(initial);
    store.getSettings.mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 15_000, autoMerge: true, maxAutoMergeRetries: 3 });
    const executor = new TaskExecutor(store as never, "/tmp/test");

    const scheduled = await (executor as never as {
      requestPreMergeOptionalStepFix(id: string, t: Task, i: Record<string, unknown>): Promise<boolean>;
    }).requestPreMergeOptionalStepFix(initial.id, initial as unknown as Task, {
      stepName: "Plan Review",
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      feedback: DIAGNOSTIC,
      nodeId: "plan-review",
    });

    expect(scheduled).toBe(false);
    expect(getLive().postReviewFixCount).toBe(0);
    expect(getLive().status).toBeNull();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.logEntry.mock.calls.some(([, message]) => String(message).includes("replan refused"))).toBe(true);
  });
});
