# Self-Improvement Learning Ledger Contract

[← Docs index](./README.md)

<!--
FNXC:AutoImprovement 2026-09-29-10:11:
The self-improvement loop keeps a DEDICATED proposal+evidence ledger rather than reusing the
Memory/Evals/Skills prose surfaces. Those surfaces are narrative and may later be rewritten,
re-scored, or archived; the loop's decision substrate must stay auditable independently of them.
This page is the single written contract for that substrate.

FNXC:AutoImprovement 2026-09-29-10:11:
This page documents the record contract that actually shipped in FUSI-009. The store, revert
transitions, run-audit emission, structural denylist, deterministic primary gate, replay corpus and
operator surface are LATER M1 slices and are marked "not yet shipped" below. Do not document a
field, state, or event the code does not actually have — a contract doc that runs ahead of the code
is worse than no doc, because the gate and the ledger then disagree about what is real.

FNXC:AutoImprovement 2026-09-30-12:59:
Four of those slices have since landed on the mission branch, so their "not yet shipped" marks are
removed and each section now states the shipped shape: the append-only store methods (FUSI-010), the
revert/re-apply write transitions (FUSI-011), run-audit emission of ledger transitions (the
`selfimprove:*` façades declared in FUSI-012, wired to their call sites in FUSI-015), the
deterministic primary gate (FUSI-016, documented below), and the test-count delta guard (FUSI-017,
documented above). The remaining unshipped list is the structural denylist, the gate runner that
consumes the delta verdict, the versioned replay corpus, the persisted-verdict/precedence rule, and
the `fn_selfimprove_*` operator surface — those stay marked, because inventing a shipped contract for
them is the failure mode the block above forbids.

FNXC:AutoImprovement 2026-09-30-13:45:
FUSI-018 adds the COST-BUDGET arm of the deterministic primary gate (pure measurement over recorded
per-task cost observations, a comparability refusal that fires before any delta is computed, and a
per-axis slack verdict). It is now documented under "Cost-budget invariants" rather than listed as
unimplemented. Its determinism is the whole point: the verdict is a function of recorded observations
and never of a clock, so measuring twice yields the same answer. The gate's OTHER boolean arms
(build/lint/typecheck, the test-count delta arm's gate runner), the structural denylist, the replay
corpus, and the operator CLI remain unimplemented and stay marked — this page still describes no
field, state, or event the code does not actually have.

FNXC:AutoImprovement 2026-09-29-10:24:
STATUS OF THE CODE THIS PAGE DESCRIBES. FUSI-009 is committed (37bd1f102) on the mission branch
mission/M-MULZRJQ4-0001-IF11, NOT on main, and is pending merge. Every file path and migration
named below is therefore absent from the current checkout until that branch lands: grepping
`canApplyProposal`, `LearningProposal` or `learning_proposals` in this tree returns only this
document. The contract below is accurate to that committed code, but the symbols are not yet
greppable in the reader's working tree, so this page must be re-read as a forward contract for the
merge, not as a description of code already present.
-->

> **Code status:** the record contract below landed in FUSI-009 and its store, revert-write, and
> run-audit layers landed with FUSI-010/011/012/015, the deterministic primary gate landed with
> FUSI-016, the test-count delta guard landed with FUSI-017, and the gate's cost-budget invariants
> landed with FUSI-018 — all committed on the mission branch and **not yet merged into `main`**. The
> file paths and migrations named here are therefore not yet present in a `main` checkout — they
> become real when that branch lands. The still-unimplemented M1 surfaces are the denylist, the gate
> runner that consumes the delta verdict, the replay corpus, the persisted-verdict/precedence rule,
> and the operator CLI.
> See [Not yet shipped](#not-yet-shipped),
> [The deterministic primary gate](#the-deterministic-primary-gate), and
> [Cost-budget invariants](#cost-budget-invariants-fusi-018).

## Overview

The Fusion self-improvement loop lets the orchestrator propose changes to itself in a **measurable
and reversible** way, and **never alone on `main`**. This page specifies the **learning ledger**: the
durable record of *what was proposed, how confident it was, what value it currently asserts, what
value it previously asserted, when it goes stale, and what evidence backs it*.

Two guarantees define the ledger:

- **Auditable**: a proposal's decision is a structured record in its own right, not a derivation
  from a narrative surface that may change underneath it.
- **Reversible**: every applied value remembers the value it replaced, so the loop can roll back to
  a known prior state instead of guessing.

## Apply ordering: data layer first

The loop mutates in a fixed order — **settings-like data first, then workflows, then agent
prompts/instructions, and only then engine self-patching**. The ledger's `target` field encodes
the first rung of that order and is a closed enum, so a proposal can only target a product surface,
never the raw engine:

| `target` | Surface |
|---|---|
| `memory` | Memory records |
| `evals` | Eval definitions and scores ([Task Evaluations](./evals.md)) |
| `skills` | Skill definitions |

Engine self-patching and the workflow/prompt rungs above these data surfaces are later milestones;
the ledger records them under the same `target` enum only once those surfaces exist.

## Record fields

One live record per `(project, proposalId)`. Re-application **versions the record in place** rather
than appending a new identity, so the ledger keeps exactly one entry per proposal plus the value it
previously held.

| Field | Type | Meaning |
|---|---|---|
| `proposalId` | `string` | Stable identity of the proposal (primary key, alongside project). |
| `target` | `"memory" \| "evals" \| "skills"` | Product surface the proposal acts on. |
| `origin` | `string` | Where the suggestion came from (e.g. `eval-failure`, `manual`, `memory-decay`). Free-form; never recorded in run-audit. |
| `confidence` | `number` (`0..1`) | Confidence in the proposal. Re-versioned on every new application. |
| `value` | `number` (`0..1`) | Value the proposal currently asserts. Re-versioned on every new application. |
| `priorValue` | `number \| null` | Value held immediately before the current `value`; `null` before the first application. |
| `expiresAt` | ISO-8601 `string \| null` | After this instant the value is stale and may not be applied without reevaluation. `null` = never expires. |
| `evidenceRefs` | `{ surface, ref, observedAt? }[]` | Pointers to the observations that justify the proposal — locators, not prose. |
| `state` | see state machine | Lifecycle state of the proposal. |
| `version` | `number` | Monotonic application counter; starts at `1`, incremented by every new application. |
| `createdAt` | ISO-8601 `string` | Instant the proposal was first recorded. |

Authoritative types: `packages/core/src/types/self-improve/learning-proposal.ts`
(`LearningProposal`, `LearningProposalEvidenceRef`, `LearningProposalState`,
`LearningProposalTarget`) — present once the FUSI-009 mission branch lands; not yet in `main`.

## State machine

Four states. `expired` is a **staleness marker, not a revert** — it records that a value went out of
date, not that it was rolled back.

| State | Meaning |
|---|---|
| `proposed` | Recorded, not yet applied. Initial state. |
| `applied` | The proposal's `value` is currently asserted. |
| `reverted` | The proposal's `value` was rolled back to its `priorValue`; the evidence was withdrawn. |
| `expired` | The value went stale (`expiresAt` reached) and may not be applied without reevaluation. |

Legal transitions and the guard each obeys:

- `proposed → applied` — a new application, which also versions confidence and value
  (see [Core invariants](#core-invariants) and [Revert and re-apply](#revert-and-re-apply)).
- `proposed/applied → reverted` — a revert, which restores `priorValue`.
- `* → expired` — a staleness marker set when the deadline is reached.
- A `reverted` proposal is **not re-applicable in place**: `canApplyProposal` refuses it, so a
  withdrawn proposal must be re-evaluated into a new record before it can be applied again.

The single source of truth for what these states *mean* is
`packages/core/src/self-improve/ledger-schema.ts` — the store, gate, and revert lanes read the
helpers there instead of re-deriving the rules, so "expired" and "versioned" cannot drift into two
meanings across the loop. (That module arrives with the FUSI-009 branch; the helpers named below
`canApplyProposal`, `applyProposalVersioning`, `normalizeConfidence` are its exports.)

## Core invariants

These are the decision rules the loop is built on. They are pure functions in
`self-improve/ledger-schema.ts`:

1. **An expired value is never applied without reevaluation.** `canApplyProposal` returns `false`
   the moment `expiresAt` is at or before `now`. The boundary is inclusive — the deadline instant
   is the *last* instant the value is still fresh, so `now === expiresAt` is already stale. A
   proposal with no deadline (`null` or unparseable) never expires.
2. **Confidence and value are versioned together on every new application.**
   `applyProposalVersioning` moves the old `value` into `priorValue` and increments `version` in the
   same step, so a proposal can never silently change weight without its own history recording the
   change. It returns a **new** record and never mutates its input.
3. **Malformed signals collapse, they don't crash.** `normalizeConfidence` bounds any input to
   `0..1` and falls back rather than throwing, because a malformed learning signal must not crash
   the loop that is trying to measure it.

## Revert and re-apply

- A revert restores the value the proposal held **immediately before** the current application
  (`priorValue`), not a hardcoded zero. This is exactly why `priorValue` is denormalized
  point-in-time evidence: once the next application overwrites `value`, the pre-application value
  would otherwise be underivable.
- Re-applying versions the record again: `version` increments, the current `value` becomes
  `priorValue`, and confidence/value move together. Identity (`proposalId`), `origin`, `target`,
  `evidenceRefs`, and `createdAt` are preserved across an application.
- A reverted proposal cannot be re-applied in place (`canApplyProposal` refuses `reverted`); it must
  be re-evaluated into a new, non-reverted record.

**Write-path status:** the record and its revert **substrate** (the `reverted` state, the
`canApplyProposal` refusal, and the `priorValue` versioning) shipped in FUSI-009, and the revert
**write transitions** shipped with FUSI-010/FUSI-011: `appendLearningProposal`,
`recordLearningApplication`, `recordLearningReversal`, and `listLearningProposals` on `TaskStore`
(thin delegations over `packages/core/src/task-store/async/async-learning-ledger.ts`). Each write is
an INSERT only — no store method updates or deletes a proposal row or its events — which is the
append-only contract the revert decision reads from.

## Persistence

The ledger is durable and **project-scoped**: `project.learning_proposals`, created by migration
`0087_fn_selfimprove_learning_ledger.sql` and declared in the Drizzle project schema. This
persistence layer is committed in FUSI-009 but is **not on `main` yet**; the constraints below
describe the shipped migration, not a table a reader can inspect in the current tree.

- **Primary key:** composite `(project_id, proposal_id)` — one live record per proposal per project,
  which is what lets re-application version in place instead of multiplying rows.
- **Project isolation:** row-level security on `project_id`, with the project-id assignment trigger.
- **Constraint parity:** `CHECK` constraints restate the TypeScript contract at the database
  boundary — the four states, the three targets, and `0..1` for both confidence and value — so a
  drifted or hand-written write is rejected rather than read back as truth by the later gate.
- **`prior_value` is nullable** because no value is held before the first application;
  `evidence_refs` is `jsonb` because a ref is a structured locator, not prose.
- **No `REFERENCES` clause:** the table describes a product surface, not a task, so it must survive
  task-archive cleanup. (Same precedent as `patchnode_entries`.)
- **Restore sentinel:** `SELFIMPROVE_LEARNING_LEDGER_VERSION` so an upgraded project gains the table
  before any self-improvement lane reads it.

## Run-audit

Every ledger transition writes one row to the platform's existing audit trail, following the repo's
**ids/counts/outcomes-only** convention — never description prose, never a free-form verdict, never a
diff, never `origin` (which is free-form by design). See the
[Run-Audit Catalogue](./run-audit.md) and the "Run Audit" rules in [AGENTS.md](../AGENTS.md).

<!--
FNXC:SelfImproveRunAudit 2026-09-29-23:32:
This section used to describe an intended contract; FUSI-015 made it the description of shipped
behavior. The three mutation types, their metadata fields, and the emission points below are the
emitted reality, verified by `packages/core/src/__tests__/self-improve-run-audit-sink-health.test.ts`
(façade × sink-mode matrix) and by the pg suite, which asserts the three rows in order and re-runs
every transition against throwing, rejecting, and never-settling sinks.
-->

- **The three events** — `selfimprove:proposal-created`, `selfimprove:proposal-applied`,
  `selfimprove:proposal-reverted` — mirror the ledger trail's `kind` CHECK one-for-one. They are the
  sole writers of the `selfimprove:*` prefix; ledger code must never call `recordRunAuditEvent`
  directly.
- **Metadata** is built from a closed field list per façade (`selfImproveEvent` in
  `packages/core/src/self-improve/self-improve-run-audit.ts`) and never spreads caller input:
  created → `proposalId`, `target`, `evidenceCount`, `outcome`; applied → additionally `version`,
  `confidence`, `value`, `hasPriorValue`; reverted → `revertedEventId` plus `revertReason`, a fixed
  five-member enum mirrored from the `0089` CHECK, so "why was this undone?" is answered by counting
  reasons. Evidence is a COUNT (`evidenceCount`), never the refs; `priorValue` is a boolean
  `hasPriorValue`, never the number.
- **Emission points** are the three `TaskStore` WRITE delegations in `packages/core/src/store.ts`
  (`appendLearningProposal`, `recordLearningApplication`, `recordLearningReversal`), each AFTER the
  awaited write has returned its committed row. `listLearningProposals` emits nothing — a read is not
  a transition.
- **Never on the success path:** the emit is deliberately **unawaited**, and the seam never throws or
  rejects, so an absent, throwing, rejecting, never-settling, or late-settling sink changes what is
  observed and nothing about what the ledger did. Emission goes through the **bounded** core seam
  (`emitBoundedRunAudit` in `packages/core/src/run-audit/emit-bounded-run-audit.ts`, timeout
  `CORE_RUN_AUDIT_EMIT_TIMEOUT_MS`); FN-9177 keeps that seam in core because core cannot import engine.
- **`timestamp` is the transition's own durable instant** — the proposal's `createdAt` or the event's
  `occurredAt` — not `Date.now()`, so the audit trail orders against the ledger it observes.
- **Never fabricate a weight:** the `applied` row needs `version`/`confidence`/`value`, which the
  appended EVENT does not carry, so the delegation reads the committed proposal row
  (`readLearningProposal`). A null row, or a read that throws after the event already committed,
  SKIPS the emit and still returns the committed event — an audit row that invents a confidence the
  ledger never asserted is worse than a missing row.

## Cost-budget invariants (FUSI-018)

The deterministic primary gate must answer, before it can keep a candidate change: **did the change make
the same work more expensive?** FUSI-018 ships the answer to that one question. This section is the
shipped contract for the comparison. It lives beside the ledger because the verdict it produces is the
input to the later apply/revert decision, and it mutates no proposal state.

<!--
FNXC:SelfImproveCostBudget 2026-09-30-13:45:
FUSI-018 ships the cost arm of the primary gate: three pure modules under
`packages/core/src/self-improve/` (`cost-budget-types.ts`, `cost-budget-measure.ts`,
`cost-budget-guard.ts`) plus one bounded-emit façade. The gate's other arms — build/lint/typecheck,
test-count delta, structural denylist — are separate slices and are NOT described here.
-->

### Measurement is by recorded observation, never by clock

A run is measured by `measureCostRun(observations)`, a **pure** function: it reads no clock, opens no
store, imports no engine, and starts no process. It sorts the observations by `taskId`, sums the three
axes, and returns totals carrying a `sha256:` fingerprint over the canonical content (corpus id, seed,
task count, ordered task ids, all three totals, and the two consistency flags).

This is what makes a verdict reproducible. Wall-clock belongs in the RECORD — an observation's
`wallClockMs`, captured once by whatever ran the task — and never in the MEASUREMENT. A measurement
that sampled `Date.now()` at read time could differ between two runs of the same corpus, which would
make "the candidate is over budget" an unreproducible claim and the whole gate worthless.

Because ordering is canonicalized by sort rather than by arrival, a shuffled input produces
byte-identical totals and an identical fingerprint. Two runs that merely arrived in different orders
are still the same run.

### Three axes, judged independently

`tokens`, `steps`, and `wallClockMs` are evaluated separately, in that fixed order. Any single axis
exceeding its slack fails the run, and the verdict names **every** exceeded axis rather than the
first — so an operator is not handed one problem at a time. There is no aggregate score and no
offsetting between axes: a candidate that is faster and far more expensive is still over budget.

The token convention mirrors `getTokenBudgetUsage` in
`packages/engine/src/concurrency/token-budget-enforcer.ts` exactly — **input + output + cacheWrite,
cache reads excluded**. That is deliberate: the platform's token budget already excludes cache reads
(a cache hit saves input tokens without the task getting cheaper to run), so a guard that counted them
would report a change as more expensive precisely when it made caching more effective.

Slack is **absolute per axis**, not a ratio. The operator-facing question is "how much more may this
spend", and a percentage allowance would silently widen the budget every time the corpus grew.

### Comparability is checked before any subtraction

`evaluateCostBudget({ baseline, candidate, slack })` refuses with `not-comparable` and computes **no
delta at all** when:

| Reason | Meaning |
| --- | --- |
| `corpus-mismatch` | The two runs measured different task sets. |
| `seed-mismatch` | The two runs used different seeds, so at least one input order could differ. |
| `ordering-mismatch` | Same corpus and seed, but the canonical task orders differ. Task-set and seed identity do **not** imply order identity. |
| `inconsistent-run` | One side's own observations disagree with each other — a mixed corpus id, a mixed seed, or the same task measured twice. |

The refusal **outranks** the budget verdict: a delta between two differently measured runs is a number
with no meaning, so reporting one would let an obviously invalid comparison pass a gate while still
producing a plausible figure. Refusing is also distinguishable from failing, which matters to an
operator: "these two runs cannot be compared — fix the harness" is a different instruction from "the
candidate spent too much".

`inconsistent-run` is reachable only because measurement **records** agreement rather than leaving it
to be re-derived. Summing destroys the evidence — once a mixed set is collapsed into one total the
second corpus id no longer exists anywhere — so `measureCostRun` carries `consistentCorpus` and
`consistentSeed` as measured facts and folds both into the fingerprint. A contaminated run therefore
cannot collide with (and be cached as) the clean run it impersonates.

### Verdict shape

A verdict is one of three values, discriminated by `verdict`:

- **`within-budget`** — comparable, and no axis exceeded its allowance. `failures` is empty.
- **`over-budget`** — comparable, and at least one axis exceeded. `failures` names each one with the
  **axis, both measured totals, the signed delta, and the allowance that was exceeded**. Both numbers
  travel with the refusal on purpose: the measurement is the expensive part of an evaluation, so
  demanding a re-run just to explain a verdict would be the wrong trade.
- **`not-comparable`** — the runs were not measured the same way. `reason` is present; `deltas` and
  `failures` are **absent**.

`baseline` and `candidate` totals are always echoed back, refusal included, so a verdict names the
exact inputs it judged.

### Where it is recorded

Every evaluation emits `selfimprove:cost-budget-evaluated` through the same bounded core seam as the
three ledger façades. It is a **gate verdict, not a ledger transition**: it has no `kind` in the
`learning_ledger_events_kind_check` CHECK and is never appended to that trail. Metadata is identities,
counts, and fixed outcomes only — `proposalId`, `target`, `outcome`, `projectId`, each side's
`corpusId`/`seed`/`taskCount`/`fingerprint`, plus conditional `reason` and `exceededAxes`.

The measured token/step/millisecond totals are **deliberately not audited**: they are corpus-specific
figures that mean nothing outside the run that produced them, and recording them would invite comparing
a cached baseline against a candidate possibly measured days later under a different corpus. What is
durable is *which* corpus, *which* seed, *how many* tasks, and *which* axes moved. See the
[Run-Audit Catalogue](./run-audit.md) for the full metadata contract.

## Safety rails

Shipped in FUSI-017:

- **Test-count delta guard:** a candidate that deletes a test, disables one, or collects fewer tests
  than the baseline is a regression *even when every remaining test is green* — see
  [Test-count delta guard](#test-count-delta-guard-fusi-017-shipped).

Mission-level, enforced by later slices:

- **Structural denylist** (gate, ratchets, quarantine ledger, release, and the self-patching code
  itself) is immutable — a diff touching it is rejected **before** the gate runs.
- **`main` is human-only:** on `main`, a human decides, via PR. The loop never lands by itself.
- **Isolation:** experiments run in a branch/worktree and a standalone sandboxed engine (own
  worktree, directory, DB/project, port, mock provider); the live engine is never restarted.

## Test-count delta guard (FUSI-017, shipped)

The guard is the primary gate's **measuring rule for coverage**: it compares a candidate test run
against a recorded baseline and returns a boolean verdict with a fixed-enum reason list. It is pure
— it never runs vitest, reads the filesystem, persists a baseline, or emits run-audit. Those belong
to the gate runner that *consumes* the verdict.

It exists because a fully green run proves only that the tests which **ran** passed. A change that
deletes a test, comments it out, or flips it to `.skip` is green in exactly the case that matters,
so build/lint/typecheck/gate/affected-tests all pass over a coverage-destroying diff. The guard
closes that hole independently of the remaining tests' outcome.

`packages/core/src/self-improve/test-count-delta.ts` (exported from `@fusion/core`):

- `buildTestCountSnapshot(report)` normalizes a vitest JSON-reporter payload into a
  `TestCountSnapshot`. Non-executed tests are counted from the **per-assertion `status`**, never
  from the aggregate `numPendingTests`/`numTodoTests` counters (those also count queued or still-
  running tests). The inventory id is `testFile::fullName`, mirroring `check-test-inventory.mjs`.
  `total` is the number of **collected** assertions, so a `passed → skipped` flip keeps it flat
  (caught by the skip rule) while a deleted test lowers it (caught by the count rule).
- `fingerprintSnapshot(snapshot)` / `createTestCountBaseline(snapshot)` produce a `sha256:` over a
  canonical, **clock-free** serialization of the counts plus sorted ids. The reporter's
  `startTime`/`endTime`/`duration` are deliberately excluded, so the same candidate always yields
  an identical verdict and fingerprint.
- `evaluateTestCountDelta({ baseline, candidate, quarantinedFiles, repoRoot })` returns
  `{ ok, reasons, removedCount, addedCount, skippedDelta, totalDelta, fingerprint }`.

**Fixed reason enum** (closed, never prose — so the verdict stays ids/counts/fixed-outcomes only for
the audit and ledger rows the consumer writes):

| Reason | Fires when |
|---|---|
| `test-count-regressed` | the candidate collected **fewer** assertions than the baseline, net of quarantine-listed files |
| `test-removed` | a baseline inventory id is absent from the candidate, net of quarantine exemptions |
| `test-skipped` | the candidate's **non-executed** count **exceeds** the baseline's |

**Rules:**

- Removal or skip is a regression **even when every remaining test passed** — the guard never
  consults the failure count, precisely because a coverage-destroying change passes when what is
  left is green. `ok` is true only when `reasons` is empty; pure additions pass.
- The three rules are **disjoint**: a deleted test fires count + removed, a skip keeps the count flat
  and fires only the skip delta, and a pure add moves nothing negative.
- A removal is exempt from **both** `test-removed` and `test-count-regressed` only when its file is
  **actually listed** in the quarantine ledger (`scripts/lib/test-quarantine.json`). This is the
  escape hatch that keeps the guard from deadlocking with the quarantine deletion ratchet (a
  quarantined file is deleted by design after 14 days; without the exemption the two mechanisms
  would block each other). The exemption is **net, not merely excusing**: a quarantined file's
  assertions are subtracted from the collected-count comparison as well, exactly as
  `check-test-inventory.mjs` prescribes for its own `--diff` guard ("diff against *snapshot minus
  quarantined entries*"). A ledger-sanctioned deletion therefore returns `ok: true` outright and
  reports `totalDelta: 0` — the number always explains the verdict. Netting only the removal reason
  would have traded `test-removed` for `test-count-regressed` and left the deadlock in place. The
  exemption cannot be widened to an unlisted file on either rule.
- The ledger stores **repo-relative** paths while vitest's JSON reporter records
  `testResults[].name` as an **absolute** path, so the guard normalizes before lookup: callers may
  pass `repoRoot` (the module never reads the filesystem), and with no root it matches a
  repo-relative entry as a `/`-anchored path **suffix**. Without this normalization the exemption
  would silently never apply in production, re-creating the deadlock behind a guard that appears to
  have an escape hatch.
- `test-skipped` is a **directional** count, not a per-id flip, so a pre-existing skip that stays
  skipped is not a regression — only a *newly* disabled test is. `skippedDelta` is deliberately
  **not** quarantine-netted: the ratchet deletes a whole file, which creates no new skips.

This module is standalone: it imports nothing from the gate runner (FUSI-016) or the denylist
(FUSI-019) and consumes no baseline from disk.

## Not yet shipped

This page covers the record contract that landed in FUSI-009, the store/revert/run-audit layers that
landed with FUSI-010/011/012/015, the gate library (FUSI-016), the test-count delta guard
(FUSI-017), and the cost-budget invariants (FUSI-018) — all committed on the mission branch and
**not yet merged into `main`**, so none of that code is greppable in a `main` checkout. The
following are later M1 slices and are **not** in the code at all:

- Structural denylist enforcement, the deterministic primary gate *runner* (FUSI-016's gate library
  above is landed, but the runner that consumes the delta guard's verdict is not), the versioned
  **replay corpus** + manifest with cached baseline and comparability guard, and the CLI/pi
  `fn_selfimprove_*` operator surface (status, proposals, experiments, veto, pause, force-revert).
  The **persisted verdict / precedence** rule is likewise a later slice.

The gate runner and the replay canary are described in the mission brief, not implemented yet; when
they land, this page is extended with the replay manifest's comparability rules. The cost-budget arm
of the primary gate shipped in FUSI-018 and is described under
[Cost-budget invariants](#cost-budget-invariants-fusi-018).

## The deterministic primary gate (FUSI-016)

The gate is the boolean ruler that decides whether a self-improvement candidate is **kept** or
**reverted**. It answers a plain yes/no the way every other change here is judged: build, lint,
typecheck, the merge gate, and only the tests the diff actually touches. Two runs over the same
candidate and corpus return the same verdict and the same fingerprint.

**The five steps** — `build`, `lint`, `typecheck`, `gate`, `affected-tests`. Each yields a boolean;
the verdict `passed` is true only when all five pass. A single failing, timed-out, or unreadable
step rejects the candidate.

**Fail-closed** — a step that timed out, could not be spawned, or whose result could not be read is
recorded as NOT-passing (never as a skip). Missing evidence must not approve a candidate.

**Reproducibility** — the verdict's `fingerprint` content-addresses (sha256) exactly the inputs that
can change a decision: the candidate sha, the sorted per-step booleans, and the sorted affected-test
file list. It excludes wall-clock, duration, and log text, so it identifies *what was decided*, not
how. Two identical runs share a fingerprint; flipping any step boolean, the candidate sha, or the
affected-test list changes it.

**Affected-file scoping, never full-suite** — the `affected-tests` step runs a per-file
`vitest run <resolved files>` derived from the diff. There is no full-suite parameter anywhere in
the executor: a whole-workspace run is structurally unreachable, mirroring the repo rule that
verification is scoped to changed files. An empty diff is an explicit `empty` state (not a silent
pass), a deleted test path yields no live entry, and a changed vitest config fans out to its
package.

**Sandbox isolation** — the executor spawns every step under the `superviseSpawn` supervisor with
`cwd` bound to a caller-supplied sandbox worktree and the mock/test-mode env
(`FUSION_TEST_MODE=1`). The live engine's cwd is never handed to a child, the live engine is never
restarted or reloaded, and git capture is bounded (max buffer + timeout) so a huge or hung diff
fails closed with a named reason instead of wedging.

**Run-audit** — each gate run emits `selfimprove:gate-run` (see
[Self-improvement primary-gate run](./run-audit.md#self-improvement-primary-gate-run-fusi-016))
recording the boolean verdict, the fingerprint, the per-step ids/booleans, and counts — ids,
counts, and booleans only, never the diff, command lines, or log prose. The emission is
best-effort: a hostile audit sink never alters the verdict the caller already holds.

## Related documentation

- [Task Evaluations Scoring Contract](./evals.md) — the `evals` surface a proposal may target.
- [Run-Audit Catalogue](./run-audit.md) — the ids/counts/outcomes-only event convention.
- [AGENTS.md](../AGENTS.md) — FNXC comment rules, the "tests never assert comments" rule, and the
  run-audit emitter seams.
- [Architecture](./architecture.md) — where the loop's engine-side surfaces fit.
