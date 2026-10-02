/**
 * FUSI-068 regression suite: a Code Review REVISE must never be silently stranded.
 *
 * The defect these pin: `sendTaskBackForFix` commits the replay step to the DURABLE ledger, then
 * hands off review → WIP through a best-effort bounce. Losing the WIP capacity race left a real
 * pending replay step with no path to the executor — `getTaskMergeBlocker` correctly returned
 * "task has incomplete steps", no sweep was keyed on a non-terminal step, and `surfaceInReviewStalls`
 * auto-disposed the card as a permanent deadlock. One log line promised a retry that nothing performed.
 *
 * Every test here is a FAILURE that was real before the fix, not a restatement of the log line.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  TransitionRejectionError,
  getTaskMergeBlocker,
  getInReviewStallReason,
  hasNonTerminalSteps,
  hasUndeliveredReplayStep,
  type Task,
  type TaskStep,
} from "@fusion/core";

import { performWorkflowRerunBounce, recordBounceCapacityWait } from "../executor/workflow-rerun-bounce.js";
import { reopenLastStepForRevision } from "../executor/reopen-last-step-for-revision.js";

/** A card carrying a REAL Code Review REVISE and an already-committed replay step — the live shape
 *  of the stranded board cards (GDPR-074, FUSI-019, and the no-failed-result shape). */
function strandedReviewTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FUSI-068-stranded",
    title: "Review bounce capacity hand-off",
    description: "Reproduce the lost capacity hand-off.",
    column: "in-review",
    worktree: "/tmp/fusi-068-stranded",
    modifiedFiles: [],
    dependencies: [],
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Testing & Verification", status: "done" },
      { name: "Documentation & Delivery", status: "done" },
      // The engine-appended replay occurrence: a name clone of its completed predecessor.
      { name: "Documentation & Delivery", status: "pending" },
    ],
    currentStep: 3,
    log: [],
    createdAt: "2026-09-25T02:58:00.000Z",
    updatedAt: "2026-09-25T02:58:27.000Z",
    ...overrides,
  } as Task;
}

type ContinuationRow = {
  runId: string; taskId: string; nodeId: string; kind: string;
  state: string; waitReason?: string | null; sourceColumn?: string | null; targetColumn?: string | null;
};

function capacityStore(
  row: Task,
  options: { continuations?: ContinuationRow[]; workflowId?: string; workflowIr?: unknown } = {},
) {
  const continuations = options.continuations ?? [];
  const recorded = [] as ContinuationRow[];
  const store = {
    getSettings: vi.fn(async () => ({ autoMerge: true })),
    getTask: vi.fn(async () => row),
    getTaskWorkflowSelection: vi.fn(async () => ({ workflowId: options.workflowId ?? "builtin:coding", stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () =>
      (options.workflowIr === undefined ? BUILTIN_CODING_WORKFLOW_IR : options.workflowIr) as never),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      Object.assign(row, patch);
      return row;
    }),
    logEntry: vi.fn(async () => undefined),
    listWorkflowWorkItemsForTask: vi.fn(async () => continuations as never),
    replaceActiveTaskWorkflowContinuation: vi.fn(async (input: ContinuationRow) => {
      recorded.push(input);
      continuations.push(input);
      return input;
    }),
    recordRunAuditEvent: vi.fn(async () => undefined),
    /*
     The move rejects on capacity exactly as the real store does. `capacityFreed` flips the lane
     open, which is the "WIP capacity frees" half of the defect's real timeline.
    */
    moveTask: vi.fn(async (_id: string, column: string) => {
      if (!store.capacityFreed) {
        throw new TransitionRejectionError({
          code: "capacity-exhausted",
          detail: "WIP column is at capacity",
        } as never);
      }
      row.column = column;
      return row;
    }),
    capacityFreed: false,
  };
  return { store, recorded, continuations };
}

const bounceDeps = (store: unknown) => ({
  store,
  workflowRerunPending: new Set<string>(),
  getExecutionPauseLabel: vi.fn(async () => null),
  resolveResumeLanes: vi.fn(async (_taskId: string) => ({ review: "in-review", wip: "in-progress" })),
  clearTerminalStepFailuresForRetry: vi.fn(async () => undefined),
});

describe("FUSI-068 a capacity-deferred review bounce is durable, not dropped", () => {
  it("Step 8.1 — the deferral is durable, and capacity freeing still lands the card in WIP", async () => {
    const row = strandedReviewTask();
    const { store, recorded } = capacityStore(row);

    /* First bounce: the WIP lane is full, so the move is deferred. */
    const deferred = await performWorkflowRerunBounce(
      bounceDeps(store) as never, row.id, row.worktree!, true, true,
    );
    expect(deferred).toBe("deferred-capacity");
    /* NOT merely logged: a durable row a later drain can pick up. */
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      taskId: row.id, kind: "task", state: "held", waitReason: "capacity",
      sourceColumn: "in-review", targetColumn: "in-progress",
    });
    expect(row.column).toBe("in-review");

    /* Capacity frees — the next bounce must actually deliver, with the replay step intact. */
    (store as never as { capacityFreed: boolean }).capacityFreed = true;
    const delivered = await performWorkflowRerunBounce(
      bounceDeps(store) as never, row.id, row.worktree!, true, true,
    );
    expect(delivered).toBe("bounced");
    expect(row.column).toBe("in-progress");
    /* The authored work survived the round trip — it is still executable. */
    expect(row.steps!.at(-1)).toMatchObject({ name: "Documentation & Delivery", status: "pending" });
  });

  it("Step 8.2 — the deferral survives a process restart (fresh executor, same store)", async () => {
    const row = strandedReviewTask();
    const { store, recorded } = capacityStore(row);

    await performWorkflowRerunBounce(bounceDeps(store) as never, row.id, row.worktree!, true, true);

    /* A brand-new executor process: no in-memory pending set, no watchdog timers, no local state.
       Everything the recovery needs must be in the durable store. */
    const freshStore = { ...store, listWorkflowWorkItemsForTask: store.listWorkflowWorkItemsForTask };
    const restartOutcome = await performWorkflowRerunBounce(
      bounceDeps(freshStore) as never, row.id, row.worktree!, true, true,
    );
    expect(["bounced", "deferred-capacity"]).toContain(restartOutcome);
    /* The marker written by the FIRST process is what a restarted drain reads. */
    expect(recorded.length).toBeGreaterThanOrEqual(1);
    expect(recorded[0]!.waitReason).toBe("capacity");
  });

  it("Step 8.4 — a second capacity deferral is NOT terminal; something durable stays armed", async () => {
    const row = strandedReviewTask();
    const { store, recorded } = capacityStore(row);

    /* The watchdog's retry arm runs the same bounce again while the lane is still full. */
    await performWorkflowRerunBounce(bounceDeps(store) as never, row.id, row.worktree!, true, true);
    await performWorkflowRerunBounce(bounceDeps(store) as never, row.id, row.worktree!, true, true);

    /* Before the fix this is where the card died: two attempts, 15s apart, then silence.
       The marker is idempotent (one live row per node), so the wait is still armed, not dropped. */
    expect(row.column).toBe("in-review");
    expect(recorded).toHaveLength(1);
    expect(store.listWorkflowWorkItemsForTask).toHaveBeenCalled();
  });

  it("records the park through the bounded run-audit seam, ids and columns only", async () => {
    const row = strandedReviewTask();
    const { store } = capacityStore(row);

    await performWorkflowRerunBounce(bounceDeps(store) as never, row.id, row.worktree!, true, true);

    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:review-bounce-capacity-parked",
    }));
    const emitted = (store.recordRunAuditEvent as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      metadata: Record<string, unknown>;
    };
    /* Never the blocker sentence, the step name, or reviewer prose. */
    expect(JSON.stringify(emitted.metadata)).not.toContain("incomplete steps");
    expect(JSON.stringify(emitted.metadata)).not.toContain("Documentation");
  });

  it("does not duplicate a live wait for the same node", async () => {
    const row = strandedReviewTask();
    const live: ContinuationRow = {
      runId: "r", taskId: row.id, nodeId: `workflow-remediation:${row.id}`, kind: "task", state: "held",
    };
    const { store, recorded } = capacityStore(row, { continuations: [live] });

    const written = await recordBounceCapacityWait(
      store as never, row.id, "in-review", "in-progress", `workflow-remediation:${row.id}`,
    );
    expect(written).toBe(false);
    expect(recorded).toHaveLength(0);
  });

  it("survives a store that cannot write the marker without masking the deferral", async () => {
    const row = strandedReviewTask();
    const { store } = capacityStore(row);
    store.replaceActiveTaskWorkflowContinuation = vi.fn(async () => {
      throw new Error("marker table unavailable");
    });

    const outcome = await performWorkflowRerunBounce(bounceDeps(store) as never, row.id, row.worktree!, true, true);
    /* The deferral still reports honestly — a failed marker write is the sweep's problem, not a crash. */
    expect(outcome).toBe("deferred-capacity");
    expect(row.column).toBe("in-review");
  });
});

describe("FUSI-068 the undelivered-replay shape is a named cause, not generic incomplete steps", () => {
  it("Step 8.5 — recognizes the stranded shape, including with ZERO failed pre-merge results", () => {
    const gdpr076Shape = strandedReviewTask({ workflowStepResults: [] });
    /* The card that no failed-pre-merge sweep can ever reach. */
    expect(gdpr076Shape.workflowStepResults ?? []).toHaveLength(0);
    expect(hasUndeliveredReplayStep(gdpr076Shape)).toBe(true);
  });

  it("Step 8.6 — does NOT fire on the control shapes", () => {
    /* A pending step that is not a replay twin. */
    expect(hasUndeliveredReplayStep(strandedReviewTask({
      steps: [{ name: "A", status: "done" }, { name: "B", status: "pending" }],
    }))).toBe(false);

    /* Duplicate names whose occurrences are ALL done (GDPR-075 / FUSI-020 — never stranded). */
    expect(hasUndeliveredReplayStep(strandedReviewTask({
      steps: [{ name: "Delivery", status: "done" }, { name: "Delivery", status: "done" }],
    }))).toBe(false);

    /* A three-way duplicate: the twin is the TRAILING one whose predecessor shares its name. */
    expect(hasUndeliveredReplayStep(strandedReviewTask({
      steps: [
        { name: "Delivery", status: "done" },
        { name: "Delivery", status: "done" },
        { name: "Delivery", status: "pending" },
      ],
    }))).toBe(true);

    /* Zero-step and single-step cards. */
    expect(hasUndeliveredReplayStep({ steps: [] } as Task)).toBe(false);
    expect(hasUndeliveredReplayStep({ steps: [{ name: "A", status: "pending" }] } as Task)).toBe(false);
    /* No steps key at all. */
    expect(hasUndeliveredReplayStep({} as Task)).toBe(false);
    /* A predecessor still in flight is not a completed occurrence being replayed. */
    expect(hasUndeliveredReplayStep(strandedReviewTask({
      steps: [{ name: "A", status: "in-progress" }, { name: "A", status: "pending" }],
    }))).toBe(false);
  });

  it("Step 8.7 — the door's refusal is UNCHANGED", () => {
    const row = strandedReviewTask();
    /* This is the constraint test. It was green before the fix and must stay green after. */
    expect(hasNonTerminalSteps(row)).toBe(true);
    expect(getTaskMergeBlocker(row, { reviewColumns: new Set(["in-review"]) }))
      .toBe("task has incomplete steps");
  });

  it("the stall diagnostic names the undelivered hand-off instead of the generic blocker", () => {
    const row = strandedReviewTask();
    const reason = getInReviewStallReason(row, { reviewColumns: new Set(["in-review"]) });
    expect(reason?.code).toBe("undelivered-replay-step");
    expect(reason?.reason).toContain("Documentation & Delivery");
    expect(reason?.reason).not.toBe("task has incomplete steps");
  });

  it("an ordinary unfinished step keeps the generic merge-blocker reason", () => {
    /* The new code must not swallow ordinary waiting and make the board noisy. */
    const ordinary = strandedReviewTask({
      steps: [{ name: "A", status: "done" }, { name: "B", status: "pending" }],
    });
    expect(getInReviewStallReason(ordinary, { reviewColumns: new Set(["in-review"]) })?.code)
      .toBe("merge-blocker");
  });

  it("an operator-held card with duplicate-name steps is not reported as undelivered", () => {
    /* GDPR-001 / FUSI-010 shape: duplicate names, all done, operator-held. */
    const held = strandedReviewTask({
      steps: [{ name: "Delivery", status: "done" }, { name: "Delivery", status: "done" }],
      paused: true,
    });
    expect(hasUndeliveredReplayStep(held)).toBe(false);
    expect(getInReviewStallReason(held, { reviewColumns: new Set(["in-review"]) })?.code).not.toBe(
      "undelivered-replay-step",
    );
  });
});describe("FUSI-068 the replay occurrence carries a distinguishable identity", () => {
  /* `updateTaskAtomic` uses `null` as its ABORT contract — the compute function returns it to refuse
     the write entirely. A mock that applies whatever the compute returns would silently "succeed"
     a refusal and make every no-op assertion vacuous. */
  const atomicStore = (row: Task) => ({
    updateTaskAtomic: vi.fn(async (_id: string, compute: (current: Task) => Record<string, unknown> | null) => {
      const patch = compute(row);
      if (patch === null) return row;
      const typed = patch as { steps?: TaskStep[]; currentStep?: number };
      if (typed.steps) row.steps = typed.steps;
      if (typed.currentStep !== undefined) row.currentStep = typed.currentStep;
      return row;
    }),
  });

  it("stamps additive replay provenance on the appended occurrence only", async () => {
    const row = strandedReviewTask({
      steps: [{ name: "Preflight", status: "done" }, { name: "Documentation & Delivery", status: "done" }],
    });
    const replay = await reopenLastStepForRevision(atomicStore(row) as never, row.id, row);
    expect(replay).toMatchObject({ name: "Documentation & Delivery" });
    const appended = row.steps!.at(-1)!;
    expect(appended.status).toBe("pending");
    /* Distinguishable from its completed sibling by durable provenance. */
    expect(appended.replay).toMatchObject({ wave: 1 });
    /* FN-180: the completed occurrence stays immutable history. */
    expect(row.steps![0]).toEqual({ name: "Preflight", status: "done" });
    expect(row.steps![1]).toEqual({ name: "Documentation & Delivery", status: "done" });
    /* Deliberately NOT the remediation field, whose presence would block a future re-parse. */
    expect(appended.remediation).toBeUndefined();
  });

  it("increments the replay wave across successive revisions", async () => {
    const row = strandedReviewTask({
      steps: [
        { name: "Delivery", status: "done" },
        { name: "Delivery", status: "done", replay: { wave: 1, replaysStepIndex: 0 } },
      ],
    });
    await reopenLastStepForRevision(atomicStore(row) as never, row.id, row);
    expect(row.steps!.at(-1)!.replay).toMatchObject({ wave: 2 });
  });

  it("refuses to grow the ledger when pending work already exists", async () => {
    const row = strandedReviewTask();
    const replay = await reopenLastStepForRevision(atomicStore(row) as never, row.id, row);
    expect(replay).toBeNull();
    expect(row.steps).toHaveLength(4);
  });
});

describe("FUSI-068 the FN-267 empty-hand-off guard still holds on the durable path", () => {
  it("refuses a bounce with no pending remediation work at all", async () => {
    /* The ordering guard the reordering must never make unreachable: a review revision may return to
       implementation only after the workflow has produced work for an executor to perform. */
    const row = strandedReviewTask({
      steps: [{ name: "Preflight", status: "done" }, { name: "Implementation", status: "done" }],
    });
    const { store, recorded } = capacityStore(row);
    (store as never as { capacityFreed: boolean }).capacityFreed = true;

    const outcome = await performWorkflowRerunBounce(bounceDeps(store) as never, row.id, row.worktree!, true, true);

    expect(outcome).toBe("refused-no-remediation");
    expect(row.column).toBe("in-review");
    expect(store.moveTask).not.toHaveBeenCalled();
    /* And a refusal is not a capacity park — no marker, no misleading telemetry. */
    expect(recorded).toHaveLength(0);
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });
});