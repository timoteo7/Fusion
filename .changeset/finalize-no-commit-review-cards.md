---
"@runfusion/fusion": patch
---

summary: A task that produced no commit is now closed as a verified no-op instead of being failed in In Review.
category: fix
dev: `SelfHealingManager.finalizeNoOpReviewTasks` admitted only cards with a worktree and skipped a missing branch as if it were unreadable Git evidence, so a read-only card with no branch, no worktree, and no owned commit could reach no finalization path and was auto-disposed `failed` by the in-review stall deadlock. Admission now covers non-workspace cards and finalizes a worktree-less card only on a positive `no-changes-finalized` classification (no branch, no owned commit, base reachable). The merge gate's `unprovable-content` answer is unchanged.
