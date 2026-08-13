---
"@runfusion/fusion": patch
---

summary: Prevent completed planning sessions from stalling before Plan Review or execution.
category: fix
dev: Avoids nested planning lifecycle locks and preserves recoverable written plans during orphan cleanup.
