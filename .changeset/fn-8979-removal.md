---
"@runfusion/fusion": minor
---

summary: Remove deprecated v0 mission resume blockers in favor of canonical descriptors.
category: breaking
dev: Removes legacyBlockers from the resume 409, MissionResumeConflictError.blockers, LegacyMissionBlocker, fromLegacyMissionBlocker, toLegacyMissionBlocker, their barrel exports, and client v0 upgrade branches after auditing supported consumers; canonical blockers now deduplicate on (rootFeatureId, source, reason).
