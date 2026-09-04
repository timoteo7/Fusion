# Self-Improvement MVP (Evolution Pipeline)

> **Status:** Shipped in KB-001. The evolution pipeline is the first end-to-end
> agent-self-improvement loop that runs in the same Fusion engine as the rest
> of the task board. It is bounded, dry-run by default, and offline-demonstrable.

[← Docs index](./README.md)

<!--
FNXC:EvolutionPipeline 2026-09-04-04:30:
KB-001 documents the shipped evolution pipeline. The MVP is intentionally a
closed loop with an explicit human approval gate, offline-demonstrable by the
test suite, and redaction-guaranteed at every write boundary. The pipeline is
the orchestrator (Fusion); Hermes and Herdr are adapters that the pipeline
invokes through injectable functions, never the other way around.
-->

## What this is

The evolution pipeline takes observed failure signals from a Fusion agent, asks
an external proposer (Hermes) to suggest a candidate change, runs that change
through a deterministic isolated trial, and applies it to the agent's live
state only after an operator has approved an explicit `ApprovalRequest`.

It is **not** a live auto-tuner. It is a sealed pipeline that produces an
artifact per cycle, redacts the artifact, emits an audit row, and waits for a
human to approve before any state on disk changes.

## What this is **not** (explicit non-goals)

- The MVP does **not** auto-apply. The apply gate is the single writer to live
  state, and it requires `approval.status === "approved"` AND
  `trial.decision === "keep"` AND a matching backing approval request.
- The MVP does **not** mine free-form prompt history. The `EvolutionSignal`
  schema is fixed (`agentId`, `outcome`, `source`, `failureCategory`,
  `humanFeedback?`, plus a few metadata fields); signals are appended via
  `EvolutionStore.createSignal`, never re-shaped at runtime.
- The MVP does **not** call live Hermes or live Herdr from the engine. The
  adapters are functions `(event) => Promise<EvolutionArtifact | null>` with
  injectable runners; the default runners shell out to a CLI, but the tests
  use `FakeHermesAdapter` and `FakeHerdrAdapter`.
- The MVP does **not** retain a working transcript of the proposer call.
  Hermes/Herdr stdout and stderr are discarded after parsing the candidate;
  only the structured `EvolutionArtifact` reaches the JSONL store.
- The MVP does **not** open a back-channel from Hermes/Herdr to Fusion. The
  adapter contract is one-way: the engine calls the adapter with a structured
  event and receives either an artifact or `null`. Hermes/Herdr never reach
  the engine's stores directly.

## Architecture

```
                  ┌────────────────────────┐
                  │  EvolutionCycle         │  heartbeat-driven
                  │  (engine, periodic)     │  sealed cluster picker
                  └──────┬──────────────────┘
                         │ EvolutionEvent (id, agentId, signals, since)
                         ▼
                  ┌────────────────────────┐
                  │  HermesAdapter          │  function: (event) => Promise<EvolutionArtifact|null>
                  │  (propose candidate)    │  injectable runner, defaultRunHermes uses
                  └──────┬──────────────────┘  `promisify(execFile)` on the local Hermes CLI
                         │ EvolutionArtifact
                         ▼
                  ┌────────────────────────┐
                  │  EvolutionTrialService  │  pure, deterministic
                  │  (run isolated trial)   │  decides keep | revert | rejected
                  └──────┬──────────────────┘
                         │ EvolutionTrialResult
                         ▼
                  ┌────────────────────────┐
                  │  EvolutionStore         │  append-only JSONL, redaction at every
                  │  (artifact + signals)   │  write boundary (humanFeedback, hypothesis,
                  └──────┬──────────────────┘  evidence, changeSummary, proposedDiff,
                         │                    rationale, baselineRun.command,
                         │                    candidateRun.command, event.summary)
                         ▼
                  ┌────────────────────────┐
                  │  ApprovalRequestStore   │  human operator decision
                  │  (operator approves)    │  ApprovalRequest.status: approved | rejected
                  └──────┬──────────────────┘
                         │ approved
                         ▼
                  ┌────────────────────────┐
                  │  EvolutionApplyGate     │  SINGLE WRITER to live agent state
                  │  (apply or refuse)      │  also redacts on the way in
                  └────────────────────────┘
```

The Herdr adapter is observation-only: it adds an `evidence.herdr` payload
(`HerdrEvidence`) to the artifact before the trial, but it never proposes
changes. Herdr does not execute the candidate.

## Components

| Component | Path | Purpose |
| --- | --- | --- |
| Domain types | `packages/core/src/agents/evolution-types.ts` | Immutable `EvolutionSignal`, `EvolutionArtifact`, `EvolutionCandidate`, `EvolutionTrial`, `EvolutionAuditEvent`, `EvolutionTrigger`, `EvolutionApproval` plus `computeEvolutionCandidateChecksum` and `redactEvolutionArtifact`. |
| Append-only store | `packages/core/src/agents/evolution-store.ts` | `EvolutionStore` writes/reads agent-scoped JSONL files. `createSignal` and `appendArtifact` redact before write. |
| Trial harness | `packages/core/src/agents/evolution-trial.ts` | `EvolutionTrialService` and the pure `decideEvolutionTrial` function. Computes a stable `EvolutionAuditEvent` id for dedupe. |
| Apply gate | `packages/core/src/agents/evolution-apply-gate.ts` | `createEvolutionApplyGate({approvalStore, liveWriter, auditHost?})` exposes `applyArtifact(artifact)`. |
| Heartbeat cycle | `packages/engine/src/agents/evolution-cycle.ts` | `EvolutionCycle.runCycle()` and the cluster picker; idempotent on `lastCycleAt` and `lastSeenSignalIds`. |
| Hermes adapter | `packages/engine/src/agents/hermes-adapter.ts` | `createHermesAdapter({runHermes, now?, log?})` returns `(event) => Promise<EvolutionArtifact\|null>`. |
| Herdr adapter | `packages/engine/src/agents/herdr-adapter.ts` | `createHerdrAdapter({runHerdr, now?, log?})` returns `(event) => Promise<HerdrEvidence\|null>`. |
| Redaction | `packages/core/src/secrets/redact-secrets.ts` | `redactSecrets(text)` strips AWS keys, bearer tokens, long base64, long hex, `key=value` assignments. |

## Signal schema

```ts
type EvolutionSignal = {
  id: string;                      // store-assigned
  agentId: string;
  outcome: string;                 // e.g. "review-rejected"
  source: string;                  // e.g. "agent-self-improve"
  failureCategory: string;         // bucketing key for the cluster picker
  taskId?: string;                 // optional
  humanFeedback?: string;          // redacted on write
  createdAt: string;               // ISO timestamp
  metadata?: Record<string, unknown>;
};
```

The cluster picker buckets signals by the `(source, failureCategory)` tuple.
The signal that *changes the most recent cluster* is the cluster promoted to a
proposal in the next cycle.

## Artifact schema

```ts
type EvolutionArtifact = {
  id: string;                      // store-assigned
  version: number;                 // monotonic per agent
  agentId: string;
  createdAt: string;
  trigger: "periodic" | "manual" | "post-task";
  event: { summary: string; taskIds: string[] };     // event.summary is redacted
  evidence: {
    signals: EvolutionSignal[];
    hermes?: HermesEvidence;
    herdr?: HerdrEvidence;
  };
  hypothesis: string;              // redacted
  candidate: EvolutionCandidate;   // changeSummary + proposedDiff redacted
  trial: EvolutionTrial;           // baselineRun.command + candidateRun.command + rationale redacted
  approval: EvolutionApproval;     // {status, approvalRequestId?, decidedBy?, decidedAt?}
};
```

## Trial decision rules

`decideEvolutionTrial({baselineRun, candidateRun, criteria})` returns
`{decision, satisfied, rationale}`. The default criteria are:

- `all-gate-checks-pass` — both runs pass.
- `primary-metric-beats-baseline` — the candidate's primary metric is at least
  as high as the baseline's.
- `no-new-failures` — the candidate does not introduce a metric regression.

`decision` is `keep` iff every criterion is satisfied; otherwise `revert`. A
`rejected` decision means the artifact had no candidate evidence at all and is
terminal.

## Redaction guarantees

Every free-text field on an `EvolutionSignal` or `EvolutionArtifact` passes
through `redactSecrets` (or the artifact-level `redactEvolutionArtifact`)
before it is written to disk. The boundary tests in
`packages/core/src/__tests__/evolution-redaction.test.ts` plant five known
secret shapes (AWS access key, bearer JWT, long base64, long hex, `password=…`
assignment) and assert that NONE of them survive at:

- (a) the JSONL line written for a signal,
- (b) the JSONL line written for an artifact (including `event.summary`,
  `hypothesis`, `candidate.changeSummary`, `candidate.proposedDiff`,
  `trial.rationale`, and `trial.{baseline,candidate}Run.command`),
- (c) the metadata of every audit row emitted by the trial service and the
  apply gate, and
- (d) every log line emitted by the evolution subsystem.

The apply gate re-runs `redactEvolutionArtifact` on the artifact as the **last
line of defense** before invoking the live writer. Even if a future caller
forgets to redact at the cycle boundary, the live state never receives a
secret.

## Audit shape

The trial service emits `evolution:audit-trial` rows via
`emitBoundedRunAudit`; the apply gate emits:

- `evolution-apply:applied` on success,
- `evolution-apply:refused` on a refusal, with the refusal reason,
- `evolution-apply:applied-but-markcompleted-failed` when the post-apply
  approval lifecycle close failed.

Audit metadata is ids/counts/outcomes only (per FN-9175/9177/9182). It never
contains the proposed diff, the change summary, the rationale, the human
feedback, or any other free-text payload. The audit row's `id` is
`evolution-audit:${agentId}:${artifactId}:${sha256(agentId::artifactId::candidateChecksum)}`
— the host sink can dedupe on the same artifact/checksum pair.

## Approval gate

`createEvolutionApplyGate({approvalStore, liveWriter, auditHost?})` produces a
gate that:

1. Verifies `artifact.approval.status === "approved"`,
2. Verifies the backing `ApprovalRequestStore.get(artifact.approval.approvalRequestId)`
   exists and is `approved`,
3. Verifies `artifact.trial.decision === "keep"`,
4. Redacts the artifact,
5. Invokes `liveWriter(redactedArtifact)`, and
6. On success, calls `approvalStore.markCompleted(requestId)` (best-effort;
   emits `evolution-apply:applied-but-markcompleted-failed` on failure).

Any failure at any step refuses the apply and emits an
`evolution-apply:refused` audit row with the typed refusal reason.

## Idempotency

The cycle tracks `lastCycleAt: Map<agentId, ISO>` and
`lastSeenSignalIds: Map<agentId, Set<string>>`. Two cycles within
`DEFAULT_EVOLUTION_CYCLE_MIN_INTERVAL_MS` (4 hours) for the same agent are
no-ops unless new signal IDs have appeared. A `getLastCycleAt` and
`getSeenSignalIds` peek method are exposed for tests and operator UI.

## Offline demonstrability

`pnpm exec vitest run packages/core/src/__tests__/evolution-store.test.ts`
exercises the JSONL store with no Hermes or Herdr dependency.
`pnpm exec vitest run packages/core/src/__tests__/evolution-trial.test.ts`
exercises the trial service with a stub `RunChecksFn`.
`pnpm exec vitest run packages/core/src/__tests__/evolution-apply-gate.test.ts`
exercises the apply gate with a stub `ApprovalRequestStoreLike` and a
`refusingLiveWriter()` test seam.
`pnpm exec vitest run packages/core/src/__tests__/evolution-redaction.test.ts`
exercises every redaction boundary.
`pnpm exec vitest run packages/engine/src/__tests__/evolution-cycle.test.ts`
exercises the cycle with `FakeHermesAdapter` and `FakeHerdrAdapter`.

The full test suite runs in CI without any network access and without any
local Hermes or Herdr binary. The adapters' default runners shell out to
`/home/mini/.local/bin/hermes` or `/home/mini/.local/bin/herdr` when the
adapter is wired into a live cycle, but the engine package tests never do.

## Operator workflow

1. **Observe.** A signal lands in the JSONL store via
   `EvolutionStore.createSignal`. The cluster picker groups signals by
   `(source, failureCategory)`.
2. **Propose.** A periodic `EvolutionCycle` tick picks the highest-impact
   cluster and calls `HermesAdapter(event)`. The adapter runs the Hermes CLI
   with a structured prompt and parses the JSON response into a candidate.
3. **Trial.** The cycle calls `EvolutionTrialService.runTrial({artifact})`.
   The trial service uses the injected `RunChecksFn` to execute the baseline
   and the candidate in a deterministic isolated sandbox. The result is a
   `keep | revert | rejected` decision plus an audit row.
4. **Apply (gated).** If the trial is `keep`, the cycle calls
   `createEvolutionApplyGate({...}).applyArtifact(redactedArtifact)`. The
   apply gate re-verifies the approval status, the trial decision, and the
   backing approval request; on success it invokes the live writer and closes
   the approval request.

At no point does the engine auto-promote a candidate to live state. The
operator's `ApprovalRequest` decision is the only path that can authorize an
apply.

## Configuration

`DEFAULT_EVOLUTION_CYCLE_MIN_INTERVAL_MS` is 4 hours. Operators can override
per-agent or per-cluster through the cycle wrapper's `minIntervalMs` option
in a follow-up that wires the cycle into a heartbeat run; the MVP ships the
pure cycle and the per-tick predicate, not a scheduler entry.

The default redaction thresholds come from
`packages/core/src/secrets/redact-secrets.ts` and apply to every write.

## Test surface

| File | Tests | What it asserts |
| --- | --- | --- |
| `packages/core/src/__tests__/evolution-store.test.ts` | 14 | JSONL round-trip, malformed-line recovery, redaction of `humanFeedback` and artifact free-text fields, monotonic version. |
| `packages/core/src/__tests__/evolution-trial.test.ts` | 15 | `decideEvolutionTrial` for keep/revert/rejected paths, `EvolutionTrialService.runTrial` for happy path + every refusal, `redactEvolutionAuditEvent` for ids-only metadata, `computeEvolutionAuditId` stability. |
| `packages/core/src/__tests__/evolution-apply-gate.test.ts` | 12 | Not-requested/pending/rejected/missing-request-id/missing-approval/mismatched-approval/revert-trial/rejected-trial/writer-throws/happy-path-with-redaction+markCompleted/audit-ids-only/refusingLiveWriter-throws. |
| `packages/core/src/__tests__/evolution-redaction.test.ts` | 20 | Boundary (a) signal on write, (b) artifact on write, (c) audit row metadata, (d) log lines. |
| `packages/engine/src/__tests__/evolution-cycle.test.ts` | 9 | Idempotency, no-cluster skip, `defaultProposeCandidate` happy path + Hermes null, audit emission through `emitBoundedRunAudit`. |
| `packages/engine/src/__tests__/hermes-adapter.test.ts` | 15 | Refusal for any missing/empty/non-JSON output, happy path with structured output, `FakeHermesAdapter` deterministic candidate. |
| `packages/engine/src/__tests__/herdr-adapter.test.ts` | 13 | `HERDR_ENV=1` preflight, refusal on missing/empty/non-JSON output, happy path with structured output, `FakeHerdrAdapter` deterministic evidence. |

Total: **98 tests** covering the MVP.

## Future work (not in this MVP)

The MVP is the sealed loop. The following are explicitly out of scope and
recorded for follow-up work, not for this change:

- Wiring the cycle into a heartbeat scheduler entry.
- A human operator UI for the `ApprovalRequest` and the artifact preview.
- Cross-agent transfer learning (the cycle is per-agent).
- A metric-store seam so the trial can pull historical baseline metrics
  without re-running the baseline command.
- A/B comparison of the candidate against a population of historical
  baselines rather than a single baseline run.
- Hermes prompt-template versioning (the prompt is a constant in the
  adapter today).
- A web-of-trust for Hermes candidates (the engine currently trusts whatever
  Hermes returns, modulo the trial).

## See also

- [Agent Self-Improvement Service](./agents.md) — the existing
  `AgentSelfImproveService` that emits the signals the cycle consumes.
- [Approval Request Store](./agents.md) — the human-in-the-loop gate.
- [Hermes integration](./hermes-integration.md) — the upstream Hermes
  project (adapter-only from the engine's perspective).
- [Herdr integration](./herdr-integration.md) — the upstream Herdr
  observation-only project.
- [Redaction policy](./secrets.md) — the `redactSecrets` library.
