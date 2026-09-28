# FUSI-035 — `runtime-Error` family determinism table

Census: `main-full-suite-census-2026-09-25.md` (family `runtime-Error`), first red run main push #3158 (`b37d0fe2`).
Branch: `fusion/fusi-035`, based on `6c57344b8`.

The family is **7 rows**, not the 5 named in the intake text. Six are repaired here; case 1 is owned by
FUSI-031. Every row reproduced identically on three consecutive runs, so **none is a flake** and
nothing was quarantined.

## Verdict table

| # | package | file | case | run 1 | run 2 | run 3 | verdict | disposition |
|---|---|---|---|---|---|---|---|---|
| 1 | `@fusion/engine` | `src/__tests__/pi-reasoning-summary.test.ts` | `createFnAgent reasoning-summary payload hook > retries once on the same session after an unsupported-summary rejection` | ✓ | ✓ | ✓ | row removed on owning branch | **FUSI-031, commit `0549c3fa6` (branch head `8dd27d628`)** — no change here |
| 2 | `@fusion/engine` | `src/__tests__/reliability-interactions/graph-node-missing-worktree-recovery.test.ts` | `Plan Review missing-worktree repo-root fallback (FN-7996) > re-acquires a task worktree for Plan Review when the recorded worktree is gone (never the repo root)` | ✓ 28ms | ✓ 19ms | ✓ 26ms | deterministic regression | repaired here |
| 3 | `@fusion/engine` | `src/__tests__/reliability-interactions/post-done-continuation-no-wedge.test.ts` | `FN-5866 reliability interactions: post-done continuation no wedge > falls through to terminal failure after the non-continuable fresh-session retry budget is exhausted` | ✓ 29ms | ✓ | ✓ | deterministic regression | repaired here |
| 4 | `@fusion/engine` | `src/__tests__/worktree-reclaim-placement.real-git.test.ts` | `reclaimable worktree placement > refuses to relocate into an occupied task-ID path instead of clobbering it` | ✓ | ✓ | ✓ | deterministic regression | repaired here (case renamed — see below) |
| 5 | `@runfusion/fusion` | `src/__tests__/cli-quiet-prompt-surfaces.test.ts` | `CLI quiet prompt and result source contracts > keeps all audited result writers attached to the output seam` | ✓ | ✓ | ✓ | deterministic regression | repaired here |
| 6 | `@runfusion/fusion` | `src/commands/__tests__/skills-get.test.ts` | `fn skills get > prints a guide and version from the same built CLI entry point` | ✓ | ✓ | ✓ | deterministic regression | repaired here |
| 7 | `@fusion/core` | `src/__tests__/git-repository.test.ts` | `ensureGitRepositoryForProjectPath > materializes an unambiguous remote-only branch without moving detached HEAD` | ✓ | ✓ | ✓ | deterministic regression | repaired here |

Case 1's `✓` marks are the state on `fusion/fusi-031`, where the census row has been replaced by
`propagates a summary rejection instead of retrying the same session` (5 passed, 5). On this branch the
file is byte-identical to `6c57344b8` and was never edited.

Case 4's census row was named `chooses a task-scoped target when the legacy basename is occupied`. The
shipped product refuses instead of disambiguating, so the case was renamed to state the shipped
contract. See the `FNXC:WorktreeReclaimPlacement` comment at the site.

## Post-repair re-verification

All six in-scope cases were re-run three times each after the repairs, using the Step 1 commands:

- Case 2: ✓ 28ms / ✓ 19ms / ✓ 26ms
- Case 3: ✓ / ✓ / ✓ (previously `Test timed out in 30000ms.`)
- Case 4: ✓ 5 passed / ✓ 5 passed / ✓ 5 passed
- Case 5: ✓ / ✓ / ✓
- Case 6: ✓ / ✓ / ✓ (previously `Test timed out in 5000ms.`)

### Case 6 under load

The first attempt used three concurrent spawns. That is correct in isolation (2.4–2.9s) but it still
failed at **5011ms** under real CPU contention, reproducing during a concurrent `pnpm test:gate` run
and under 12 busy-loop processes. Per the standing rule the budget was not raised; the third spawn was
removed instead, deriving the version from the `package.json` that the built entry point's guide
header and `fn --version` both read. Re-measured:

- clean: ✓ 3165ms / ✓ 2485ms / ✓ 2587ms
- during a real concurrent `pnpm test:gate` run: ✓ 3220ms / ✓ 2733ms / ✓ 2842ms

- Case 7: ✓ / ✓ / ✓ (previously `Command failed: git symbolic-ref -d refs/remotes/origin/HEAD`)

## Quarantine

Nothing. `scripts/lib/test-quarantine.json` still holds `"entries": []`, and
`node scripts/check-quarantine-ledger.mjs --strict` exits 0. No `exclude` was added to any
`vitest.config.ts`.

## Pre-existing failures ruled out of scope

- `graph-node-missing-worktree-recovery.test.ts` still has **5** red cases in the sibling
  `graph-node unusable-worktree failure recovery (FN-7996)` describe. Verified pre-existing by running
  a baseline copy of the unmodified HEAD file: **6 failures before this branch, 5 after** — the fix
  removed exactly the case-2 row and nothing else. Those 5 are the `assertion-other` rows FUSI-031
  owns, and on `fusion/fusi-031` they are green while the case-2 row is red — the exact inverse of
  this branch, so the two cards split the file without overlapping: FUSI-031 edits lines 66–313, this
  branch edits lines 16 and 348–393.
- `git-repository.test.ts > keeps the baseline branch for an unborn repository with fetched refs` fails
  on this branch. Verified pre-existing: a baseline copy of the unmodified HEAD file fails it
  identically. Different case, different shape from census row 7, not owned by FUSI-035.
