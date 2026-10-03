---
"@runfusion/fusion": patch
---

summary: Stop a finished mission slice from hanging as in-progress forever after its work was replaced.
category: fix
dev: `reconcileSupersededGeneratedFixFeatures` (async + sync twins) now writes `lastValidatorStatus: "passed"` alongside `loopState: "passed"`, and the three selection filters test the same field set so the already-terminal row is actually selected. Deliberately writes no `lastValidatorRunId`; the `!hasPassedAncestor` fabrication guard is unchanged.
