---
"@runfusion/fusion": patch
---

summary: Fix a CLI contract test that referenced a command file removed with fn research.
category: fix
dev: Drops `research.ts` (removed in 74ffa19ef) from the audited result-writer list in
packages/cli/src/__tests__/cli-quiet-prompt-surfaces.test.ts. In skills-get.test.ts the three cold
CLI spawns (~2s each) were awaited serially inside a 5s per-test budget; they now run concurrently
and the third spawn was replaced by reading the shipped package.json version, which the built
entry point's own guide header and `fn --version` both derive from. No production behavior changes;
no timeout, retry, or assertion was weakened.
