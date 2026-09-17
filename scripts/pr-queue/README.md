# PR queue — open PRs authored by `timoteo7`

<!--
FNXC:PRQueue 2026-09-17-09:20:
FUSI-001 deliverable. The queue is the input for FUSI-002 (Greptile score
extraction), FUSI-003 (unresolved bot-thread extraction), FUSI-004 (effort
ranking), and for the operator view. It is regenerated from scratch on every
run because the mission is continuous: PRs opened during the mission, or PRs
that fall back below target, must enter scope automatically.
-->

`discover-open-prs.mjs` regenerates the authoritative inventory of every open
PR authored by `timoteo7`:

```bash
node scripts/pr-queue/discover-open-prs.mjs                 # writes the two artifacts
node scripts/pr-queue/discover-open-prs.mjs --stdout        # prints queue.json to stdout
node scripts/pr-queue/discover-open-prs.mjs --strict        # exit 1 on any completeness doubt
node scripts/pr-queue/discover-open-prs.mjs --out /tmp/q    # alternate output directory
```

## Outputs

| Path | Contents |
| --- | --- |
| `~/.fusion/pr-queue/queue.json` | machine-readable snapshot (`schema`, `generatedAt`, `queueHash`, `discovery`, `prs[]`) |
| `~/.fusion/pr-queue/queue.md` | human-readable rendering of the same snapshot |

Per PR the snapshot records: repository, number, URL, title, branch, draft
flag, `mergeStateStatus`, which discovery paths found it, the Greptile state
(score, reviewed commit, check-run conclusion, and the id/date of the message
the score came from), unresolved review threads split into bot and human
buckets (`id`/`path`/`author`/`isOutdated`), and the CI rollup
(`state`/`total`/`failing[]`/`pending[]`).

A PR with no Greptile review yet is labelled with the literal
`aguardando primeira revisão` and stays in the snapshot, so a later score below
5 or a new bot comment pulls it into scope on the next run with no manual
re-listing.

## Completeness contract

Discovery runs through three independent paths and reconciles them:

1. `gh search prs --author timoteo7 --state open`
2. `gh search issues --author timoteo7 --state open is:pr`
3. `gh pr list --repo <R> --author timoteo7 --state open` for every repository
   seen by paths 1–2 (catches PRs GitHub's search index has not ingested yet)

Every candidate is then re-verified through `gh pr view` — it must still be
`OPEN` and authored by `timoteo7`, otherwise it is recorded under
`discovery.ineligible` instead of being silently dropped. Path errors,
cross-path discrepancies, and ineligible candidates are always reported;
`--strict` turns them into a non-zero exit instead of a warning.

## Determinism

`queueHash` is a `sha256:` digest over a canonical projection of the queue.
Volatile fields (fetch timestamps, index-lag `foundBy` sets, comment dates) are
excluded, so re-running against unchanged GitHub state yields a byte-identical
hash while any real change (score, resolved thread, check conclusion, branch or
draft flip) moves it.

## Safety

The tool is read-only by construction: it only runs `gh` read subcommands
(`search`, `list`, `view`, `api graphql` queries). It never posts a comment,
never triggers a review, never resolves a thread, and never touches a PR
branch. Bot threads may be resolved autonomously by the mission's executors;
human threads never may — `isBotAuthor` therefore classifies a thread as bot
only on positive evidence (known bot login, `[bot]` marker, `-bot` suffix) and
treats everything else as human.

## Tests

```bash
pnpm test:scripts -- scripts/__tests__/pr-queue-discover-open-prs.test.mjs
```

The suite is fixture-driven: pure classifiers plus the full
discovery/reconciliation pipeline driven through the injected `gh` runner seam,
with no network access.
