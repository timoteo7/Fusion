/**
 * FNXC:StrandedCommits 2026-09-23-21:01:
 * SOURCE-OF-TRUTH for "stranded commits" on a task branch. Root cause (operator board): the count was duplicated across
 * self-healing-branch.ts, merger.ts, branch-conflicts.ts (x2) and each copy walked `<base>..<branch>`, counting the SHARED
 * fork/main lineage as unsaved work whenever the branch tip descended from the merge-base (the forged "194 stranded since
 * a830cde"). Every recurrence was a new call site of the same wrong walk.
 * Invariant enforced HERE so no call site can miscount again:
 *   1. measure from the branch FORK-POINT (where the branch actually diverged), never the raw merge-base;
 *   2. a branch with ZERO task-unique commits has ZERO stranded commits (shared history is never unsaved work).
 */
import { promisify } from "node:util";
import { execFile } from "node:child_process";
const execFileAsync = promisify(execFile);

export async function resolveStrandedStartPoint(rootDir: string, branchName: string, baseRef: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["merge-base", "--fork-point", branchName, baseRef], { cwd: rootDir, timeout: 30_000 });
    const forkPoint = stdout.trim();
    if (forkPoint) return forkPoint;
  } catch {
    // FNXC:StrandedCommits 2026-09-23-21:44:
    // When the fork-point lookup FAILS (e.g. partial-SHA baseRef: "No such ref"), do NOT fall back to the raw baseRef:
    // `baseRef..branch` counts the SHARED fork/main lineage (the forged "115/199 stranded"). We cannot prove where the
    // branch diverged, so return the branch itself => ZERO task-unique commits to strand (shared history is never unsaved).
    return branchName;
  }
  return baseRef;
}

export async function countStrandedCommits(rootDir: string, branchName: string, baseRef: string): Promise<number> {
  const start = await resolveStrandedStartPoint(rootDir, branchName, baseRef);
  try {
    const { stdout } = await execFileAsync("git", ["rev-list", "--count", `${start}..${branchName}`], { cwd: rootDir, timeout: 30_000 });
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
