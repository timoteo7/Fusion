/**
 * FUSI-028 regression: a slice closed by FEATURE VALIDATION must trigger the
 * same guarded, strictly-ordered next-slice admission that task completion does.
 *
 * Before the fix, slice advance fired only from a task-completion event
 * (`handleMissionTaskCompletion` -> `Scheduler.onSliceComplete`). A slice whose
 * last feature closes by a `passed` validator verdict — with no task completing
 * in the window — never fired the hook, so the next `pending` slice stayed
 * `pending` forever and the mission silently stalled (no error, no progress log).
 *
 * These tests drive the real `MissionExecutionLoop` over a faithful fake mission
 * store (one that reuses the real `selectNextSerialMissionSlice` for ordering)
 * and assert the shared store-backed seam advances the roadmap.
 */

import { describe, it, expect, vi } from "vitest";
import { selectNextSerialMissionSlice, type MissionStore, type TaskStore } from "@fusion/core";
import { MissionExecutionLoop } from "../missions/mission-execution-loop.js";
import { advanceMissionToNextSlice } from "../missions/slice-advance.js";

/*
 * FNXC:MissionSliceAdvanceOnValidation 2026-09-30-13:20:
 * The fake store mirrors `computeSliceStatus` (MissionStore): a slice flips to
 * `complete` once every one of its features is `done` and, for assertion-linked
 * features, `lastValidatorStatus === "passed"`. `completeValidatorRun` therefore
 * performs the same feature→done + slice→complete recompute the real store runs
 * inside the terminal CAS, so the loop's post-pass re-read observes a truthful
 * `complete` slice exactly as production does.
 */

const NOW = new Date().toISOString();

function makeFeature(id: string, sliceId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sliceId,
    title: `Feature ${id}`,
    status: "in-progress",
    loopState: "implementing",
    implementationAttemptCount: 1,
    validatorAttemptCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as any;
}

type Options = {
  /** Feature ids that live on SL-001 and start in-progress. */
  openFeatures?: string[];
  missionOverrides?: Record<string, unknown>;
};

/** Three ordered slices on one milestone: SL-001 (active), SL-002/SL-003 (pending). */
function makeHarness({ openFeatures = ["F-001"], missionOverrides = {} }: Options = {}) {
  const mission = {
    id: "M-001",
    title: "Mission",
    status: "active",
    autoAdvance: true,
    autopilotEnabled: true,
    autopilotState: "inactive",
    interviewState: "not_started",
    createdAt: NOW,
    updatedAt: NOW,
    ...missionOverrides,
  } as any;
  const milestone = {
    id: "MS-001",
    missionId: mission.id,
    title: "Milestone",
    status: "active",
    orderIndex: 0,
    interviewState: "not_started",
    dependencies: [],
    createdAt: NOW,
    updatedAt: NOW,
  } as any;
  const slices = new Map<string, any>([
    ["SL-001", { id: "SL-001", milestoneId: milestone.id, title: "S1", status: "active", planState: "not_started", orderIndex: 0, createdAt: NOW, updatedAt: NOW }],
    ["SL-002", { id: "SL-002", milestoneId: milestone.id, title: "S2", status: "pending", planState: "not_started", orderIndex: 1, createdAt: NOW, updatedAt: NOW }],
    ["SL-003", { id: "SL-003", milestoneId: milestone.id, title: "S3", status: "pending", planState: "not_started", orderIndex: 2, createdAt: NOW, updatedAt: NOW }],
  ]);
  const features = new Map<string, any>();
  for (const id of openFeatures) features.set(id, makeFeature(id, "SL-001"));

  // Mirrors MissionStore.computeSliceStatus.
  const recomputeSlice = (sliceId: string) => {
    const slice = slices.get(sliceId);
    if (!slice) return;
    const owned = [...features.values()].filter((f) => f.sliceId === sliceId);
    if (owned.length === 0) return;
    const allDone = owned.every((f) => f.status === "done" && (f.lastValidatorStatus === "passed" || f.loopState === "idle" || f.loopState === undefined));
    const next = allDone ? "complete" : "active";
    if (slice.status !== next) slices.set(sliceId, { ...slice, status: next, updatedAt: NOW });
  };

  const getMissionWithHierarchy = vi.fn(() => ({
    ...mission,
    milestones: [{
      ...milestone,
      slices: [...slices.values()].map((s) => ({ ...s, features: [...features.values()].filter((f) => f.sliceId === s.id) })),
    }],
  }));

  const runFeatureById = new Map<string, string>();

  const missionStore = {
    getMission: vi.fn((id: string) => (id === mission.id ? mission : undefined)),
    getMissionWithHierarchy,
    getMilestone: vi.fn((id: string) => (id === milestone.id ? milestone : undefined)),
    getSlice: vi.fn((id: string) => slices.get(id)),
    updateSlice: vi.fn((id: string, updates: any) => {
      const next = { ...slices.get(id), ...updates, updatedAt: NOW };
      slices.set(id, next);
      return next;
    }),
    listFeatures: vi.fn((sliceId?: string) => [...features.values()].filter((f) => !sliceId || f.sliceId === sliceId)),
    getFeature: vi.fn((id: string) => features.get(id)),
    getFeatureByTaskId: vi.fn((taskId: string) => [...features.values()].find((f) => f.taskId === taskId)),
    updateFeatureStatus: vi.fn((id: string, status: string) => {
      const existing = features.get(id);
      if (!existing) return undefined;
      const next = { ...existing, status, updatedAt: NOW };
      features.set(id, next);
      recomputeSlice(next.sliceId);
      return next;
    }),
    updateFeature: vi.fn((id: string, updates: any) => {
      const existing = features.get(id);
      if (!existing) return undefined;
      const next = { ...existing, ...updates, updatedAt: NOW };
      features.set(id, next);
      recomputeSlice(next.sliceId);
      return next;
    }),
    transitionLoopState: vi.fn((id: string, newState: string) => {
      const existing = features.get(id);
      if (!existing) return undefined;
      const next = { ...existing, loopState: newState, updatedAt: NOW };
      features.set(id, next);
      return next;
    }),
    listAssertionsForFeature: vi.fn(async () => [{ id: "CA-1", milestoneId: milestone.id, title: "a", assertion: "works", status: "pending", orderIndex: 0, createdAt: NOW, updatedAt: NOW }]),
    ensureFeatureAssertionLinked: vi.fn(async () => [{ id: "CA-1", milestoneId: milestone.id, title: "a", assertion: "works", status: "pending", orderIndex: 0, createdAt: NOW, updatedAt: NOW }]),
    startValidatorRun: vi.fn(async (featureId: string) => {
      const feature = features.get(featureId)!;
      features.set(featureId, { ...feature, loopState: "validating", validatorAttemptCount: (feature.validatorAttemptCount ?? 0) + 1 });
      const run = { id: `VR-${featureId}`, featureId, milestoneId: milestone.id, sliceId: feature.sliceId, status: "running", triggerType: "task_completion", implementationAttempt: 1, validatorAttempt: 1, startedAt: NOW, createdAt: NOW, updatedAt: NOW };
      runFeatureById.set(run.id, featureId);
      return run;
    }),
    completeValidatorRun: vi.fn(async (runId: string, status: string) => {
      const featureId = runFeatureById.get(runId);
      const feature = featureId ? features.get(featureId) : undefined;
      if (feature && status === "passed") {
        const next = { ...feature, status: "done", loopState: "passed", lastValidatorStatus: "passed", updatedAt: NOW };
        features.set(featureId!, next);
        recomputeSlice(next.sliceId);
      }
      return { completionApplied: true };
    }),
    tryActivateNextPendingSlice: vi.fn(async () => {
      const candidate = selectNextSerialMissionSlice(getMissionWithHierarchy(mission.id));
      if (!candidate) return undefined;
      if (slices.get(candidate.id)?.status !== "pending") return undefined;
      const activated = { ...slices.get(candidate.id), status: "active", activatedAt: NOW, updatedAt: NOW };
      slices.set(candidate.id, activated);
      return activated;
    }),
    on: vi.fn(),
    off: vi.fn(),
  } as any;

  const taskStore = {
    getTask: vi.fn(async () => ({ id: "FN-001", title: "Task", description: "desc", column: "done", sliceId: "SL-001", log: [] })),
    getRootDir: vi.fn(() => "/tmp"),
    getTasksDir: vi.fn(() => "/tmp/.fusion/tasks"),
    getSettings: vi.fn(async () => ({})),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
    updateTask: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;

  const onSliceValidated = vi.fn(async (missionId: string) => {
    await advanceMissionToNextSlice(missionStore as unknown as MissionStore, missionId);
  });

  const loop = new MissionExecutionLoop({
    taskStore,
    missionStore: missionStore as unknown as MissionStore,
    rootDir: "/tmp",
    onSliceValidated,
  });
  vi.spyOn(loop as any, "runValidation").mockImplementation(async () => ({
    result: { status: "pass", assertions: [], summary: "ok" },
    inspection: { workspaceStale: false },
  }));
  loop.start();

  /*
   * FNXC:MissionSliceAdvanceOnValidation 2026-09-30-13:24:
   * Drive the REAL validation-pass funnel rather than `processTaskOutcome`. These
   * features deliberately carry NO `taskId` — that is the FUSI-028 hole: the
   * task-completion route cannot reach them at all. `handleValidationPass` is the
   * same entry `runFeatureValidation` uses for every pass verdict (no-assertion
   * early return, `reuse-pass`, and the main `result.status === "pass"` branch).
   */
  const passFeature = async (featureId: string) => {
    const run = await missionStore.startValidatorRun(featureId, "task_completion");
    return (loop as any).handleValidationPass(featureId, run.id, "ok", { featureId, assertions: [] });
  };

  return { mission, slices, features, missionStore, loop, onSliceValidated, openFeatures, passFeature };
}

describe("FUSI-028: slice closed by feature validation advances the next slice", () => {
  it("activates the next pending slice when the last feature closes by validation (no task completing)", async () => {
    const h = makeHarness();

    // No task is linked and none moves; the feature closes purely by a passed
    // validator verdict — the exact FUSI-028 stall.
    await expect(h.passFeature("F-001")).resolves.toBe(true);

    expect(h.features.get("F-001")?.status).toBe("done");
    expect(h.slices.get("SL-001")?.status).toBe("complete");
    expect(h.onSliceValidated).toHaveBeenCalledWith("M-001");
    expect(h.missionStore.tryActivateNextPendingSlice).toHaveBeenCalledWith("M-001");
    expect(h.slices.get("SL-002")?.status).toBe("active");
  });

  it("does not advance while a sibling feature in the slice is still open", async () => {
    const h = makeHarness({ openFeatures: ["F-001", "F-002"] });

    await h.passFeature("F-001");

    // F-002 is still open, so SL-001 is not complete and no advance may fire.
    expect(h.slices.get("SL-001")?.status).toBe("active");
    expect(h.missionStore.tryActivateNextPendingSlice).not.toHaveBeenCalled();
    expect(h.slices.get("SL-002")?.status).toBe("pending");
  });

  it("preserves strict ordering: the earliest pending slice wins, later ones stay pending", async () => {
    const h = makeHarness();

    await h.passFeature("F-001");

    expect(h.slices.get("SL-002")?.status).toBe("active");
    expect(h.slices.get("SL-003")?.status).toBe("pending");
  });

  it("does not advance when the mission is not active", async () => {
    const h = makeHarness({ missionOverrides: { status: "planning" } });

    await h.passFeature("F-001");

    expect(h.slices.get("SL-001")?.status).toBe("complete");
    expect(h.slices.get("SL-002")?.status).toBe("pending");
    expect(h.missionStore.tryActivateNextPendingSlice).not.toHaveBeenCalled();
  });

  it("does not advance when both autopilotEnabled and autoAdvance are false", async () => {
    const h = makeHarness({ missionOverrides: { autopilotEnabled: false, autoAdvance: false } });

    await h.passFeature("F-001");

    expect(h.slices.get("SL-001")?.status).toBe("complete");
    expect(h.slices.get("SL-002")?.status).toBe("pending");
    expect(h.missionStore.tryActivateNextPendingSlice).not.toHaveBeenCalled();
  });

  it("admits at most once for a duplicated pass signal", async () => {
    const h = makeHarness();

    await h.passFeature("F-001");
    const admittedAfterFirst = h.missionStore.tryActivateNextPendingSlice.mock.calls.length;
    expect(admittedAfterFirst).toBe(1);
    expect(h.slices.get("SL-002")?.status).toBe("active");

    // A second pass signal for the same feature re-enters the seam. The store's
    // atomic admission is a no-op now that SL-002 is active.
    await h.passFeature("F-001");
    expect(h.missionStore.tryActivateNextPendingSlice.mock.calls.length).toBe(2);
    expect(h.slices.get("SL-002")?.status).toBe("active");
    expect(h.slices.get("SL-003")?.status).toBe("pending");
  });
});