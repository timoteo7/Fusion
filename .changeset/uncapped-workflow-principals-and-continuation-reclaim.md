---
"@runfusion/fusion": minor
---

summary: Remove workflow principal session caps and auto-resume continuations stranded in running or held.
category: fix
dev: `WorkflowAgentCapacity.acquire` drops `maxProjectSessions`/`maxWorkflowSessions` (leases become bookkeeping only) and `routeWorkflowPrincipal`'s availability test is now eligibility-only, so the capacity re-route loops in `triage.ts` and `workflow-principal-before-node.ts` are deleted. New self-healing sweep `reconcileStrandedWorkflowContinuations` (startup + periodic) re-queues `running` rows with a dead/absent lease and `held` rows the claim predicate cannot re-take, and retires active-state rows belonging to deleted/archived tasks; decision logic is the pure `evaluateStrandedContinuationReclaim`. New run-audit types: `workflowWorkItem:reconcile-stranded-requeued`, `workflowWorkItem:reconcile-stranded-retired`.
