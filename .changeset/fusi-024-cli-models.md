---
"@runfusion/fusion": minor
---

summary: Add a headless `fn models` command to list available models, per-model pricing, and connected providers.
category: feature
dev: New `fn models [list|ls] [--json] [--provider <id>] [--all]` and `fn models providers [--json]` CLI surface. Runs with no dashboard process, API token, or running engine; never prints credentials. Provider filtering reuses the shared configured-provider gate used by the dashboard (`discoverConfiguredProviders`/`addToggleConfiguredProviders`, now exported from `@fusion/core`); `--all` opts out. Prices are copied from the model registry in USD per 1M tokens and an unknown price is shown as `n/a` / `null` rather than fabricated as zero. The `/api/models` catalog row also now carries a `cost` field.
