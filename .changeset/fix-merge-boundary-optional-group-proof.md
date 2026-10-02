---
"@runfusion/fusion": patch
---

summary: Stop parking tasks at merge-boundary-unproven when their passed pre-merge reviews came from enabled optional steps.
category: fix
dev: The merge-boundary proof now accepts graph-native pre-merge results from both origins (`source="node"` and `source="optional-group"`); phase (`pre-merge`) and terminality plus foreach instance coverage stay mandatory. Shared predicate `isGraphNativePreMergeResult` also backs `shouldCompleteChecklistAtWorkflowMerge`.
