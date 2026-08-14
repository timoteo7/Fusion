/**
 * FNXC:CodeOrganization 2026-08-03-14:35:
 * Self-owned active-session reconcile before worktree remove (U4 Slice B).
 */
import {
  activeSessionRegistry,
  executingTaskLock,
  reconcileSelfOwnedActiveSessionForRemoval,
} from "../agents/active-session-registry.js";
import { executorLog } from "../logger.js";
import type { RunMutationContext } from "@fusion/core";

export type SelfOwnedReconcileStore = {
  /*
  FNXC:Identity 2026-08-12-01:20 (U18/KTD2 — the seam restates the required context):
  This narrowed store re-declared `logEntry` with NO context parameter, so it did not inherit the
  canonical/deprecated overload pair and would keep accepting unattributed writes even after every
  call site was converted — a hole the census cannot see. Mirror the CANONICAL arity instead.
  Do not relax it back to quiet a caller.
  */
  logEntry: (taskId: string, action: string, outcome: string | undefined, runContext: RunMutationContext) => Promise<unknown>;
};

/**
 * Reconcile a self-owned activeSessionRegistry entry before removeWorktree.
 * Uses the hardened gates (process-active + min-idle window) via worktree-backend.
 */
export async function reconcileSelfOwnedBeforeRemove(
  store: SelfOwnedReconcileStore,
  worktreePath: string,
  taskId: string,
  hasActiveWorktreeBinding: (ownerTaskId: string, path: string) => boolean,
  /** FNXC:Identity 2026-08-12-01:20 (U18/KTD2 Stage C): the run making these writes; REQUIRED so an unwired caller is a compile error, not a silent unattributed write. */
  runContext: RunMutationContext,
): Promise<void> {
  const outcome = reconcileSelfOwnedActiveSessionForRemoval(
    activeSessionRegistry,
    worktreePath,
    taskId,
    (path, ownerTaskId) => hasActiveWorktreeBinding(ownerTaskId, path),
    {
      processActiveProbe: (probeTaskId) => executingTaskLock.has(probeTaskId),
    },
  );
  if (outcome.action === "reconciled") {
    executorLog.warn(
      `[FN-5346] ${taskId}: dropped stale self-owned activeSessionRegistry entry before removeWorktree at ${worktreePath}`,
    );
    await store.logEntry(taskId, "Cleared stale self-owned active-session entry before remove", worktreePath, runContext);
  } else if (outcome.action === "process-active-refuses") {
    executorLog.warn(
      `[FN-5256] refused stale-self-owned reconcile for ${taskId}: process-active=true at ${worktreePath}`,
    );
    await store.logEntry(
      taskId,
      "Refused stale self-owned reconcile — task still actively executing",
      worktreePath, runContext).catch(() => undefined);
  } else if (outcome.action === "too-recent-refuses") {
    executorLog.warn(
      `[FN-5256] refused stale-self-owned reconcile for ${taskId}: age=${outcome.ageMs}ms (<${outcome.minIdleMs}ms) at ${worktreePath}`,
    );
    await store.logEntry(
      taskId,
      `Refused stale self-owned reconcile — registration too recent (${outcome.ageMs}ms < ${outcome.minIdleMs}ms)`,
      worktreePath, runContext).catch(() => undefined);
  }
}
