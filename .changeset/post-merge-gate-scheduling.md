---
"@runfusion/fusion": patch
---

summary: Re-arm an unreported post-merge gate so a confirmed merge is not deferred forever.
category: fix
dev: The `post-merge-verification` optional group is a graph post-merge hop that only runs while the `merge` node executes. After the merge seam returns, finalization refused completion on the missing gate and nothing re-entered the graph, so on a repository with no post-landing CI evidence the card was permanently parked in review. `finalizeProvenAutoMergeTask` now schedules the unreported gate as a runnable continuation before deferring. Completion is still refused until the gate actually reports; only the silent deadlock is removed.
