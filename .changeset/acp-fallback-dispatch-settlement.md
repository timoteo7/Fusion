---
"@runfusion/fusion": patch
---

summary: Fix planner "fallback-dispatch settlement boundary" failure so ACP-runtime planning attempts stop failing closed.
category: fix
dev: The ACP runtime adapter now provides `settleFallbackDispatch` (parity with the pi runtime), preventing `fallbackDispatchBoundaryMissing` from failing planning attempts (FUSI-021/022/023).
