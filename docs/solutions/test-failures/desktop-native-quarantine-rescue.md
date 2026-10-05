# Desktop native updater quarantine rescue

## Symptom and cause

The 2026-09-24 quarantine cites three upstream shard-4 runs: 35959852349,
35965109937 and 35965648898. Each reports 2 failures among 47 native tests.
The first updater flags test times out near 5 seconds (`STACK_TRACE_ERROR` is
Vitest's timeout capture), then the listener test sees two initial checks.

The flags become true before `applyConfiguredUpdateChannel` finishes its dynamic
core import and settings read. `vi.dynamicImportSettled` joins imports, not all
fire-and-forget updater work. The old test could exit while setup remained alive.
After clearing mocks and resetting modules, that continuation and a fresh module
shared the same hoisted updater mock. A controlled held-settings reproduction
produced exactly the archived two-calls-versus-one assertion. Draining the prior
initial check before reset makes that same reproduction pass.

## Fix and retained value

The fixture now owns only the `GlobalSettingsStore` boundary with in-memory reads,
and the first flags test also waits for exactly one initial check. Mock
implementations are reset so rejected checks cannot leak into later tests.
All 47 original test subjects and assertions remain. Three additional tests cover
held settings plus overlapping setup continuations, beta-to-stable manual rereads,
and stable fallback after settings failure. There are no timeout increases,
retries, test deletions, skips or production changes.

Vitest 4.1.10 manual mocks can bypass one of two simultaneous dynamic imports.
The deferred test settles the first mock import before the second setup, while
both settings reads remain held on the same gate. `settingsInit=2`, listeners=4,
and checks=0 prove that overlap; gate release must yield exactly one check.

A controlled mutation of the real native beta-channel branch to stable makes the
new deferred test fail (`expected null to be beta`). The native source was then
restored byte-for-byte. This demonstrates regression signal, not just repeated
stabilization passes. The fixture's 50 cases pass through the ordinary desktop
project after removing only the matching exclusion and quarantine ledger row.
Other quarantine dates and all strict thresholds stay unchanged.

## Deployment scope

This rescue changes tests and test admission only. It does not change the Bunny
production fix, installed bundles, application version or paused FUSI-036. It
requires no new local injection or service restart. Detailed RED/GREEN, historical
artifacts and independent review are retained with the PR delivery evidence.
