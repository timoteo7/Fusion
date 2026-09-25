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

  /**
   * FNXC:EvolutionStoreLayout 2026-09-25-12:10:
   * The CLI resolves a PROJECT root, but EvolutionStore's `rootDir` is the fn DATA directory.
   * Constructing the store from the project root wrote every operator-run artifact to
   * `<projectRoot>/evolution` — a directory the dashboard approval bridge never reads (it reads
   * `<projectRoot>/.fusion/evolution`). The operator approved, the bridge found no artifact, and
   * the apply gate refused with `approval-pending` forever. The old test passed because it
   * injected its own store, so the production construction was never executed.
   *
   * This drives the real construction (no injected `store`) and then re-opens the project the
   * way the dashboard does, so a path disagreement fails here instead of in production.
   */
  it("persists a real cycle under .fusion/evolution so the approval bridge can find it", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-evolution-cli-"));
    roots.push(root);
    const taskStore = {
      getRootDir: () => root,
      getFusionDir: () => join(root, ".fusion"),
      getAsyncLayer: () => undefined,
      getSettings: async () => ({ testCommand: "node -e process.exit(0)" }),
      recordRunAuditEvent: async () => undefined,
    } as unknown as TaskStore;

    // A real signal so the cycle has something to cluster.
    const seed = new EvolutionStore({ rootDir: join(root, ".fusion") });
    await seed.init();
    await seed.createSignal({
      agentId: "agent-1",
      taskId: "task-1",
      outcome: "failure",
      source: "execution",
      failureCategory: "test-failure",
    });

    // No `store` injected: this is the production construction the operator actually runs.
    const result = await runEvolutionRun({
      rootDir: root,
      agentId: "agent-1",
      taskStore: taskStore as never,
      log: () => undefined,
    });

    expect(result.status).toBe("ran");
    const version = result.artifact?.version ?? 0;

    // On disk, the artifact lives where the store's documented layout says it does.
    await expect(readFile(join(root, ".fusion", "evolution", "agent-1-evolution.jsonl"), "utf8"))
      .resolves.toContain(result.artifact?.id ?? "");
    // The split-brain directory from the pre-fix construction must not exist at all.
    await expect(readFile(join(root, "evolution", "agent-1-evolution.jsonl"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    // The dashboard's construction must see the artifact the cycle just wrote.
    const bridgeView = EvolutionStore.forProject(root);
    await bridgeView.init();
    const found = await bridgeView.getArtifactByVersion("agent-1", version);
    expect(found?.id).toBe(result.artifact?.id);

    // And an operator decision must land on that same artifact, unblocking the apply gate.
    // (This trial reverts, so the cycle created no approval request and the artifact is still
    // `not-requested`; the point under test is the shared directory, not the keep-trial path,
    // which the engine cycle tests already cover.)
    const pending = await bridgeView.markApprovalState("agent-1", version, {
      status: "pending",
      approvalRequestId: "approval-1",
    });
    expect(pending?.approval.status).toBe("pending");
    const approved = await bridgeView.markApprovalState("agent-1", version, {
      status: "approved",
      approvalRequestId: "approval-1",
      decidedBy: "user",
    });
    expect(approved?.approval.status).toBe("approved");
  });
});
