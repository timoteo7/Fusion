/**
 * Shared, store-backed seam for mission slice auto-advance.
 *
 * FNXC:MissionSliceAdvanceOnValidation 2026-09-30-13:31:
 * Slice auto-advance used to exist only inside `Scheduler.onSliceComplete`, which
 * is reachable only from a TASK-completion event (`handleMissionTaskCompletion`).
 * A slice whose last feature closes by FEATURE VALIDATION — every feature `done`
 * with a `passed` verdict, and no task completing in the window — never fired that
 * hook, so the next `pending` slice stayed `pending` forever and the mission
 * silently stalled: no error, no progress log. Observed live on M-MULZRJQ4-0001-IF11,
 * where S1.1 closed via F-MUN6HH49-0007-3UMV passing in VR-MUO2D2O3-000L-3MGM and
 * S1.2 (SL-MULZRJXG-000H-ALLI) had to be activated by hand.
 *
 * This module is deliberately a FUNCTION OVER THE MISSION STORE, never a
 * `Scheduler` method. That is the whole point: `MissionAutopilot.advanceToNextSlice`
 * delegates to `Scheduler.activateNextPendingSlice`, and in UI-only mode
 * (`fn dashboard --no-engine`) no `Scheduler` is ever constructed or wired, so a
 * scheduler-shaped seam would be a permanent silent no-op there. A store-backed
 * seam reaches the identical behavior in every mode with no engine bootstrap.
 *
 * Invariants this seam must never break:
 * - The admission itself is delegated to `MissionStore.tryActivateNextPendingSlice`
 *   (atomic, strictly ordered via `selectNextSerialMissionSlice`, duplicate-safe).
 *   Never write slice status directly from a caller.
 * - The `onSliceComplete` guards are reproduced EXACTLY: the mission must exist,
 *   be `active`, and have `autopilotEnabled === true || autoAdvance === true`.
 *   A mission that is not autorunning, or whose autopilot is off, must not advance.
 * - Fail-soft: a throwing store is logged and yields `undefined`. Slice advance is
 *   convenience automation; it must never become a validation/lifecycle dependency.
 */
import type { AsyncMissionStore, MissionStore, Slice } from "@fusion/core";
import { createLogger } from "../logger.js";

const sliceAdvanceLog = createLogger("mission-slice-advance");

/** Resolves a mission ID's next serially-eligible slice, honoring every advance guard. */
export type MissionStoreLike = Pick<MissionStore | AsyncMissionStore, "getMission" | "tryActivateNextPendingSlice">;

/**
 * Promote-and-advance one step for an autopilot-enabled, active mission.
 *
 * Both closure routes converge here — the task-completion route
 * (`Scheduler.onSliceComplete`) and the feature-validation route
 * (`MissionExecutionLoop` → `onSliceValidated`) — so they cannot drift.
 *
 * @param missionStore - Mission store (sync or async backend)
 * @param missionId - Mission whose next `pending` slice should be admitted
 * @returns The admitted slice, or `undefined` when nothing was eligible
 */
export async function advanceMissionToNextSlice(
  missionStore: MissionStoreLike,
  missionId: string,
): Promise<Slice | undefined> {
  try {
    const mission = await missionStore.getMission(missionId);
    // `autopilotEnabled` is canonical; `autoAdvance` is the legacy field kept for
    // backward compatibility. This pair is the onSliceComplete guard, verbatim.
    const shouldAutoAdvance = mission?.autopilotEnabled === true || mission?.autoAdvance === true;
    if (!mission || mission.status !== "active" || !shouldAutoAdvance) {
      return undefined;
    }

    // The store re-reads the hierarchy and claims the candidate atomically, so a
    // duplicate pass signal is a no-op rather than a double activation.
    return await missionStore.tryActivateNextPendingSlice(missionId);
  } catch (err) {
    sliceAdvanceLog.error(`Error advancing mission ${missionId} to its next slice:`, err);
    return undefined;
  }
}
