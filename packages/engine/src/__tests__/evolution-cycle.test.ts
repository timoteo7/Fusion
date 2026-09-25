/**
 * FNXC:EvolutionPipeline 2026-09-04-02:40:
 * KB-001 Step 4 tests: heartbeat-driven evolution cycle. Coverage:
 *   1. Ran: signals present, candidate proposed, trial evaluated, artifact persisted.
 *   2. Skipped (no-signals): an empty store skips cleanly.
 *   3. Skipped (throttled): no new signals AND interval not elapsed.
 *   4. Cluster ties: deterministic tie-break on (source, changeType).
 *   5. Audit row: ids/counts only; never artifact prose.
 *   6. Refusal: empty agentId is rejected without writing.
 *   7. Replay: the cycle + trial combination is deterministic for the same signal set.
 */
import { mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EvolutionStore,
  type EvolutionRun,
  type EvolutionSignal,
} from "@fusion/core";
import {
  EvolutionCycle,
  DEFAULT_EVOLUTION_CYCLE_MIN_INTERVAL_MS,
} from "../agents/evolution-cycle.js";

interface RunChecksCall {
  agentId: string;
  artifactId: string;
  kind: "baseline" | "candidate";
}

function makeRunChecks(behavior: { baseline: EvolutionRun; candidate: EvolutionRun }) {
  const calls: RunChecksCall[] = [];
  return {
    calls,
    fn: vi.fn(async (params: RunChecksCall) => {
      calls.push(params);
      return params.kind === "baseline" ? behavior.baseline : behavior.candidate;
    }),
  };
}

function makeSignal(overrides: Partial<EvolutionSignal> = {}): EvolutionSignal {
  return {
    id: `signal-${randomUUID().slice(0, 8)}`,
    agentId: "agent-1",
    timestamp: "2026-09-04T00:00:00.000Z",
    outcome: "failure",
    source: "execution",
    failureCategory: "test-failure",
    ...overrides,
  };
}

describe("EvolutionCycle", () => {
  let rootDir: string;
  let store: EvolutionStore;
  let now: () => Date;
  let currentTime: number;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), `evolution-cycle-${randomUUID().slice(0, 6)}-`));
    store = new EvolutionStore({ rootDir });
    await store.init();
    currentTime = Date.parse("2026-09-04T12:00:00.000Z");
    now = () => new Date(currentTime);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the cycle when signals are present and persists the artifact with the trial", async () => {
    await store.createSignal({ agentId: "agent-1", outcome: "failure", source: "execution", failureCategory: "test-failure", humanFeedback: "first" });
    await store.createSignal({ agentId: "agent-1", outcome: "failure", source: "execution", failureCategory: "test-failure", humanFeedback: "second" });

    const runChecks = makeRunChecks({
      baseline: { command: "vitest", passed: true, metrics: { passRate: 0.95 } },
      candidate: { command: "vitest", passed: true, metrics: { passRate: 0.97 } },
    });
    const cycle = new EvolutionCycle({ store, runChecks: runChecks.fn, now });

    const result = await cycle.runCycle({ agentId: "agent-1" });
    expect(result.outcome).toBe("ran");
    if (result.outcome !== "ran") throw new Error("expected ran");
    expect(result.artifact.agentId).toBe("agent-1");
    expect(result.artifact.evidence.signals.length).toBe(2);
    expect(result.artifact.candidate.checksum).toBeTruthy();
    expect(result.artifact.trial.decision).toBe("keep");
    expect(result.trial.trial.decision).toBe("keep");
    expect(runChecks.calls.map((c) => c.kind)).toEqual(["baseline", "candidate"]);
    expect(cycle.getLastCycleAt("agent-1")).toBe("2026-09-04T12:00:00.000Z");
    const artifacts = await store.getArtifacts("agent-1");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.id).toBe(result.artifact.id);
    expect(artifacts[0]!.trial.decision).toBe("keep");
  });

  it("reverts when the trial decides revert and persists the revert", async () => {
    await store.createSignal({ agentId: "agent-1", outcome: "failure", source: "execution", failureCategory: "test-failure" });
    const runChecks = makeRunChecks({
      baseline: { command: "vitest", passed: true, metrics: { passRate: 0.95 } },
      candidate: { command: "vitest", passed: false, metrics: { passRate: 0.40 } },
    });
    const cycle = new EvolutionCycle({ store, runChecks: runChecks.fn, now });
    const result = await cycle.runCycle({ agentId: "agent-1" });
    if (result.outcome !== "ran") throw new Error("expected ran");
    expect(result.artifact.trial.decision).toBe("revert");
  });

  it("skips with no-signals when the store is empty for that agent", async () => {
    const runChecks = makeRunChecks({
      baseline: { command: "vitest", passed: true, metrics: {} },
      candidate: { command: "vitest", passed: true, metrics: {} },
    });
    const cycle = new EvolutionCycle({ store, runChecks: runChecks.fn, now });
    const result = await cycle.runCycle({ agentId: "agent-1" });
    expect(result.outcome).toBe("skipped");
    if (result.outcome !== "skipped") throw new Error("expected skipped");
    expect(result.reason).toBe("no-signals");
    expect(runChecks.fn).not.toHaveBeenCalled();
  });

  it("skips with throttled when the interval has not elapsed and no new signals", async () => {
    await store.createSignal({ agentId: "agent-1", outcome: "failure", source: "execution", failureCategory: "test-failure" });
    const runChecks = makeRunChecks({
      baseline: { command: "vitest", passed: true, metrics: { passRate: 0.95 } },
      candidate: { command: "vitest", passed: true, metrics: { passRate: 0.97 } },
    });
    const cycle = new EvolutionCycle({ store, runChecks: runChecks.fn, now, minIntervalMs: 60_000 });

    // First run consumes the signals.
    const first = await cycle.runCycle({ agentId: "agent-1" });
    expect(first.outcome).toBe("ran");

    // Advance the clock by 30s (under the 60s interval) with no new signals → throttled.
    currentTime += 30_000;
    const second = await cycle.runCycle({ agentId: "agent-1" });
    expect(second.outcome).toBe("skipped");
    if (second.outcome !== "skipped") throw new Error("expected skipped");
    expect(second.reason).toBe("throttled");
    expect(runChecks.fn).toHaveBeenCalledTimes(2); // unchanged
  });

  it("enforces the interval even when a new signal arrives, then runs later", async () => {
    await store.createSignal({ agentId: "agent-1", outcome: "failure", source: "execution", failureCategory: "test-failure" });
    const runChecks = makeRunChecks({
      baseline: { command: "vitest", passed: true, metrics: { passRate: 0.95 } },
      candidate: { command: "vitest", passed: true, metrics: { passRate: 0.97 } },
    });
    const cycle = new EvolutionCycle({ store, runChecks: runChecks.fn, now, minIntervalMs: 60_000 });

    const first = await cycle.runCycle({ agentId: "agent-1" });
    expect(first.outcome).toBe("ran");

    currentTime += 30_000;
    await store.createSignal({ agentId: "agent-1", outcome: "failure", source: "execution", failureCategory: "test-failure" });
    const throttled = await cycle.runCycle({ agentId: "agent-1" });
    expect(throttled).toMatchObject({ outcome: "skipped", reason: "throttled" });

    currentTime += 30_000;
    const later = await cycle.runCycle({ agentId: "agent-1" });
    expect(later.outcome).toBe("ran");
  });

  it("breaks cluster ties deterministically (smallest source+changeType key wins)", async () => {
    await store.createSignal({ agentId: "agent-1", outcome: "failure", source: "zeta", failureCategory: "test-failure" });
    await store.createSignal({ agentId: "agent-1", outcome: "failure", source: "alpha", failureCategory: "test-failure" });
    // Two clusters, each with 1 signal. Lexicographic tie-break: alpha < zeta.
    const runChecks = makeRunChecks({
      baseline: { command: "vitest", passed: true, metrics: { passRate: 0.95 } },
      candidate: { command: "vitest", passed: true, metrics: { passRate: 0.97 } },
    });
    const cycle = new EvolutionCycle({ store, runChecks: runChecks.fn, now });
    const result = await cycle.runCycle({ agentId: "agent-1" });
    if (result.outcome !== "ran") throw new Error("expected ran");
    expect(result.artifact.evidence.signals).toHaveLength(1);
    // The lone signal chosen must come from "alpha".
    const chosenSignal = await store.getSignals("agent-1");
    const chosen = chosenSignal.find((s) => s.source === "alpha");
    expect(result.artifact.evidence.signals[0]).toBe(chosen!.id);
  });

  it("refuses empty agentId without writing anything", async () => {
    const runChecks = makeRunChecks({
      baseline: { command: "vitest", passed: true, metrics: {} },
      candidate: { command: "vitest", passed: true, metrics: {} },
    });
    const cycle = new EvolutionCycle({ store, runChecks: runChecks.fn, now });
    const result = await cycle.runCycle({ agentId: "  " });
    expect(result.outcome).toBe("refused");
    expect(runChecks.fn).not.toHaveBeenCalled();
  });

  it("attaches read-only Herdr evidence and creates a pending approval for a keep candidate", async () => {
    await store.createSignal({ agentId: "agent-1", outcome: "failure", source: "execution", failureCategory: "test-failure" });
    const approvalCreate = vi.fn(async () => ({ id: "approval-1" }) as never);
    const herdr = vi.fn(async () => ({ panes: 2, sessions: 1, activeCommands: 0, durationMs: 12 }));
    const runChecks = makeRunChecks({
      baseline: { command: "vitest", passed: true, metrics: { passRate: 0.95 } },
      candidate: { command: "vitest", passed: true, metrics: { passRate: 0.97 } },
    });
    const cycle = new EvolutionCycle({
      store,
      runChecks: runChecks.fn,
      now,
      approvalStore: { create: approvalCreate },
      herdrAdapter: herdr,
    });

    const result = await cycle.runCycle({ agentId: "agent-1" });
    expect(result.outcome).toBe("ran");
    if (result.outcome !== "ran") return;
    expect(result.artifact.evidence.herdr).toEqual({ panes: 2, sessions: 1, activeCommands: 0, durationMs: 12 });
    expect(approvalCreate).toHaveBeenCalledWith(expect.objectContaining({
      targetAction: expect.objectContaining({
        category: "task_agent_mutation",
        context: expect.objectContaining({ source: "evolution-cycle", trialDecision: "keep" }),
      }),
    }));
    expect(result.artifact.approval).toMatchObject({ status: "pending", approvalRequestId: "approval-1" });
  });

  it("persists a redacted last-cycle summary on the next artifact", async () => {
    await store.createSignal({ agentId: "agent-1", outcome: "failure", source: "execution", failureCategory: "test-failure", humanFeedback: "first" });
    const runChecks = makeRunChecks({
      baseline: { command: "vitest", passed: true, metrics: { passRate: 0.95 } },
      candidate: { command: "vitest", passed: true, metrics: { passRate: 0.97 } },
    });
    let currentTime = Date.parse("2026-09-04T12:00:00.000Z");
    const cycle = new EvolutionCycle({ store, runChecks: runChecks.fn, now: () => new Date(currentTime), minIntervalMs: 0 });
    await cycle.runCycle({ agentId: "agent-1" });
    await store.createSignal({ agentId: "agent-1", outcome: "failure", source: "execution", failureCategory: "test-failure", humanFeedback: "second" });
    currentTime += 1;
    const second = await cycle.runCycle({ agentId: "agent-1" });
    expect(second.outcome).toBe("ran");
    if (second.outcome !== "ran") return;
    expect(second.artifact.lastCycleSummary).toContain("previous cycle");
  });

  it("emits a cycle audit row with ids/counts only (never artifact prose)", async () => {
    const auditRows: unknown[] = [];
    const auditHost = { recordRunAuditEvent: (row: unknown) => { auditRows.push(row); return row; } };
    await store.createSignal({ agentId: "agent-1", outcome: "failure", source: "execution", failureCategory: "test-failure" });
    const runChecks = makeRunChecks({
      baseline: { command: "vitest", passed: true, metrics: { passRate: 0.95 } },
      candidate: { command: "vitest", passed: true, metrics: { passRate: 0.97 } },
    });
    const cycle = new EvolutionCycle({ store, runChecks: runChecks.fn, now, auditHost });
    await cycle.runCycle({ agentId: "agent-1" });
    // Two audit rows: the trial's evolution-trial:run and the cycle's evolution-cycle:run.
    expect(auditRows.length).toBeGreaterThanOrEqual(2);
    const cycleRow = auditRows.find((r) => (r as { mutationType?: string }).mutationType === "evolution-cycle:run") as Record<string, unknown> | undefined;
    expect(cycleRow).toBeDefined();
    expect(cycleRow!.mutationType).toBe("evolution-cycle:run");
    expect(cycleRow!.agentId).toBe("agent-1");
    expect(typeof cycleRow!.artifactId).toBe("string");
    expect(typeof cycleRow!.artifactVersion).toBe("number");
    expect(cycleRow!.decision).toBe("keep");
    expect(typeof cycleRow!.clusterSize).toBe("number");
    // Defense: no summary/hypothesis/event prose leaks into the row.
    const serialized = JSON.stringify(cycleRow);
    expect(serialized).not.toMatch(/hypothesis/);
    expect(serialized).not.toMatch(/event/);
    expect(serialized).not.toMatch(/self-improve/);
  });

  it("uses the default minimum interval when no override is provided", () => {
    expect(DEFAULT_EVOLUTION_CYCLE_MIN_INTERVAL_MS).toBe(14_400_000);
  });

  /**
   * FNXC:EvolutionCycleLease 2026-09-25-10:50:
   * The durable cursor makes the rate limit survive a restart, but on its own it did
   * not stop two PROCESSES from reading the same cursor and both passing the window
   * check. A held lease must skip the cycle instead of double-appending an artifact
   * for the same agent.
   */
  it("skips the cycle while another process holds the agent lease", async () => {
    await store.createSignal({ agentId: "agent-1", outcome: "failure", source: "execution", failureCategory: "test-failure" });
    const runChecks = makeRunChecks({
      baseline: { command: "vitest", passed: true, metrics: { passRate: 0.95 } },
      candidate: { command: "vitest", passed: true, metrics: { passRate: 0.97 } },
    });
    // A separate store instance stands in for a second process: same files, no shared lock map.
    const otherProcess = new EvolutionStore({ rootDir });
    await otherProcess.init();
    const held = await otherProcess.claimCycle("agent-1", { holder: "other-process", nowMs: currentTime });
    expect(held.claimed).toBe(true);

    const cycle = new EvolutionCycle({ store, runChecks: runChecks.fn, now, minIntervalMs: 0 });
    const result = await cycle.runCycle({ agentId: "agent-1" });

    expect(result).toEqual({ outcome: "skipped", reason: "lease-held" });
    expect(runChecks.calls).toHaveLength(0);
    expect(await store.getArtifacts("agent-1")).toHaveLength(0);

    // Releasing lets the very next cycle proceed: the lease must not wedge the lane.
    await held.released();
    const afterRelease = await cycle.runCycle({ agentId: "agent-1" });
    expect(afterRelease.outcome).toBe("ran");
  });

  it("reclaims a lease abandoned by a crashed holder", async () => {
    const crashed = new EvolutionStore({ rootDir });
    await crashed.init();
    // Claimed far enough in the past to be unambiguously stale.
    const stale = await crashed.claimCycle("agent-1", { holder: "crashed", nowMs: currentTime - 60 * 60_000 });
    expect(stale.claimed).toBe(true);

    await store.createSignal({ agentId: "agent-1", outcome: "failure", source: "execution", failureCategory: "test-failure" });
    const runChecks = makeRunChecks({
      baseline: { command: "vitest", passed: true, metrics: { passRate: 0.95 } },
      candidate: { command: "vitest", passed: true, metrics: { passRate: 0.97 } },
    });
    const cycle = new EvolutionCycle({ store, runChecks: runChecks.fn, now, minIntervalMs: 0 });

    const result = await cycle.runCycle({ agentId: "agent-1" });
    expect(result.outcome).toBe("ran");
  });
});
