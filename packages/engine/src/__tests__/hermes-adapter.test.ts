/**
 * FNXC:EvolutionPipeline 2026-09-04-03:10:
 * KB-001 Step 5 tests: Hermes adapter contract. Coverage:
 *   1. Returns the canned artifact for a happy-path event.
 *   2. Refuses empty agentId without invoking the runner.
 *   3. Refuses when the runner reports refusal.
 *   4. parseHermesOutput accepts well-formed JSON, refuses garbage, refuses refusal-payloads.
 *   5. Redaction: the runner's output is NOT reflected verbatim — free-text passes through redactSecrets.
 *   6. FakeHermesAdapter records calls and can be configured to throw.
 *   7. Audit row: ids-only metadata, never artifact prose.
 *   8. Production adapter uses the injected runner (no live hermes binary required).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHermesAdapter,
  parseHermesOutput,
  FakeHermesAdapter,
  makeFakeHermesArtifact,
  type HermesRunnerOutput,
  type EvolutionEvent,
} from "../agents/hermes-adapter.js";
import { computeEvolutionCandidateChecksum, type EvolutionCandidate } from "@fusion/core";

describe("parseHermesOutput", () => {
  it("parses a well-formed candidate JSON", () => {
    const candidate: EvolutionCandidate = {
      changeType: "instructions",
      target: "agent/x/instructions.md",
      changeSummary: "tighten retry policy",
      proposedDiff: "--- a\n+++ b\n",
      checksum: "",
    };
    candidate.checksum = computeEvolutionCandidateChecksum(candidate);
    const json = JSON.stringify(candidate);
    const result = parseHermesOutput(`Here's the change: ${json} — done.`);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.candidate.changeType).toBe("instructions");
      expect(result.candidate.target).toBe("agent/x/instructions.md");
      expect(result.candidate.checksum).toBe(candidate.checksum);
    }
  });

  it("refuses garbage (no JSON object present)", () => {
    expect(parseHermesOutput("not json at all").kind).toBe("refused");
  });

  it("refuses when stdout is empty", () => {
    const result = parseHermesOutput("");
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("runner-returned-empty");
  });

  it("refuses when the candidate is malformed (missing fields)", () => {
    const result = parseHermesOutput(JSON.stringify({ changeType: "instructions" }));
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("runner-returned-garbage");
  });

  it("refuses a refusal payload", () => {
    const result = parseHermesOutput(JSON.stringify({ refused: true, reason: "policy" }));
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("refused-by-hermes");
  });

  it("refuses an unknown changeType", () => {
    const result = parseHermesOutput(
      JSON.stringify({ changeType: "instructions-and-things", target: "t", changeSummary: "s", proposedDiff: "d" }),
    );
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("runner-returned-garbage");
  });
});

describe("createHermesAdapter (production-shaped)", () => {
  let auditRows: unknown[] = [];
  beforeEach(() => {
    auditRows = [];
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the artifact produced by the runner", async () => {
    const candidate: EvolutionCandidate = {
      changeType: "config",
      target: "agent/x/config.yaml",
      changeSummary: "raise retry budget",
      proposedDiff: "+retries: 5",
      checksum: "",
    };
    candidate.checksum = computeEvolutionCandidateChecksum(candidate);
    const runner = vi.fn(async (): Promise<HermesRunnerOutput> => ({ kind: "ok", candidate }));
    const adapter = createHermesAdapter({ runner, auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } } });

    const event: EvolutionEvent = { source: "manual", agentId: "agent-x", operator: "alice", reason: "post-incident" };
    const artifact = await adapter(event);
    expect(artifact).not.toBeNull();
    expect(artifact!.candidate.changeType).toBe("config");
    expect(artifact!.agentId).toBe("agent-x");
    expect(artifact!.trial.decision).toBe("rejected"); // pending trial
    expect(artifact!.approval.status).toBe("not-requested");
    expect(auditRows).toHaveLength(1);
    expect((auditRows[0] as { mutationType: string }).mutationType).toBe("evolution-hermes:produced");
  });

  it("refuses empty agentId without invoking the runner", async () => {
    const runner = vi.fn();
    const adapter = createHermesAdapter({ runner, auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } } });
    const result = await adapter({ source: "cycle", agentId: "  ", clusterId: "c", signals: [] });
    expect(result).toBeNull();
    expect(runner).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(1);
    expect((auditRows[0] as { reason: string }).reason).toBe("empty-agent-id");
  });

  it("returns null when the runner refuses (without throwing)", async () => {
    const runner = vi.fn(async (): Promise<HermesRunnerOutput> => ({ kind: "refused", reason: "refused-by-hermes" }));
    const adapter = createHermesAdapter({ runner, auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } } });
    const event: EvolutionEvent = { source: "external", agentId: "agent-x", sourceSystem: "kanban", reason: "ticket" };
    const result = await adapter(event);
    expect(result).toBeNull();
    expect(auditRows).toHaveLength(1);
    expect((auditRows[0] as { mutationType: string }).mutationType).toBe("evolution-hermes:refused");
  });

  it("audit metadata is ids-only (no candidate prose, no summary)", async () => {
    const candidate: EvolutionCandidate = {
      changeType: "skill",
      target: "skill/test/SKILL.md",
      changeSummary: "this should never appear in audit metadata",
      proposedDiff: "secret diff body that must not leak",
      checksum: "",
    };
    candidate.checksum = computeEvolutionCandidateChecksum(candidate);
    const runner = vi.fn(async (): Promise<HermesRunnerOutput> => ({ kind: "ok", candidate }));
    const adapter = createHermesAdapter({ runner, auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } } });
    await adapter({ source: "manual", agentId: "agent-x", operator: "alice", reason: "test" });

    const serialized = JSON.stringify(auditRows[0]);
    expect(serialized).not.toMatch(/secret diff body/);
    expect(serialized).not.toMatch(/never appear/);
    // ids only
    expect(serialized).toMatch(/agent-x/);
    expect(serialized).toMatch(/artifact/);
  });
});

describe("FakeHermesAdapter", () => {
  it("returns canned artifacts in order and records every call", async () => {
    const a1 = makeFakeHermesArtifact({ id: "evolution-artifact-aaaaaaaaaa" });
    const a2 = makeFakeHermesArtifact({ id: "evolution-artifact-bbbbbbbbbb" });
    const fake = new FakeHermesAdapter({ canned: [a1, a2] });
    const r1 = await fake.invoke({ source: "manual", agentId: "agent-x", operator: "u", reason: "r" });
    const r2 = await fake.invoke({ source: "manual", agentId: "agent-x", operator: "u", reason: "r" });
    expect(r1?.id).toBe("evolution-artifact-aaaaaaaaaa");
    expect(r2?.id).toBe("evolution-artifact-bbbbbbbbbb");
    expect(fake.calls).toHaveLength(2);
  });

  it("returns null when configured to return-null and canned is empty", async () => {
    const fake = new FakeHermesAdapter({ canned: [] });
    const result = await fake.invoke({ source: "manual", agentId: "agent-x", operator: "u", reason: "r" });
    expect(result).toBeNull();
  });

  it("returns null when configured to return-garbage (no throw)", async () => {
    const a = makeFakeHermesArtifact();
    const fake = new FakeHermesAdapter({ canned: [a], failureMode: "return-garbage" });
    const result = await fake.invoke({ source: "manual", agentId: "agent-x", operator: "u", reason: "r" });
    expect(result).toBeNull();
  });

  it("throws when configured to throw (caller catches and refuses)", async () => {
    const fake = new FakeHermesAdapter({ canned: [], failureMode: "throw" });
    await expect(
      fake.invoke({ source: "manual", agentId: "agent-x", operator: "u", reason: "r" }),
    ).rejects.toThrow();
  });

  it("emits a redacted artifact — the factory passes every artifact through redactEvolutionArtifact", async () => {
    // The fake's factory (`makeFakeHermesArtifact`) is the canonical test fixture for
    // adapter tests. The dedicated redaction coverage lives in
    // `packages/core/src/__tests__/evolution-redaction.test.ts` (Step 8). This assertion
    // documents the contract so a refactor cannot accidentally bypass the redactor.
    const result = makeFakeHermesArtifact({ event: { summary: "AKIAIOSFODNN7EXAMPLE leaked", taskIds: [] } });
    expect(result).not.toBeNull();
    // If the factory ever drops the redactor, this assertion fails:
    expect(result.event.summary).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
  });
});
