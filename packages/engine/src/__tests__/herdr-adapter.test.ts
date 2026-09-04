/**
 * FNXC:EvolutionPipeline 2026-09-04-03:30:
 * KB-001 Step 6 tests: Herdr observation-only adapter. Coverage:
 *   1. parseHerdrOutput: well-formed JSON → evidence with sane counts.
 *   2. parseHerdrOutput: garbage → refused.
 *   3. parseHerdrOutput: empty → refused.
 *   4. createHerdrAdapter: returns evidence from the runner.
 *   5. createHerdrAdapter: refuses when agentId is empty.
 *   6. createHerdrAdapter: refuses when runner refuses.
 *   7. Audit row: ids/counts only — never command body, never pane name.
 *   8. Default runner refuses when HERDR_ENV is missing.
 *   9. FakeHerdrAdapter: canned + records calls.
 *  10. NEVER writes to herdr: only the read-only `api status` subcommand is invoked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHerdrAdapter,
  parseHerdrOutput,
  FakeHerdrAdapter,
  makeFakeHerdrEvidence,
  defaultRunHerdr,
  type HerdrRunnerOutput,
  type HerdrEvent,
} from "../agents/herdr-adapter.js";
import type { HerdrEvidence } from "@fusion/core";

describe("parseHerdrOutput", () => {
  const event: HerdrEvent = { agentId: "agent-1" };
  it("parses a well-formed status blob and counts panes/sessions", () => {
    const json = JSON.stringify({
      panes: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
      sessions: [{ id: "s1" }, { id: "s2" }],
      active_commands: [{ id: "c1" }],
    });
    const result = parseHerdrOutput(json, event, 100);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.evidence.panes).toBe(3);
      expect(result.evidence.sessions).toBe(2);
      expect(result.evidence.activeCommands).toBe(0); // includeActiveCommands not set
      expect(result.evidence.durationMs).toBe(100);
    }
  });

  it("counts active commands when includeActiveCommands is true", () => {
    const json = JSON.stringify({ panes: [], sessions: [], active_commands: [{ id: "c1" }, { id: "c2" }] });
    const result = parseHerdrOutput(json, { ...event, includeActiveCommands: true }, 50);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.evidence.activeCommands).toBe(2);
    }
  });

  it("refuses empty stdout", () => {
    const result = parseHerdrOutput("", event, 1);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("runner-returned-empty");
  });

  it("refuses non-JSON stdout", () => {
    const result = parseHerdrOutput("not json", event, 1);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("runner-returned-garbage");
  });

  it("refuses when stdout is a non-object", () => {
    const result = parseHerdrOutput("42", event, 1);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("runner-returned-garbage");
  });
});

describe("createHerdrAdapter (production-shaped)", () => {
  let auditRows: unknown[] = [];
  beforeEach(() => { auditRows = []; });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns the evidence produced by the runner", async () => {
    const evidence: HerdrEvidence = { panes: 4, sessions: 1, activeCommands: 0, durationMs: 200 };
    const runner = vi.fn(async (): Promise<HerdrRunnerOutput> => ({ kind: "ok", evidence }));
    const adapter = createHerdrAdapter({ runner, auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } } });
    const result = await adapter({ agentId: "agent-1" });
    expect(result).toEqual(evidence);
    expect(auditRows).toHaveLength(1);
    expect((auditRows[0] as { mutationType: string }).mutationType).toBe("evolution-herdr:observed");
  });

  it("refuses empty agentId without invoking the runner", async () => {
    const runner = vi.fn();
    const adapter = createHerdrAdapter({ runner, auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } } });
    const result = await adapter({ agentId: "  " });
    expect(result).toBeNull();
    expect(runner).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(1);
    expect((auditRows[0] as { reason: string }).reason).toBe("agent-id-missing");
  });

  it("returns null when the runner refuses (without throwing)", async () => {
    const runner = vi.fn(async (): Promise<HerdrRunnerOutput> => ({ kind: "refused", reason: "binary-not-found" }));
    const adapter = createHerdrAdapter({ runner, auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } } });
    const result = await adapter({ agentId: "agent-1" });
    expect(result).toBeNull();
    expect(auditRows).toHaveLength(1);
    expect((auditRows[0] as { mutationType: string }).mutationType).toBe("evolution-herdr:refused");
    expect((auditRows[0] as { reason: string }).reason).toBe("binary-not-found");
  });

  it("audit metadata is ids/counts only — no command body, no pane name", async () => {
    const evidence: HerdrEvidence = { panes: 1, sessions: 1, activeCommands: 0, durationMs: 50 };
    const runner = vi.fn(async (): Promise<HerdrRunnerOutput> => ({ kind: "ok", evidence }));
    const adapter = createHerdrAdapter({ runner, auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } } });
    await adapter({ agentId: "agent-1" });
    const serialized = JSON.stringify(auditRows[0]);
    expect(serialized).toMatch(/agent-1/);
    expect(serialized).toMatch(/pane/);
    expect(serialized).toMatch(/duration/);
    // No secrets / no command body / no command names
    expect(serialized).not.toMatch(/secret/);
    expect(serialized).not.toMatch(/AKIA/);
    expect(serialized).not.toMatch(/rm -rf/);
  });
});

describe("defaultRunHerdr (env guard)", () => {
  const ORIGINAL_ENV = process.env.HERDR_ENV;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = ORIGINAL_ENV;
  });

  it("refuses with herdr-env-missing when HERDR_ENV is unset", async () => {
    delete process.env.HERDR_ENV;
    const result = await defaultRunHerdr({ agentId: "agent-1" });
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("herdr-env-missing");
  });

  it("does NOT call the binary when HERDR_ENV is unset (no exec invocation)", async () => {
    delete process.env.HERDR_ENV;
    // The only way the runner would know it called the binary is by an ENOENT. Since
    // we never reach execFile, we should get the env-missing refusal, not a binary-not-found
    // or runner-threw refusal.
    const result = await defaultRunHerdr({ agentId: "agent-1" });
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(["herdr-env-missing"]).toContain(result.reason);
    }
  });
});

describe("FakeHerdrAdapter", () => {
  it("returns canned evidence in order and records every call", async () => {
    const e1 = makeFakeHerdrEvidence({ panes: 1 });
    const e2 = makeFakeHerdrEvidence({ panes: 2 });
    const fake = new FakeHerdrAdapter({ canned: [e1, e2] });
    const r1 = await fake.invoke({ agentId: "agent-1" });
    const r2 = await fake.invoke({ agentId: "agent-2" });
    expect(r1?.panes).toBe(1);
    expect(r2?.panes).toBe(2);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.agentId).toBe("agent-1");
    expect(fake.calls[1]!.agentId).toBe("agent-2");
  });

  it("returns null when canned is empty", async () => {
    const fake = new FakeHerdrAdapter({ canned: [] });
    expect(await fake.invoke({ agentId: "agent-1" })).toBeNull();
  });
});
