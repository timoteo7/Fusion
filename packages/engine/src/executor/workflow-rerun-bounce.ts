/**
 * FNXC:CodeOrganization 2026-08-03-21:45:
 * performWorkflowRerunBounce peeled from TaskExecutor (U4).
 * Move in-progress/in-review → rebound → wip for remediation with re-entry and pause guards.
 *
 * FNXC:WorkflowOptionalStepFix 2026-06-27-13:30:
 * A pre-merge optional step REVISE schedules this bounce via sendTaskBackForFix AFTER reopening
 * the last plan step to pending. in-review must bounce like in-progress to avoid deadlock.
 */
import type { Task, TaskStore } from "@fusion/core";
import {
  ACTIVE_WORKFLOW_WORK_ITEM_STATES,
  hasPendingReviewRemediationWork,
  resolveStepReopenPolicy,
  resolveWipTargetForTask,
  resolveWorkflowIrForTask,
  type WorkflowWorkItemState,
} from "@fusion/core";
import { executorLog } from "../logger.js";
import { moveTaskWithLifecycleReason } from "../execution/lifecycle-move.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { generateSyntheticRunId } from "../util/run-audit.js";
import { resolveReboundColumnFor } from "./lifecycle-columns.js";

/*
FNXC:ReviewBounceCapacityHandOff 2026-10-02-00:20:
A Code Review REVISE appends its replay step to the DURABLE ledger (reopenLastStepForRevision) and only
THEN attempts the review→WIP hand-off, which is a best-effort setTimeout bounce. When the WIP lane is
at capacity the move is caught and logged "retrying later", but before FUSI-068 nothing retried: the
replay step stayed `pending` forever, `getTaskMergeBlocker` correctly returned "task has incomplete
steps", no sweep is keyed on a non-terminal step, and `surfaceInReviewStalls` auto-disposed the card
as `in-review-stall-deadlock`. The reviewer's real work was dropped with only a log line as evidence.

The deferral is now DURABLE. On `deferred-capacity` this function writes the SAME durable
continuation shape the graph's own capacity-suspend already uses (`workflow-column-boundary-hooks.ts`
onSuspend: `state:"held"`, `waitReason:"capacity"`, `sourceColumn`/`targetColumn`), so the existing
due-drain (`drainDuePlanningContinuations`, which admits EVERY due `kind:"task"` continuation whatever
its waitReason) resumes the card when a slot frees, and `reconcileStrandedWorkflowContinuations`
covers a continuation whose writing process died before the drain saw it. The invariant this restores:
a committed pending step must never exist without a live path to the executor.

An ACTIVE continuation for the same node is honored rather than duplicated (same live-wait guard the
graph hook uses): a cancelled/exhausted row is finished work, and treating it as live would strand the
card with nothing to resume from.

Reservation-FIRST (AC1 option a) is deliberately NOT used here. The production `reserveSlot`
(`scheduler.ts`) closes over per-dispatch-pass local scope-lease registries (`activeScopes`,
`dormantScopes`, `leaseWaiverIds`) that the executor's bounce cannot reach — grep shows exactly one
production call site. Sharing it would require extracting scheduler-internal state out of the
dispatch loop, well beyond this fix's blast radius, and a no-op reservation would make a caller
believe a slot is held. Durable continuation is the honest mechanism; the FN-267 empty-hand-off guard
below is unchanged so a bounce with no pending work is still refused.
*/

export type WorkflowRerunBounceDeps = {
  store: TaskStore;
  workflowRerunPending: Set<string>;
  getExecutionPauseLabel: () => Promise<string | null>;
  resolveResumeLanes: (taskId: string) => Promise<{ wip: string; review: string }>;
  clearTerminalStepFailuresForRetry: (taskId: string, mode: "archive" | "clear") => Promise<void>;
};

/**
 * Record the durable capacity wait for a review→WIP bounce that lost the race (FUSI-068).
 *
 * Mirrors the graph's capacity-suspend continuation (`workflow-column-boundary-hooks.ts` `onSuspend`)
 * so both capacity crossings in the codebase park through ONE durable shape that the due-drain and
 * the stranded-continuation sweep already understand. Best-effort: a failure to write the marker must
 * not mask the underlying deferral, and the Step-5 shape sweep is the backstop for a lost marker.
 */
export async function recordBounceCapacityWait(
  store: TaskStore,
  taskId: string,
  sourceColumn: string,
  targetColumn: string,
  nodeId: string,
): Promise<boolean> {
  try {
    const items = await store.listWorkflowWorkItemsForTask(taskId, { kinds: ["task"] });
    const live = items.filter((item) =>
      ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state as WorkflowWorkItemState));
    if (live.some((item) => item.nodeId === nodeId)) return false;
    // The executor's bounce does not hold the graph's run id (it fires from a setTimeout after the
    // graph already yielded), so it uses the SAME `${taskId}:workflow` stable fallback the graph hook
    // itself applies when `workflowRunId` is unknown. The due-drain keys on `taskId`, not `runId`.
    const stableRunId = `${taskId}:workflow`;
    await store.replaceActiveTaskWorkflowContinuation({
      runId: `${stableRunId}:continuation:${nodeId}:${items.length}`,
      taskId,
      nodeId,
      kind: "task",
      state: "held",
      stableWorkflowRunId: stableRunId,
      continuationSequence: items.length,
      waitReason: "capacity",
      sourceColumn,
      targetColumn,
    });
    executorLog.log(`${taskId}: review bounce deferred for capacity — durable wait recorded (${sourceColumn} → ${targetColumn})`);
    /*
    FNXC:ReviewBounceCapacityHandOff 2026-10-02-00:20:
    Ids/columns/fixed outcome only. The merge-blocker string, the replay step's name, and reviewer
    prose stay on the task; bounded telemetry never becomes a lifecycle dependency.
    */
    await emitBoundedRunAudit(store, {
      taskId,
      agentId: "executor",
      runId: generateSyntheticRunId("review-bounce-capacity", taskId),
      domain: "database",
      mutationType: "task:review-bounce-capacity-parked",
      target: taskId,
      metadata: { taskId, sourceColumn, targetColumn, outcome: "durable-wait-recorded" },
    });
    return true;
  } catch (err: unknown) {
    executorLog.warn(`${taskId}: could not record durable capacity wait for review bounce: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function performWorkflowRerunBounce(
  deps: WorkflowRerunBounceDeps,
  taskId: string,
  worktreePath: string,
  preserveResumeState: boolean = true,
  /*
  FNXC:ExternalExecutionCheckout 2026-08-09-22:43:
  When false, do not persist the remediation path as task.worktree (external checkouts).
  */
  persistWorktreePath: boolean = true,
): Promise<"bounced" | "skipped-pending" | "deferred-paused" | "deferred-capacity" | "refused-no-remediation"> {
  const pauseLabel = await deps.getExecutionPauseLabel();
  if (pauseLabel) {
    executorLog.log(`${taskId}: workflow rerun deferred — ${pauseLabel} active`);
    return "deferred-paused";
  }

  // Re-entry guard: if a previous bounce for the same task is still
  // mid-flight (e.g., the watchdog fired before the original sequence
  // completed), skip rather than racing two concurrent moveTask sequences.
  if (deps.workflowRerunPending.has(taskId)) {
    executorLog.warn(`${taskId}: workflow rerun bounce already in flight — skipping re-entry`);
    return "skipped-pending";
  }
  deps.workflowRerunPending.add(taskId);
  try {
    // moveTask(in-progress → todo) clears `task.worktree`; restore it before
    // the return trip so the dashboard never renders the task under
    // "Unassigned" and self-healing can't reclaim the worktree as idle.
    const latestTask = await deps.store.getTask(taskId);
    if (!latestTask) {
      throw new Error("task missing during workflow rerun bounce");
    }
    if (latestTask.paused) {
      executorLog.log(`${taskId}: workflow rerun deferred — task is paused`);
      return "deferred-paused";
    }
    /* FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): both lanes from ONE snapshot — the comment
       above says in-review must bounce EXACTLY like in-progress, so resolving them separately is how the
       bounce ends up handling one lane and throwing on the other, which is the bug that comment is about. */
    const bounceLanes = await deps.resolveResumeLanes(taskId);
    /*
    FNXC:LifecycleContainment 2026-08-30-12:57:
    FN-267 keeps the review-to-WIP guard but asks whether the selected workflow has produced its
    own remediation model before moving. Named-remediation workflows require a pending structural
    fix step; trailing-reopen workflows instead produce a plain pending replay occurrence. An IR
    resolution failure stays strict so an unknown workflow never receives an empty hand-off.
    */
    const workflowIr = await resolveWorkflowIrForTask(deps.store, taskId).catch(() => undefined);
    const stepReopenPolicy = workflowIr ? resolveStepReopenPolicy(workflowIr) : "none";
    if (latestTask.column === bounceLanes.review && !hasPendingReviewRemediationWork(latestTask, { stepReopenPolicy })) {
      await deps.store.logEntry(
        taskId,
        "Workflow rerun refused — no pending remediation work",
        "A review revision may return to implementation only after the workflow has produced pending remediation work.",
      );
      return "refused-no-remediation";
    }
    if (latestTask.column === bounceLanes.wip || latestTask.column === bounceLanes.review) {
      const originalExecutionStartedAt = latestTask.executionStartedAt;
      /*
      FNXC:LifecycleContainment 2026-08-28-02:24:
      FN-207 removes the old review → Planning → WIP rerun hop. Review remediation moves directly
      to WIP, while remediation already in WIP stays there; both preserve the checkout and progress.
      A full WIP lane defers the card in review for the watchdog retry instead of retargeting Planning.
      */
      if (latestTask.column === bounceLanes.review) {
        const moveResult = await moveTaskWithLifecycleReason(
          deps.store,
          taskId,
          bounceLanes.wip,
          "code-review-revise-remediation",
          {
            ...(preserveResumeState ? { preserveResumeState: true } : {}),
            preserveWorktree: true,
            workflowMoveSource: "workflow-remediation",
          },
        );
        if (!moveResult.moved) {
          /*
          FNXC:ReviewBounceCapacityHandOff 2026-10-02-00:20:
          The replay step for this REVISE is already committed to the durable ledger. A capacity
          refusal therefore strands real review work unless the wait itself is durable — record it
          through the same continuation shape the graph's capacity-suspend writes, so the existing
          due-drain resumes the card when a slot frees. Best-effort by design: the marker write never
          masks the deferral, and the shape sweep is the backstop if it is lost.
          */
          await recordBounceCapacityWait(
            deps.store,
            taskId,
            latestTask.column,
            bounceLanes.wip,
            `workflow-remediation:${taskId}`,
          );
          return "deferred-capacity";
        }
      }
      await deps.store.updateTask(taskId, {
        ...(persistWorktreePath ? { worktree: worktreePath } : {}),
        executionStartedAt: originalExecutionStartedAt ?? null,
      });
      const pauseLabelAfterMove = await deps.getExecutionPauseLabel();
      if (pauseLabelAfterMove) {
        executorLog.log(`${taskId}: workflow rerun contained in ${bounceLanes.wip} — ${pauseLabelAfterMove} became active during bounce`);
        return "deferred-paused";
      }
      await deps.clearTerminalStepFailuresForRetry(taskId, "archive");
      return "bounced";
    }

    if (latestTask.column === await resolveReboundColumnFor(deps.store, taskId)) {
      if (persistWorktreePath) await deps.store.updateTask(taskId, { worktree: worktreePath });
      const pauseLabelBeforeResume = await deps.getExecutionPauseLabel();
      if (pauseLabelBeforeResume) {
        executorLog.log(`${taskId}: workflow rerun parked in todo — ${pauseLabelBeforeResume} became active before resume`);
        return "deferred-paused";
      }
      // Already in `todo` (non-mergeable) — archive prior gate failures for the next reviewer.
      await deps.clearTerminalStepFailuresForRetry(taskId, "archive");
      /* FNXC:WorkflowResolvedColumns 2026-07-30-21:40: census-invisible moveTask DESTINATION — a call argument, not a comparison. The SOURCE guard four lines up already resolves via resolveReboundColumnFor; leaving the destination literal is a split brain inside one function. */
      await deps.store.moveTask(taskId, await resolveWipTargetForTask(deps.store, taskId));
      return "bounced";
    }

    throw new Error(`task is in '${latestTask.column}', cannot bounce to in-progress`);
  } finally {
    deps.workflowRerunPending.delete(taskId);
  }
}
