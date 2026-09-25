/**
 * FNXC:CodeOrganization 2026-07-15-16:00:
 * Branch-ahead-of-base probe peeled from self-healing.ts.
 */
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { Task } from "@fusion/core";
import { resolveTaskWorkingBranch } from "../worktree/worktree-names.js";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";
import { createLogger } from "../logger.js";

const log = createLogger("self-healing");
const execFileAsync = promisify(execFile);

export async function isBranchAheadOfBase(
  task: Task,
  rootDir: string,
  preferredBaseRef?: string,
): Promise<{ aheadCount: number; baseRef: string } | null> {
  const branchName = resolveTaskWorkingBranch(task);

  try {
    await execFileAsync("git", ["rev-parse", "--verify", branchName], {
      cwd: rootDir,
      timeout: 30_000,
    });
  } catch {
    return null;
  }

  const requestedBaseRef = preferredBaseRef || task.mergeDetails?.mergeTargetBranch || await resolveIntegrationBranch(rootDir, undefined);
  let resolvedBaseRef = requestedBaseRef;

  try {
    await execFileAsync("git", ["rev-parse", "--verify", requestedBaseRef], {
      cwd: rootDir,
      timeout: 30_000,
    });
  } catch {
    const remoteRef = `origin/${requestedBaseRef}`;
    try {
      await execFileAsync("git", ["rev-parse", "--verify", remoteRef], {
        cwd: rootDir,
        timeout: 30_000,
      });
      resolvedBaseRef = remoteRef;
    } catch {
      return null;
    }
  }

  // FNXC:WorktreeReclaimStrandedBase 2026-09-23-19:02:
  // Root cause (operator board): `rev-list --count <base>..<branch>` counts the SHARED fork/main lineage as "ahead"
  // when the branch tip is a descendant of the merge-base (194 forged "stranded commits since a830cde", FUSI-004/019/023,
  // GDPR-075). Measure from the branch FORK-POINT (where it actually diverged) so shared history is never counted as
  // unsaved work. A manual rebase/reclaim must never see shared lineage as stranded.
  try {
    let countRange = `${resolvedBaseRef}..${branchName}`;
    try {
      const { stdout: fp } = await execFileAsync(
        "git",
        ["merge-base", "--fork-point", branchName, resolvedBaseRef],
        { cwd: rootDir, timeout: 30_000 },
      );
      const forkPoint = fp.trim();
      if (forkPoint) countRange = `${forkPoint}..${branchName}`;
    } catch {
      // fall back to the plain base range when fork-point is unavailable
    }
    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--count", countRange],
      { cwd: rootDir, timeout: 30_000 },
    );
    const aheadCount = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(aheadCount)) {
      return null;
    }
    return { aheadCount, baseRef: resolvedBaseRef };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.warn(
      `Failed to compare ${branchName} against ${resolvedBaseRef} for ${task.id}: ${errorMessage}`,
    );
    return null;
  }
}
