---
"@runfusion/fusion": patch
---

summary: Keep durable agent data isolated to the active project in shared PostgreSQL.
category: fix
dev: Agent reads, mutations, satellite tables, analytics, and reassignment links now apply the bound project scope.
