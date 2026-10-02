---
"@runfusion/fusion": patch
---

summary: A Code Review "fix this" request that runs out of capacity is no longer silently stranded in Review.
category: fix
dev: `performWorkflowRerunBounce` now records a durable capacity wait (workflow continuation, `waitReason:"capacity"`) instead of only logging "retrying later". New `undelivered-replay-step` in-review stall reason names the stranded hand-off on the board; `SelfHealingManager.recoverUndeliveredReviewReplaySteps` (predicate `hasUndeliveredReplayStep`, not a blocker-string match) re-issues the contained review→WIP move for a replay step never delivered, and clears only its own engine-authored `in-review-stall-deadlock` park, never an operator `userPaused` hold.