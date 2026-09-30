/**
 * MissionAutopilot health-check eligibility regression (FUSI-026).
 *
 * The periodic health check used to gate itself on the derived in-memory `watchedMissions` map:
 *
 *     if (!this.running || this.watchedMissions.size === 0) return;
 *
 * That map is written only by `poll()` and `recoverMissions()`, so an autopilot process that started
 * without a preceding poll kept it empty forever and the corrector became a silent no-op that still
 * logged "fixed 0 inconsistencies" every interval. Measured on M-MULZRJQ4-0001-IF11: the API
 * reported `{"enabled":true,"state":"watching","watched":false}` while 6 health checks in 30 minutes
 * each logged "fixed 0" and slice S1.1 stayed `active` for 12+ hours.
 *
 * These tests pin the corrected contract: eligibility is derived from each mission's own
 * `autopilotEnabled` / `status`, an unwatched autopilot mission is auto-watched before being
 * reconciled, and the sweep stays reconcile-only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MissionAutopilot } from "../missions/mission-autopilot.js";
import { autopilotLog } from "../logger.js";
import type { Mission, Milestone, Slice, MissionFeature } from "@fusion/core";

// ── Mock Factories ──────────────────────────────────────────────────

function createMockMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "M-UNWATCHED",
    title: "Unwatched Mission",
    status: "active",
    interviewState: "not_started",
    autoAdvance: true,
    autopilotEnabled: true,
    // The state a restarted autopilot process finds on disk: the flag is on, the in-memory
    // watch registry is empty, and nothing has re-asserted "watching" yet.
    autopilotState: "inactive",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockMilestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: "MS-001",
    missionId: "M-UNWATCHED",
    title: "Test Milestone",
    status: "active",
    orderIndex: 0,
    interviewState: "not_started",
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockSlice(overrides: Partial<Slice> = {}): Slice {
  return {
    id: "SL-001",
    milestoneId: "MS-001",
    title: "Test Slice",
    status: "active",
    planState: "not_started",
    orderIndex: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockFeature(overrides: Partial<MissionFeature> = {}): MissionFeature {
  return {
    id: "F-001",
    sliceId: "SL-001",
    title: "Test Feature",
    status: "triaged",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockMissionStore(missions: Mission[] = []) {
  const missionMap = new Map(missions.map((m) => [m.id, m]));

  return {
    getMission: vi.fn((id: string) => missionMap.get(id)),
    listMissions: vi.fn(() => [...missionMap.values()]),
    updateMission: vi.fn((id: string, updates: Partial<Mission>) => {
      const existing = missionMap.get(id);
      if (!existing) throw new Error(`Mission ${id} not found`);
      const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
      missionMap.set(id, updated);
      return updated;
    }),
    logMissionEvent: vi.fn((missionId: string, eventType: string, description: string, metadata?: Record<string, unknown>) => ({
      id: `ME-${Date.now()}`,
      missionId,
      eventType,
      description,
      metadata: metadata ?? null,
      timestamp: new Date().toISOString(),
    })),
    getMilestone: vi.fn(),
    listMilestones: vi.fn(),
    getSlice: vi.fn(),
    listSlices: vi.fn(),
    getFeatureByTaskId: vi.fn(),
    listFeatures: vi.fn(),
    updateFeatureStatus: vi.fn(),
    getMissionWithHierarchy: vi.fn(),
    updateSlice: vi.fn((id: string, updates: Partial<any>) => ({
      id,
      ...updates,
      updatedAt: new Date().toISOString(),
    })),
    computeSliceStatus: vi.fn((id: string) => "pending"),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  };
}

function createMockTaskStore() {
  return {
    on: vi.fn(),
    off: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({
      missionStaleThresholdMs: 600_000,
      missionMaxTaskRetries: 3,
      missionHealthCheckIntervalMs: 300_000,
    }),
    getTask: vi.fn().mockResolvedValue({ id: "FN-001", column: "in-progress" }),
    listTasks: vi.fn().mockResolvedValue([]),
    moveTask: vi.fn().mockResolvedValue({ id: "FN-001", column: "todo" }),
    updateTask: vi.fn().mockResolvedValue({}),
    createTask: vi.fn(),
  };
}

function createMockScheduler() {
  return {
    activateNextPendingSlice: vi.fn().mockResolvedValue(null),
  };
}

/** A hierarchy whose single feature is drifted from its linked task's real column. */
function driftedHierarchy(overrides: Partial<Mission> = {}) {
  return {
    ...createMockMission(overrides),
    milestones: [{
      ...createMockMilestone(),
      slices: [{
        ...createMockSlice({ status: "active" }),
        features: [createMockFeature({ id: "F-001", status: "triaged", taskId: "FN-001" })],
      }],
    }],
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("MissionAutopilot health check — unwatched missions (FUSI-026)", () => {
  let autopilot: MissionAutopilot;
  let missionStore: ReturnType<typeof createMockMissionStore>;
  let taskStore: ReturnType<typeof createMockTaskStore>;
  let scheduler: ReturnType<typeof createMockScheduler>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  /** runHealthCheck is private; reach it the same way the existing autopilot suite does. */
  const runHealthCheck = (): Promise<void> => (autopilot as any).runHealthCheck();

  beforeEach(() => {
    vi.useFakeTimers();
    const mission = createMockMission();
    missionStore = createMockMissionStore([mission]);
    taskStore = createMockTaskStore();
    scheduler = createMockScheduler();
    logSpy = vi.spyOn(autopilotLog, "log").mockImplementation(() => {});

    autopilot = new MissionAutopilot(
      taskStore as any,
      missionStore as any,
      { scheduler },
    );
  });

  afterEach(() => {
    autopilot.stop();
    vi.useRealTimers();
    logSpy.mockRestore();
  });

  // ── The reported failure ────────────────────────────────────────

  it("reconciles an autopilot-enabled mission even when the watch registry is empty", async () => {
    autopilot.start();
    // Precondition: nothing has ever watched this mission in this process.
    expect(autopilot.isWatching("M-UNWATCHED")).toBe(false);
    expect(autopilot.getWatchedMissionIds()).toEqual([]);

    missionStore.getMissionWithHierarchy.mockReturnValue(driftedHierarchy());
    taskStore.getTask.mockResolvedValue({ id: "FN-001", column: "in-progress" });

    await runHealthCheck();

    // (a) The sweep did not bail out: the mission was auto-adopted into the watch registry.
    expect(autopilot.isWatching("M-UNWATCHED")).toBe(true);
    expect(missionStore.updateMission).toHaveBeenCalledWith(
      "M-UNWATCHED",
      expect.objectContaining({ autopilotState: "watching" }),
    );

    // (b) The sweep actually reconciled: the drifted feature was repaired to the task's real lane.
    expect(missionStore.updateFeatureStatus).toHaveBeenCalledWith(
      "F-001",
      "in-progress",
      expect.objectContaining({ actor: expect.objectContaining({ source: "mission-reconcile:autopilot" }) }),
    );
  });

  it("reconciles the exact reported symptom: autopilotState=watching on disk but never watched", async () => {
    // M-MULZRJQ4-0001-IF11 reported {"enabled":true,"state":"watching","watched":false}: the
    // persisted state already claimed "watching" while the process-local registry never got there,
    // so no state write is owed — the sweep must still repair the bookkeeping.
    const stuck = createMockMission({ autopilotState: "watching" });
    missionStore = createMockMissionStore([stuck]);
    taskStore = createMockTaskStore();
    scheduler = createMockScheduler();
    autopilot = new MissionAutopilot(taskStore as any, missionStore as any, { scheduler });

    autopilot.start();
    expect(autopilot.isWatching("M-UNWATCHED")).toBe(false);

    missionStore.getMissionWithHierarchy.mockReturnValue(driftedHierarchy({ autopilotState: "watching" }));
    taskStore.getTask.mockResolvedValue({ id: "FN-001", column: "in-progress" });

    await runHealthCheck();

    expect(autopilot.isWatching("M-UNWATCHED")).toBe(true);
    expect(missionStore.updateFeatureStatus).toHaveBeenCalledWith(
      "F-001",
      "in-progress",
      expect.objectContaining({ actor: expect.objectContaining({ source: "mission-reconcile:autopilot" }) }),
    );
  });

  it("distinguishes a real sweep from 'no eligible mission' in the log", async () => {
    autopilot.start();
    missionStore.getMissionWithHierarchy.mockReturnValue(driftedHierarchy());

    await runHealthCheck();
    const sweptMessages = logSpy.mock.calls.map(([message]) => String(message));
    expect(sweptMessages.some((m) => m.includes("Mission health check complete: reconciled 1 mission"))).toBe(true);
    expect(sweptMessages.some((m) => m.includes("no eligible missions"))).toBe(false);
    // The adoption line names the mission id it adopted, mirroring the poll auto-watch wording.
    expect(sweptMessages.some((m) => m.includes("auto-watching mission M-UNWATCHED"))).toBe(true);
  });

  it("logs an explicit 'no eligible missions' line and reconciles nothing when there are no live missions", async () => {
    missionStore = createMockMissionStore([]);
    taskStore = createMockTaskStore();
    scheduler = createMockScheduler();
    autopilot = new MissionAutopilot(taskStore as any, missionStore as any, { scheduler });

    autopilot.start();
    await runHealthCheck();

    const messages = logSpy.mock.calls.map(([message]) => String(message));
    expect(messages.some((m) => m.includes("no eligible missions"))).toBe(true);
    expect(missionStore.getMissionWithHierarchy).not.toHaveBeenCalled();
    expect(missionStore.updateFeatureStatus).not.toHaveBeenCalled();
  });

  // ── Terminal missions ───────────────────────────────────────────

  it.each([
    ["complete", "complete"],
    ["archived", "archived"],
  ] as const)("never reconciles a %s mission", async (_label, status) => {
    const terminal = createMockMission({ status });
    missionStore = createMockMissionStore([terminal]);
    taskStore = createMockTaskStore();
    scheduler = createMockScheduler();
    autopilot = new MissionAutopilot(taskStore as any, missionStore as any, { scheduler });

    autopilot.start();
    missionStore.getMissionWithHierarchy.mockReturnValue(
      driftedHierarchy({ status }),
    );

    await runHealthCheck();

    expect(missionStore.getMissionWithHierarchy).not.toHaveBeenCalled();
    expect(missionStore.updateFeatureStatus).not.toHaveBeenCalled();
    expect(autopilot.isWatching("M-UNWATCHED")).toBe(false);
  });

  // ── Autopilot-off but active ────────────────────────────────────

  it("reconciles an active mission with autopilot off without watching it", async () => {
    const manual = createMockMission({ autopilotEnabled: false, autoAdvance: false });
    missionStore = createMockMissionStore([manual]);
    taskStore = createMockTaskStore();
    scheduler = createMockScheduler();
    autopilot = new MissionAutopilot(taskStore as any, missionStore as any, { scheduler });

    autopilot.start();
    missionStore.getMissionWithHierarchy.mockReturnValue(
      driftedHierarchy({ autopilotEnabled: false, autoAdvance: false }),
    );
    taskStore.getTask.mockResolvedValue({ id: "FN-001", column: "in-progress" });

    await runHealthCheck();

    // Reconciled...
    expect(missionStore.updateFeatureStatus).toHaveBeenCalledWith(
      "F-001",
      "in-progress",
      expect.objectContaining({ actor: expect.objectContaining({ source: "mission-reconcile:autopilot" }) }),
    );
    // ...but never adopted into the watch registry: reconciliation is not opt-in to watching.
    expect(autopilot.isWatching("M-UNWATCHED")).toBe(false);
  });

  // ── Robustness ──────────────────────────────────────────────────

  it("continues the sweep when getMissionWithHierarchy returns undefined", async () => {
    autopilot.start();
    missionStore.getMissionWithHierarchy.mockReturnValue(undefined);

    await expect(runHealthCheck()).resolves.toBeUndefined();

    // Auto-watch still happened even though reconciliation had nothing to read.
    expect(autopilot.isWatching("M-UNWATCHED")).toBe(true);
    const messages = logSpy.mock.calls.map(([message]) => String(message));
    expect(messages.some((m) => m.includes("reconciled 0 missions"))).toBe(true);
  });

  it("skips one failing mission and still reconciles the others", async () => {
    const second = createMockMission({ id: "M-SECOND" });
    missionStore = createMockMissionStore([createMockMission(), second]);
    taskStore = createMockTaskStore();
    scheduler = createMockScheduler();
    autopilot = new MissionAutopilot(taskStore as any, missionStore as any, { scheduler });
    logSpy.mockRestore();
    const errorSpy = vi.spyOn(autopilotLog, "error").mockImplementation(() => {});
    const okSpy = vi.spyOn(autopilotLog, "log").mockImplementation(() => {});

    autopilot.start();
    missionStore.getMissionWithHierarchy.mockImplementation((id: string) => {
      if (id === "M-UNWATCHED") throw new Error("store exploded");
      return driftedHierarchy({ id });
    });
    taskStore.getTask.mockResolvedValue({ id: "FN-001", column: "in-progress" });

    await expect(runHealthCheck()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    expect(okSpy.mock.calls.map(([m]) => String(m)).some((m) => m.includes("reconciled 1 mission"))).toBe(true);
    expect(autopilot.isWatching("M-SECOND")).toBe(true);

    errorSpy.mockRestore();
    okSpy.mockRestore();
  });

  // ── Invariants: reconcile-only, never progress ──────────────────

  it("creates no board task, promotes no slice, and writes no slice status", async () => {
    autopilot.start();
    missionStore.getMissionWithHierarchy.mockReturnValue(driftedHierarchy());
    taskStore.getTask.mockResolvedValue({ id: "FN-001", column: "in-progress" });

    await runHealthCheck();

    // No task creation.
    expect(taskStore.createTask).not.toHaveBeenCalled();
    // No slice promotion via the scheduler.
    expect(scheduler.activateNextPendingSlice).not.toHaveBeenCalled();
    // No slice status write.
    expect(missionStore.updateSlice).not.toHaveBeenCalled();
  });

  it("does not run at all when the autopilot is not started", async () => {
    // running === false is the only remaining early return.
    await runHealthCheck();

    expect(missionStore.listMissions).not.toHaveBeenCalled();
    expect(missionStore.updateFeatureStatus).not.toHaveBeenCalled();
  });
});
