---
"@runfusion/fusion": patch
---

summary: Hide Promote until a task’s required plan review and approval holds clear.
category: fix
dev: Adds `isPlanReviewGateUnsatisfied` and `isTaskBlockedOnApprovalHold`, mirroring server predicates with the default-on plan-review fallback and column-independent approval holds.
