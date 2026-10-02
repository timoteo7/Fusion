import { isPlanReviewSatisfied, PlanningLifecycleLockTransportError, type Task } from "@fusion/core";

export const LEGACY_NULL_PLAN_HANDOFF_STALE_MS = 30 * 60 * 1000;

export type PersistedPlanHandoffKind = "planning" | "approved-null" | "legacy-null";

export function isPlanningLifecycleLockTransportError(error: unknown): error is Error {
  return error instanceof PlanningLifecycleLockTransportError
    || (error instanceof Error && error.name === "PlanningLifecycleLockTransportError");
}

/**
 * FNXC:PlanningLifecycleLock 2026-08-23-06:25:
 * Graph boundaries can flatten a typed transport rejection to text. Keep the
 * recovery fallback anchored to the lock's five canonical messages so a generic
 * timeout never changes executor retry classification.
 */
export function isPlanningLifecycleLockTransportFailure(error: unknown, message: string): boolean {
  if (isPlanningLifecycleLockTransportError(error)) return true;
  return /^Planning lifecycle lock (?:acquisition timed out after \d+ms|acquisition failed|cleanup timed out after \d+ms|cleanup failed|transport unavailable: .+)$/i.test(message);
}

/**
 * Shared persisted-state classifier for planning handoff recovery. It deliberately
 * excludes graph work-item/step-instance evidence, which callers must check at
 * their own store boundary before acting on a `legacy-null` result.
 */
export function classifyPersistedPlanHandoff(
  task: Pick<Task,
    | "status"
    | "paused"
    | "userPaused"
    | "approvedPlanFingerprint"
    | "awaitingApprovalReason"
    | "workflowStepResults"
    | "updatedAt"
    | "steps"
    | "worktree"
    | "firstExecutionAt"
    | "executionStartedAt"
  >,
  options: {
    now: number;
    hasLivePlanningWork: boolean;
    legacyStaleMs?: number;
    requirePersistedSteps?: boolean;
  },
): PersistedPlanHandoffKind | null {
  if (task.paused || task.userPaused || options.hasLivePlanningWork) return null;
  // FNXC:PlanningHandoffRecovery 2026-08-04-06:35 (FN-8768): Manual approval
  // parks and execution evidence outrank stale planning projections. In particular,
  // a retained Plan Review approval must never make an operator-held or already-
  // executing task eligible for planning-handoff recovery.
  if (task.awaitingApprovalReason) return null;
  if (task.firstExecutionAt || task.executionStartedAt) return null;
  // A planning worktree belongs to the planner and may legitimately survive a
  // crashed session. It must not hide a written plan from canonical handoff
  // recovery. Null-status compatibility recovery remains fenced below because
  // at that point a retained worktree is ambiguous execution evidence.
  if (task.status === "planning") return "planning";
  if (task.status != null) return null;
  if (task.worktree) return null;
  if (task.workflowStepResults?.some(isPlanReviewSatisfied)) return "approved-null";
  if (task.approvedPlanFingerprint != null) return null;
  if (task.workflowStepResults?.length) return null;
  if (options.requirePersistedSteps && !task.steps?.length) return null;

  const staleMs = options.legacyStaleMs ?? 0;
  const updatedAt = new Date(task.updatedAt).getTime();
  if (!Number.isFinite(updatedAt) || options.now - updatedAt < staleMs) return null;
  return "legacy-null";
}

/**
 * FNXC:TriagePlanningRecovery 2026-09-19-04:04:
 * Requirement: a card left in planning may never be a silent no-op, and the graph fence that guards
 * legacy null-status handoff repair must only defer to a LIVE graph run.
 *
 * `listWorkflowWorkItemsForTask` returns the card's whole work-item history, not just live rows, so
 * the previous `len === 0` fence read finished history as in-flight work. Every card that had ever
 * recorded an item was refused — in production the sweep logged `Recovering specified triage task
 * FN-XXXX` on every poll and `recoverApprovedTask` returned false without a reason, so the board
 * showed cards stuck in planning with no cause recorded anywhere.
 *
 * Terminal states are finished work: they cannot own the card. Anything else (runnable, running,
 * held, retrying, manual-required, or an unknown future state) still blocks, which keeps the fence's
 * original purpose — never double-finalize a plan whose graph run is live.
 *
 * Mirrors `TaskStore.isTerminalWorkflowWorkItemState`; kept as a local predicate because engine unit
 * stores are narrow partial adapters that do not implement that method.
 */
export const TERMINAL_WORK_ITEM_STATES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "exhausted",
]);

/** True when the card still has at least one work item that is not finished history. */
export function hasNonTerminalWorkItem(items: readonly { state: string }[] | undefined | null): boolean {
  return (items ?? []).some((item) => !TERMINAL_WORK_ITEM_STATES.has(item.state));
}
