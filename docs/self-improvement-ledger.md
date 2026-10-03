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

FNXC:AutoImprovement 2026-09-30-15:26:
FUSI-020 lands a further M1 slice: the deterministic gate's VERDICT RECORD and its PRIMARY-GATE
PRECEDENCE rule, so the persisted-verdict/precedence rule is no longer on the unshipped list. The
"Deterministic gate verdict record" section below states the shipped shape (the closed verdict enum,
the four-branch precedence rule in which the primary always prevails over the replay canary, the
derived idempotent verdict id, the two required readers, and the bounded
`selfimprove:gate-verdict-recorded` audit row). What remains unshipped is the gate RUNNER that computes
the primary signals and drives the canary, the replay corpus's cached baseline and comparability guard
(the versioned manifest contract itself landed later, in FUSI-030 — see
[Replay corpus manifest](#replay-corpus-manifest-fusi-030)), the structural denylist, and the
`fn_selfimprove_*` operator surface — the verdict record is the durable destination the runner will
write to, so recording the verdict contract now is accurate while leaving the runner, baseline cache,
and comparability guard marked as not-yet-shipped.

FNXC:AutoImprovement 2026-09-29-10:24:
STATUS OF THE CODE THIS PAGE DESCRIBES. FUSI-009 is committed (37bd1f102) on the mission branch
mission/M-MULZRJQ4-0001-IF11, NOT on main, and is pending merge. Every file path and migration
named below is therefore absent from the current checkout until that branch lands: grepping
`canApplyProposal`, `LearningProposal` or `learning_proposals` in this tree returns only this
document. The contract below is accurate to that committed code, but the symbols are not yet
greppable in the reader's working tree, so this page must be re-read as a forward contract for the
merge, not as a description of code already present.
*/

/*
FNXC:AutoImprovement 2026-09-30-15:26: FUSI-020 lands the deterministic gate's verdict record and
primary-precedence rule; the block above states exactly which M1 surfaces remain unshipped.

FNXC:AutoImprovement 2026-09-30-19:22: FUSI-031 lands the baseline cache with its content-addressed
fingerprint, the reuse/rebuild resolver, the durable cache table, and the operator status read model.
The cached-baseline arm of the replay-corpus bullet in the code-status block is therefore no longer
entirely unshipped: the cache and its invalidation contract are real.

FNXC:SelfImproveBaselineCacheStatus 2026-09-30-20:35: FUSI-034 lands `fn_selfimprove_status`, the
operator tool that RENDERS the `BaselineCacheStatus` read model. Before it, the read model was built
and unit-tested but nothing displayed it — every occurrence of the tool name in the repository was a
comment describing a future render target — so an operator could not answer "may I reuse this
baseline, and why" without a bespoke SQL query, and a silent incomparability had no first-class read
path. The tool renders the read model VERBATIM through the one accessor (`readBaselineCacheStatus`),
so it cannot report a reuse rule the cache is not governed by. It NEVER renders the cached payload:
what must be observable is WHICH fingerprint is in play, never WHAT was measured. Each call records
one `selfimprove:baseline-cache-resolved` row through the bounded FN-9177 seam, and telemetry is not
load-bearing — a hostile sink leaves the returned read model unchanged.

FNXC:SelfImproveBaselineCacheStatus 2026-09-30-20:35: The tool takes the fingerprint INPUTS as
parameters and deliberately does NOT read them from the FUSI-030 manifest. That manifest carries a
NUMBER `version` and a different digest (`fingerprintReplayCorpusManifest`), which are not this
feature's `manifestVersion`/`configHash`; binding them together belongs to the measurement runner,
which is still unshipped. Until then the operator supplies the exact inputs a measurement would use
and the tool answers reuse-vs-rebuild for exactly those inputs.
*/

> **Code status:** the record contract below landed in FUSI-009 and its store, revert-write, and
> run-audit layers landed with FUSI-010/011/012/015, the deterministic primary gate landed with
> FUSI-016, the test-count delta guard landed with FUSI-017, the gate's cost-budget invariants
> landed with FUSI-018, the structural denylist and its pre-gate guard landed with FUSI-019, the
> gate's persisted verdict record and primary-precedence rule landed with FUSI-020, the versioned
> replay corpus manifest landed with FUSI-030, the cached replay baseline with its fingerprint-based
> invalidation landed with FUSI-031, the secondary ruler's four corpus metrics landed with FUSI-033,
> and the `fn_selfimprove_status` operator tool that renders the baseline-cache status read model
> landed with FUSI-034 — all
> committed on the mission branch and **not yet merged into `main`**. The file paths and
> migrations named here are therefore not yet present in a `main` checkout — they become real
> when that branch lands. The still-unimplemented M1 surfaces are the gate runner that computes
> the primary signals and drives the canary, and the
> operator CLI.
> See [Not yet shipped](#not-yet-shipped),
> [The deterministic primary gate](#the-deterministic-primary-gate),
> [Cost-budget invariants](#cost-budget-invariants-fusi-018),
> [Replay corpus manifest](#replay-corpus-manifest-fusi-030),
> [Cached replay baseline](#cached-replay-baseline),
> [Corpus metrics](#corpus-metrics-fusi-033),
> [Replay comparability guard](#replay-comparability-guard-fusi-032), and
> [Deterministic gate verdict record](#deterministic-gate-verdict-record).

FNXC:AutoImprovement 2026-09-30-19:35:
FUSI-030 lands the REPLAY CORPUS MANIFEST — the versioned, validated document that declares which task
ids a corpus covers, in which order, under which seed, with which provider. The cost-budget arm above
already refuses to compare two runs that disagree on corpusId/seed/order, but until now those facts
lived only as arguments a caller happened to pass, so "the same corpus" was an unverifiable claim.
This manifest is the single on-disk declaration of them, plus a stable fingerprint the comparability
machinery can key on. It is PURE types + a PURE validator: it declares a corpus, it does not run one.
The provider is typed as the single mock literal (unrepresentable at the type level, not merely
rejected at runtime) so no corpus run can ever reach a real model, and version is data rather than a
boolean flag so a v1 document is refused by a v2 loader instead of silently half-interpreted. The
baseline CACHE that consumes it landed with FUSI-031 and the comparability GUARD is the later slice
FUSI-032; both stay on the not-yet-shipped list together with the measurement runner that would
actually EXECUTE a corpus and skip re-execution on a reuse.

<!--
FNXC:AutoImprovement 2026-09-30-20:31:
Conflict resolution: FUSI-030 (manifest), FUSI-031 (cached baseline), and FUSI-033 (corpus metrics)
all extend this same status block. The merged text names all three, and the "See" list links all three
sections, so the merged page claims exactly the surfaces the merged code actually ships. The list of
not-yet-shipped surfaces is reconciled in the same way: the canary that CONSUMES the FUSI-033 metrics
is still unshipped, and so is the operator CLI.

FNXC:AutoImprovement 2026-09-30-20:49:
FUSI-032 lands the replay corpus's COMPARABILITY GUARD, so the surfaces listed as unshipped in the
block above and in FUSI-030's own dated note are now real. The guard is PURE — four fixed dimensions
(`manifest`, `seed`, `engine`, `config`), a closed refusal vocabulary (`divergent-identity` |
`not-a-run`), and a refusal that fires BEFORE any delta is computed — and it consumes exactly the
manifest fingerprint FUSI-030 ORIGINATES and the cached baseline FUSI-031 stores. Its contract is
documented under [Replay comparability guard](#replay-comparability-guard-fusi-032); its bounded
`selfimprove:comparability-refused` row is catalogued in the Run-Audit Catalogue.

This block records the transition rather than rewriting the dated blocks above it: those describe
their own moment, and a contract page that simultaneously documents a surface and denies it exists
is the exact failure this page's header warns against.
-->

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

## Replay corpus manifest (FUSI-030)

The versioned declaration of *what a corpus is*. The cost-budget arm above refuses to compare two
runs that disagree on `corpusId`, `seed`, or the canonical task order — but until FUSI-030 those
facts lived only as arguments a caller happened to pass, so "the same corpus" was an unverifiable
claim. This manifest is the single on-disk declaration of them, and its fingerprint is the identity
the comparability machinery can key on.

Shipped in FUSI-030 as **pure types plus a pure validator**: it declares a corpus, it does not run
one. There is no store, no engine path, and no provider client.

### Fields

| Field | Meaning |
|---|---|
| `version` | Schema version; must be in `REPLAY_CORPUS_MANIFEST_VERSIONS` (currently `[1]`, exposed as `REPLAY_CORPUS_MANIFEST_VERSION`). |
| `corpusId` | Identity of the task set; travels with every measurement so a run cannot be silently relabelled. |
| `taskIds` | The tasks the corpus covers, in **declared** order. |
| `seed` | The run's seed; a re-seeded corpus is a different corpus. |
| `provider` | Always the **mock** provider. |
| `order` | How `taskIds` becomes the canonical order: `lexicographic` or `manifest`. |
| `reproducibility` | Three booleans — `deterministicSeed`, `stableOrder`, `mockProviderOnly` — the rules the corpus commits to. |

The **provider is a single literal, not a union with a restriction**. `provider` is typed as
`typeof MOCK_PROVIDER_ID`, so there is no union arm through which a real provider id can be written
at all: a non-mock provider is *unrepresentable at the type level*, not merely rejected at runtime.
That is stronger than a union plus a validator, which is a convention a future edit can quietly
relax. A corpus run must never reach a real model, because a real call would make both the cost
measurement and the gate verdict irreproducible.

**Version is data, not a flag.** `version` is a `number` compared against the accepted-versions
array, not a `legacy?: boolean`. A boolean admits exactly two histories; a version admits N and says
which one a document was written against, so a v1 document is *refused* by a v2 loader rather than
silently half-interpreted.

### Load-time validation

`loadReplayCorpusManifest(raw)` returns a result — it never throws — so the caller (a gate deciding
whether to measure) learns *which* defect it hit without a try/catch. It copies `taskIds` and
`reproducibility`, so the loaded manifest is a **snapshot** a later caller mutation cannot reach.

Refusal reasons are a **closed enum**, and each refusal names the offending **field** but never the
offending **value** (the value may be a task id; echoing caller text into an operator surface is how
injection and secret-leak bugs start):

| Reason | Refused because |
|---|---|
| `unsupported-version` | `version` is absent or outside the accepted set. |
| `missing-field` | A required field is absent or the wrong type (including a non-object document). |
| `empty-corpus` | `taskIds` is empty — a corpus with no tasks has nothing to replay. |
| `duplicate-task-id` | The same task id appears twice. |
| `empty-task-id` | A task id is empty or non-string. |
| `provider-not-mock` | `provider` is not the mock provider. |
| `unsupported-order` | `order` is not `lexicographic` or `manifest`. |
| `unknown-field` | The document (or its `reproducibility` block) carries a field this version does not define. |

`unknown-field` is **refused, not ignored**: a permissive reader would happily accept a document
written for a future version and then measure the corpus as something it is not. Refusing the unknown
key is what makes `version` load-bearing rather than decorative.

### Ordering and the fingerprint

`resolveReplayCorpusOrder(manifest)` returns a **fresh** array and never mutates the manifest.

- **`lexicographic`** sorts by task id, so the order is a function of the *set*: a shuffled document
  resolves to the same corpus.
- **`manifest`** keeps the declared order, so a reordered document is a *different* corpus.

`fingerprintReplayCorpusManifest(manifest)` is a `sha256:` digest over a **fixed-key canonical
object** of exactly the comparability facts — `version`, `corpusId`, `seed`, `provider`, `order`, and
the **resolved** ordered task ids. It mirrors `fingerprintCostRun` and deliberately **excludes** any
timestamp, duration, or wall clock. Because the fingerprint hashes the *resolved* order, the two
modes are distinguishable by construction: a lexicographic shuffle leaves the fingerprint unchanged,
while a `manifest`-order shuffle changes it.

The loaded manifest imports nothing but `node:crypto`, the shared mock-provider literal, and its own
type module — no clock, no store, no provider client. That import list is the cheapest guard against
the two mistakes that would destroy the feature's value: sampling `Date.now()` (which would make two
runs of one corpus disagree) and reaching a provider (which would make a "reproducible" measurement
depend on a real model's availability and pricing).

The **baseline cache** (reuse/invalidation) landed with FUSI-031 and the operator tool that RENDERS its
status, `fn_selfimprove_status`, landed with FUSI-034; the comparability GUARD (FUSI-032) and the
measurement runner that would consume this manifest by supplying `manifestVersion`/`seed` are later
slices and are not yet shipped.

## Corpus metrics (FUSI-033)

The secondary ruler. Where the primary gate is a boolean over build/lint/typecheck/gate/affected-tests
plus the cost-budget invariants, the **replay canary** asks the follow-up question: over the same
corpus, did the candidate still succeed as often, need as much rework, cost as much, and run as
slowly? FUSI-033 ships the **measurement** of those four metrics. It is the pure, deterministic seam
the canary will consume; it drives no replay itself, mutates no proposal state, and adds no run-audit
event.

<!--
FNXC:SelfImproveCorpusMetrics 2026-09-30-18:56:
FUSI-033 ships two pure modules under `packages/core/src/self-improve/`
(`corpus-metrics-types.ts`, `corpus-metrics.ts`) plus their test. Unlike the cost-budget arm it has no
verdict and no guard yet — the canary that CONSUMES these metrics, and the second ruler's
keep/revert-by-canary decision, are later slices. This section therefore documents the measurement
contract only; it does not claim the canary exists.
-->

### The four fixed definitions

Each metric is a count over recorded observations or a straight arithmetic combination of counts —
never a ratio of opinions, never a model-assigned score. If a definition could vary between two
evaluations of the same corpus, the ruler would disagree with itself and become unreproducible.

| Metric | Definition |
| --- | --- |
| **Success** | The number of DISTINCT tasks whose recorded terminal `succeeded` boolean is true, and the `successRate` = `succeededTaskCount / taskCount`. The denominator is the distinct task count, matching the cost lane's counting basis so both rulers divide by the same number. |
| **Rework** | The SUM of the engine's recorded rework counter — `workflow_run_step_instances.reworkCount`, which the foreach graph increments on each `kind: "rework"` edge and `AgentSelfImproveService` already sums per task and run. |
| **Cost** | Delegated to `measureCostRun` (see [Cost-budget invariants](#cost-budget-invariants-fusi-018)). Reported as the summed `tokens`, `steps`, and `wallClockMs`. |
| **Latency** | Delegated to `measureCostRun` — the summed `wallClockMs` over the corpus. |

**Rework is a counted fact, not a subjective judgment.** That is the load-bearing definitional choice.
The engine already persists a verifiable counter; reading that recorded number gives "redone more" a
definition two readers of the same run always agree on. Deriving rework from log prose, or scoring
it, would make one run measure differently for two readers and would turn the ruler subjective — the
exact failure the primary gate's determinism rule exists to prevent.

**Cost and latency are reused, never forked.** They are the shipped cost lane's job, including its
token convention (input + output + cacheWrite, cache reads excluded), canonical ordering, and
fingerprint. This module does not restate them; it projects the recorded cost fields onto cost-lane
observations via `toCostObservations` and hands them to `measureCostRun`. A corpus therefore has exactly
ONE notion of "a run": if the corpus re-derived cost with a different rule, the canary could report a
replay as cheaper while the primary gate's cost-budget arm reported the same replay as over budget, and
neither verdict would be explainable.

### Determinism: measured by recorded observation, never by clock

`measureCorpusMetrics(observations)` is a **pure** function: it reads no clock, opens no store, imports
no engine, and starts no process. Success, rework, tokens, steps, and wall-clock all arrive already
captured on each observation. Ordering is canonicalized by **sort** on `taskId`, so a shuffled input
yields byte-identical metrics and an identical `sha256:` fingerprint — two evaluations that merely
arrived in different orders are still the same evaluation. `seed` and `corpusId` travel **with** each
observation (not as measurement parameters) so a corpus cannot be silently re-run under a different
seed or task set between the baseline and candidate passes.

### Grouping by task, and duplicates that stay visible

Metrics are grouped by `taskId` into one entry per distinct task, in canonical order. When a task was
measured more than once, its occurrences collapse into a single entry whose numeric fields **sum**, whose
`succeeded` flag is true only when **every** occurrence succeeded (a partial success must not read as
clean success), and whose `occurrences` and `duplicateTaskIds` stay in the record so a corpus that
measured a task twice is auditable rather than silently collapsed into a clean-looking total.

### Validity is recorded, not thrown

A `reworkCount` that is negative, fractional, or non-finite means the producer wrote a bad record. The
measurement sets `valid: false` and lists the offending task ids in `invalidReworkTaskIds` rather than
throwing, so a completed replay still reports its other metrics and a caller can decide whether to
refuse. Summing destroys *which* observation was bad, so the ids are captured here, at the only point
the individual observations still exist. The empty corpus is legal: it reports zero for every metric and
a success rate of zero rather than throwing or producing `NaN`.

## Structural denylist

The floor under the primary gate: an experiment may change product behavior, but it may not rewrite
the equipment that measures it. Shipped in FUSI-019 as a pure classifier plus a guard that aborts
before any gate step runs.

- **Five immutable categories**, evaluated **first-match-wins** in this order:
  1. `quarantine` — the flaky-test ledger (`scripts/lib/test-quarantine.json` and its schema). It
     leads because its consumers are also vitest configs, and the file that decides which failures
     are tolerated must always be answerable as "quarantine".
  2. `gate` — everything the merge gate's verdict depends on (see the family below).
  3. `ratchets` — the `scripts/check-*.mjs` validator family (matched by shape, so a new validator
     is protected the day it lands) plus `eslint.config.mjs`.
  4. `release` — `scripts/release.mjs`, the `.changeset/` directory, and every `CHANGELOG.md`.
  5. `self-patching` — `packages/core/src/self-improve/` and `packages/engine/src/experiment/`.

- **The gate category is a derived family, never a hand list.** The merge gate is not one file: it
  is `test:gate` → `run-static-gate-checks.mjs` (which itself reads the `test:gate:static` body out
  of the manifest at runtime) plus the four launchers `test:gate` / `test:gate:static` /
  `smoke:boot` / `verify:fast`, plus the `engine-core` vitest project that actually decides the
  verdict. Membership:
  - `scripts/run-static-gate-checks.mjs` — `test:gate`'s first command, and **not** a `check-*.mjs`.
  - `scripts/build-engine-core-gate-bundle.mjs` — wired into `engine-core` via `globalSetup`.
  - `scripts/boot-smoke.mjs` — merge-blocking at `pr-checks.yml:300`, and not a check either.
  - `scripts/verify-fast.mjs` — one of the four launchers.
  - `packages/core/src/index.gate.ts` — the reduced `@fusion/core` barrel `engine-core` aliases to;
    its drift has already broken Plan Review and 72 gate cases.
  - `packages/core/src/__test-utils__/vitest-teardown.ts` — the root `globalSetup` every project
    inherits.
  - the per-package `packages/<pkg>/vitest*.config.ts` family (not just `vitest.config.ts`), whose
    `engine-core` allow-list decides which suites are merge-blocking. The sibling configs matter
    because each is a `--config` a gate lane invokes and each `mergeConfig`s the protected base:
    `packages/core/vitest.pg.config.ts` is what `test:pg-gate` runs, so overriding include/exclude or
    `hookTimeout` there silently reweights one third of the gate.
  - the **manifests that define the gate**, matched by shape: root `package.json` and every
    `packages/<pkg>/package.json`. These are loaders, not targets. `run-static-gate-checks.mjs`
    resolves the blocking-validator inventory out of the root manifest at runtime
    (`scripts/run-static-gate-checks.mjs:55-56`), and `packages/core/package.json` holds the literal
    merge-blocking file lists for `test:unit-gate` and `test:pg-gate` — two of the three lanes the
    root `test:gate` spawns. Protecting only the scripts those bodies point at would let an
    experiment delete a validator from `test:gate:static`, or un-list a blocking test file, while
    touching **no** denylisted path, because the removed `check-*.mjs` files are never modified.
    Manifests are protected by shape rather than by inspecting their bodies, because the classifier
    is pure: it sees a path string and nothing else. Over-refusing a manifest edit (a dependency
    bump in `packages/core/package.json`) is the correct conservative answer — the floor may be
    wider than the need, never narrower.

  A **census test** re-derives this set from the repository — the four manifest gate bodies, the
  nested validator level, the on-disk `check-*` sweep, the `engine-core` `globalSetup`/`resolve.alias`
  targets, the whole `vitest*.config.ts` family, the root manifest, and each `--filter <pkg>` manifest
  the root gate spawns — and asserts each derived path classifies non-null, so a new gate-authoritative
  file fails the suite rather than the first time an experiment edits it. The manifest and sibling-config
  legs are asserted explicitly: a derivation that yielded only scripts and `vitest.config.ts` passed
  vacuously while the files holding the gate bodies were unprotected.

- **Refusal happens before the gate runs.** `guardStructuralDenylist(changedPaths, gate, options)`
  is the module's single entry and the only place the gate callback is invoked — one `await gate()`
  call site at the bottom of that function, marked `THE ONE INVOCATION SITE`. It classifies the
  full changed-path set first; on a hit it returns `{ executed: false, rejected: true, categories,
  counts, fileCount }` **without ever calling the callback**, so there is no gate verdict for a
  caller to weigh against the refusal. `rejected: true` is a hard stop the primary gate cannot
  ignore.

- **No escape hatch.** There is no `bypass`/`force`/`skipDenylist`/`override` parameter, no
  environment variable, and no settings key. An escape-hatch ratchet in the guard suite scans both
  new source files (comments stripped) for exactly those identifiers and env/settings reads.

- **The refusal is auditable, and telemetry is not load-bearing.** The row is
  `selfimprove:denylist-rejected`, written through the same bounded core seam as the other three
  events. Its metadata is a closed list — `categories`, per-category `counts`, `categoryCount`,
  `fileCount`, `rejected: true`, plus `proposalId`/`target`/`projectId` **only when present**.
  `proposalId` and `target` are optional because a commit is classified before any proposal exists
  and a code-level hit has no product target. **Paths, diffs, and prose are never recorded.** An
  absent, throwing, rejecting, never-settling, or late-settling sink still yields `rejected: true`
  with zero gate calls.

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
landed with FUSI-010/011/012/015, the structural denylist and its pre-gate guard (FUSI-019), the
gate library (FUSI-016), the test-count delta guard (FUSI-017), the cost-budget invariants
(FUSI-018), and the secondary ruler's four corpus metrics (FUSI-033) — all committed on the mission branch and
**not yet merged into `main`**, so none of that code is greppable in a `main` checkout. The
following are later M1 slices and are **not** in the code at all:

- The deterministic primary gate *runner* (FUSI-016's gate library above is landed, but the
runner that consumes the delta guard's verdict is not), the **canary that consumes** the four
  corpus metrics, and the CLI/pi `fn_selfimprove_*`
  operator surface (status, proposals, experiments, veto, pause, force-revert). The structural
  denylist shipped in FUSI-019, the **persisted verdict / precedence** rule in FUSI-020, the
  **versioned replay corpus manifest** in FUSI-030, the **cached baseline with its fingerprint and
  invalidation rule** in FUSI-031, the four **corpus metrics** in FUSI-033, and the **comparability
  guard** in FUSI-032, so none of those six is on this list.

The cached baseline itself shipped in FUSI-031 — see
[Cached replay baseline](#cached-replay-baseline) — and the versioned manifest that ORIGINATES its
`manifestVersion` and `seed` inputs shipped in FUSI-030 — see
[Replay corpus manifest](#replay-corpus-manifest-fusi-030). The comparability guard that CONSUMES
the manifest's fingerprint to decide whether two runs describe the same corpus shipped in FUSI-032 —
see [Replay comparability guard](#replay-comparability-guard-fusi-032) — and what did not ship with
it is the CLI that renders the status read model. The four corpus metrics — the secondary
ruler's measurement seam — shipped in FUSI-033 and are described under
[Corpus metrics](#corpus-metrics-fusi-033); what did NOT ship there is the **canary** that consumes
them and turns their comparison into a keep/revert decision. The gate runner and the replay canary
are described in the mission brief, not implemented yet; when they land, this page is extended with
the rules for driving a comparison from a guarded verdict. The cost-budget arm of the primary gate shipped in
FUSI-018 and is described under
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

## Deterministic gate verdict record (FUSI-020)

The gate's **verdict** is persisted as an append-only trail so an experiment's outcome is an operator-visible, reproducible record rather than a log line. The verdict contract is pure and lives in `packages/core/src/self-improve/learning-gate-verdict-types.ts`; the persistence and readers are in `packages/core/src/task-store/async/async-learning-gate-verdicts.ts`.

**Closed verdict enum** — `keep | reverse | inconclusive | abstain`. A closed enum (not free text) is required so a verdict is countable and an operator can never read a novel label off the trail.

**Primary-gate precedence.** The verdict is resolved by ONE pure function, `resolveLearningGateVerdict(primaryVerdict, canaryVerdict)`, from the primary gate's verdict and the replay canary's verdict. The rule, in order:

1. **Canary absent** → the primary's verdict stands; `precedenceOutcome: "canary-absent"`.
2. **Both agree** → that verdict stands; `precedenceOutcome: "agreed"`.
3. **Primary abstained** (`inconclusive`) → the canary decides; `precedenceOutcome: "primary-abstained"`. If the canary is *also* inconclusive, the resolved verdict stays inconclusive — an abstention is never upgraded into a decision.
4. **Both decisive and disagreeing** → **the PRIMARY gate prevails**; the canary never overturns it; `precedenceOutcome: "primary-prevailed"`.

The primary gate is a boolean over its deterministic signals (build, lint, typecheck, gate, affected tests, the test-count delta, and the cost-budget invariant) and yields `keep` only when every lane is green and both invariants held; any failed lane, a moved test count, or a broken cost invariant is `reverse`; absent signals are the honest `inconclusive`. A failing lane is therefore never downgraded to "we don't know".

**Idempotency by derivation.** `verdict_id` is `buildLearningGateVerdictId(experimentId, baselineId, fingerprint)` — never a fresh uuid — where the fingerprint is a canonical NUL-separated SHA-256 over the primary signals. Re-recording the *identical* judgment collides on the composite `(project_id, verdict_id)` primary key and is a no-op reported as `outcome: "already-recorded"`; a re-evaluation under a changed corpus version or seed yields a different fingerprint and therefore a genuinely new row, so the trail holds every judgment made rather than the last write. The resolution is computed by the accessor, never accepted from the caller, so the stored primary/canary/resolved triple is self-consistent by construction.

**Readers** — `readLearningGateVerdictByExperiment` and `readLearningGateVerdictByBaseline` (both project-scoped and index-backed), plus a paginated `listLearningGateVerdicts`. The record is append-only: no accessor updates or deletes a verdict, because a status flip would make "the gate judged this and was overruled" indistinguishable from "the record moved". A gate verdict emits one bounded run-audit row (`selfimprove:gate-verdict-recorded`) from the committed row; the readers emit nothing.

**Durable shape** — table `project.learning_gate_verdicts` (migration `0090`), with CHECKs mirroring the verdict/precedence enums, a canary-pairing invariant (a verdict that records a canary must record that canary's verdict), and a fingerprint-format check. The pure precedence rule and its fingerprint are pinned by `learning-gate-verdict-pure.test.ts`; the durable shape by `self-improve-gate-verdicts.pg.test.ts`; the store's audit mirroring and emission-freedom by `self-improve-gate-verdict-store.test.ts`.

## Cached replay baseline

A verdict names a baseline; this section is what makes that baseline's **measurement identity** checkable. Without a cache the loop re-measures the replay corpus for every candidate — slow, and worse, with no proof the candidate was compared against a baseline produced under the same corpus, engine build, configuration, and seed. A stale reuse would silently mix incomparable measurements, which is the failure this feature exists to prevent.

The pure identity contract lives in `packages/core/src/self-improve/baseline-fingerprint.ts`; the durable cache and its accessors are in `packages/core/src/task-store/async/async-learning-baseline-cache.ts`.

**Fingerprint** — `computeBaselineFingerprint` is a deterministic SHA-256 over a canonical, order-stable, NUL-separated `key=value` string of exactly four inputs: `manifestVersion`, `engineSha`, `configHash`, and `seed`. It is emitted as `sha256:<hex>`, matching the convention in `cost-budget-measure.ts` and `test-count-delta.ts`. Because it covers all four, a change to any one of them is provably a different measurement. Two normalization rules matter:

- **The seed is normalized to an integer.** A manifest may carry `"42"` while a runtime passes `42`; hashing the raw string would mint two fingerprints for one seed and rebuild the baseline on every alternate call path — a cache that never hits.
- **A non-numeric seed is refused, not coerced.** Unlike the verdict fingerprint, which falls back to `0`, silently hashing `NaN` as `0` here would attribute a measurement to a seed it was not run with — the same unattributability the blank-field refusal prevents. Blank `manifestVersion`, `engineSha`, and `configHash` are refused for the same reason.

**Reuse/rebuild resolver** — `resolveBaselineCache({ cachedFingerprint, requestedFingerprint })` is pure and TOTAL, returning `{ action, reason }` over a closed vocabulary:

| Condition | `action` | `reason` |
| --- | --- | --- |
| Nothing cached for the key | `rebuild` | `no-cached-baseline` |
| Cached fingerprint identical | `reuse` | `fingerprint-matched` |
| Cached fingerprint differs | `rebuild` | `fingerprint-diverged` |

The reason is a closed enum rather than free text so an operator can **count** why comparisons were refused — "how many comparisons were refused as incomparable" must be answerable by query. The resolver takes two strings rather than a cache entry, so the accessor decides how to *fetch* while this function alone decides what the answer *means*; a cache that reuses on a different rule than the one status reports is the drift this separation prevents.

**Status read model** — `buildBaselineCacheStatus` (pure) and `readBaselineCacheStatus` (accessor-backed) produce the object `fn_selfimprove_status` will render:

```ts
{ baselineKey, inputFingerprint, cachedFingerprint, present, action, reason }
```

It is the complete answer to "may I trust this comparison?". `present` is **derived** from the cached fingerprint rather than accepted as a separate input, so a status can never claim a baseline exists while simultaneously reporting `no-cached-baseline`. Both fingerprints are surfaced so an operator can see which component moved. The CLI that renders this is a later M1 slice; this feature delivers the substrate only.

**Durable shape** — table `project.learning_baseline_cache` (migration `0091`), keyed `(project_id, baseline_key)`. Unlike the verdict trail this is a **cache, not an append-only log**: one row per baseline per project, because the newest entry is the only valid one. `writeBaselineCache` therefore uses `onConflictDoUpdate`, which gives three behaviors from one statement — an identical re-store is a no-op, a changed fingerprint replaces the entry in place, a first measurement inserts. The four measurement components are denormalized beside `input_fingerprint` (a SHA-256 is one-way; without them a reader could confirm two entries came from the same inputs but not *which*), while `payload` is deliberately **opaque jsonb** — the measurement layer owns its shape, and the fingerprint, never the payload, governs reuse. `created_at` survives a replacement so a forced rebuild stays distinguishable from the original measurement. A CHECK restricts `input_fingerprint` to the `sha256:<hex>` shape so a drifted writer fails loudly at the database instead of being read back as a plausible value.

The accessor is an `AsyncDataLayer` function, deliberately **not** a `TaskStore` method: a measurement cache has no business widening the durable-write inventory the store's public surface is held to.

**Observability** — every resolution emits one bounded `selfimprove:baseline-cache-resolved` run-audit row carrying ids and fixed outcomes only; the measured payload is structurally excluded. See [Run-Audit Catalogue](./run-audit.md#self-improvement-baseline-cache-resolution-fusi-031).

**Verification** — the pure identity, normalization, refusals, and resolver truth table are pinned by `self-improve-baseline-fingerprint-pure.test.ts`; the durable round trip, row-count idempotence, in-place replacement, `created_at` preservation, project scoping, and CHECK rejections by `self-improve-baseline-cache.pg.test.ts`; the sink health and metadata containment by `self-improve-baseline-cache-run-audit-sink-health.test.ts`.


/*
FNXC:AutoImprovement 2026-09-30-18:03:
FUSI-019 lands a further M1 slice: the STRUCTURAL DENYLIST and its pre-gate guard — the pure
five-category classifier, the single-invocation-site guard that refuses a candidate diff before
any gate step runs, and the `selfimprove:denylist-rejected` audit row. It is documented above
under "Structural denylist" rather than left on the unshipped list, and that list plus the
code-status banner have been corrected accordingly: a page that simultaneously documents a
contract and denies it exists is the exact failure the top-of-page block warns about. The
FNXC banner at the head of this file still lists the denylist among the remaining unshipped
surfaces in one historical block; those blocks are dated and describe their own moment, so they
are left intact rather than retroactively rewritten.
*/

## Replay comparability guard (FUSI-032)

A replay experiment keeps a **cached baseline** from a prior pass and measures a **fresh candidate**
now. The entire value of the delta between them rests on both sides having been produced the same
way, so the loop refuses to compare two runs whose measurement inputs differ. The contract is pure
and lives in `packages/core/src/self-improve/comparability-types.ts`; the guard is
`evaluateComparability` in `packages/core/src/self-improve/comparability-guard.ts`.

**Four fixed dimensions.** A replay result is invalid because the corpus `manifest` was edited, the
`seed` was re-rolled, the `engine` build changed, or the resolved `config` changed — and those are
the only four ways, because they are the only inputs that determine *what* a replay pass measures.
The set is a closed enum (`COMPARABILITY_DIMENSIONS`, evaluated in exactly the order
`manifest, seed, engine, config`) so a crafted or misspelled name cannot widen what is compared or
recorded. The order is fixed so the reported cause is a deterministic, reproducible list.

**Refuse before running — never compute a metric.** There is deliberately no "how far apart" field.
The guard walks the four dimensions, collects **every** dimension whose value differs, and the moment
at least one does it returns `not-comparable` carrying that ordered list, computing no delta, score,
or comparison value at all. A delta between two differently-produced runs is a number with no
meaning, and a meaningless number that renders as a plausible delta is worse than none — it survives
a glance and enters a keep-or-revert decision. Only a `comparable` verdict (all four dimensions equal)
authorizes a metric downstream.

**A half-populated identity is not a run.** An identity with an empty `manifest`, `seed`, `engine`, or
`config` is a placeholder, not a measurement, and its own reported values are not evidence that a pass
happened. It is refused as `not-a-run` (checked on both sides, before any dimension comparison) rather
than trusted — this mirrors the cost-budget guard's `inconsistent-run` refusal. So the refusal
vocabulary is exactly two fixed values: `divergent-identity` (a dimension diverged; `diverged` names
which) and `not-a-run` (a placeholder side).

**Determinism by content, never by clock.** An identity's `fingerprint` is a `sha256:` digest over the
canonical serialization of its four dimension values, computed from the identity's own content — not
from a clock, a store, an engine import, or the caller's property insertion order. The same four
values always yield the same fingerprint on any host, which is exactly what makes a baseline cached on
one pass comparable to a candidate measured later or elsewhere. Judging the same pair twice is
deep-equal, including the recomputed fingerprints and both echoed identities, so a caller can record
exactly what was judged without re-deriving it.

**Fixed-outcome recording.** A refusal emits `selfimprove:comparability-refused` through the core
bounded run-audit seam (see
[Self-improvement learning ledger](./run-audit.md)). Metadata is ids/counts/fixed outcomes only: a
fixed `outcome` (`divergent-identity` | `not-a-run`), the ordered `diverged` dimension list, its
`divergedCount`, the eight opaque identity values (four per side), and `proposalId`/`projectId` only
when present. The `diverged` enum list **is** the named cause — a reason sentence would be a second,
uncountable vocabulary — and a crafted unknown dimension name is dropped rather than recorded. A
hostile audit sink cannot soften, delay, or reverse a stop: the refusal was already decided by the
pure guard before the emit was attempted.

## Related documentation

- [Task Evaluations Scoring Contract](./evals.md) — the `evals` surface a proposal may target.
- [Run-Audit Catalogue](./run-audit.md) — the ids/counts/outcomes-only event convention.
- [AGENTS.md](../AGENTS.md) — FNXC comment rules, the "tests never assert comments" rule, and the
  run-audit emitter seams.
- [Architecture](./architecture.md) — where the loop's engine-side surfaces fit.
