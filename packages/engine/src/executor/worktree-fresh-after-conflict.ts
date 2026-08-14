/**
 * FNXC:CodeOrganization 2026-08-03-15:00:
 * tryFreshWorktreeAfterLiveConflict peeled from TaskExecutor (U4 Slice B).
 * Injects rootDir/store/tryCreateWorktree so the free helper stays free of class state.
 */
import type { Settings } from "@fusion/core";
import { generateWorktreeName } from "../worktree/worktree-names.js";
import { resolveTaskWorktreePath } from "../worktree/worktree-paths.js";
import { extractWorktreeConflictInfo } from "./worktree-conflict-info.js";
import { runContextForTotal } from "./run-context-for.js";
import type { EngineRunContext } from "../util/run-audit.js";
import type { RunMutationContext } from "@fusion/core";

export type TryCreateWorktreeFn = (
  branch: string,
  path: string,
  taskId: string,
  startPoint?: string,
  attemptNumber?: number,
  recoveryDepth?: number,
  allowSiblingBranchRename?: boolean,
  settings?: Partial<Settings>,
) => Promise<{ path: string; branch: string }>;

export type FreshAfterConflictDeps = {
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
  tryCreateWorktree: TryCreateWorktreeFn;
};

export async function tryFreshWorktreeAfterLiveConflict(
  deps: FreshAfterConflictDeps,
  input: {
    conflictPath: string;
    branch: string;
    taskId: string;
    startPoint?: string;
    attemptNumber?: number;
    allowSiblingBranchRename: boolean;
    settings: Partial<Settings>;
  },
): Promise<{ path: string; branch: string }> {
  const { conflictPath, branch, taskId, attemptNumber, allowSiblingBranchRename, settings } = input;
  if (!allowSiblingBranchRename) {
    throw new Error(`Branch ${branch} conflict could not be auto-resolved`);
  }

  const conflictStartPoint = branch;
  for (let suffix = 2; suffix <= 6; suffix++) {
    const suffixedBranch = `${branch}-${suffix}`;
    const newPath = resolveTaskWorktreePath(deps.rootDir, settings, generateWorktreeName(deps.rootDir, settings));
    try {
      await deps.store.logEntry(
        taskId,
        `Preserved active conflicting worktree and retrying with fresh worktree branch ${suffixedBranch}`,
        `${conflictPath} -> ${newPath}`, runContextForTotal(deps.getRunContextFor, taskId));
      /*
       * FNXC:ExecutorWorktree 2026-07-01-00:00:
       * Active-session cleanup refusal must allocate a fresh worktree/branch instead of bubbling automatic cleanup failure. Removing the live conflicting path violates the FN-4811 invariant, so bounded sibling branches preserve the owner while letting the requesting task continue.
       */
      return await deps.tryCreateWorktree(suffixedBranch, newPath, taskId, conflictStartPoint, attemptNumber, 0, true, settings);
    } catch (suffixErr: unknown) {
      const info = extractWorktreeConflictInfo(suffixErr);
      if (info.type === "already-used") {
        continue;
      }
      throw suffixErr;
    }
  }
  throw new Error(
    `Cannot create branch for task: "${branch}"; live conflicting worktree ${conflictPath} was preserved and suffixes -2 through -6 are all in use by other worktrees`,
  );
}
