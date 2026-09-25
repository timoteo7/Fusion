import type { Task } from "../types.js";

export const IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON = "in-review-stall-deadlock";

export const MANUAL_RETRY_RESET_COUNTER_KEYS = [
  "stuckKillCount",
  "resumeLimboCount",
  "executeRequeueLoopCount",
  "graphResumeRetryCount",
  "consecutiveToolFailureRetryCount",
  "recoveryRetryCount",
  "sessionContentionHoldCount",
  "taskDoneRetryCount",
  "worktreeSessionRetryCount",
  "workflowStepRetries",
  "verificationFailureCount",
  "postReviewFixCount",
  "planReviewReplanCount",
  "mergeConflictBounceCount",
  "branchConflictRecoveryCount",
  "reviewerContextRetryCount",
  "reviewerFallbackRetryCount",
  "reviewConvergenceStage",
  "reviewConvergenceEscalationCount",
  "completionHandoffLimboRecoveryCount",
  "mergeAuditBounceCount",
] as const satisfies ReadonlyArray<keyof Task>;

export function buildAutoPauseClearPatch(
  task: Pick<Task, "paused" | "userPaused" | "pausedReason">,
): Partial<Task> {
  // FNXC:ManualRetryReset 2026-09-23-18:00:
  // Root cause (operator board): the manual retry cleared the engine pause ONLY for the in-review-stall-deadlock
  // reason, so any OTHER engine park (branch-conflict-unrecoverable, tripwires, rate-limits) survived fn_task_retry
  // as {paused:true, pausedReason:...} and the card stayed functionally paused (GDPR-075, FUSI-023). A manual retry is
  // an explicit resume, so it must clear ANY non-user pause; userPaused is operator-owned and stays untouched.
  if (
    task.paused === true
    && task.userPaused !== true
  ) {
    return {
      paused: false,
      pausedReason: null as unknown as Task["pausedReason"],
    };
  }

  return {};
}

export function buildManualRetryResetPatch(options?: { resetMergeRetries?: boolean }): Partial<Task> {
  const patch: Partial<Task> = {
    nextRecoveryAt: null as unknown as Task["nextRecoveryAt"],
    sessionContentionWaitReason: null as unknown as Task["sessionContentionWaitReason"],
    executorEscalationAttempted: false,
    toolFailureDetectorLogCursor: null,
    toolFailureRetryExhaustedAuditEmitted: false,
    // FNXC:Lifecycle 2026-07-16-21:40:
    // FN-8141 — an operator manual retry/edit is an honest exit signal that clears the
    // skip-bypass taint, so a legitimately retried task can promote on its skipped steps.
    bulkCompletionRefusalAt: null as unknown as Task["bulkCompletionRefusalAt"],
  };

  for (const key of MANUAL_RETRY_RESET_COUNTER_KEYS) {
    patch[key] = 0;
  }

  if (options?.resetMergeRetries) {
    patch.mergeRetries = 0;
  }

  return patch;
}
