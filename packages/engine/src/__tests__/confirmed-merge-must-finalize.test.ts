import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { postMergeOptionalGroupNode } from "@fusion/core";

import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";

/*
 * FNXC:ConfirmedMergeMustFinalize 2026-08-23-09:15:
 * FN-180 treats a confirmed integration write as irreversible. Stale checklist state is reconciled
 * before the terminal move; only independent blockers may defer finalization.
 *
 * FNXC:PostMergeAdvisoryDemotion 2026-09-29-14:57:
 * FUSI-064 demoted the BUILT-IN post-merge verification to an advisory observation, so a merge-confirmed
 * card on `builtin:coding` now finalizes on merge confirmation alone even with an absent, pending, skipped,
 * or REVISE post-merge result. `finalizeProvenAutoMergeTask` still defers on a genuinely GATE-MODE
 * post-merge group, so the blocking coverage below is retained against a custom workflow that declares
 * `gateMode: "gate"`. `makeStore` takes a workflow selector so each test can pin either contract.
 */

/** Custom workflow whose post-merge group is explicitly gate-mode, so the finalize path's
 *  post-merge-evidence blocker is still exercised end-to-end. */
function gateModeWorkflowId(): string {
  return "WF-PM-GATE";
}

const gateModeWorkflowIr = {
  version: "v2",
  name: "gate-post-merge",
  columns: [
    { id: "in-review", name: "Review", traits: [] },
    { id: "done", name: "Done", traits: [] },
  ],
  nodes: [
    postMergeOptionalGroupNode({
      id: "post-merge-verification",
      name: "Post-merge verification",
      column: "done",
      prompt: "gate-mode post-merge verification",
      gateMode: "gate",
      defaultOn: true,
    }),
  ],
  edges: [],
};

function makeStore(task: Task, options: { workflowId?: string } = {}): TaskStore {
  const workflowId = options.workflowId ?? "builtin:coding";
  const selection = () => ({ workflowId, stepIds: task.enabledWorkflowSteps ?? [] });
  const store = {
    getTask: vi.fn(async () => task),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
    updateTaskAtomic: vi.fn(async (_id: string, update: (current: Task) => Partial<Task>) => Object.assign(task, update(task))),
    moveTask: vi.fn(async (_id: string, column: string) => Object.assign(task, { column })),
    logEntry: vi.fn(), recordRunAuditEvent: vi.fn(), getSettings: vi.fn(async () => ({})),
    getTaskWorkflowSelection: vi.fn(selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection()),
    getWorkflowDefinition: vi.fn(async (id: string) => (id === gateModeWorkflowId() ? { ir: gateModeWorkflowIr } : undefined)),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
  } as unknown as TaskStore;
  store.moveTaskIf = vi.fn(async (_id, column, predicate, options2) => {
    if (!await predicate(task)) return { task, moved: false };
    return { task: await store.moveTask(task.id, column, options2), moved: true };
  });
  return store;
}

describe("FN-180 confirmed merge must finalize", () => {
  it("reconciles an incomplete checklist instead of writing a failed park", async () => {
    const task = {
      id: "FN-180", column: "in-review", steps: [{ name: "implementation", status: "done" }, { name: "verification", status: "pending" }],
      mergeDetails: { mergeConfirmed: true }, enabledWorkflowSteps: [], workflowStepResults: [],
    } as unknown as Task;
    const store = makeStore(task);

    const result = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "direct-ai-merge" });
    expect(result.outcome).toBe("done");
    expect(task.column).toBe("done");
    expect(task.steps.map((step) => step.status)).toEqual(["done", "skipped"]);
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ status: "failed" }));
  });

  it("finalizes a merge-confirmed card on builtin:coding even without post-merge approval (advisory gate)", async () => {
    /*
    FNXC:PostMergeAdvisoryDemotion 2026-09-29-14:57:
    The FUSI-064 Symptom Verification contract at the finalize layer: with the built-in advisory
    post-merge verification, a card whose work merged cleanly reaches 'done' regardless of an
    absent, pending, skipped, or REVISE post-merge result — the shape a red/never-green Full Suite
    produces. This is the assertion that the pre-fix permanent block is gone.
    */
    const resultShapes = [
      [],
      [{ workflowStepId: "post-merge-verification", status: "pending" }],
      [{ workflowStepId: "post-merge-verification", status: "skipped" }],
      [{ workflowStepId: "post-merge-verification", status: "failed", verdict: "REVISE" }],
    ];
    // A fresh card per (result shape, source): a shared card would already be in 'done' on the
    // second finalize, which is an unrelated idempotence path ('already-done'), not this contract.
    for (const [shapeIndex, workflowStepResults] of resultShapes.entries()) {
      for (const source of ["direct-ai-merge", "self-healing"] as const) {
        const fresh = {
          id: `FN-PM-advisory-${source}-${shapeIndex}`,
          column: "in-review",
          steps: [{ name: "implementation", status: "done" }],
          mergeDetails: { mergeConfirmed: true },
          enabledWorkflowSteps: ["post-merge-verification"],
          workflowStepResults,
        } as unknown as Task;
        const freshStore = makeStore(fresh);
        const result = await finalizeProvenAutoMergeTask({ store: freshStore, taskId: fresh.id, source });
        expect(result.outcome, `source=${source} results=${JSON.stringify(workflowStepResults)}`).toBe("done");
        expect(fresh.column).toBe("done");
      }
    }
  });

  it("blocks direct and self-healing finalization until a gate-mode post-merge gate approves", async () => {
    const task = {
      id: "FN-PM-finalize",
      column: "in-review",
      steps: [{ name: "implementation", status: "done" }],
      mergeDetails: { mergeConfirmed: true },
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [],
    } as unknown as Task;
    const store = makeStore(task, { workflowId: gateModeWorkflowId() });

    for (const workflowStepResults of [
      [],
      [{ workflowStepId: "post-merge-verification", status: "pending" }],
      [{ workflowStepId: "post-merge-verification", status: "skipped" }],
      [{ workflowStepId: "post-merge-verification", status: "failed", verdict: "REVISE" }],
    ]) {
      task.workflowStepResults = workflowStepResults as Task["workflowStepResults"];
      for (const source of ["direct-ai-merge", "self-healing"] as const) {
        const result = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source });
        expect(result).toMatchObject({ outcome: "blocked", reason: expect.stringContaining("post-merge evidence") });
        expect(task.column).toBe("in-review");
        expect(store.moveTask).not.toHaveBeenCalled();
      }
    }

    task.workflowStepResults = [{
      workflowStepId: "post-merge-verification",
      status: "passed",
      verdict: "APPROVE",
    }] as Task["workflowStepResults"];
    const approved = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" });
    expect(approved.outcome).toBe("done");
    expect(task.column).toBe("done");
  });

  it("refuses completion when a gate-mode approval is superseded after the optimistic evidence read", async () => {
    const task = {
      id: "FN-PM-finalization-race",
      column: "in-review",
      steps: [{ name: "implementation", status: "done" }],
      mergeDetails: { mergeConfirmed: true },
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [{ workflowStepId: "post-merge-verification", status: "passed", verdict: "APPROVE" }],
    } as unknown as Task;
    const store = makeStore(task, { workflowId: gateModeWorkflowId() });
    const standardMove = store.moveTaskIf.getMockImplementation()!;
    store.moveTaskIf = vi.fn(async (id, column, predicate, options) => {
      task.workflowStepResults = [];
      return standardMove(id, column, predicate, options);
    });

    await expect(finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" }))
      .resolves.toMatchObject({ outcome: "blocked", reason: expect.stringContaining("post-merge evidence") });
    expect(task.column).toBe("in-review");
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("does not treat an already-complete card as converged without gate-mode post-merge approval", async () => {
    const task = {
      id: "FN-PM-already-done",
      column: "done",
      steps: [{ name: "implementation", status: "done" }],
      mergeDetails: { mergeConfirmed: true },
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [],
    } as unknown as Task;
    const store = makeStore(task, { workflowId: gateModeWorkflowId() });

    await expect(finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" }))
      .resolves.toMatchObject({ outcome: "blocked", reason: expect.stringContaining("post-merge evidence") });
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("finalizes a merge-confirmed review card parked failed by lifecycle F3", async () => {
    const task = {
      id: "FN-221",
      column: "in-review",
      status: "failed",
      error: "Cannot move FN-221 to 'done': Forbidden lifecycle path F3…",
      steps: [{ name: "implementation", status: "done" }],
      mergeDetails: { mergeConfirmed: true },
      enabledWorkflowSteps: [],
      workflowStepResults: [],
    } as unknown as Task;
    const store = makeStore(task);

    const result = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" });

    expect(result.outcome).toBe("done");
    expect(task.column).toBe("done");
    expect(task.status).toBeNull();
    expect(task.error).toBeNull();
    expect(store.updateTaskAtomic).toHaveBeenCalledWith(task.id, expect.any(Function));
  });
});
