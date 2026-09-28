---
"@runfusion/fusion": patch
---

summary: Fix a CLI contract test that referenced a command file removed with fn research.
category: fix
dev: Drops `research.ts` (removed in 74ffa19ef) from the audited result-writer list in
packages/cli/src/__tests__/cli-quiet-prompt-surfaces.test.ts, and runs the three cold CLI spawns in
skills-get.test.ts concurrently instead of serially so they fit the default 5s per-test budget.
No production behavior changes; no timeout, retry, or assertion was weakened.
