---
"@runfusion/fusion": patch
---

summary: Stop a task stuck in planning from holding a capacity slot and freezing planning.
category: fix
dev: `isRunningAgentTask` counts `status:"planning"` only while a planner liveness probe reports the task live, so a durable planning row with no session (FUSI-018: `claimed=2, processing=0` on 677 throttle lines) can no longer self-block the project's admission gate. Flag-less callers keep the previous count.
