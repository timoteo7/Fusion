import type { RunAuditEventInput } from "../types/audit/run-audit.js";
import { emitBoundedRunAudit, type RunAuditSinkHost } from "../run-audit/emit-bounded-run-audit.js";
import type { LearningProposalTarget } from "../types/self-improve/learning-proposal.js";
import {
  LEARNING_REVERT_REASONS,
  isLearningRevertReason,
  type LearningRevertReason,
} from "./learning-revert-types.js";
import {
  COST_AXES,
  type CostAxis,
  type CostBudgetReason,
  type CostBudgetVerdictValue,
  type CostTotals,
} from "./cost-budget-types.js";
import type {
  LearningGatePrecedenceOutcome,
  LearningGateVerdict,
} from "../types/self-improve/learning-gate-verdict.js";
import type { StructuralDenylistCategory } from "./structural-denylist.js";
import {
  COMPARABILITY_DIMENSIONS,
  isComparabilityDimension,
  type ComparabilityDimension,
  type ComparabilityIdentity,
  type ComparabilityRefusalReason,
} from "./comparability-types.js";

/*
FNXC:SelfImproveLearningRevertSemantics 2026-09-30-08:20:
The revert-reason enum is RE-EXPORTED from `learning-revert-types.js` rather than declared here.
FUSI-012 (this module) and FUSI-011 (that module) each arrived at the same fixed enum from opposite
directions — the audit edge needed it to mirror the ledger's CHECK, the revert semantics needed it to
classify a reversal — and two declarations of one enum is exactly the drift this contract exists to
prevent: the audit row and the ledger row could then disagree about why a reversal happened, which is
the single question this layer exists to answer. One declaration, re-exported, keeps both import
paths working for existing callers while leaving a single source of truth.
*/

export { LEARNING_REVERT_REASONS, isLearningRevertReason };
export type { LearningRevertReason };

/*
FNXC:SelfImproveRunAudit 2026-09-29-18:51:
FUSI-012 is the run-audit layer of the self-improvement ledger. Every ledger transition — a proposal
recorded, an application asserted, an application rolled back — leaves a durable row in the
platform's existing audit trail, so an operator can see WHICH learning transitions happened without
the loop ever needing to answer for the reasoning behind them.

FNXC:SelfImproveRunAudit 2026-09-29-18:51:
The three event names mirror the `learning_ledger_events_kind_check` CHECK (`proposed`, `applied`,
`reverted`) one-for-one, and every fixed-enum value in this module mirrors the corresponding database
CHECK exactly. That is deliberate rather than cosmetic: run-audit is the observability edge, and an
observability edge whose vocabulary drifted from the ledger it observes would report a "why" the
ledger does not hold. `LearningProposalState`'s fourth member `expired` is deliberately NOT an event
here, matching FUSI-010: expiry is a staleness marker written onto the proposal row, not a transition
in the experiment trail, so there is nothing to append and nothing to audit.

FNXC:SelfImproveRunAudit 2026-09-29-18:51:
Metadata is ids/counts/fixed outcomes ONLY. A proposal's free-form `origin`, its evidence refs, any
rationale an operator typed, any revert reason written as a sentence, and any code diff are
structurally excluded: each façade builds its metadata from an explicit closed field list and never
spreads caller input into it. A spreading implementation would silently widen the audit surface the
moment a new optional field was added to the ledger record — precisely the "narrative leaked into
telemetry" failure this contract exists to prevent. The narrative stays in the append-only ledger
trail (`learning_ledger_events`), which is the durable record; run-audit is the queryable edge.

FNXC:SelfImproveRunAudit 2026-09-30-15:26:
There are now FOUR façades, not three: the three proposal-lifecycle transitions plus
`emitSelfImproveGateVerdictRecorded` (FUSI-020). The single-writer contract extends to all four —
do NOT call `recordRunAuditEvent` directly from any self-improvement code, and do NOT introduce a
fifth `selfimprove:*` mutation type: the durable row and its audit row must never be produced by
divergent code paths, because "the ledger says reverted but run-audit has no reversion" is exactly
the divergence an operator cannot debug.

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
FUSI-018 adds a FOURTH event to that union, and the single-writer rule applies to it exactly as it
does to the three ledger transitions — but it is a different KIND of row, and conflating the two would
corrupt the ledger trail's meaning. `selfimprove:cost-budget-evaluated` records a decision the
deterministic primary gate REACHED; it mutates no proposal state, so it has no `kind` in the
`learning_ledger_events_kind_check` CHECK and must never be appended to that trail. It lives in
run-audit only. The single-writer rule exists so that any `selfimprove:*` row — transition or verdict —
is produced by exactly one façade in this file, never by a caller reaching past it; the reason a
verdict still needs that protection is that an `over-budget` gate decision is the input to a later
revert, so "the gate says over budget but no audit row names it" is just as un-debuggable as the
revert case.

FNXC:SelfImproveRunAudit 2026-09-29-18:51:
Single-writer contract. These façades are the ONLY writer of `selfimprove:*` mutation types.
Do NOT call `recordRunAuditEvent` directly from ledger code, and do NOT introduce a second
`selfimprove:*` mutation type: the ledger row and its audit row must never be produced by divergent
code paths, because "the ledger says reverted but run-audit has no reversion" is exactly the
divergence an operator cannot debug. `emitSelfImproveDenylistRejected` (FUSI-019, the structural
denylist refusal) lives here for the same reason as the rest: a refusal recorded by the guard and a
refusal recorded by its caller would be two different code paths deciding the same event existed.

FNXC:SelfImproveRunAudit 2026-09-29-18:51:
Telemetry is NOT load-bearing. Every façade routes through the FN-9177 bounded core seam (the
deliberate copy of the engine seam, because `@fusion/core` cannot import `@fusion/engine`) and
returns its promise so a caller MAY await it, but it never throws, never rejects, and never requires
an audit row to have landed before the transition proceeds. A sink that is absent, throws, rejects,
never settles, or settles late changes what is OBSERVED and nothing about what the ledger DID. This
is the invariant that lets a learning experiment be judged on its deterministic gate verdict rather
than on whether telemetry was healthy.

FNXC:SelfImproveRunAudit 2026-09-29-18:51:
The façade host is the bounded seam's own structural `RunAuditSinkHost` — NOT `TaskStore` and not a
FUSI-010 store method. The emitter is intentionally independent of how the ledger happens to be
persisted: a caller holding any object with a `recordRunAuditEvent` seam can record a transition, and
the façade compiles against a two-line structural type that cannot drift when the store's method
names change. It is also why the test suite can drive every hostile sink state with a plain object.

FNXC:SelfImproveRunAudit 2026-09-29-18:51:
The synthetic `runId` default is derived from the proposal id, NOT from a clock. A learning proposal
outlives any single heartbeat run, so `Date.now()`-based lineage (as the planner façade uses) would
scatter one proposal's lifecycle across unrelated run ids and make "show me this proposal's history"
a cross-run query. The stable default keeps every transition of one proposal under one correlation
id while a caller that genuinely owns a run can still pass its own.
*/

/** The mutation types this module is the sole writer of. Mirrors the ledger trail's `kind`. */
export const SELF_IMPROVE_RUN_AUDIT_EVENTS = {
  created: "selfimprove:proposal-created",
  applied: "selfimprove:proposal-applied",
  reverted: "selfimprove:proposal-reverted",
  costBudgetEvaluated: "selfimprove:cost-budget-evaluated",
  gateVerdict: "selfimprove:gate-verdict-recorded",
  denylistRejected: "selfimprove:denylist-rejected",
  comparabilityRefused: "selfimprove:comparability-refused",
} as const;

/*
FNXC:SelfImproveRunAudit 2026-09-30-15:26:
A gate verdict is NOT a proposal transition, so it gets its OWN mutation type rather than being
folded into one of the three ledger events. The verdict names an EXPERIMENT and a BASELINE, not a
proposal, and it is recorded when the deterministic gate RESOLVES — a point that frequently has no
proposal row at all (a candidate judged against a baseline before it was ever proposed). Reusing
`selfimprove:proposal-*` would have forced a fabricated `proposalId`/`target` into the metadata,
which is exactly the fabrication the existing façades' "ids the caller actually has" rule forbids.

FNXC:SelfImproveRunAudit 2026-09-30-15:26:
Because the verdict's own identity is the experiment/baseline pair, the shared `SelfImproveRunAuditInput`
(which requires a `proposalId` and its product `target`) does NOT fit it. This façade therefore takes
its own input shape and does not route through `selfImproveEvent` — it builds the audit row directly,
so the verdict path never borrows a proposal's identity to fill a required field. The bounded core
seam, the fixed `SELF_IMPROVE_AUDIT_AGENT_ID` principal, and the `domain`/`taskId` conventions are all
still reused, so this remains a `selfimprove:*` row like the others.
*/

/**
 * One of the `selfimprove:*` event types.
 *
 * The first three are LEDGER TRANSITIONS and mirror the append-only trail's `kind` CHECK. The
 * `selfimprove:cost-budget-evaluated` and `selfimprove:gate-verdict-recorded` rows are GATE VERDICTS:
 * they record decisions the deterministic gate reached, mutate no proposal state, and therefore have
 * no `kind` in that CHECK. `selfimprove:denylist-rejected` is a PRE-GATE REFUSAL (FUSI-019): the
 * candidate was classified and refused before the gate ever ran, so it is neither a transition nor a
 * verdict. The non-transition rows live in this union — not in the ledger trail — because run-audit
 * is the observability edge, and the ledger trail is the durable record of what was DONE to a proposal.
 */
export type SelfImproveRunAuditEventType =
  (typeof SELF_IMPROVE_RUN_AUDIT_EVENTS)[keyof typeof SELF_IMPROVE_RUN_AUDIT_EVENTS];


/**
 * Outcome recorded for a created proposal. A closed enum so "how do proposals enter the ledger?" is
 * a count by class; an unrecorded default is not permitted because every creation DID happen.
 */
export type SelfImproveProposalCreatedOutcome = "recorded";

/**
 * Outcome recorded for an applied proposal. Mirrors the ledger's own applied/reverted lifecycle:
 * an application is either currently in effect or has since been reverted. `applied` here means "an
 * application event was appended"; whether it is still in effect is answered by whether a later
 * `selfimprove:proposal-reverted` names it.
 */
export type SelfImproveProposalAppliedOutcome = "applied";

/**
 * Outcome recorded for a reversion. `reverted` is the normal terminal outcome of an application;
 * `already-reverted` records an idempotent re-attempt that appended nothing new because a reversal
 * already named that application (the ledger collapses it in one transaction). Both are recorded so
 * a repeated revert is distinguishable from the first successful one, without either writing prose.
 */
export type SelfImproveProposalRevertedOutcome = "reverted" | "already-reverted";

/** The fixed agent id recorded when a caller does not name one. */
export const SELF_IMPROVE_AUDIT_AGENT_ID = "selfimprove";

/**
 * Outcome recorded for a cost-budget evaluation. The guard's own verdict, widened by exactly one
 * value: a refusal is a fixed reason rather than a `reason` string on the verdict, so an operator
 * counting evaluations groups "not comparable" outcomes by class instead of reading sentences.
 *
 * The refusal is recorded as its OWN outcome rather than being folded into the two budget verdicts
 * because "these runs cannot be compared" is a harness fact the operator must act on, while
 * "within budget" and "over budget" are the budget question itself. Collapsing them would make the
 * most actionable result the rarest number in the table.
 */
export type SelfImproveCostBudgetOutcome = CostBudgetVerdictValue | "not-comparable";

/** Input for one cost-budget evaluation's audit row. */
export interface SelfImproveCostBudgetAuditInput {
  /** The structural audit sink (`TaskStore` satisfies it). */
  host: RunAuditSinkHost;
  /** Learning proposal whose experiment the candidate run belongs to. Also the audit `target`. */
  proposalId: string;
  /** Product surface the proposal acts on. Mirrors the ledger's `target` CHECK. */
  target: LearningProposalTarget;
  /** Baseline totals the candidate was measured against. */
  baseline: CostTotals;
  /** Candidate totals that were measured. */
  candidate: CostTotals;
  /** Deterministic verdict, recorded verbatim. */
  outcome: SelfImproveCostBudgetOutcome;
  /** Comparability refusal reason. Recorded ONLY when `outcome` is `not-comparable`. */
  reason?: CostBudgetReason;
  /** Axes that exceeded their allowance. Recorded only when `outcome` is `over-budget`. */
  exceededAxes?: readonly CostAxis[];
  /** Project-scoped audit correlation id, when the caller tracks one. */
  projectId?: string;
  /** Actor recorded as the evaluating agent. Defaults to the fixed system principal. */
  agentId?: string;
  /**
   * Run that performed the evaluation. Defaults to a stable synthetic id derived from the proposal,
   * matching the three ledger façades so one proposal's gate decision correlates with its lifecycle.
   */
  runId?: string;
  /** ISO-8601 instant override. Defaults to now. */
  timestamp?: string;
}

/**
 * Shared input for every `selfimprove:*` façade.
 *
 * `host` is the structural audit sink, deliberately not a concrete store, so the emitter cannot
 * drift with FUSI-010's method names. `runId` defaults to a stable per-proposal lineage id rather
 * than a clock-derived one (see the FNXC block above).
 */
export interface SelfImproveRunAuditInput {
  /** Any object exposing the minimal `recordRunAuditEvent` seam (`TaskStore` satisfies it structurally). */
  host: RunAuditSinkHost;
  /** Durable identity of the learning proposal this transition belongs to. Also the audit `target`. */
  proposalId: string;
  /** Product surface the proposal acts on. Mirrors the ledger's `target` CHECK. */
  target: LearningProposalTarget;
  /** Project-scoped audit correlation id, when the caller tracks one. */
  projectId?: string;
  /** Actor recorded as the mutating agent. Defaults to the fixed system principal. */
  agentId?: string;
  /**
   * Run that performed the transition. Optional: defaults to a stable synthetic id derived from the
   * proposal so one proposal's whole lifecycle correlates under a single run id.
   */
  runId?: string;
  /** ISO-8601 instant override. Defaults to now. */
  timestamp?: string;
}

/** Metadata shared by every `selfimprove:*` row: the proposal identity and its product surface. */
interface SelfImproveBaseMetadata {
  proposalId: string;
  target: LearningProposalTarget;
  projectId?: string;
}

/**
 * Build the audit input for one ledger transition.
 *
 * Metadata is assembled from an EXPLICIT field list — never `{ ...input }` — so adding an optional
 * field to {@link SelfImproveRunAuditInput} can never silently widen what run-audit records. That is
 * the structural reason this helper exists rather than three inline `emitBoundedRunAudit` calls.
 */
function selfImproveEvent(
  input: SelfImproveRunAuditInput,
  mutationType: SelfImproveRunAuditEventType,
  metadata: SelfImproveBaseMetadata & Record<string, unknown>,
): RunAuditEventInput {
  return {
    // A learning proposal is not a task and belongs to no task column; the run-audit seam's
    // optional taskId is deliberately left undefined rather than borrowed for the proposal id.
    taskId: undefined,
    agentId: input.agentId ?? SELF_IMPROVE_AUDIT_AGENT_ID,
    runId: input.runId ?? `selfimprove-${input.proposalId}`,
    domain: "database",
    mutationType,
    target: input.proposalId,
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    metadata: {
      ...metadata,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
  };
}

/**
 * Record that a learning proposal entered the ledger.
 *
 * Emits `selfimprove:proposal-created`. `evidenceCount` is a COUNT, not a pointer: the evidence refs
 * themselves are narrative locators (surface + ref + observedAt) and stay in the ledger trail.
 */
export function emitSelfImproveProposalCreated(
  input: SelfImproveRunAuditInput & { evidenceCount: number; outcome?: SelfImproveProposalCreatedOutcome },
): Promise<void> {
  return emitBoundedRunAudit(
    input.host,
    selfImproveEvent(input, SELF_IMPROVE_RUN_AUDIT_EVENTS.created, {
      proposalId: input.proposalId,
      target: input.target,
      evidenceCount: input.evidenceCount,
      outcome: input.outcome ?? "recorded",
    }),
  );
}

/**
 * Record that a learning proposal was applied inside an experiment branch.
 *
 * Emits `selfimprove:proposal-applied`. `version` is the ledger's monotonic application counter, and
 * `confidence`/`value` are the BOUNDED 0..1 numbers the ledger already normalizes — they are the
 * machine-comparable weight of the decision, not prose about it. `priorValue` is recorded as a count
 * -like `hasPriorValue` boolean rather than the number, because before the first application there is
 * no prior value at all and a nullable number would make "unversioned" and "priorly zero" ambiguous
 * in a COUNT.
 */
export function emitSelfImproveProposalApplied(
  input: SelfImproveRunAuditInput & {
    version: number;
    confidence: number;
    value: number;
    evidenceCount: number;
    hasPriorValue: boolean;
    outcome?: SelfImproveProposalAppliedOutcome;
  },
): Promise<void> {
  return emitBoundedRunAudit(
    input.host,
    selfImproveEvent(input, SELF_IMPROVE_RUN_AUDIT_EVENTS.applied, {
      proposalId: input.proposalId,
      target: input.target,
      version: input.version,
      confidence: input.confidence,
      value: input.value,
      evidenceCount: input.evidenceCount,
      hasPriorValue: input.hasPriorValue,
      outcome: input.outcome ?? "applied",
    }),
  );
}

/**
 * Record that an application was rolled back.
 *
 * Emits `selfimprove:proposal-reverted`. `revertedEventId` is the `applied` event this reversal
 * cancels (the ledger's `reverts_event_id`), and `revertReason` is the fixed enum mirrored from the
 * 0088 CHECK, so an operator answering "why was this undone?" counts reasons instead of reading
 * sentences. `outcome: "already-reverted"` records an idempotent re-attempt that appended nothing.
 */
export function emitSelfImproveProposalReverted(
  input: SelfImproveRunAuditInput & {
    revertedEventId: string;
    revertReason: LearningRevertReason;
    outcome?: SelfImproveProposalRevertedOutcome;
  },
): Promise<void> {
  return emitBoundedRunAudit(
    input.host,
    selfImproveEvent(input, SELF_IMPROVE_RUN_AUDIT_EVENTS.reverted, {
      proposalId: input.proposalId,
      target: input.target,
      revertedEventId: input.revertedEventId,
      revertReason: input.revertReason,
      outcome: input.outcome ?? "reverted",
    }),
  );
}

/*
FNXC:SelfImproveCostBudget 2026-09-30-13:45:
`emitSelfImproveCostBudgetEvaluated` records that the deterministic gate ASKED its cost question and
what it answered. It is deliberately NOT a fourth ledger transition: a cost evaluation changes no
proposal state, so it does not belong in the append-only `learning_ledger_events` trail and does not
take a `kind` from its CHECK constraint. It is a gate verdict, and its home is run-audit — where an
operator can count how often candidates were over budget, refused comparison, or clean.

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
THE COST NUMBERS THEMSELVES ARE NOT AUDITED — only the AXES and the identities. The run-audit rule is
ids/counts/fixed outcomes, and the measured token/step/millisecond totals are corpus-specific numbers
that mean nothing outside the run that produced them: recording `baseline.tokens` next to a candidate's
would invite an operator to compare a cached baseline against a candidate that may have been measured
days later under a different corpus. What is durable and meaningful is WHICH corpus, WHICH seed, HOW
MANY tasks, and WHICH axes moved. Those are the facts that let a later reader locate and re-derive
the comparison; the arithmetic is re-derivable from the recorded identities, and the `sha256:`
fingerprints are included so a reader can prove they are holding the same pair of runs.

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
`reason` and `exceededAxes` are CONDITIONAL, and their absence is meaningful rather than an
inconvenience: a `not-comparable` row has no axes (nothing was measured against anything), and a
`within-budget` row has no exceeded axes (nothing exceeded). Both fields are omitted rather than
defaulted to an empty list or a null, because "no axis exceeded" and "we never evaluated an axis" are
different claims and a default would erase the difference.

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
Metadata is assembled from an EXPLICIT field list built from a CLOSED axis set, never by spreading the
input or the totals. `{ ...input.baseline }` would dump every field a future producer added to
`CostTotals` straight into the audit trail — and since `CostTotals` is exactly the shape most likely to
grow a new measured axis, a spreading implementation would widen the audit surface silently and
precisely when someone added a measurement. `exceededAxes` is likewise filtered through the fixed
`COST_AXES` membership so a caller passing an unrecognized axis name cannot write it into telemetry.
*/

/** Run identity fields shared by the cost-budget row, mirroring the ledger façades' correlation. */
interface SelfImproveCostBudgetCorrelation {
  proposalId: string;
  target: LearningProposalTarget;
  projectId?: string;
  agentId?: string;
  runId?: string;
  timestamp?: string;
}

/**
 * Record the deterministic gate's cost-budget verdict for one candidate run.
 *
 * Emits `selfimprove:cost-budget-evaluated` through the same bounded core seam as the three ledger
 * façades, so an absent, throwing, rejecting, never-settling, or late-settling sink changes what is
 * OBSERVED and nothing about what the gate DID. The verdict is the caller's; this function never
 * computes, re-judges, or softens it.
 */
export function emitSelfImproveCostBudgetEvaluated(input: SelfImproveCostBudgetAuditInput): Promise<void> {
  const correlation: SelfImproveCostBudgetCorrelation = {
    proposalId: input.proposalId,
    target: input.target,
    projectId: input.projectId,
    agentId: input.agentId,
    runId: input.runId ?? `selfimprove-${input.proposalId}`,
    timestamp: input.timestamp,
  };

  // Only axes that are BOTH named by the caller and members of the fixed set are recorded, so this
  // list cannot become an open-ended free-text channel through a crafted caller.
  const exceededAxes = (input.exceededAxes ?? []).filter((axis): axis is CostAxis => COST_AXES.includes(axis));

  return emitBoundedRunAudit(
    input.host,
    selfImproveEvent(
      { host: input.host, ...correlation },
      SELF_IMPROVE_RUN_AUDIT_EVENTS.costBudgetEvaluated,
      {
      proposalId: input.proposalId,
      target: input.target,
      outcome: input.outcome,
      baselineCorpusId: input.baseline.corpusId,
      baselineSeed: input.baseline.seed,
      baselineTaskCount: input.baseline.taskCount,
      baselineFingerprint: input.baseline.fingerprint,
      candidateCorpusId: input.candidate.corpusId,
      candidateSeed: input.candidate.seed,
      candidateTaskCount: input.candidate.taskCount,
      candidateFingerprint: input.candidate.fingerprint,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(exceededAxes.length > 0 ? { exceededAxes } : {}),
      },
    ),
  );
}

/**
 * Shared input for the gate-verdict façade.
 *
 * Deliberately its own shape rather than {@link SelfImproveRunAuditInput}: a gate verdict is
 * identified by an EXPERIMENT against a BASELINE, and it is routinely recorded for a candidate that
 * has no proposal row yet. Reusing the proposal-shaped input would force a fabricated `proposalId`
 * and `target` into the metadata. `host` is the same structural bounded-seam host the other façades
 * use, and `runId` defaults to a stable per-experiment lineage id (not a clock) so every judgment
 * about one experiment correlates under a single run.
 */
export interface SelfImproveGateVerdictAuditInput {
  /** Any object exposing the minimal `recordRunAuditEvent` seam (`TaskStore` satisfies it structurally). */
  host: RunAuditSinkHost;
  /** The experiment this verdict is about. Also the audit `target`. */
  experimentId: string;
  /** The baseline the experiment was compared against. */
  baselineId: string;
  /** Project-scoped audit correlation id, when the caller tracks one. */
  projectId?: string;
  /** Actor recorded as the mutating agent. Defaults to the fixed system principal. */
  agentId?: string;
  /** Run that recorded the verdict. Defaults to a stable synthetic per-experiment id. */
  runId?: string;
  /** ISO-8601 instant override. Defaults to now. */
  timestamp?: string;
  /** The verdict that stands after the precedence rule. */
  resolvedVerdict: LearningGateVerdict;
  /** The primary gate's own verdict, verbatim. */
  primaryVerdict: LearningGateVerdict;
  /** The canary's verdict, or `null` when no canary ran. */
  canaryVerdict: LearningGateVerdict | null;
  /** Which rule decided the resolved verdict. */
  precedenceOutcome: LearningGatePrecedenceOutcome;
  /** The deterministic sha256 over the primary signals that the stored row is keyed on. */
  inputFingerprint: string;
  /** Version of the replay corpus the signals were computed against. */
  corpusVersion: string;
  /** Fixed seed the corpus was sampled with. */
  seed: number;
  /**
   * Outcome recorded for the write. `already-recorded` marks an idempotent re-attempt that appended
   * nothing new because the identical judgment (same derived verdict id) was already stored, so a
   * repeat is distinguishable from the first successful record without writing prose.
   */
  outcome: "recorded" | "already-recorded";
}

/**
 * Record that the deterministic gate resolved a verdict for an experiment.
 *
 * Emits `selfimprove:gate-verdict-recorded`. Metadata is an EXPLICIT closed list of ids/fixed
 * outcomes: the experiment, the baseline, all THREE verdicts (resolved, primary, canary — the
 * divergence is the point, so it must be observable), the input fingerprint, the corpus version,
 * the seed, and the outcome. It deliberately does NOT include the primary signal booleans or the
 * test-count delta: those live on the durable verdict row, and duplicating them in telemetry would
 * give the two records a second thing to disagree about. It NEVER includes a diff, the canary's
 * reasoning, or any free prose.
 */
export function emitSelfImproveGateVerdictRecorded(input: SelfImproveGateVerdictAuditInput): Promise<void> {
  return emitBoundedRunAudit(input.host, {
    // A gate verdict is not a task and belongs to no task column.
    taskId: undefined,
    agentId: input.agentId ?? SELF_IMPROVE_AUDIT_AGENT_ID,
    runId: input.runId ?? `selfimprove-gate-${input.experimentId}`,
    domain: "database",
    mutationType: SELF_IMPROVE_RUN_AUDIT_EVENTS.gateVerdict,
    target: input.experimentId,
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    metadata: {
      experimentId: input.experimentId,
      baselineId: input.baselineId,
      resolvedVerdict: input.resolvedVerdict,
      primaryVerdict: input.primaryVerdict,
      canaryVerdict: input.canaryVerdict,
      precedenceOutcome: input.precedenceOutcome,
      inputFingerprint: input.inputFingerprint,
      corpusVersion: input.corpusVersion,
      seed: input.seed,
      outcome: input.outcome,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
  });
}

/*
FNXC:SelfImproveRunAudit 2026-09-30-11:50:
The denylist refusal takes a NARROWER input than `SelfImproveRunAuditInput`, and the narrowing is
the point rather than a convenience. That interface requires both a `proposalId` and a `target`,
but the structural denylist runs BEFORE a proposal exists: the guard classifies a candidate COMMIT,
and a commit can be refused with no proposal id and no product target in the world — a change to the
gate barrel or the release script has no `evals`/`skills`/`memory` surface to point at. Making the
ids optional here, and omitting them from the event when absent, is what lets the guard be the first
thing to touch a diff. Fabricating a placeholder proposal id to satisfy a stricter signature would
put a fake identity into an append-only audit trail, and fabricating a `target` would claim a product
surface the refusal never had.

FNXC:SelfImproveRunAudit 2026-09-30-11:50:
The metadata is a CLOSED list of categories, counts, and outcomes — NEVER paths, diffs, or prose.
The category names are the five fixed enum members, so "which floor did the experiment try to move"
is answerable by counting; the per-category counts and the total `fileCount` are the only shape
numbers. The offending PATHS are deliberately absent: recording them would write the candidate diff
into run-audit, and run-audit's whole contract (stated at the top of this module) is ids/counts/
fixed-outcomes only. The full path list stays in the guard's return value for the operator surface,
where it belongs, and never reaches telemetry.
*/

/**
 * Outcome recorded for a denylist refusal. A single fixed value: the guard only ever emits this
 * when it actually refused, so there is no unreported or ambiguous outcome to distinguish.
 */
export type SelfImproveDenylistRejectedOutcome = "rejected";

/**
 * Input for a structural denylist refusal.
 *
 * Deliberately NOT `SelfImproveRunAuditInput`: see the FNXC block above. `proposalId` and `target`
 * are both optional because a commit can be classified before any proposal exists and a code-level
 * hit has no product target.
 */
export interface SelfImproveDenylistRejectedInput {
  /** Any object exposing the minimal `recordRunAuditEvent` seam. */
  host: RunAuditSinkHost;
  /** The immutable categories the diff was refused under, in classifier order. */
  categories: readonly StructuralDenylistCategory[];
  /** Number of protected files per refused category. */
  counts: Partial<Record<StructuralDenylistCategory, number>>;
  /** Total number of protected files across all refused categories. */
  fileCount: number;
  /** Durable identity of the learning proposal, when the refusal is attributable to one. */
  proposalId?: string;
  /** Product surface the proposal acts on, when one is known. */
  target?: LearningProposalTarget;
  /** Project-scoped audit correlation id, when the caller tracks one. */
  projectId?: string;
  /** Actor recorded as the mutating agent. Defaults to the fixed system principal. */
  agentId?: string;
  /** Project-scoped audit correlation run id, when the caller owns one. */
  runId?: string;
  /** ISO-8601 instant override. Defaults to now. */
  timestamp?: string;
}

/**
 * Record that a candidate diff was refused by the structural denylist before the gate ran.
 *
 * Emits `selfimprove:denylist-rejected`. This is best-effort telemetry routed through the bounded
 * core seam: an absent, throwing, rejecting, hung, or late sink changes what is OBSERVED and
 * nothing about what the guard DID — the guard still refuses, and the gate still never runs. The
 * refusal is a deterministic property of the diff, not something the audit row grants.
 */
export function emitSelfImproveDenylistRejected(
  input: SelfImproveDenylistRejectedInput,
): Promise<void> {
  return emitBoundedRunAudit(input.host, {
    taskId: undefined,
    agentId: input.agentId ?? SELF_IMPROVE_AUDIT_AGENT_ID,
    runId: input.runId ?? (input.proposalId ? `selfimprove-${input.proposalId}` : "selfimprove-denylist"),
    domain: "database",
    mutationType: SELF_IMPROVE_RUN_AUDIT_EVENTS.denylistRejected,
    // A refusal with no proposal to attribute is a fixed sentinel target, not a borrowed id.
    target: input.proposalId ?? "structural-denylist",
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    // Explicit closed list: categories, per-category counts, the total, the rejection flag, and
    // ids ONLY when the caller actually has them. Never paths, never diffs, never prose.
    metadata: {
      categories: input.categories,
      counts: input.counts,
      categoryCount: input.categories.length,
      fileCount: input.fileCount,
      rejected: true,
      ...(input.proposalId ? { proposalId: input.proposalId } : {}),
      ...(input.target ? { target: input.target } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
  });
}

/*
FNXC:SelfImproveComparability 2026-09-30-19:55:
A COMPARABILITY REFUSAL IS ITS OWN EVENT, NOT A REUSE OF `cost-budget-evaluated`. The cost-budget row
records a verdict the primary gate REACHED after a measurement; this one records that a comparison was
REFUSED BEFORE anything was measured, because the cached baseline and the fresh candidate were not
produced the same way. Those are different facts at different points in the pipeline, and folding the
earlier refusal into the later verdict row would make "the harness was misconfigured" indistinguishable
from "the candidate spent too much" — the two most actionable and most opposite operator instructions
the loop can produce. The single-writer rule applies here exactly as it does to every other
`selfimprove:*` row: the guard that decided the refusal and the code that records it must not be two
divergent paths, or "run-audit has no row" and "the guard refused" stop agreeing.

FNXC:SelfImproveComparability 2026-09-30-19:55:
THE `diverged` LIST IS THE NAMED CAUSE, AND IT IS THE ONLY REASON THIS ROW CARRIES. The guard already
decided which fixed dimension(s) diverged; recording that ordered enum list makes the refusal
actionable ("re-seed the corpus" / "rebuild the engine" / "re-resolve the config") without a single
sentence of prose. A reason string would be a second, unbounded vocabulary that cannot be counted, so
recurring mismatches would not group by cause. For the same reason the row NEVER carries a diff, a
manifest body, a config blob, or a rationale: the eight identity values are opaque digests/ids
precisely so that an operator sees WHICH dimension broke without the audit trail absorbing the content
that broke it.

FNXC:SelfImproveComparability 2026-09-30-19:55:
The `diverged` list is filtered through the `isComparabilityDimension` membership guard exactly as the
sibling `exceededAxes` list is filtered through `COST_AXES`, so a caller passing a crafted or
misspelled dimension name cannot write an unrecognized value into telemetry — the recorded cause list
is structurally bounded by the same closed enum the guard compared against. The `divergedCount` is
recorded separately so a recurring single-dimension failure is countable without parsing the list.
*/

/** Outcome recorded for a comparability refusal. */
export type SelfImproveComparabilityRefusedOutcome = ComparabilityRefusalReason;

/**
 * Input for a comparability refusal's audit row.
 *
 * Deliberately NOT `SelfImproveRunAuditInput`: a comparability refusal can happen before any proposal
 * exists (a baseline is a cached corpus pass, not a learning transition), so `proposalId` is optional
 * and omitted from the row when absent rather than fabricated. `target` is not part of this input at
 * all: a replay corpus has no product surface to point at, and borrowing one would claim a rung of the
 * apply-order ladder the refusal never occupied.
 */
export interface SelfImproveComparabilityRefusedInput {
  /** Any object exposing the minimal `recordRunAuditEvent` seam. */
  host: RunAuditSinkHost;
  /** The cached baseline identity the candidate was to be compared against. */
  baseline: ComparabilityIdentity;
  /** The candidate identity that was refused. */
  candidate: ComparabilityIdentity;
  /**
   * Fixed dimensions that differed, in `COMPARABILITY_DIMENSIONS` order. Recorded only after
   * membership filtering, so an unknown name is dropped rather than written. Empty for a `not-a-run`
   * refusal (a placeholder is not a divergence).
   */
  diverged?: readonly ComparabilityDimension[];
  /** Deterministic refusal reason, recorded verbatim. */
  outcome: SelfImproveComparabilityRefusedOutcome;
  /** Durable identity of the learning proposal, when the refusal is attributable to one. */
  proposalId?: string;
  /** Project-scoped audit correlation id, when the caller tracks one. */
  projectId?: string;
  /** Actor recorded as the evaluating agent. Defaults to the fixed system principal. */
  agentId?: string;
  /** Correlation run id, when the caller owns one. Defaults to a stable non-clock sentinel. */
  runId?: string;
  /** ISO-8601 instant override. Defaults to now. */
  timestamp?: string;
}

/**
 * Record that a replay comparison was refused because the baseline and candidate were not comparable.
 *
 * Emits `selfimprove:comparability-refused` through the same bounded core seam as every other
 * `selfimprove:*` row, so an absent, throwing, rejecting, never-settling, or late-settling sink changes
 * what is OBSERVED and nothing about what the guard DID — the refusal was already decided by the pure
 * guard before this function was called. This function never computes, re-judges, or softens a verdict.
 */
export function emitSelfImproveComparabilityRefused(
  input: SelfImproveComparabilityRefusedInput,
): Promise<void> {
  // Only dimensions that are BOTH named by the caller and members of the fixed set are recorded, so
  // this list cannot become an open-ended free-text channel through a crafted caller. The recorded
  // list is normalized to the fixed COMPARABILITY_DIMENSIONS order so a repeat of the same refusal
  // produces the same row.
  const diverged = COMPARABILITY_DIMENSIONS.filter(
    (dimension): boolean =>
      (input.diverged ?? []).some((named) => isComparabilityDimension(named) && named === dimension),
  );

  return emitBoundedRunAudit(input.host, {
    taskId: undefined,
    agentId: input.agentId ?? SELF_IMPROVE_AUDIT_AGENT_ID,
    runId: input.runId ?? (input.proposalId ? `selfimprove-${input.proposalId}` : "selfimprove-comparability"),
    domain: "database",
    mutationType: SELF_IMPROVE_RUN_AUDIT_EVENTS.comparabilityRefused,
    target: input.proposalId ?? "replay-comparability",
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    // Explicit closed list: the fixed outcome, the ordered diverged dimensions and their count, the
    // eight identity values (four per side), and ids ONLY when the caller actually has them. The
    // identity values are opaque digests/ids, never manifest bodies, diffs, or prose.
    metadata: {
      outcome: input.outcome,
      diverged,
      divergedCount: diverged.length,
      baselineManifest: input.baseline.manifest,
      baselineSeed: input.baseline.seed,
      baselineEngine: input.baseline.engine,
      baselineConfig: input.baseline.config,
      candidateManifest: input.candidate.manifest,
      candidateSeed: input.candidate.seed,
      candidateEngine: input.candidate.engine,
      candidateConfig: input.candidate.config,
      ...(input.proposalId ? { proposalId: input.proposalId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
  });
}
