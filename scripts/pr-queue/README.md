# PR queue — open PRs authored by `timoteo7`

<!--
FNXC:PRQueue 2026-09-17-11:27:
FUSI-001 deliverable. The queue is the durable input for FUSI-002 (Greptile score extraction), FUSI-003 (unresolved bot-thread extraction), FUSI-004 (effort ranking) and for the operator view. It is regenerated from scratch on every run because the mission is continuous: PRs opened during the mission, or PRs that fall back below target, must enter scope automatically with no manual re-listing. Every field name and enum value below is a versioned contract: additive fields keep `schema_version: 1`, breaking changes bump it.
-->

`discover-open-prs.mjs` regenerates the authoritative inventory of every open PR authored by `timoteo7`:

```bash
node scripts/pr-queue/discover-open-prs.mjs                    # writes the three artifacts
node scripts/pr-queue/discover-open-prs.mjs --json             # print queue.json to stdout, write nothing
node scripts/pr-queue/discover-open-prs.mjs --strict           # exit 2 on any completeness doubt
node scripts/pr-queue/discover-open-prs.mjs --only o/r#123     # refresh one PR (reconciliation still covers every candidate)
node scripts/pr-queue/discover-open-prs.mjs --out /tmp/q --limit 500
```

## Outputs

| Path | Contents |
| --- | --- |
| `~/.fusion/pr-queue/queue.json` | machine-readable snapshot: `schema_version`, `generated_at`, `author`, `queue_hash`, `totals`, `reconciliation`, `discovery`, `prs[]` |
| `~/.fusion/pr-queue/queue.md` | operator rendering: totals, reconciliation line, one table row per PR, the `aguardando primeira revisão` section, per-thread evidence with ids/paths, notes |
| `~/.fusion/pr-queue/last-run.json` | run metadata (counts, rejected/incomplete ids) |

Per PR: `repo`/`owner`/`name`/`number`/`url`/`title`, `state`, `is_draft`, `is_cross_repository`, `head_repo_owner`/`head_repo_name`, `branch`, `base_ref`, `head_oid`, `size`, `review_decision`, `merge_state_status`, the `greptile` block, the `threads` block, the `ci` block, and `scope`/`scope_reasons` (the raw material FUSI-004 ranks by effort).

## Greptile semantics

| Situation | Result |
| --- | --- |
| A scored source exists | `status: "scored"`, `status_label: "<score>/5"` (target 5) |
| Greptile signal present, nothing parseable | `status: "awaiting_first_review"`, `status_label: "aguardando primeira revisão"` |
| No Greptile check run, comment or review at all | `status: "not_detected"`, same literal label, `signal: "absent"`, `triggerable: false` |

`score` comes from the **most recently updated scored source** — a Greptile issue comment or a Greptile review body, whichever is newer, with an exact tie going to the issue comment — and `score_source` records which one it was, so the loop knows the provenance. `reviewed_commit` is the 10-character SHA parsed from the `Last reviewed commit` link **URL** (never the anchor text), and `score_stale` is true only when it differs from `head_oid.slice(0, 10)` and both are known. `idle` is the negation of the Greptile check run's `status !== "COMPLETED"`, and is `null` (unknown) when there is no check run. `triggerable` is true only when a Greptile check run exists on the PR.

`not_detected` is deliberately **not** "review pending": at planning time six of the enumerated PRs live in repositories where Greptile is not installed, so a consumer that treated the absence of a signal as "waiting for Greptile" would post review-trigger spam.

## Thread semantics

`threads.unresolved_bot[]` / `threads.unresolved_human[]` entries carry `id`, `path`, `author`, `author_type`, `is_outdated` (and `classification_basis` for bots: `author_type` from GraphQL, `login_fallback` from REST). `human_policy` is the literal `never-auto-resolve`. A thread is classified bot only on positive evidence (GraphQL `author.__typename == "Bot"`, or a known bot login / `[bot]` marker / `-bot` suffix); everything else is human. An unresolved thread with `isOutdated: true` is still unresolved.

## CI semantics

`ci.state` ∈ `green | failing | pending | unknown`; a PR with zero check runs is `unknown`, never counted as passing. `ci.blocking_ci_failing` uses the per-repository blocking table (`Runfusion/Fusion`: `Lint`, `Typecheck`, `Build`, `Gate`) or every failing check as a candidate elsewhere, and `blocking_checks_source` records which evidence was used — a `gh api .../branches/<base>/protection` probe upgrades it to `branch_protection` when the token can read it, and degrades silently on 404/403.

## Completeness contract

Discovery runs through three paths and reconciles id sets (never counts):

1. `gh search prs --author timoteo7 --state open`
2. `gh search issues --author timoteo7 --state open is:pr`
3. `gh pr list --repo <R> --author timoteo7 --state open` for every repository named by (1), (2), or the previous snapshot's repositories

Every candidate is then re-verified with `gh pr view` — it must still be `OPEN` and authored by `timoteo7`, otherwise the id is recorded in `reconciliation.rejected_by_state_check` instead of being silently dropped. `reconciliation` also carries `search_ids`, `repo_union_ids`, `verified_open_ids`, `missing_from_search`, `missing_from_repo_union`, `missing_from_verified`, `carry_over_repositories`, `search_total_count` (information only — the search index lags) and `notes`. A repository the search index drops is still enumerated through path B from carry-over, and the miss stays visible in `missing_from_search` instead of quietly shrinking the queue.

`--strict` fails (exit 2) when `reconciled` is false, when a discovery path errored, when a row is missing `branch`/`ci`/`greptile`, or when a PR from the previous snapshot disappeared without a rejection entry. Exit code 3 is a failed `gh` call (named in the message, no partial snapshot written), and 4 is an invalid flag. `--only` restricts per-PR extraction to one PR and therefore cannot reconcile by construction: the comparison is reported (`missing_from_verified`) but skipped by the gate, so the authoritative snapshot is always a full run.

## Determinism

`queue_hash` is a `sha256:` digest over the canonical JSON of the `prs` array only (rows sorted by repo then number, keys sorted recursively). `generated_at` and other run-level values are excluded, so an unchanged GitHub state reproduces the same hash while a new score, a resolved thread or a changed check conclusion moves it.

## Safety

The tool is read-only by construction: it only runs `gh` read subcommands (`search`, `list`, `view`, `api`, `graphql` queries). It never posts a comment, never triggers a review, never resolves a thread and never touches a PR branch. Bot threads may be resolved autonomously by the mission's executors; human threads never may.

## Tests

```bash
pnpm test:scripts -- scripts/__tests__/pr-queue-discover.test.mjs
```

The suite is fixture-driven: the pure classifiers plus the full discovery/reconciliation/CLI pipeline driven through the injected `gh` runner seam, with no network access.
