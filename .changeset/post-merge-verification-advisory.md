---
"@runfusion/fusion": patch
---

summary: Merged cards now finalize on merge proof; a red Full Suite no longer blocks completion.
category: fix
dev: Demotes the built-in `post-merge-verification` post-merge group from gate to advisory in `packages/core/src/workflows/builtin-post-merge-group.ts`; both the graph executor and `getRequiredPostMergeEvidenceBlocker` key on `gateMode === "gate"`, so this single value removes the hard completion block. The node still runs and records its `phase: "post-merge"` verdict, and the Full Suite remains the advisory post-merge signal the repository already documented. FUSI-064 (Option A default; no operator decision was supplied).
