---
"@runfusion/fusion": patch
---

summary: Fix missions stalling when a stage closed by validation instead of a completed task.
category: fix
dev: Both slice-closure routes (task completion and feature validation) now converge on the shared store-backed `advanceMissionToNextSlice` seam in `packages/engine/src/missions/slice-advance.ts`. `MissionExecutionLoop` fires it from `notifyValidationPass` via a new optional `onSliceValidated` callback, wired in both `in-process-runtime.ts` (engine mode) and `cli/src/commands/dashboard.ts` (UI-only mode, where no `Scheduler` exists). Also removed the `if (!feature?.taskId) return;` early-return in both `notifyValidationComplete` implementations that swallowed the no-task path. Guards are unchanged: mission must be `active` with `autopilotEnabled || autoAdvance`, admission stays strictly ordered through `tryActivateNextPendingSlice`, and the seam is fail-soft.
