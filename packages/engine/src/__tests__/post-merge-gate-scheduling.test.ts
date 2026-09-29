import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";

import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";

/*
 * FNXC:PostMergeGateScheduling 2026-09-29:
 * FN-9369 made the post-merge-verification optional group a REQUIRED gate, and
 * upgradeLegacyCodingPostMergeVerificationStepIds() auto-migrates older coding tasks onto it.
 * The gate is a graph post-merge hop: it only runs while the graph is executing the `merge`
 * node (runLegacyMergeSeam -> postMergeEntryNodeIds -> walk(entryId)). Once the merge seam has
 * already returned, a later finalizeProvenAutoMergeTask() call finds the gate unreported and
 * returns `blocked` forever. Nothing ever re-enters the graph at the post-merge node, so on a
 * repository that cannot produce the gate's post-landing CI evidence the card can never
 * finalize. This test pins the missing scheduling half: finalization must make the pending
 * gate runnable instead of only logging that it is missing.
 */
function makeStore(task: Task, opts: { workItems?: unknown[] } = {}): TaskStore {
  const workItems = opts.workItems ?? [];
  const store = {
    getTask: vi.fn(async () => task),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
    updateTaskAtomic: vi.fn(async (_id: string, update: (current: Task) => Partial<Task>) => Object.assign(task, update(task))),
    moveTask: vi.fn(async (_id: string, column: string) => Object.assign(task, { column })),
    logEntry: vi.fn(),
    recordRunAuditEvent: vi.fn(),
    getSettings: vi.fn(async () => ({})),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps ?? [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps ?? [] })),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    listWorkflowWorkItemsForTask: vi.fn(async () => workItems),
    upsertWorkflowWorkItem: vi.fn(async (input: unknown) => ({ id: "wi-post-merge", ...(input as object) })),
  } as unknown as TaskStore;
  store.moveTaskIf = vi.fn(async (_id, column, predicate, options) => {
    if (!await predicate(task)) return { task, moved: false };
    return { task: await store.moveTask(task.id, column, options), moved: true };
  });
  return store;
}

function mergedTaskWithPendingGate(): Task {
  return {
    id: "FN-PM-schedule",
    column: "in-review",
    steps: [{ name: "implementation", status: "done" }],
    mergeDetails: { mergeConfirmed: true, commitSha: "abc123" },
    enabledWorkflowSteps: ["post-merge-verification"],
    workflowStepResults: [],
  } as unknown as Task;
}

describe("FN-9369 post-merge gate must become runnable after the merge seam returned", () => {
  it("schedules the unreported post-merge gate instead of only reporting it missing", async () => {
    const task = mergedTaskWithPendingGate();
    const store = makeStore(task);

    const result = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" });

    // Still refuses to finalize: the gate has not run, so there is no evidence.
    expect(result).toMatchObject({ outcome: "blocked" });
    expect(task.column).toBe("in-review");
    // ...but the missing gate is now dispatched, so the block is not terminal.
    expect(store.upsertWorkflowWorkItem).toHaveBeenCalledTimes(1);
    const seeded = store.upsertWorkflowWorkItem.mock.calls[0]?.[0] as { nodeId?: string; state?: string; kind?: string };
    expect(seeded.nodeId).toBe("post-merge-verification");
    expect(seeded.state).toBe("runnable");
  });

  it("does not re-seed a gate that already has an active continuation", async () => {
    const task = mergedTaskWithPendingGate();
    const store = makeStore(task, {
      workItems: [{ id: "wi-existing", nodeId: "post-merge-verification", state: "runnable" }],
    });

    const result = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" });

    expect(result).toMatchObject({ outcome: "blocked" });
    expect(store.upsertWorkflowWorkItem).not.toHaveBeenCalled();
  });

  it("still finalizes normally when the post-merge gate is disabled", async () => {
    const task = mergedTaskWithPendingGate();
    task.enabledWorkflowSteps = [];
    const store = makeStore(task);

    const result = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" });

    expect(result.outcome).toBe("done");
    expect(store.upsertWorkflowWorkItem).not.toHaveBeenCalled();
  });
});
