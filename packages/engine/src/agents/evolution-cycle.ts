/**
 * FNXC:EvolutionPipeline 2026-09-04-02:30:
 * KB-001 Step 4 (heartbeat cycle): wires the per-agent evolution loop to the existing
 * heartbeat. Each tick:
 *   1. Read signals for the agent from `EvolutionStore`.
 *   2. Cluster them deterministically (MVP: signal-source + changeType tuple).
 *   3. Propose exactly ONE `EvolutionCandidate` for the highest-impact cluster.
 *   4. Construct an `EvolutionArtifact` in memory (trial placeholder).
 *   5. Invoke the Step 3 `EvolutionTrialService` to evaluate baseline vs candidate.
 *   6. Persist the artifact to the store with the trial result filled in.
 *   7. Emit a cycle audit row (ids/counts/outcomes only — never artifact prose).
 *
 * Idempotency: the cycle tracks `lastCycleAt` per agent in memory and refuses to run if the
 * heartbeat interval has not elapsed AND no new signals arrived since the last run. This is
 * the "once per agent per heartbeat, idempotent if no new signals" rule from the spec — a
 * noisy heartbeat cannot spam the trial harness, and a slow heartbeat still sees the latest
 * signals.
 *
 * Authority: the cycle NEVER mutates the live agent. It only reads signals, writes the
 * artifact to the store, and emits the cycle audit row. Promotion through the approval gate
 * and the eventual `markApplied` are owned by Step 7 (apply gate) and the engine self-healing
 * lane respectively.
 */
import { createHash } from "node:crypto";
import { createLogger } from "../logger.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import type {
  EvolutionArtifact,
  EvolutionCandidate,
  EvolutionSignal,
  EvolutionStore,
  EvolutionTrial,
} from "@fusion/core";
import {
  EvolutionTrialService,
  computeEvolutionAuditId,
  type EvolutionTrialResult,
  type RunChecksFn,
} from "@fusion/core";
import { computeEvolutionCandidateChecksum } from "@fusion/core";

const evolutionCycleLog = createLogger("evolution-cycle");

/** Minimum time between cycles for the same agent. */
export const DEFAULT_EVOLUTION_CYCLE_MIN_INTERVAL_MS = 14_400_000; // 4h

/** A bounded cluster of signals that share source + changeType. */
export interface EvolutionSignalCluster {
  id: string;
  agentId: string;
  source: string;
  changeType: string;
  signals: EvolutionSignal[];
}

/** Inputs to a single cycle run. */
export interface RunEvolutionCycleInput {
  agentId: string;
  /** Optional override for the heartbeat trigger (defaults to `periodic`). */
  trigger?: EvolutionArtifact["trigger"];
  /** Optional explicit criteria (defaults to the trial service's defaults). */
  criteria?: readonly EvolutionArtifact["trial"]["decisions"][number][];
  /** Optional explicit clock for tests. */
  now?: () => Date;
}

/** Outcome of a cycle run. */
export type RunEvolutionCycleResult =
  | { outcome: "ran"; artifact: EvolutionArtifact; trial: EvolutionTrialResult }
  | { outcome: "skipped"; reason: "no-signals" | "throttled" | "no-cluster"; lastCycleAt?: string }
  | { outcome: "refused"; reason: string };

export interface EvolutionCycleOptions {
  store: EvolutionStore;
  runChecks: RunChecksFn;
  /** Host's audit-sink (engine's `TaskStore` is the typical provider). */
  auditHost?: { recordRunAuditEvent?: (event: unknown) => unknown } | null;
  /** Minimum interval between cycles per agent. */
  minIntervalMs?: number;
  /**
   * Optional candidate-proposer. The MVP impl always proposes a `prompt` change with a
   * synthetic summary derived from the cluster; production cycle would call the model. The
   * hook lets tests inject a deterministic proposer.
   */
  proposeCandidate?: (cluster: EvolutionSignalCluster) => EvolutionCandidate;
  /** Optional clock for tests. */
  now?: () => Date;
}

/**
 * Default candidate-proposer. MVP behavior: a `prompt` change with a deterministic summary
 * derived from the cluster's signal ids. The candidate is what the trial will apply; for
 * the MVP it is a no-op on the live agent (the apply gate refuses non-`manual`-approved
 * changes) but still gives the trial a concrete candidate to run.
 */
export function defaultProposeCandidate(cluster: EvolutionSignalCluster): EvolutionCandidate {
  const signalIds = cluster.signals.map((s) => s.id).sort();
  const summary = `self-improve: ${cluster.source}/${cluster.changeType} (${cluster.signals.length} signal${cluster.signals.length === 1 ? "" : "s"})`;
  const proposedDiff = [
    `# Proposed by EvolutionCycle defaultProposeCandidate`,
    `# Cluster: ${cluster.id} (source=${cluster.source}, changeType=${cluster.changeType})`,
    `# Signal ids: ${signalIds.join(", ")}`,
    `# No-op MVP placeholder — real change is gated by approval.`,
  ].join("\n");
  const candidate: EvolutionCandidate = {
    changeType: "instructions",
    target: `agent/${cluster.agentId}/instructions.md`,
    changeSummary: summary,
    proposedDiff,
    checksum: "", // populated by computeEvolutionCandidateChecksum below
  };
  candidate.checksum = computeEvolutionCandidateChecksum(candidate);
  return candidate;
}

/** Heartbeat-driven evolution cycle. */
export class EvolutionCycle {
  private readonly store: EvolutionStore;
  private readonly runChecks: RunChecksFn;
  private readonly auditHost: EvolutionCycleOptions["auditHost"];
  private readonly minIntervalMs: number;
  private readonly proposeCandidate: (cluster: EvolutionSignalCluster) => EvolutionCandidate;
  private readonly now: () => Date;
  private readonly lastCycleAt: Map<string, string> = new Map();
  private readonly lastSeenSignalIds: Map<string, Set<string>> = new Map();
  private readonly trialService: EvolutionTrialService;

  constructor(options: EvolutionCycleOptions) {
    this.store = options.store;
    this.runChecks = options.runChecks;
    this.auditHost = options.auditHost ?? null;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_EVOLUTION_CYCLE_MIN_INTERVAL_MS;
    this.proposeCandidate = options.proposeCandidate ?? defaultProposeCandidate;
    this.now = options.now ?? (() => new Date());
    this.trialService = new EvolutionTrialService({
      runChecks: this.runChecks,
      audit: (event) => this.emitCycleAudit(event),
      now: this.now,
    });
  }

  /** Read-only peek at the throttle map. Tests use it to assert idempotency. */
  getLastCycleAt(agentId: string): string | undefined {
    return this.lastCycleAt.get(agentId);
  }

  /** Read-only peek at the seen-signal-ids set. Tests use it to assert idempotency. */
  getSeenSignalIds(agentId: string): readonly string[] {
    return Array.from(this.lastSeenSignalIds.get(agentId) ?? []);
  }

  /** Run one cycle for a single agent. */
  async runCycle(input: RunEvolutionCycleInput): Promise<RunEvolutionCycleResult> {
    const agentId = input.agentId;
    if (!agentId?.trim()) {
      return { outcome: "refused", reason: "agentId required" };
    }
    const now = this.now();
    const nowIso = now.toISOString();
    const lastCycleAt = this.lastCycleAt.get(agentId);
    const signals = await this.store.getSignals(agentId);

    // Idempotency rule: skip if (interval not elapsed) AND (no new signals since last cycle).
    const intervalOk = !lastCycleAt || (now.getTime() - Date.parse(lastCycleAt)) >= this.minIntervalMs;
    const seenIds = this.lastSeenSignalIds.get(agentId) ?? new Set<string>();
    const hasNewSignals = signals.length > 0 && signals.some((s) => !seenIds.has(s.id));
    if (!intervalOk && !hasNewSignals) {
      return { outcome: "skipped", reason: "throttled", lastCycleAt };
    }
    if (signals.length === 0) {
      this.lastCycleAt.set(agentId, nowIso);
      return { outcome: "skipped", reason: "no-signals", lastCycleAt: nowIso };
    }

    // Update the seen-id set so the next tick can tell which signals are new.
    const nextSeen = new Set<string>(seenIds);
    for (const s of signals) nextSeen.add(s.id);
    this.lastSeenSignalIds.set(agentId, nextSeen);

    const cluster = pickHighestImpactCluster(signals);
    if (!cluster) {
      this.lastCycleAt.set(agentId, nowIso);
      return { outcome: "skipped", reason: "no-cluster", lastCycleAt: nowIso };
    }

    const candidate = this.proposeCandidate(cluster);
    const artifact = buildArtifact({
      agentId,
      candidate,
      cluster,
      nowIso,
      trigger: input.trigger ?? "periodic",
    });

    // Run the trial in memory first, then persist the artifact with the trial filled in.
    // (The store does not expose a "rewrite the trial field" public API — see
    //  evolution-store.ts. We deliberately keep the store immutable here and only append
    //  new artifacts, so the trial result is durable without violating append-only.)
    const trialResult = await this.trialService.runTrial(
      { artifact, criteria: input.criteria },
      { isReplay: false },
    );

    const finalArtifact: EvolutionArtifact = { ...artifact, trial: trialResult.trial };
    // The store's appendArtifact is idempotent on (candidateChecksum, trial.rationale) when
    // the latest artifact is already published. Since we are appending for the first time,
    // this always produces a new row.
    const persisted = await this.store.appendArtifact({
      agentId,
      trigger: finalArtifact.trigger,
      event: finalArtifact.event,
      evidence: finalArtifact.evidence,
      hypothesis: finalArtifact.hypothesis,
      candidate: finalArtifact.candidate,
      trial: finalArtifact.trial,
    });

    this.lastCycleAt.set(agentId, nowIso);
    evolutionCycleLog.log(
      `cycle ${trialResult.trial.decision} for ${agentId} (cluster=${cluster.id}, signals=${cluster.signals.length})`,
    );
    await this.emitCycleRow({
      outcome: "ran",
      agentId,
      artifactId: persisted.id,
      artifactVersion: persisted.version,
      decision: trialResult.trial.decision,
      clusterSize: cluster.signals.length,
      satisfied: trialResult.audit.satisfiedCriteria.length,
      unsatisfied: trialResult.audit.unsatisfiedCriteria.length,
    });

    return { outcome: "ran", artifact: persisted, trial: trialResult };
  }

  private async emitCycleAudit(event: import("@fusion/core").EvolutionAuditEvent): Promise<void> {
    if (!this.auditHost) return;
    await emitBoundedRunAudit(this.auditHost, {
      mutationType: "evolution-trial:run",
      id: event.id,
      agentId: event.agentId,
      artifactId: event.artifactId,
      candidateChecksum: event.candidateChecksum,
      decision: event.decision,
      satisfiedCriteria: event.satisfiedCriteria,
      unsatisfiedCriteria: event.unsatisfiedCriteria,
      refused: event.refused,
      baselinePassed: event.baselinePassed,
      candidatePassed: event.candidatePassed,
      idempotent: event.idempotent,
      at: event.at,
    });
  }

  private async emitCycleRow(row: CycleAuditRow): Promise<void> {
    if (!this.auditHost) return;
    const id = `evolution-cycle:${row.agentId}:${row.artifactId}:${row.artifactVersion}`;
    await emitBoundedRunAudit(this.auditHost, {
      mutationType: "evolution-cycle:run",
      id,
      agentId: row.agentId,
      artifactId: row.artifactId,
      artifactVersion: row.artifactVersion,
      decision: row.decision,
      clusterSize: row.clusterSize,
      satisfied: row.satisfied,
      unsatisfied: row.unsatisfied,
      outcome: row.outcome,
      at: this.now().toISOString(),
    });
  }
}

interface CycleAuditRow {
  outcome: "ran";
  agentId: string;
  artifactId: string;
  artifactVersion: number;
  decision: EvolutionTrial["decision"];
  clusterSize: number;
  satisfied: number;
  unsatisfied: number;
}

interface BuildArtifactParams {
  agentId: string;
  candidate: EvolutionCandidate;
  cluster: EvolutionSignalCluster;
  nowIso: string;
  trigger: EvolutionArtifact["trigger"];
}

function buildArtifact(params: BuildArtifactParams): EvolutionArtifact {
  const evidence = {
    signals: params.cluster.signals.map((s) => s.id),
  };
  const taskIds = unique(
    params.cluster.signals.map((s) => s.taskId).filter((id): id is string => typeof id === "string"),
  );
  const event = {
    summary: `cluster ${params.cluster.id} (${params.cluster.signals.length} signal${params.cluster.signals.length === 1 ? "" : "s"})`,
    taskIds,
  };
  const hypothesis = `propose ${params.candidate.changeType} change in response to ${params.cluster.source} signals`;
  const placeholderTrial: EvolutionTrial = {
    decision: "rejected",
    decisions: [],
    baselineRun: { command: "pending", passed: false, metrics: {} },
    candidateRun: { command: "pending", passed: false, metrics: {} },
    rationale: "trial pending",
  };
  return {
    id: `evolution-artifact-${createHash("sha256").update(`${params.agentId}::${params.candidate.checksum}::${params.nowIso}`).digest("hex").slice(0, 8)}`,
    version: 0, // store assigns the real version
    agentId: params.agentId,
    createdAt: params.nowIso,
    trigger: params.trigger,
    event,
    evidence,
    hypothesis,
    candidate: params.candidate,
    trial: placeholderTrial,
    approval: { status: "not-requested" },
  };
}

function pickHighestImpactCluster(signals: readonly EvolutionSignal[]): EvolutionSignalCluster | null {
  if (signals.length === 0) return null;
  // MVP clustering: bucket by (source, changeType) and pick the largest bucket. Ties broken
  // by lexicographically smallest key for determinism.
  const buckets = new Map<string, EvolutionSignal[]>();
  for (const signal of signals) {
    const key = `${signal.source}::${signal.failureCategory ?? "unspecified"}`;
    const list = buckets.get(key) ?? [];
    list.push(signal);
    buckets.set(key, list);
  }
  let bestKey: string | null = null;
  let bestSize = 0;
  for (const [key, list] of buckets) {
    if (list.length > bestSize || (list.length === bestSize && (bestKey === null || key < bestKey))) {
      bestKey = key;
      bestSize = list.length;
    }
  }
  if (!bestKey) return null;
  const list = buckets.get(bestKey) ?? [];
  const [source, changeType] = bestKey.split("::");
  return {
    id: `cluster-${createHash("sha256").update(bestKey).digest("hex").slice(0, 8)}`,
    agentId: list[0]!.agentId,
    source: source!,
    changeType: changeType!,
    signals: list,
  };
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

// re-export for tests
export { computeEvolutionAuditId };
