---
"@runfusion/fusion": patch
---

summary: Review comments on a pull request are now recorded separately instead of overwriting each other.
category: fix
dev: `gh` supplies a GraphQL node id, not a numeric one, so both `gh` readers parsed it to NaN and every comment collapsed onto the constant key `gh-comment-NaN`. Adds a shared `resolvePrCommentIdentity` in `@fusion/core` returning an opaque identity key and a separate monotonic ordering sequence, and switches `PrMonitor` to order on the sequence. A transport that cannot resolve an id now throws instead of inventing a shared sentinel. Review rows written before this fix are left for operator disposition, not auto-rewritten.