---
"@runfusion/fusion": minor
---

summary: Add an operator-only tool to clear a stale mission blocked badge from the CLI.
category: feature
dev: Registers fn_mission_clear_blocked in the pi extension (withheld from agent principals), classifies it as task_agent_mutation in gating-classifications.ts, and denies it in readonly workflow steps.
