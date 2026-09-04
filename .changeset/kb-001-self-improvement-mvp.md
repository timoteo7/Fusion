---
"@runfusion/fusion": minor
---

summary: Ship the self-improvement MVP: a sealed evolution pipeline with deterministic trials, an apply gate, and redaction.
category: feature
dev: Adds `EvolutionStore`, `EvolutionTrialService`, `EvolutionApplyGate`, `EvolutionCycle`, `HermesAdapter`, `HerdrAdapter`, `redactEvolutionArtifact` under `packages/core/src/agents/` and `packages/engine/src/agents/`. 98 tests cover the loop. The apply gate is the single writer to live agent state; Hermes/Herdr are function adapters that never reach the engine's stores. See `docs/self-improvement-mvp.md`.
