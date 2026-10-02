---
"@runfusion/fusion": patch
---

summary: A failed merge now names the conflicting commit and files instead of a wall of skip warnings.
category: fix
dev: Task-log truncation is structure-aware and shared by the `action` and `outcome` fields: near-identical `warning:` runs collapse to a counted line and a command failure keeps its head plus its tail, so the `fatal:`/`CONFLICT`/`Could not apply` line and test-runner assertion diffs survive the 4,000-character cap. The merge-failure producers moved the diagnostic payload from `action` into `outcome` (previously `action` carried the whole `git rebase` stderr — duplicated across every retry entry — and `outcome` held the bare string `Error`).
