import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvolutionStore } from "@fusion/core";
import type { EvolutionArtifact, EvolutionTrial, TaskStore } from "@fusion/core";
import { runEvolutionRun } from "../commands/evolution.js";

/**
 * FNXC:EvolutionCli 2026-09-25-10:00:
 * GDPR-075 makes the previously library-only cycle operator-invokable. The
 * command runs one cycle, defaults to dry-run, persists no live mutation, and
 * surfaces the redacted artifact without allowing `--apply` to bypass approval.
 */
function makeArtifact(overrides: Partial<EvolutionArtifact> = {}): EvolutionArtifact {
  const trial: EvolutionTrial = {
    decision: "keep",
    decisions: ["all-gate-checks-pass", "primary-metric-beats-baseline", "no-new-failures"],
    baselineRun: { command: "fixture", passed: true, metrics: { passRate: 0.9 } },
    candidateRun: { command: "fixture", passed: true, metrics: { passRate: 0.95 } },
    rationale: "fixture keep",
  };
  return {
    id: "artifact-1",
    version: 1,
    agentId: "agent-1",
    createdAt: "2026-09-25T09:00:00.000Z",
    trigger: "manual",
    event: { summary: "fixture cycle", taskIds: ["task-1"] },
    evidence: { signals: ["signal-1"] },
    hypothesis: "fixture hypothesis",
    candidate: {
      changeType: "instructions",
      target: "agent/agent-1/instructions.md",
      changeSummary: "fixture candidate",
      proposedDiff: "fixture diff",
      checksum: "a".repeat(64),
    },
    trial,
    approval: { status: "pending", approvalRequestId: "approval-1" },
    ...overrides,
  };
}

describe("fn evolution run", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("runs exactly one dry-run cycle and writes no live state", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-evolution-cli-"));
    roots.push(root);
    const artifact = makeArtifact();
    const runCycle = vi.fn(async () => ({
      outcome: "ran" as const,
      artifact,
      trial: { trial: artifact.trial, audit: { id: "audit-1" }, artifactId: artifact.id, criteria: [], at: artifact.createdAt, isReplay: false },
      approvalRequestId: "approval-1",
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await runEvolutionRun({ rootDir: root, agentId: "agent-1", runCycle, log });

    expect(runCycle).toHaveBeenCalledOnce();
    expect(result.status).toBe("ran");
    expect(result.artifact).toEqual(artifact);
    expect(result.approvalRequestId).toBe("approval-1");
    expect(log.mock.calls.flat().join("\n")).toContain("dry-run");
    await expect(readFile(join(root, ".fusion", "evolution", "state.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes an approved keep artifact through the injected apply gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-evolution-cli-"));
    roots.push(root);
    const artifact = makeArtifact({ approval: { status: "approved", approvalRequestId: "approval-1" } });
    const runCycle = vi.fn(async () => ({
      outcome: "ran" as const,
      artifact,
      trial: { trial: artifact.trial, audit: { id: "audit-1" }, artifactId: artifact.id, criteria: [], at: artifact.createdAt, isReplay: false },
      approvalRequestId: "approval-1",
    }));
    const gate = { applyArtifact: vi.fn(async () => ({ kind: "applied" as const, artifactId: artifact.id, appliedAt: artifact.createdAt })) };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await runEvolutionRun({ rootDir: root, agentId: "agent-1", apply: true, runCycle, gate, log });

    expect(gate.applyArtifact).toHaveBeenCalledWith(artifact);
    expect(result.apply).toEqual({ kind: "applied", artifactId: artifact.id, appliedAt: artifact.createdAt });
  });

  it("does not invoke the apply gate in the default dry-run mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-evolution-cli-"));
    roots.push(root);
    const artifact = makeArtifact();
    const runCycle = vi.fn(async () => ({
      outcome: "ran" as const,
      artifact,
      trial: { trial: artifact.trial, audit: { id: "audit-1" }, artifactId: artifact.id, criteria: [], at: artifact.createdAt, isReplay: false },
    }));
    const gate = { applyArtifact: vi.fn(async () => ({ kind: "refused" as const, reason: "approval-pending" as const, hasReason: true })) };

    await runEvolutionRun({ rootDir: root, agentId: "agent-1", runCycle, gate });

    expect(gate.applyArtifact).not.toHaveBeenCalled();
  });

  /**
   * FNXC:EvolutionTrialChecks 2026-09-25-10:40:
   * The production path (no injected runCycle) previously always used a checker that
   * reported `passed: false`, so no operator run could ever reach a `keep` trial and
   * the approval surface was unreachable outside tests. This drives the real path with
   * a project verification command and asserts the cycle actually evaluates it.
   *
   * The command is `node -e ...` so it needs no shell, no network, and no real project
   * toolchain — the assertion is that the operator's configured command is executed and
   * its result drives the trial, not which command it was.
   */
  it("evaluates the project's configured verification command on the production path", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-evolution-cli-"));
    roots.push(root);
    const marker = join(root, "verification-ran.txt");
    // A script file, not an inline `-e` snippet: an interpolated absolute path inside
    // nested shell quotes is a quoting minefield, and a real subprocess file is a closer
    // stand-in for the operator's own `pnpm test` than a one-liner anyway.
    const script = join(root, "verify.cjs");
    await writeFile(script, `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    const taskStore = {
      getRootDir: () => root,
      getFusionDir: () => join(root, ".fusion"),
      getAsyncLayer: () => undefined,
      getSettings: async () => ({ testCommand: `node verify.cjs` }),
      recordRunAuditEvent: async () => undefined,
    } as unknown as TaskStore;

    const store = new EvolutionStore({ rootDir: root });
    await store.init();
    await store.createSignal({
      agentId: "agent-1",
      taskId: "task-1",
      outcome: "failure",
      source: "execution",
      failureCategory: "test-failure",
    });

    const result = await runEvolutionRun({
      rootDir: root,
      agentId: "agent-1",
      store,
      taskStore: taskStore as never,
      log: () => undefined,
    });

    // The configured command really ran (proves the checker is no longer the stub).
    await expect(readFile(marker, "utf8")).resolves.toBe("ran");
    expect(result.status).toBe("ran");
    // A passing check with no baseline delta yields a real decision rather than a refusal.
    if (result.status === "ran") {
      expect(result.artifact?.trial.baselineRun.command).toBe("node verify.cjs");
    }
  });
});
