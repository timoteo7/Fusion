---
"@runfusion/fusion": patch
---

summary: Automatic mission validation no longer starts a second run while manual validation is in flight.
category: fix
dev: Uses a feature-scoped live-run check and exposes optional ValidatorRunAdmission.blockingScope.
