---
"@runfusion/fusion": patch
---

summary: Recover cards stuck in planning whose workflow work items are all finished, and records why any recovery is refused.
category: fix
dev: The stale-planning sweep's graph fence treated `listWorkflowWorkItemsForTask(...).length === 0` as "no live graph run", but that reader returns the card's whole history, so any terminal work item (succeeded/failed/cancelled/exhausted) blocked legacy null-status recovery in silence. Only non-terminal items block now. Every refusal in `recoverApprovedTask` and in `SelfHealingManager.recoverApprovedTriageTasks` logs its gate; the triage processor also writes one deduplicated `Planning recovery withheld: <reason>` task-log entry per (task, reason) so a retried refusal does not flood the card history.
