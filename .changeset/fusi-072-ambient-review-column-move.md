---
"@runfusion/fusion": minor
---

summary: Ambient heartbeat agents can now close a finished card from review under operator approval policy.
category: feature
dev: Adds `fn_task_column_move` to the no-task heartbeat branch, classified `task_agent_mutation` in `gating-classifications.ts`. Forward-only: review lane to the workflow's complete column, resolved from workflow traits. Backed by `moveSource: "engine"` with `bypassGuards: false` so core lifecycle containment runs instead of being bypassed.