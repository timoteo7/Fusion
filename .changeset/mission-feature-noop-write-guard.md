---
"@runfusion/fusion": patch
---

summary: Mission features are no longer rewritten when nothing changed, so updatedAt is truthful again.
category: fix
dev: `AsyncMissionStore.updateFeature` now skips the whole write — no `UPDATE mission_features`, no `updatedAt` stamp, no `feature:updated` emit, no status event, no slice rollup — when the resolved feature matches the locked pre-image on every column the low-level writer persists (`featurePersistedColumnsChanged` in `async-mission-store-queries.ts`). `updateFeatureStatus` and `transitionLoopState` inherit it through the boundary. The suppressor behind the reported periodic bursts was the spec-alignment projection at `mission-state-reconcile.ts:291`: its guard compares `feature.specAlignment` against the computed alignment, but this store never persisted `specAlignment` (it is absent from the low-level writer's column set), so the guard could not converge and every reconcile pass re-issued the same empty write for each taskId-bearing feature. Set `FUSION_DEBUG=core-async-mission-store` to log one line per suppressed write with the caller stack.
