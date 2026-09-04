/**
 * FNXC:EvolutionPipeline 2026-09-04-02:10:
 * KB-001 Step 3 tests: deterministic, isolated trial harness. Four required scenarios from
 * the PROMPT spec:
 *   1. baseline vs candidate that wins on every criterion → keep
 *   2. candidate that breaks a gate or regresses a metric → revert
 *   3. same (artifact, criteria, run-checks) replayed → identical trial + same audit id
 *   4. artifact missing candidate evidence → rejected (no run-checks call, audit still emitted)
 * Plus helpers for the audit-emission seam and the redactor (FN-9175 boundary). Tests run
 * synchronously against an in-memory fake `RunChecksFn`; no real worktree, no real pnpm
 * invocation. The host (engine cycle, Step 4) wires the real worktree runner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EvolutionArtifact,
  EvolutionAuditEvent,
  EvolutionRun,
  EvolutionTrial,
} from "../agents/evolution-types.js";
import {
  DEFAULT_EVOLUTION_TRIAL_CRITERIA,
  EvolutionTrialService,
  computeEvolutionAuditId,
  decideEvolutionTrial,
  redactEvolutionAuditEvent,
} from "../agents/evolution-trial.js";

interface FakeRun {
  calls: Array<{ kind: "baseline" | "candidate"; artifactId: string }>;
  responses: {
    baseline: EvolutionRun;
    candidate: EvolutionRun;
  };
}

function makeFakeRunChecks(run: FakeRun) {
  return vi.fn(async (params: { artifactId: string; kind: "baseline" | "candidate" }) => {
    run.calls.push({ kind: params.kind, artifactId: params.artifactId });
    return params.kind === "baseline" ? run.responses.baseline : run.responses.candidate;
  });
}

function makeArtifact(overrides: Partial<EvolutionArtifact> = {}): EvolutionArtifact {
  return {
    id: "artifact-1",
    version: 1,
    agentId: "agent-1",
    createdAt: "2026-09-04T00:00:00.000Z",
    trigger: "periodic",
    event: { summary: "self-improve cycle", taskIds: ["task-1"] },
    evidence: { signals: ["signal-1"] },
    hypothesis: "add stricter gate",
    candidate: {
      checksum: "candidate-checksum-abc123",
      changeType: "prompt",
      summary: "stricter gate",
    },
    trial: {
      decision: "rejected",
      decisions: [],
      baselineRun: { command: "none", passed: false, metrics: {} },
      candidateRun: { command: "none", passed: false, metrics: {} },
      rationale: "pending",
    },
    approval: { status: "not-requested" },
    ...overrides,
  };
}

describe("decideEvolutionTrial", () => {
  it("returns keep when every default criterion is satisfied", () => {
    const result = decideEvolutionTrial({
      baselineRun: { command: "vitest", passed: true, metrics: { passRate: 0.95, latencyMs: 100 } },
      candidateRun: { command: "vitest", passed: true, metrics: { passRate: 0.97, latencyMs: 95 } },
      criteria: DEFAULT_EVOLUTION_TRIAL_CRITERIA,
    });
    expect(result.decision).toBe("keep");
    expect(result.satisfied).toEqual([
      "all-gate-checks-pass",
      "primary-metric-beats-baseline",
      "no-new-failures",
    ]);
    expect(result.rationale).toContain("keep");
  });

  it("returns revert when the candidate regresses the primary metric", () => {
    const result = decideEvolutionTrial({
      baselineRun: { command: "vitest", passed: true, metrics: { passRate: 0.95 } },
      candidateRun: { command: "vitest", passed: true, metrics: { passRate: 0.90 } },
      criteria: DEFAULT_EVOLUTION_TRIAL_CRITERIA,
    });
    expect(result.decision).toBe("revert");
    expect(result.satisfied).toEqual(["all-gate-checks-pass"]);
    expect(result.rationale).toContain("revert");
  });

  it("returns revert when the candidate fails the gate even with a higher metric", () => {
    const result = decideEvolutionTrial({
      baselineRun: { command: "vitest", passed: true, metrics: { passRate: 0.90 } },
      candidateRun: { command: "vitest", passed: false, metrics: { passRate: 0.99 } },
      criteria: DEFAULT_EVOLUTION_TRIAL_CRITERIA,
    });
    expect(result.decision).toBe("revert");
    expect(result.satisfied).not.toContain("all-gate-checks-pass");
    expect(result.satisfied).not.toContain("no-new-failures");
  });

  it("treats missing primary-metric evidence as unsatisfied", () => {
    const result = decideEvolutionTrial({
      baselineRun: { command: "vitest", passed: true, metrics: {} },
      candidateRun: { command: "vitest", passed: true, metrics: { passRate: 0.99 } },
      criteria: DEFAULT_EVOLUTION_TRIAL_CRITERIA,
    });
    expect(result.decision).toBe("revert");
    expect(result.satisfied).toEqual(["all-gate-checks-pass", "no-new-failures"]);
  });
});

describe("computeEvolutionAuditId", () => {
  it("returns a stable id for the same (agent, artifact, checksum) triple", () => {
    const a = computeEvolutionAuditId({ agentId: "agent-1", artifactId: "artifact-1", candidateChecksum: "abc" });
    const b = computeEvolutionAuditId({ agentId: "agent-1", artifactId: "artifact-1", candidateChecksum: "abc" });
    expect(a).toBe(b);
  });

  it("returns a different id when the checksum changes", () => {
    const a = computeEvolutionAuditId({ agentId: "agent-1", artifactId: "artifact-1", candidateChecksum: "abc" });
    const b = computeEvolutionAuditId({ agentId: "agent-1", artifactId: "artifact-1", candidateChecksum: "def" });
    expect(a).not.toBe(b);
  });

  it("returns a different id when the agent changes", () => {
    const a = computeEvolutionAuditId({ agentId: "agent-1", artifactId: "artifact-1", candidateChecksum: "abc" });
    const b = computeEvolutionAuditId({ agentId: "agent-2", artifactId: "artifact-1", candidateChecksum: "abc" });
    expect(a).not.toBe(b);
  });
});

describe("EvolutionTrialService.runTrial", () => {
  let now: () => Date;
  beforeEach(() => {
    now = () => new Date("2026-09-04T12:00:00.000Z");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a candidate that beats the baseline on every default criterion", async () => {
    const auditEvents: EvolutionAuditEvent[] = [];
    const fake: FakeRun = {
      calls: [],
      responses: {
        baseline: { command: "vitest", passed: true, metrics: { passRate: 0.95, latencyMs: 100 } },
        candidate: { command: "vitest", passed: true, metrics: { passRate: 0.97, latencyMs: 95 } },
      },
    };
    const runChecks = makeFakeRunChecks(fake);
    const service = new EvolutionTrialService({ runChecks, audit: (e) => { auditEvents.push(e); }, now });

    const result = await service.runTrial({ artifact: makeArtifact() });

    expect(result.trial.decision).toBe("keep");
    expect(result.trial.decisions).toContain("all-gate-checks-pass");
    expect(result.trial.decisions).toContain("primary-metric-beats-baseline");
    expect(result.trial.decisions).toContain("no-new-failures");
    expect(result.trial.rationale).toContain("keep");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.map((c) => c.kind)).toEqual(["baseline", "candidate"]);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].decision).toBe("keep");
    expect(auditEvents[0].refused).toBe(false);
    expect(auditEvents[0].baselinePassed).toBe(true);
    expect(auditEvents[0].candidatePassed).toBe(true);
    expect(auditEvents[0].idempotent).toBe(true);
    expect(auditEvents[0].at).toBe("2026-09-04T12:00:00.000Z");
    expect(auditEvents[0].id).toBe(
      computeEvolutionAuditId({
        agentId: "agent-1",
        artifactId: "artifact-1",
        candidateChecksum: "candidate-checksum-abc123",
      }),
    );
  });

  it("reverts a candidate that breaks a gate or regresses a metric", async () => {
    const auditEvents: EvolutionAuditEvent[] = [];
    const fake: FakeRun = {
      calls: [],
      responses: {
        baseline: { command: "vitest", passed: true, metrics: { passRate: 0.95 } },
        candidate: { command: "vitest", passed: false, metrics: { passRate: 0.40 } },
      },
    };
    const service = new EvolutionTrialService({
      runChecks: makeFakeRunChecks(fake),
      audit: (e) => { auditEvents.push(e); },
      now,
    });

    const result = await service.runTrial({ artifact: makeArtifact() });

    expect(result.trial.decision).toBe("revert");
    expect(result.trial.decisions).not.toContain("all-gate-checks-pass");
    expect(result.trial.rationale).toContain("revert");
    expect(auditEvents[0].decision).toBe("revert");
    expect(auditEvents[0].candidatePassed).toBe(false);
    expect(auditEvents[0].baselinePassed).toBe(true);
    expect(auditEvents[0].unsatisfiedCriteria.length).toBeGreaterThan(0);
  });

  it("rejects artifacts whose candidate has an empty checksum without invoking run-checks", async () => {
    const auditEvents: EvolutionAuditEvent[] = [];
    const fake: FakeRun = { calls: [], responses: {
      baseline: { command: "vitest", passed: true, metrics: {} },
      candidate: { command: "vitest", passed: true, metrics: {} },
    } };
    const service = new EvolutionTrialService({
      runChecks: makeFakeRunChecks(fake),
      audit: (e) => { auditEvents.push(e); },
      now,
    });
    const result = await service.runTrial({
      artifact: makeArtifact({ candidate: { checksum: "", changeType: "prompt", summary: "x" } }),
    });

    expect(result.trial.decision).toBe("rejected");
    expect(result.trial.decisions).toEqual([]);
    expect(result.trial.rationale).toContain("rejected");
    expect(fake.calls).toHaveLength(0);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].refused).toBe(true);
    expect(auditEvents[0].decision).toBe("rejected");
  });

  it("is idempotent: replaying the same (artifact, criteria, run-checks) returns the same trial + same audit id", async () => {
    const auditEvents: EvolutionAuditEvent[] = [];
    const fake: FakeRun = {
      calls: [],
      responses: {
        baseline: { command: "vitest", passed: true, metrics: { passRate: 0.95 } },
        candidate: { command: "vitest", passed: true, metrics: { passRate: 0.97 } },
      },
    };
    const service = new EvolutionTrialService({
      runChecks: makeFakeRunChecks(fake),
      audit: (e) => { auditEvents.push(e); },
      now,
    });
    const artifact = makeArtifact();

    const first = await service.runTrial({ artifact });
    const second = await service.runTrial({ artifact }, { isReplay: true });

    expect(second.isReplay).toBe(true);
    expect(second.trial).toEqual(first.trial);
    expect(second.audit.id).toBe(first.audit.id);
    expect(second.audit.decision).toBe(first.audit.decision);
    // Replay still emits an audit row, but the host's audit sink is expected to dedupe on
    // audit.id (so a recorder wrapping the sink collapses repeated emissions). The trial
    // harness itself never silently drops — that would hide a re-run of a stale trial.
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents[0].id).toBe(auditEvents[1].id);
  });

  it("swallows + logs audit-emission failures (FN-9175: telemetry is never a lifecycle dependency)", async () => {
    const fake: FakeRun = {
      calls: [],
      responses: {
        baseline: { command: "vitest", passed: true, metrics: { passRate: 0.95 } },
        candidate: { command: "vitest", passed: true, metrics: { passRate: 0.97 } },
      },
    };
    const service = new EvolutionTrialService({
      runChecks: makeFakeRunChecks(fake),
      audit: () => { throw new Error("sink-down"); },
      now,
    });

    const result = await service.runTrial({ artifact: makeArtifact() });
    expect(result.trial.decision).toBe("keep");
  });

  it("supports a custom criteria list (cycle can override defaults)", async () => {
    const auditEvents: EvolutionAuditEvent[] = [];
    const fake: FakeRun = {
      calls: [],
      responses: {
        baseline: { command: "vitest", passed: true, metrics: { passRate: 0.95 } },
        candidate: { command: "vitest", passed: true, metrics: { passRate: 0.97 } },
      },
    };
    const service = new EvolutionTrialService({
      runChecks: makeFakeRunChecks(fake),
      audit: (e) => { auditEvents.push(e); },
      now,
    });

    const result = await service.runTrial({
      artifact: makeArtifact(),
      criteria: ["all-gate-checks-pass"],
    });

    expect(result.trial.decision).toBe("keep");
    expect(result.criteria).toEqual(["all-gate-checks-pass"]);
    expect(auditEvents[0].unsatisfiedCriteria).toEqual([]);
  });
});

describe("redactEvolutionAuditEvent", () => {
  it("preserves opaque identifier fields unchanged", () => {
    const event: EvolutionAuditEvent = {
      id: "evolution-audit:agent-1:artifact-1:abcdef123456",
      agentId: "agent-1",
      artifactId: "artifact-1",
      candidateChecksum: "abc123",
      decision: "keep",
      satisfiedCriteria: ["all-gate-checks-pass"],
      unsatisfiedCriteria: [],
      refused: false,
      baselinePassed: true,
      candidatePassed: true,
      idempotent: true,
      at: "2026-09-04T12:00:00.000Z",
    };
    const redacted = redactEvolutionAuditEvent(event);
    expect(redacted).toEqual(event);
  });

  it("hashes a secret-shaped identifier that slipped into the audit row (defense in depth)", () => {
    const event: EvolutionAuditEvent = {
      id: "evolution-audit:agent-1:artifact-1:abcdef",
      agentId: "agent-1",
      artifactId: "ghp_1234567890abcdefghij", // Looks like a GitHub PAT.
      candidateChecksum: "abc123",
      decision: "keep",
      satisfiedCriteria: ["all-gate-checks-pass"],
      unsatisfiedCriteria: [],
      refused: false,
      baselinePassed: true,
      candidatePassed: true,
      idempotent: true,
      at: "2026-09-04T12:00:00.000Z",
    };
    const redacted = redactEvolutionAuditEvent(event);
    expect(redacted.artifactId).not.toBe("ghp_1234567890abcdefghij");
    expect(redacted.artifactId).toMatch(/^artifact:redacted:[0-9a-f]{12}$/);
  });
});
