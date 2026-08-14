/**
 * FNXC:CodeOrganization 2026-08-03-14:50:
 * normalizeReclaimableWorktreePath peeled from TaskExecutor (U4 Slice B).
 */
import type { Settings } from "@fusion/core";
import { relocateReclaimableWorktreeIntoRoot } from "../worktree/worktree-pool.js";
import { NonRetryableWorktreeError } from "./worktree-registry-helpers.js";
import { runContextForTotal } from "./run-context-for.js";
import type { EngineRunContext } from "../util/run-audit.js";
import type { RunMutationContext } from "@fusion/core";

export type ReclaimPathDeps = {
  /* FNXC:Identity 2026-08-12-01:20 (U18 Stage C): the live per-task run, so this module's store writes are attributed to it rather than to the bare executor lane. */
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  rootDir: string;
  store: {
    /*
  FNXC:Identity 2026-08-12-01:20 (U18/KTD2 — the seam restates the required context):
  This narrowed store re-declared `logEntry` with NO context parameter, so it did not inherit the
  canonical/deprecated overload pair and would keep accepting unattributed writes even after every
  call site was converted — a hole the census cannot see. Mirror the CANONICAL arity instead.
  Do not relax it back to quiet a caller.
  */
  logEntry: (taskId: string, action: string, outcome: string | undefined, runContext: RunMutationContext) => Promise<unknown>;
  };
  hasActiveWorktreeBinding: (taskId: string, path: string) => boolean;
  isLiveCleanupRefusal: (worktreePath: string, taskId: string) => Promise<boolean>;
};

export async function normalizeReclaimableWorktreePath(
  deps: ReclaimPathDeps,
  sourcePath: string,
  targetPath: string,
  taskId: string,
  settings: Partial<Settings>,
): Promise<string> {
  const isRelocationActive = async (path: string) =>
    deps.hasActiveWorktreeBinding(taskId, path)
    || await deps.isLiveCleanupRefusal(path, taskId);
  try {
    const placement = await relocateReclaimableWorktreeIntoRoot({
      rootDir: deps.rootDir,
      sourcePath,
      targetPath,
      taskId,
      settings,
      isPathActive: isRelocationActive,
    });
    if (placement.kind === "deferred-live") {
      await deps.store.logEntry(
        taskId,
        `[recovery] deferred relocation of active preserved worktree ${sourcePath}`,
        sourcePath, runContextForTotal(deps.getRunContextFor, taskId));
      return placement.path;
    }
    if (placement.relocated) {
      await deps.store.logEntry(
        taskId,
        `[recovery] relocated preserved worktree from ${sourcePath} to ${placement.path}`,
        placement.path, runContextForTotal(deps.getRunContextFor, taskId));
    }
    return placement.path;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await deps.store.logEntry(
      taskId,
      `[recovery] failed to relocate preserved worktree from ${sourcePath} to ${targetPath}: ${detail}`,
      sourcePath, runContextForTotal(deps.getRunContextFor, taskId));
    throw new NonRetryableWorktreeError(
      `Could not relocate preserved ${taskId} worktree into the configured worktrees directory: ${detail}`,
    );
  }
}
