# Test velocity baseline

> Weekly FN-6612 signal-per-second baseline. Measure and report feedback-loop velocity; do **not** add slow tests or wire this report into blocking PR checks. The merge gate remains the existing thin Lint, Typecheck, Build, and Gate path.

## Latest baseline

- Cycle: **2026-W33**
- Captured at: **2026-08-13T01:59:18.032Z**
- Timing snapshot: `scripts/test-timings.json` captured at **2026-07-24T13:09:41.412Z**
- Quarantine ledger: `scripts/lib/test-quarantine.json`

## Metrics

| Metric | Current | Delta vs previous |
|---|---:|---:|
| Merge gate wall-time (`pnpm test:gate`) | 11.0s | -3.6s |
| Boot smoke wall-time (`pnpm smoke:boot`) | 26.7s | +8.5s |
| Changed-only test wall-time (`pnpm test`) | 17.6s | -4.9s |
| Quarantine / flake count | 0 | 0 |
| Deletion-due quarantines | 0 | n/a |

## Measurement failures

- None recorded.

## Timing snapshot notes

- Timing snapshot is 19 days old; verify slowest-file attribution before treating the table as the current culprit.

## Slowest 20 test files

| Rank | File | Package | Duration |
|---:|---|---|---:|
| 1 | `packages/dashboard/app/components/__tests__/SettingsModal.general.test.tsx` | @fusion/dashboard | 2m 01s |
| 2 | `packages/dashboard/app/components/__tests__/SettingsModal.scheduling-merge.test.tsx` | @fusion/dashboard | 1m 18s |
| 3 | `packages/core/src/__tests__/postgres/schema-applier.test.ts` | @fusion/core | 1m 06s |
| 4 | `packages/dashboard/app/components/__tests__/SettingsModal.remote-notifications.test.tsx` | @fusion/dashboard | 55.7s |
| 5 | `packages/dashboard/app/components/__tests__/SettingsModal.models-auth.test.tsx` | @fusion/dashboard | 53.5s |
| 6 | `packages/dashboard/app/components/__tests__/TaskDetailModal.rendering.test.tsx` | @fusion/dashboard | 52.1s |
| 7 | `packages/cli/src/__tests__/extension.test.ts` | @runfusion/fusion | 51.6s |
| 8 | `packages/core/src/__tests__/postgres/sqlite-migrator.test.ts` | @fusion/core | 51.3s |
| 9 | `packages/dashboard/app/components/__tests__/TaskDetailModal.inline-editing-and-integrations.test.tsx` | @fusion/dashboard | 39.7s |
| 10 | `packages/dashboard/app/components/__tests__/ListView.test.tsx` | @fusion/dashboard | 38.1s |
| 11 | `packages/dashboard/app/components/__tests__/App.test.tsx` | @fusion/dashboard | 33.1s |
| 12 | `packages/dashboard/app/components/__tests__/WorkflowNodeEditor.test.tsx` | @fusion/dashboard | 33.1s |
| 13 | `packages/dashboard/app/components/__tests__/AgentDetailView.advanced-settings.test.tsx` | @fusion/dashboard | 32.9s |
| 14 | `packages/dashboard/app/components/__tests__/SecretsView.test.tsx` | @fusion/dashboard | 30.9s |
| 15 | `packages/core/src/__tests__/postgres/taskstore-remaining.test.ts` | @fusion/core | 30.5s |
| 16 | `packages/dashboard/app/components/__tests__/AgentPromptsManager.test.tsx` | @fusion/dashboard | 30.2s |
| 17 | `packages/dashboard/app/components/__tests__/ChatView.core-interactions.test.tsx` | @fusion/dashboard | 29.2s |
| 18 | `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` | @fusion/dashboard | 27.8s |
| 19 | `packages/dashboard/app/components/__tests__/TaskDetailModal.definition-actions.test.tsx` | @fusion/dashboard | 27.0s |
| 20 | `packages/engine/src/__tests__/reliability-interactions/explicit-duplicate-marker-sweep.test.ts` | @fusion/engine | 26.8s |

## Quarantine age buckets

| Age bucket | Count |
|---|---:|
| 0-6 days | 0 |
| 7-13 days | 0 |
| deletion due (>=14 days) | 0 |
| unknown/future | 0 |

### Deletion-due entries

| File | Quarantined at | Age (days) |
|---|---:|---:|
| — | — | — |

## Before / after trend

| Row | Captured at | Gate | Boot smoke | `pnpm test` | Quarantine count |
|---|---|---:|---:|---:|---:|
| Previous | 2026-08-04T03:10:46.073Z | 14.6s | 18.1s | 22.4s | 0 |
| Latest | 2026-08-13T01:59:18.032Z | 11.0s | 26.7s | 17.6s | 0 |
| Delta | — | -3.6s | +8.5s | -4.9s | 0 |

_Future weekly rows append to `scripts/test-velocity-history.json`; compare the latest row against the previous row before posting to #leads._

## Post to #leads

```text
FN-6612 weekly test velocity: gate 11.0s (-3.6s), boot smoke 26.7s (+8.5s), pnpm test 17.6s (-4.9s), quarantine ledger 0 (0). Slowest file: packages/dashboard/app/components/__tests__/SettingsModal.general.test.tsx at 2m 01s. Deletion-due quarantines: 0.
```

## How to refresh

```bash
pnpm test:velocity -- --measure --write-report
```

In measure mode, the script runs a non-measured `pnpm build` preflight before timing `pnpm test:gate`, `pnpm smoke:boot`, or `pnpm test`. The preflight time is setup only and is excluded from lane metrics; if it fails, the Measurement failures section records `Build preflight (pnpm build)` as the reason. Use `--skip-build-preflight` only when the workspace is already built by CI.

Report-only regeneration is cheap and does not run any suite:

```bash
pnpm test:velocity
```
