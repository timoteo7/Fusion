/**
 * FNXC:CodeOrganization 2026-08-10-04:05:
 * Workspace liveness predicates peeled from SelfHealingManager (U5 / wave19 Slice B).
 */
import type { Task } from "@fusion/core";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";

/**
 * FNXC:Workspace 2026-06-22-09:30 (Phase D U1, KTD2 — workspace-aware liveness predicate):
 * A workspace task is LIVE iff ANY of its sub-repo paths is still registered as active
 * (`pathsForTask` ∩ `isPathActive`) OR a process-wide executing/active signal is held.
 */
export function isWorkspaceTaskLive(
  task: Task,
  isTaskActive?: (taskId: string) => boolean,
): { live: boolean; livePaths: string[] } {
  const livePaths = activeSessionRegistry.pathsForTask(task.id).filter((path) => activeSessionRegistry.isPathActive(path));
  const live = livePaths.length > 0
    || executingTaskLock.has(task.id)
    || isTaskActive?.(task.id) === true;
  return { live, livePaths };
}

/**
 * FNXC:Workspace 2026-06-22-14:10 / FNXC:WorkflowResolvedColumns 2026-07-31-23:40:
 * Owner is LIVE unless it is provably terminal — missing, complete-column, or failed.
 */
export function isWorkspaceOwnerLive(owner: Task | null | undefined, completeColumns: ReadonlySet<string>): boolean {
  if (!owner) return false;
  if (completeColumns.has(owner.column)) return false;
  if (owner.status === "failed") return false;
  return true;
}
