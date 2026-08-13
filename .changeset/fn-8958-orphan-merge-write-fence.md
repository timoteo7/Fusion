---
"@runfusion/fusion": patch
---

summary: Prevent canceled AI merge bodies from overwriting successor merge state.
category: fix
dev: Adds `merge-write-fence` with per-mutation ownership checks, optional squash-landing signals and ref-advance checkpoints. Aborts rethrow as `MergeAbortedError`; the injected `merge:orphan-write-fenced` audit emits once at first interaction with an emit-time suppression count.
