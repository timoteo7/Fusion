/**
 * FNXC:CodeOrganization 2026-08-03-17:05:
 * reviewWorkspacePerRepo peeled from TaskExecutor (U4 Slice B).
 *
 * FNXC:Workspace 2026-06-22-00:30: KTD3 — per-repo review by looping the EXISTING single-cwd reviewStep.
 * The reviewer is an AGENT spawned with `cwd = worktree`, told (in prompt text, reviewer.ts) to run `git diff`
 * itself — it does NOT read a diff passed in code. So per-repo review = ONE reviewer agent per sub-repo. We keep
 * `reviewStep` single-cwd; the CALLERS loop. This helper is the shared loop+aggregate so both review entry points
 * (historically the deleted in-session review tool, now only the step-inversion `stepReview` seam) iterate
 * identically: it invokes the caller's
 * own `invokeForCwd(cwd)` once per acquired worktree (cwd = repo.worktreePath) and aggregates the repo-tagged
 * verdicts as a CONJUNCTION — the task is "reviewed" only if EVERY repo passes; the FIRST non-APPROVE repo's
 * verdict becomes the aggregate verdict (mirroring verifyWorktreeInvariants' first-failing-repo return), and its
 * findings are repo-tagged. A zero-acquire workspace task is classified with the completion invariant: proven
 * commit-free work approves honestly, while unproven work returns non-retryable UNAVAILABLE.
 *
 * Verdict severity for the conjunction: any RETHINK/REVISE/UNAVAILABLE fails the whole review; only all-APPROVE
 * (or all-skipped UNAVAILABLE-advisory, handled by the caller) approves. We surface the first failing repo's exact
 * verdict so the caller's existing verdict→edge mapping (APPROVE done-marking, REVISE block, RETHINK reset,
 * UNAVAILABLE retry) is unchanged.
 */
import type { Task } from "@fusion/core";
import type { ReviewResult } from "../execution/reviewer.js";
import { classifyWorkspaceZeroAcquire, type WorkspaceZeroAcquireOptions } from "./workspace-zero-acquire.js";

export async function reviewWorkspacePerRepo(
  // FNXC:Workspace 2026-06-21-15:00: F7 — drop the dead `repoRel` callback param.
  // Both call sites bind `(cwd) => runForCwd(cwd)` and discard the second arg, so the type wrongly
  // implied repo identity is observable inside `runForCwd`. Removed until a real consumer needs it
  // (Phase C). The loop below still tags findings with `repoRel` from its own iteration key.
  task: Task,
  invokeForCwd: (cwd: string) => Promise<ReviewResult>,
  options: Omit<WorkspaceZeroAcquireOptions, "workspaceMode"> & { workspaceMode?: boolean } = {},
): Promise<ReviewResult> {
  const workspaceWorktrees = task.workspaceWorktrees ?? {};
  // FNXC:Workspace 2026-06-21-15:00: F6 — sort repo keys so the reported FIRST failing repo is
  // deterministic across runs/rehydrate.
  const repoKeys = Object.keys(workspaceWorktrees).sort();
  if (repoKeys.length === 0) {
    /*
    FNXC:Workspace 2026-08-15-04:21:
    This is the review-side consumer of classifyWorkspaceZeroAcquire. A proven
    commit-free task has no diff to inspect and may approve honestly; an unproven
    empty map remains unavailable, but re-invoking cannot acquire a repo, so it is
    explicitly non-retryable rather than burning the review retry budget.
    */
    const zeroAcquire = classifyWorkspaceZeroAcquire(task, {
      workspaceMode: options.workspaceMode ?? true,
      noOpCompletion: options.noOpCompletion,
      noOpCompletionReason: options.noOpCompletionReason,
    });
    if (zeroAcquire.kind === "commit-free-eligible") {
      return {
        verdict: "APPROVE",
        review: `No sub-repo worktree was acquired; no diff was reviewed because this workspace task is commit-free eligible (${zeroAcquire.reason}).`,
        summary: `APPROVE: no sub-repo worktree acquired (${zeroAcquire.reason})`,
      };
    }
    return {
      verdict: "UNAVAILABLE",
      retryable: false,
      review: "No acquired sub-repo worktree to review; re-invocation cannot change this unproven zero-acquire workspace verdict.",
      summary: "Unavailable: no sub-repo worktree acquired",
    };
  }

  const reviewSections: string[] = [];
  const summarySections: string[] = [];
  let firstFailing: { repo: string; result: ReviewResult } | undefined;
  for (const repoRel of repoKeys) {
    const repo = workspaceWorktrees[repoRel];
    const result = await invokeForCwd(repo.worktreePath);
    // Tag every per-repo finding with its sub-repo so downstream readers attribute it correctly.
    reviewSections.push(`### [${repoRel}] ${result.verdict}\n${result.review}`);
    summarySections.push(`[${repoRel}] ${result.verdict}: ${result.summary}`);
    if (result.verdict !== "APPROVE") {
      // FNXC:Workspace 2026-06-21-15:00: F3 — BREAK on the first non-APPROVE repo.
      // The contract is "the FIRST non-APPROVE repo's verdict becomes the aggregate". Without the
      // break, a LATER repo's reviewer throwing would discard this already-determined REVISE/RETHINK
      // and the caller would see UNAVAILABLE — masking the real verdict. Stop at the first failure.
      firstFailing = { repo: repoRel, result };
      break;
    }
  }

  if (firstFailing) {
    // Conjunction failed: the aggregate carries the FIRST failing repo's verdict (so the caller's
    // verdict→edge mapping is identical to single-cwd), with the full repo-tagged review body.
    return {
      verdict: firstFailing.result.verdict,
      // FNXC:Workspace 2026-06-22-00:00: the conjunction BREAKS on the first non-APPROVE repo,
      // so reviewSections holds only the repos evaluated up to (and including) the failure — not
      // every sub-repo. Label it honestly so operators don't read a partial list as exhaustive.
      review: `Workspace review failed in sub-repo \`${firstFailing.repo}\` (verdict ${firstFailing.result.verdict}). Per-repo verdicts (evaluation stopped at first failure; later repos not reviewed):\n\n${reviewSections.join("\n\n")}`,
      summary: `${firstFailing.repo}: ${firstFailing.result.verdict} — ${summarySections.join(" | ")}`,
    };
  }

  // Every sub-repo approved → the task is reviewed (conjunction satisfied).
  return {
    verdict: "APPROVE",
    review: `All ${repoKeys.length} sub-repo(s) approved. Per-repo verdicts:\n\n${reviewSections.join("\n\n")}`,
    summary: `APPROVE across ${repoKeys.length} sub-repo(s): ${summarySections.join(" | ")}`,
  };
}
