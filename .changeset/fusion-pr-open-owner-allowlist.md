---
"@runfusion/fusion": minor
---

summary: Block agents from opening GitHub PRs unless the target owner is allow-listed.
category: security
dev: New bash-containment rules `company-pr-open` / `company-pr-open-api` deny `gh pr create`, `gh pr create-pr`, `hub pull-request`, and REST calls to `/pulls` from every agent session at every permission preset. Deny is the default (fail closed); operators can permit agents to open PRs against their OWN repositories only by setting `FUSION_PR_OPEN_ALLOW_OWNERS` (comma-separated GitHub owners). Target owner is parsed from `--repo o/r`, `--head o:branch`, `gh api repos/o/r/pulls`, or github.com URLs. Incident 2026-09-04 GDPR-072: an executor autonomously ran `gh pr create` against a company repo after completing its spec (commit/push), ignoring the PR-creation skill's operator-approval requirement.
