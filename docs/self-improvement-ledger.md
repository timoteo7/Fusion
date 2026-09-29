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

FNXC:AutoImprovement 2026-09-29-10:24:
STATUS OF THE CODE THIS PAGE DESCRIBES. FUSI-009 is committed (37bd1f102) on the mission branch
mission/M-MULZRJQ4-0001-IF11, NOT on main, and is pending merge. Every file path and migration
named below is therefore absent from the current checkout until that branch lands: grepping
`canApplyProposal`, `LearningProposal` or `learning_proposals` in this tree returns only this
document. The contract below is accurate to that committed code, but the symbols are not yet
greppable in the reader's working tree, so this page must be re-read as a forward contract for the
merge, not as a description of code already present.
-->

> **Code status:** the record contract below landed in FUSI-009, which is committed on the mission
> branch and **not yet merged into `main`**. The file paths and migration named here are therefore
> not yet present in the current checkout — they become real when that branch lands. Later M1
> surfaces (store, revert writes, run-audit emission, denylist, gate, replay corpus, operator CLI)
> are not implemented at all. See [Not yet shipped](#not-yet-shipped).

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
`canApplyProposal` refusal, and the `priorValue` versioning) have shipped. The revert **write
transitions** — the store calls that move a proposal between states — are **not yet shipped**
(FUSI-011, still open). This page documents the contract those transitions must satisfy.

## Persistence

The ledger is durable and **project-scoped**: `project.learning_proposals`, created by migration
`0086_fn_selfimprove_learning_ledger.sql` and declared in the Drizzle project schema. This
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

- Ledger transitions are **intended** to be recorded in run-audit following the repo's
  **ids/counts/outcomes-only** convention — never description prose, never a free-form verdict,
  never a diff, never `origin` (which is free-form by design). See the
  [Run-Audit Catalogue](./run-audit.md) and the "Run Audit" rules in [AGENTS.md](../AGENTS.md).
- When those emissions land they must go through the **bounded** core seam
  (`emitBoundedRunAudit` in `packages/core/src/run-audit/emit-bounded-run-audit.ts`, timeout
  `CORE_RUN_AUDIT_EMIT_TIMEOUT_MS`) so a hostile/stalled audit sink can never become a lifecycle
  dependency for the loop. FN-9177 keeps this bounded seam in core because core cannot import engine.
- **Status:** no ledger run-audit event has shipped yet (FUSI-012, still open). This section states
  the contract those events must satisfy; it does not name event types that do not exist.

## Safety rails (mission-level; enforced by later slices)

- **Structural denylist** (gate, ratchets, quarantine ledger, release, and the self-patching code
  itself) is immutable — a diff touching it is rejected **before** the gate runs.
- **`main` is human-only:** on `main`, a human decides, via PR. The loop never lands by itself.
- **Isolation:** experiments run in a branch/worktree and a standalone sandboxed engine (own
  worktree, directory, DB/project, port, mock provider); the live engine is never restarted.

## Not yet shipped

This page covers the record contract that landed in FUSI-009 — which itself is committed on the mission
branch and **not yet merged into `main`**, so even the fields above are not greppable in the current
checkout. The following are later M1 slices and are **not** in the code at all:

- Append-only store write/list methods and window/target reads (FUSI-010).
- Revert/re-apply **write** transitions (FUSI-011) — only the state and guard exist.
- Run-audit emission of ledger transitions (FUSI-012) — see [Run-audit](#run-audit).
- Structural denylist enforcement, the deterministic **primary gate**, the versioned **replay
  corpus** + manifest with cached baseline and comparability guard, and the CLI/pi
  `fn_selfimprove_*` operator surface (status, proposals, experiments, veto, pause, force-revert).

The deterministic primary gate and the replay canary are described in the mission brief, not
implemented yet; when they land, this page is extended with the gate's verdict contract and the
replay manifest's comparability rules.

## Related documentation

- [Task Evaluations Scoring Contract](./evals.md) — the `evals` surface a proposal may target.
- [Run-Audit Catalogue](./run-audit.md) — the ids/counts/outcomes-only event convention.
- [AGENTS.md](../AGENTS.md) — FNXC comment rules, the "tests never assert comments" rule, and the
  run-audit emitter seams.
- [Architecture](./architecture.md) — where the loop's engine-side surfaces fit.
