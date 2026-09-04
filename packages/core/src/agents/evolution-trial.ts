/**
 * FNXC:EvolutionPipeline 2026-09-04-02:05:
 * KB-001 Step 3 (deterministic, isolated trial): runs ONE EvolutionCandidate against the
 * baseline on a fresh isolated worktree and emits a keep / revert / rejected decision with a
 * versioned audit row. Pure (no engine or filesystem dependency): the host injects a
 * `RunChecksFn` that performs the actual baseline + candidate command invocations, and an
 * `EvolutionAuditEmitter` that forwards the row to the engine's bounded run-audit seam
 * (FN-9175 / FN-9177 / FN-9182). The trial never mutates the live agent; the produced
 * `EvolutionTrial` is what the cycle (Step 4) writes back to the store and what the apply
 * gate (Step 7) consults before any persistent change is made.
 *
 * The trial's audit row is keyed by `evolution-audit:${agentId}:${artifactId}:${candidateChecksum}`
 * so re-running the same trial for the same artifact + candidate is idempotent: the host's
 * audit sink (or a dedup wrapper around it) collapses repeated emissions. The trial is
 * deterministic: same (artifact, criteria, run-checks) → same `EvolutionTrial`.
 *
 * Refusal philosophy: an artifact that lacks a `candidate` or whose `candidate.checksum` is
 * empty cannot be trialed. Such artifacts are rejected with `decision:"rejected"`, a
 * rationale referencing the missing evidence, and an audit row (count-only). The cycle
 * (Step 4) treats `rejected` as terminal — it never advances a rejected artifact to the
 * approval gate (Step 7).
 */
import { createHash } from "node:crypto";
import { createLogger } from "../process/logger.js";
import { redactSecrets } from "../secrets/redact-secrets.js";
import type {
  EvolutionArtifact,
  EvolutionCandidate,
  EvolutionDecision,
  EvolutionDecisionCriterion,
  EvolutionRun,
  EvolutionTrial,
} from "./evolution-types.js";

const evolutionTrialLog = createLogger("core-evolution-trial");

/** Default decision criteria applied when a trial does not pass an explicit list. */
export const DEFAULT_EVOLUTION_TRIAL_CRITERIA: readonly EvolutionDecisionCriterion[] = [
  "all-gate-checks-pass",
  "primary-metric-beats-baseline",
  "no-new-failures",
];

/** Inputs to a single deterministic trial. */
export interface EvolutionTrialInput {
  /** The candidate artifact under trial (already published, with a checksum). */
  artifact: EvolutionArtifact;
  /**
   * Optional explicit criteria list. When omitted, `DEFAULT_EVOLUTION_TRIAL_CRITERIA` is
   * applied. Cycles that want a stricter pass (e.g. an MVP-gated no-regressions rule) can
   * pass their own list here.
   */
  criteria?: readonly EvolutionDecisionCriterion[];
}

/** Run-checks function signature. The host (engine cycle) injects the actual command runner. */
export type RunChecksFn = (params: {
  agentId: string;
  artifactId: string;
  kind: "baseline" | "candidate";
  candidate: EvolutionCandidate;
}) => Promise<EvolutionRun>;

/** Audit-emitter function signature (matches the engine `emitBoundedRunAudit` shape). */
export type EvolutionAuditEmitter = (event: EvolutionAuditEvent) => Promise<void> | void;

/** Audit row emitted on every trial run (kept ids/counts/outcomes only — never artifact prose). */
export interface EvolutionAuditEvent {
  /** Stable id: `evolution-audit:${agentId}:${artifactId}:${candidateChecksum}`. */
  id: string;
  agentId: string;
  artifactId: string;
  candidateChecksum: string;
  decision: EvolutionDecision;
  /** Criteria that were satisfied (subset of input criteria). */
  satisfiedCriteria: EvolutionDecisionCriterion[];
  /** Criteria that were not satisfied. */
  unsatisfiedCriteria: EvolutionDecisionCriterion[];
  /** True when the trial was refused (artifact missing evidence). */
  refused: boolean;
  /** Counts only — never error prose. */
  baselinePassed: boolean;
  candidatePassed: boolean;
  /** True when the audit emission must be deduped (idempotent re-run). */
  idempotent: true;
  /** ISO timestamp the trial finished. */
  at: string;
}

/** Outcome of a trial run (the trial itself + the audit row + whether this was a replay). */
export interface EvolutionTrialResult {
  /** The trial's keep/revert/rejected verdict + the criteria that were satisfied. */
  trial: EvolutionTrial;
  /** The audit row emitted through the engine's bounded run-audit seam. */
  audit: EvolutionAuditEvent;
  /** The artifact id this trial was run for (so the cycle can write the trial back). */
  artifactId: string;
  /** The criteria list applied to this trial. */
  criteria: readonly EvolutionDecisionCriterion[];
  /** ISO timestamp the trial finished. */
  at: string;
  /** True when this trial re-ran a previously-recorded (artifact, candidate) pair. */
  isReplay: boolean;
}

interface RunEvolutionTrialOptions {
  /** Whether this is a replay of a previously-recorded trial. */
  isReplay?: boolean;
}

/**
 * Decide keep / revert / rejected from a baseline run, a candidate run, and a criteria list.
 * Pure — exported separately so the cycle and the tests can assert the decision rule without
 * re-running the full trial harness.
 */
export function decideEvolutionTrial(params: {
  baselineRun: EvolutionRun;
  candidateRun: EvolutionRun;
  criteria: readonly EvolutionDecisionCriterion[];
}): { decision: EvolutionDecision; satisfied: EvolutionDecisionCriterion[]; rationale: string } {
  const satisfied: EvolutionDecisionCriterion[] = [];

  // 1. all-gate-checks-pass: both runs must have passed.
  const allGatePass = params.baselineRun.passed && params.candidateRun.passed;
  if (allGatePass) {
    satisfied.push("all-gate-checks-pass");
  }

  // 2. primary-metric-beats-baseline: the candidate's primary metric must be at least as
  //    high as the baseline's. Missing metrics count as not satisfied.
  const primaryMetric = pickPrimaryMetric(params.candidateRun.metrics, params.baselineRun.metrics);
  if (primaryMetric !== null && primaryMetric.beatsBaseline) {
    satisfied.push("primary-metric-beats-baseline");
  }

  // 3. no-new-failures: candidate must not introduce failures the baseline did not have.
  //    Heuristic: candidateRun.passed && no metric strictly regresses vs baseline.
  const noNewFailures = params.candidateRun.passed && !primaryMetric?.isRegression;
  if (noNewFailures) {
    satisfied.push("no-new-failures");
  }

  const unsatisfied = params.criteria.filter((criterion) => !satisfied.includes(criterion));
  const allSatisfied = unsatisfied.length === 0;
  const decision: EvolutionDecision = allSatisfied ? "keep" : "revert";

  const rationale = allSatisfied
    ? `keep: ${satisfied.length}/${params.criteria.length} criteria satisfied`
    : `revert: ${unsatisfied.length}/${params.criteria.length} criteria unsatisfied: ${unsatisfied.join(",")}`;

  return { decision, satisfied, rationale };
}

interface PrimaryMetricResult {
  name: string | null;
  candidate: number | null;
  baseline: number | null;
  /** Strictly beats: candidate > baseline. */
  beatsBaseline: boolean;
  /** Strictly regresses: candidate < baseline. */
  isRegression: boolean;
}

function pickPrimaryMetric(
  candidateMetrics: Readonly<Record<string, number>>,
  baselineMetrics: Readonly<Record<string, number>>,
): PrimaryMetricResult | null {
  const candidateKeys = Object.keys(candidateMetrics);
  if (candidateKeys.length === 0) {
    return null;
  }
  // Prefer an explicit `passRate` metric; otherwise the first shared numeric metric.
  const preferred = candidateMetrics.passRate !== undefined
    ? "passRate"
    : candidateKeys.find((key) => baselineMetrics[key] !== undefined) ?? candidateKeys[0];
  const candidate = candidateMetrics[preferred];
  const baseline = baselineMetrics[preferred];
  if (typeof candidate !== "number" || typeof baseline !== "number") {
    return null;
  }
  return {
    name: preferred,
    candidate,
    baseline,
    beatsBaseline: candidate > baseline,
    isRegression: candidate < baseline,
  };
}

/**
 * Service that runs deterministic, isolated trials. Holds no mutable state of its own —
 * `runTrial` is a pure-ish function of its inputs (the only side effects are the injected
 * `runChecks` and `audit` calls, both of which the host controls).
 */
export class EvolutionTrialService {
  constructor(
    private readonly options: {
      runChecks: RunChecksFn;
      audit?: EvolutionAuditEmitter;
      /**
       * Clock injection. Defaults to `() => new Date()` — tests can pin time.
       */
      now?: () => Date;
    },
  ) {}

  /** Run a single deterministic trial for the given artifact. */
  async runTrial(
    input: EvolutionTrialInput,
    options: RunEvolutionTrialOptions = {},
  ): Promise<EvolutionTrialResult> {
    const { artifact } = input;
    const criteria = input.criteria ?? DEFAULT_EVOLUTION_TRIAL_CRITERIA;
    const at = (this.options.now ?? (() => new Date()))().toISOString();
    const candidateChecksum = artifact.candidate?.checksum ?? "";
    const auditId = computeEvolutionAuditId({
      agentId: artifact.agentId,
      artifactId: artifact.id,
      candidateChecksum,
    });

    // Refusal: artifact without a candidate cannot be trialed.
    if (!artifact.candidate || candidateChecksum.length === 0) {
      const rationale = "rejected: artifact missing candidate evidence";
      const trial: EvolutionTrial = {
        decision: "rejected",
        decisions: [],
        baselineRun: { command: "none", passed: false, metrics: {} },
        candidateRun: { command: "none", passed: false, metrics: {} },
        rationale,
      };
      const audit: EvolutionAuditEvent = {
        id: auditId,
        agentId: artifact.agentId,
        artifactId: artifact.id,
        candidateChecksum,
        decision: "rejected",
        satisfiedCriteria: [],
        unsatisfiedCriteria: [...criteria],
        refused: true,
        baselinePassed: false,
        candidatePassed: false,
        idempotent: true,
        at,
      };
      await this.emitAudit(audit);
      return { trial, audit, artifactId: artifact.id, criteria, at, isReplay: options.isReplay ?? false };
    }

    // Run baseline + candidate. The host's runChecks performs the actual worktree
    // isolation; this layer treats the result as opaque `EvolutionRun` data.
    const baselineRun = await this.options.runChecks({
      agentId: artifact.agentId,
      artifactId: artifact.id,
      kind: "baseline",
      candidate: artifact.candidate,
    });
    const candidateRun = await this.options.runChecks({
      agentId: artifact.agentId,
      artifactId: artifact.id,
      kind: "candidate",
      candidate: artifact.candidate,
    });

    const { decision, satisfied, rationale } = decideEvolutionTrial({
      baselineRun,
      candidateRun,
      criteria,
    });

    const trial: EvolutionTrial = {
      decision,
      decisions: satisfied,
      baselineRun,
      candidateRun,
      rationale,
    };

    const audit: EvolutionAuditEvent = {
      id: auditId,
      agentId: artifact.agentId,
      artifactId: artifact.id,
      candidateChecksum,
      decision,
      satisfiedCriteria: satisfied,
      unsatisfiedCriteria: criteria.filter((c) => !satisfied.includes(c)),
      refused: false,
      baselinePassed: baselineRun.passed,
      candidatePassed: candidateRun.passed,
      idempotent: true,
      at,
    };

    evolutionTrialLog.log(
      `trial ${decision} for ${artifact.id} (${satisfied.length}/${criteria.length} criteria)`,
    );
    await this.emitAudit(audit);
    return { trial, audit, artifactId: artifact.id, criteria, at, isReplay: options.isReplay ?? false };
  }

  private async emitAudit(audit: EvolutionAuditEvent): Promise<void> {
    if (!this.options.audit) return;
    // Defensive: redact any future free-text fields that callers might add to the audit
    // shape. The schema is currently ids/counts/outcomes only, but the redaction pass keeps
    // the invariant under future drift. redactSecrets is a pure function and is itself
    // covered by packages/core/src/__tests__/evolution-redaction.test.ts.
    const safeAudit = redactEvolutionAuditEvent(audit);
    try {
      await this.options.audit(safeAudit);
    } catch (error) {
      // Audit emission is best-effort telemetry (FN-9175). Swallow + log; never let an
      // audit failure fail the trial — the trial itself is the lifecycle-bearing event.
      evolutionTrialLog.warn(
        `audit emission failed for ${audit.artifactId}: ${describeAuditError(error)}`,
      );
    }
  }
}

function describeAuditError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return String(error).slice(0, 200);
}

/**
 * Redact any string fields in the audit row. Today the schema is ids/counts/outcomes only;
 * this function still runs every emission so a future audit-shape change that accidentally
 * introduces a free-text field cannot leak a secret. The redactor is shared with the
 * `redactSecrets` module used by the artifact store.
 */
export function redactEvolutionAuditEvent(event: EvolutionAuditEvent): EvolutionAuditEvent {
  // Sanitize id, agentId, artifactId, candidateChecksum — these are protocol identifiers and
  // should be opaque, but if any caller ever interpolated a secret into one (e.g. a
  // human-feedback summary accidentally included as the artifact id), this guard catches it.
  const safeId = safeIdentifier(event.id, "evolution-audit");
  const safeAgentId = safeIdentifier(event.agentId, "agent");
  const safeArtifactId = safeIdentifier(event.artifactId, "artifact");
  const safeChecksum = safeIdentifier(event.candidateChecksum, "checksum");
  return {
    ...event,
    id: safeId,
    agentId: safeAgentId,
    artifactId: safeArtifactId,
    candidateChecksum: safeChecksum,
  };
}

function safeIdentifier(value: string, fallbackPrefix: string): string {
  // Identifiers are by construction short opaque tokens (UUIDs, hashes). If a redactSecrets
  // pass triggers, the original must NOT be persisted; replace with a stable hash-prefix.
  const redacted = redactSecrets(value);
  if (redacted !== value || value.length > 256) {
    return `${fallbackPrefix}:redacted:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
  }
  return value;
}

/**
 * Compute a stable audit id for a (agentId, artifactId, candidateChecksum) triple. Exported
 * so the cycle (Step 4) and the apply gate (Step 7) can compute the same id when they need
 * to dedupe a previously-recorded trial.
 */
export function computeEvolutionAuditId(params: {
  agentId: string;
  artifactId: string;
  candidateChecksum: string;
}): string {
  const fingerprint = `${params.agentId}::${params.artifactId}::${params.candidateChecksum}`;
  const digest = createHash("sha256").update(fingerprint).digest("hex").slice(0, 24);
  return `evolution-audit:${params.agentId}:${params.artifactId}:${digest}`;
}

/**
 * Returns the redactSecrets pass-through import. Kept as a named re-export so the trial
 * test can verify the same redactor instance is used by both the store and the trial.
 */
export { redactSecrets };
