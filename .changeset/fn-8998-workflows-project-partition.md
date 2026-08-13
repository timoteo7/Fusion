---
"@runfusion/fusion": patch
---

summary: Keep custom workflows private to their project on shared databases.
category: fix
dev: Models project.workflows as (project_id, id), scopes predicates with projectScopeFor, and preserves global ID occupancy allocation.
