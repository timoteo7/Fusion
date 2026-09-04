/**
 * FNXC:EvolutionPipeline 2026-09-04-04:10:
 * KB-001 Step 8: boundary redaction tests. Verifies that a known secret shape
 * (a fake AWS key, a fake bearer token, a long base64 blob, a hex blob) is stripped
 * at every write/read/log boundary in the evolution subsystem.
 *
 * Coverage:
 *   (a) signal `humanFeedback` on write -> JSONL line never contains the secret.
 *   (b) artifact hypothesis/evidence/proposedDiff/changeSummary/event.summary on write -> JSONL line never contains the secret.
 *   (c) every audit row emitted by the trial service / apply gate -> metadata never contains the secret.
 *   (d) every log line emitted by the evolution subsystem -> no secret in the log payload.
 *
 * Approach: use a `SECRET_AWS` and `SECRET_BEARER` and `SECRET_B64` and `SECRET_HEX`
 * plus a `password=hunter2` assignment, plant them in every free-text field, and assert
 * NONE of them survive at any boundary.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EvolutionStore,
  type CreateEvolutionSignalInput,
  type AppendEvolutionArtifactInput,
} from "../agents/evolution-store.js";
import {
  computeEvolutionCandidateChecksum,
  redactEvolutionArtifact,
  type EvolutionCandidate,
} from "../agents/evolution-types.js";
import { redactSecrets } from "../secrets/redact-secrets.js";
import {
  decideEvolutionTrial,
  redactEvolutionAuditEvent,
} from "../agents/evolution-trial.js";
import { createEvolutionApplyGate, type ApprovalRequestStoreLike } from "../agents/evolution-apply-gate.js";
import type {
  ApprovalRequest,
  ApprovalRequestActorSnapshot,
  EvolutionAuditEvent,
} from "../types.js";

const SECRET_AWS = "AKIAIOSFODNN7EXAMPLE";
const SECRET_BEARER =
  "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const SECRET_B64 =
  "SGVsbG9Xb3JsZFRoaXNJc0FuQVNlY3JldEZvclRlc3RzMTIzNDU2Nzg5MA==";
const SECRET_HEX =
  "deadbeefcafebabe1234567890abcdef1234567890abcdef1234567890abcdef";
const SECRET_PAIR = `password=hunter2 and ${SECRET_AWS}`;

const ALL_SECRETS = [SECRET_AWS, SECRET_BEARER, SECRET_B64, SECRET_HEX, "hunter2"];

function anySecretFound(text: string): boolean {
  return ALL_SECRETS.some((s) => text.includes(s));
}

function makeSignalInput(
  agentId: string,
  overrides: Partial<CreateEvolutionSignalInput> = {},
): CreateEvolutionSignalInput {
  return {
    agentId,
    outcome: "review-rejected",
    source: "agent-self-improve",
    failureCategory: "review-rejected",
    humanFeedback: `Reviewer left feedback: ${SECRET_AWS} should not leak; ${SECRET_BEARER} also bad.`,
    ...overrides,
  };
}

function makeArtifactInput(agentId: string): AppendEvolutionArtifactInput {
  const candidate: EvolutionCandidate = {
    changeType: "instructions",
    target: "agent-x/instructions.md",
    changeSummary: `change summary contains ${SECRET_AWS}`,
    proposedDiff: `--- a\n+++ b\n@@\n-old\n+new password=hunter2\n`,
    checksum: "",
  };
  candidate.checksum = computeEvolutionCandidateChecksum(candidate);
  return {
    agentId,
    trigger: "manual",
    event: {
      summary: `event summary contains ${SECRET_BEARER}`,
      taskIds: [],
    },
    evidence: { signals: [] },
    hypothesis: `hypothesis contains ${SECRET_B64}`,
    candidate,
    trial: {
      baselineRun: { command: `echo ${SECRET_AWS}`, passed: true, metrics: {} },
      candidateRun: { command: `echo ${SECRET_HEX}`, passed: true, metrics: {} },
      decisions: ["all-gate-checks-pass"],
      decision: "keep",
      rationale: `rationale contains ${SECRET_PAIR}`,
    },
  };
}

describe("redactSecrets sanity", () => {
  it("strips AWS keys", () => {
    expect(redactSecrets(SECRET_AWS)).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
  });
  it("strips bearer tokens", () => {
    expect(redactSecrets(SECRET_BEARER)).not.toMatch(/eyJhbGciOiJIUzI1NiJ9/);
  });
  it("strips long base64", () => {
    expect(redactSecrets(SECRET_B64)).not.toMatch(/SGVsbG9Xb3JsZA/);
  });
  it("strips long hex", () => {
    expect(redactSecrets(SECRET_HEX)).not.toMatch(/deadbeef/);
  });
  it("strips password= assignments", () => {
    expect(redactSecrets(SECRET_PAIR)).not.toMatch(/hunter2/);
  });
});

describe("redactEvolutionArtifact: every free-text field is redacted", () => {
  function buildArtifact() {
    const input = makeArtifactInput("agent-x");
    return {
      id: "evolution-artifact-test",
      version: 1,
      agentId: input.agentId,
      createdAt: "2026-09-04T12:00:00.000Z",
      trigger: input.trigger,
      event: input.event,
      evidence: input.evidence,
      hypothesis: input.hypothesis,
      candidate: input.candidate,
      trial: input.trial,
      approval: { status: "not-requested" as const },
    };
  }
  it("event.summary is redacted", () => {
    const out = redactEvolutionArtifact(buildArtifact());
    expect(out.event.summary).not.toMatch(/eyJhbGciOiJIUzI1NiJ9/);
  });
  it("hypothesis is redacted", () => {
    const out = redactEvolutionArtifact(buildArtifact());
    expect(out.hypothesis).not.toMatch(/SGVsbG9Xb3JsZA/);
  });
  it("candidate.changeSummary is redacted", () => {
    const out = redactEvolutionArtifact(buildArtifact());
    expect(out.candidate.changeSummary).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
  });
  it("candidate.proposedDiff is redacted", () => {
    const out = redactEvolutionArtifact(buildArtifact());
    expect(out.candidate.proposedDiff).not.toMatch(/hunter2/);
  });
  it("trial.rationale is redacted", () => {
    const out = redactEvolutionArtifact(buildArtifact());
    expect(out.trial.rationale).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
    expect(out.trial.rationale).not.toMatch(/hunter2/);
  });
});

describe("boundary (a): signal humanFeedback on write", () => {
  let tmp: string;
  let store: EvolutionStore;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "evolution-redact-signal-"));
    store = new EvolutionStore({ rootDir: tmp });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the JSONL line never contains any of the secrets", async () => {
    await store.init();
    await store.createSignal(makeSignalInput("agent-x"));
    const raw = readFileSync(
      join(tmp, "evolution/agent-x-signals.jsonl"),
      "utf8",
    );
    expect(anySecretFound(raw)).toBe(false);
  });

  it("the in-memory signal (after createSignal round-trip) never contains any of the secrets", async () => {
    await store.init();
    const signal = await store.createSignal(makeSignalInput("agent-x"));
    expect(signal.humanFeedback).toBeDefined();
    expect(anySecretFound(signal.humanFeedback!)).toBe(false);
  });

  it("a re-loaded signal (read back from JSONL) never contains any of the secrets", async () => {
    await store.init();
    await store.createSignal(makeSignalInput("agent-x"));
    const signals = await store.getSignals("agent-x");
    expect(signals).toHaveLength(1);
    expect(anySecretFound(JSON.stringify(signals[0]))).toBe(false);
  });
});

describe("boundary (b): artifact hypothesis/evidence/proposedDiff/changeSummary/event.summary on write", () => {
  let tmp: string;
  let store: EvolutionStore;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "evolution-redact-artifact-"));
    store = new EvolutionStore({ rootDir: tmp });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the JSONL line never contains any of the secrets", async () => {
    await store.init();
    await store.appendArtifact(makeArtifactInput("agent-x"));
    const raw = readFileSync(
      join(tmp, "evolution/agent-x-evolution.jsonl"),
      "utf8",
    );
    expect(anySecretFound(raw)).toBe(false);
  });

  it("the in-memory artifact (after appendArtifact) never contains any of the secrets", async () => {
    await store.init();
    const artifact = await store.appendArtifact(makeArtifactInput("agent-x"));
    const serialized = JSON.stringify(artifact);
    expect(anySecretFound(serialized)).toBe(false);
  });

  it("a re-loaded artifact never contains any of the secrets", async () => {
    await store.init();
    await store.appendArtifact(makeArtifactInput("agent-x"));
    const artifacts = await store.getArtifacts("agent-x");
    expect(artifacts).toHaveLength(1);
    expect(anySecretFound(JSON.stringify(artifacts[0]))).toBe(false);
  });
});

describe("boundary (c): audit row metadata is ids/counts/outcomes only", () => {
  it("redactEvolutionAuditEvent keeps only id/agentId/artifactId/candidateChecksum; future free-text fields are redacted", () => {
    const event: EvolutionAuditEvent = {
      id: `evolution-audit:${SECRET_AWS}`,
      agentId: `agent-${SECRET_BEARER}`,
      artifactId: `artifact-${SECRET_B64}`,
      candidateChecksum: SECRET_HEX,
      at: "2026-09-04T12:00:00.000Z",
      decision: "keep",
      criteria: ["all-gate-checks-pass"],
    };
    const redacted = redactEvolutionAuditEvent(event);
    const serialized = JSON.stringify(redacted);
    // Each id field is forced through a safe identifier rule that forbids bearer/aws/long-base64 shapes
    expect(serialized).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
    expect(serialized).not.toMatch(/eyJhbGciOiJIUzI1NiJ9/);
    expect(serialized).not.toMatch(/SGVsbG9Xb3JsZA/);
    expect(serialized).not.toMatch(/deadbeef/);
  });

  it("decideEvolutionTrial returns a decision object with redacted rationale, even when the trial commands reference a secret", async () => {
    const result = decideEvolutionTrial({
      baselineRun: { command: `echo ${SECRET_AWS}`, passed: true, metrics: { accuracy: 0.9 } },
      candidateRun: { command: `echo ${SECRET_BEARER}`, passed: true, metrics: { accuracy: 0.92 } },
      criteria: ["all-gate-checks-pass", "primary-metric-beats-baseline", "no-new-failures"],
    });
    expect(result.decision).toBe("keep");
    const serialized = JSON.stringify(result);
    // The decision/rationale are not free-text, but the test asserts the same redactor
    // passes through them without leaking the secret strings.
    expect(serialized).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
    expect(serialized).not.toMatch(/eyJhbGciOiJIUzI1NiJ9/);
  });

  it("apply-gate audit rows are ids-only: never the proposed diff, never the change summary", async () => {
    const auditRows: unknown[] = [];
    const actor: ApprovalRequestActorSnapshot = {
      actorId: "system",
      actorType: "operator",
      actorName: "system",
    };
    const approval: ApprovalRequest = {
      id: "appr-1",
      status: "approved",
      requester: actor,
      targetAction: {
        category: "agent_provisioning",
        action: "apply_evolution",
        summary: `summary ${SECRET_AWS}`,
        resourceType: "evolution_artifact",
        resourceId: "evolution-artifact-test",
      },
      requestedAt: "2026-09-04T12:00:00.000Z",
      decidedAt: "2026-09-04T12:00:00.000Z",
      createdAt: "2026-09-04T12:00:00.000Z",
      updatedAt: "2026-09-04T12:00:00.000Z",
    };
    const store: ApprovalRequestStoreLike = {
      get: vi.fn(async (id: string) => ({ ...approval, id })),
      decide: vi.fn(async (id: string) => ({ ...approval, id })),
      markCompleted: vi.fn(async (id: string) => ({ ...approval, id })),
    };
    const written: unknown[] = [];
    const liveWriter = vi.fn(async (a: unknown) => {
      written.push(a);
    });
    const candidate: EvolutionCandidate = {
      changeType: "instructions",
      target: "agent-x/instructions.md",
      changeSummary: `changeSummary ${SECRET_AWS}`,
      proposedDiff: `proposedDiff ${SECRET_BEARER}`,
      checksum: "",
    };
    candidate.checksum = computeEvolutionCandidateChecksum(candidate);
    const artifact = {
      id: `evolution-artifact-${candidate.checksum.slice(0, 8)}`,
      version: 1,
      agentId: "agent-x",
      createdAt: "2026-09-04T12:00:00.000Z",
      trigger: "manual" as const,
      event: { summary: `event summary ${SECRET_B64}`, taskIds: [] },
      evidence: { signals: [] },
      hypothesis: `hypothesis ${SECRET_HEX}`,
      candidate,
      trial: {
        baselineRun: { command: "none", passed: true, metrics: {} },
        candidateRun: { command: "none", passed: true, metrics: {} },
        decisions: ["all-gate-checks-pass"],
        decision: "keep" as const,
        rationale: `rationale ${SECRET_PAIR}`,
      },
      approval: { status: "approved" as const, approvalRequestId: "appr-1" },
    };
    const gate = createEvolutionApplyGate({
      approvalStore: store,
      liveWriter,
      auditHost: {
        recordRunAuditEvent: (r: unknown) => {
          auditRows.push(r);
          return r;
        },
      },
    });
    await gate.applyArtifact(artifact);
    const auditSerialized = JSON.stringify(auditRows);
    expect(auditSerialized).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
    expect(auditSerialized).not.toMatch(/eyJhbGciOiJIUzI1NiJ9/);
    expect(auditSerialized).not.toMatch(/SGVsbG9Xb3JsZA/);
    expect(auditSerialized).not.toMatch(/deadbeef/);
    expect(auditSerialized).not.toMatch(/hunter2/);
    // The live writer ALSO received a redacted artifact.
    expect(written).toHaveLength(1);
    const writtenSerialized = JSON.stringify(written[0]);
    expect(writtenSerialized).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
    expect(writtenSerialized).not.toMatch(/eyJhbGciOiJIUzI1NiJ9/);
  });
});

describe("boundary (d): logger never receives a secret", () => {
  let tmp: string;
  let store: EvolutionStore;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "evolution-redact-log-"));
    store = new EvolutionStore({ rootDir: tmp });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no log line emitted by the store contains any of the secrets", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Plant a secret in humanFeedback; the store may log a warning if validation fails,
    // but it MUST NOT log the secret itself.
    await store.init();
    await store.createSignal(makeSignalInput("agent-x"));
    await store.appendArtifact(makeArtifactInput("agent-x"));
    const all = [
      ...(warnSpy.mock.calls as string[][]),
      ...(logSpy.mock.calls as string[][]),
      ...(errorSpy.mock.calls as string[][]),
    ]
      .map((args) => args.join(" "))
      .join("\n");
    expect(anySecretFound(all)).toBe(false);
  });
});
