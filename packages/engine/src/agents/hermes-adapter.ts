/**
 * FNXC:EvolutionPipeline 2026-09-04-02:50:
 * KB-001 Step 5 (Hermes adapter): boundary between the evolution cycle and the upstream
 * `hermes` agent CLI. The adapter is a FUNCTION — never a class with a side-effecting
 * constructor — so the cycle can compose multiple sources (in-engine proposer, Hermes,
 * future adapters) under a single `(event) => Promise<EvolutionArtifact | null>` contract.
 *
 * Authority rules (enforced by the adapter, not by callers):
 *   - Hermes NEVER executes a mutation on the live agent. The adapter is read-only; it asks
 *     Hermes for a candidate description and returns it as an `EvolutionArtifact`. The
 *     apply gate (Step 7) and `markApplied` are the only paths that can ever apply.
 *   - No duplicate memory, no duplicate skills, no agent loop. The adapter is invoked
 *     once per `EvolutionEvent`; it does not subscribe, poll, or schedule.
 *   - All errors are returned to the caller as `null` (with a `reason` audit row). The
 *     adapter does not throw — throwing would let a Hermes outage park the cycle.
 *
 * Production path: the adapter invokes the `hermes` CLI via an injected async runner
 * (`RunHermesFn`) so the runtime seam is unit-testable without a real binary. The
 * default runner uses `execFile` (NOT `execSync` — see `engine-no-blocking-shellout`).
 *
 * Test path: `FakeHermesAdapter` returns canned artifacts and can be configured to fail
 * (`failureMode: "throw" | "return-null" | "return-garbage"`). Every test of the cycle
 * uses the fake so the suite is offline-demonstrable.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  computeEvolutionCandidateChecksum,
  redactEvolutionArtifact,
  type EvolutionArtifact,
  type EvolutionCandidate,
  type EvolutionTrigger,
} from "@fusion/core";
import { emitBoundedRunAudit, type RunAuditSinkHost } from "../util/emit-bounded-run-audit.js";
import { createLogger } from "../logger.js";

const execFileAsync = promisify(execFile);
const hermesAdapterLog = createLogger("evolution-hermes-adapter");

/**
 * The input event the adapter receives. Mirrors the smallest shape a self-improve
 * signal from outside the engine must carry. Defined as a tagged union so the adapter
 * can be called with a uniform contract from the cycle, the dashboard, or a CLI hook.
 */
export type EvolutionEvent =
  | { source: "cycle"; agentId: string; clusterId: string; signals: string[] }
  | { source: "manual"; agentId: string; operator: string; reason: string }
  | { source: "external"; agentId: string; sourceSystem: string; reason: string };

/** The adapter contract: produces an artifact or refuses (null). */
export type HermesAdapter = (event: EvolutionEvent) => Promise<EvolutionArtifact | null>;

/** Reason an adapter refused to produce an artifact. Recorded in audit metadata. */
export type HermesRefusalReason =
  | "empty-agent-id"
  | "runner-threw"
  | "runner-returned-empty"
  | "runner-returned-garbage"
  | "refused-by-hermes";

/** Why the fake adapter refused (test-only; production adapter uses HermesRefusalReason). */
export type FakeHermesFailureMode =
  | "return-null"
  | "throw"
  | "return-garbage";

/** What the runner produced. Either a structured candidate or a refusal. */
export type HermesRunnerOutput =
  | { kind: "ok"; candidate: EvolutionCandidate }
  | { kind: "refused"; reason: HermesRefusalReason };

/** A pluggable runner that invokes the upstream hermes binary. */
export type RunHermesFn = (event: EvolutionEvent) => Promise<HermesRunnerOutput>;

const DEFAULT_TIMEOUT_MS = 5_000;

/** Render an event as a deterministic, redacted prompt body. The body is for audit only. */
function describeEvent(event: EvolutionEvent): string {
  switch (event.source) {
    case "cycle":
      return `cycle cluster=${event.clusterId} signals=${event.signals.length}`;
    case "manual":
      return `manual operator=${event.operator}`;
    case "external":
      return `external source=${event.sourceSystem}`;
  }
}

/**
 * Default runner: invoke the `hermes` CLI in non-interactive mode. The prompt body is a
 * short, redacted request that asks Hermes to emit a JSON `EvolutionCandidate`. The runner
 * NEVER applies anything — Hermes returns JSON, the adapter turns it into an artifact.
 */
export async function defaultRunHermes(
  binary: string,
  event: EvolutionEvent,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<HermesRunnerOutput> {
  const prompt = [
    "You are an evolution-advisor. Respond with a SINGLE JSON object of the form",
    '`{"refused":true,"reason":"..."}` or `{"changeType":"instructions|skill|config","target":"<path>","changeSummary":"<one line>","proposedDiff":"<unified diff or empty>"}`.',
    "Do NOT attempt to write any files, run any commands, or call any tools.",
    `Event: ${describeEvent(event)} (agentId=${event.agentId}).`,
  ].join(" ");

  try {
    const { stdout } = await execFileAsync(binary, ["chat", "-z", prompt, "--no-restore-cwd", "--safe-mode"], {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    return parseHermesOutput(stdout);
  } catch (error) {
    hermesAdapterLog.warn("hermes runner failed", error);
    return { kind: "refused", reason: "runner-threw" };
  }
}

/** Parse a hermes stdout blob into a structured runner output. Defensive against garbage. */
export function parseHermesOutput(stdout: string): HermesRunnerOutput {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { kind: "refused", reason: "runner-returned-empty" };
  }
  // The runner expects JSON but Hermes may wrap it in prose. Find the first `{` and the matching `}`.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    return { kind: "refused", reason: "runner-returned-garbage" };
  }
  const slice = trimmed.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return { kind: "refused", reason: "runner-returned-garbage" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { kind: "refused", reason: "runner-returned-garbage" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.refused === true) {
    return {
      kind: "refused",
      reason: typeof obj.reason === "string" ? "refused-by-hermes" : "refused-by-hermes",
    };
  }
  const changeType = obj.changeType;
  const target = obj.target;
  const changeSummary = obj.changeSummary;
  const proposedDiff = obj.proposedDiff;
  if (
    (changeType !== "instructions" && changeType !== "skill" && changeType !== "config") ||
    typeof target !== "string" ||
    typeof changeSummary !== "string" ||
    typeof proposedDiff !== "string"
  ) {
    return { kind: "refused", reason: "runner-returned-garbage" };
  }
  const candidate: EvolutionCandidate = {
    changeType,
    target,
    changeSummary,
    proposedDiff,
    checksum: "", // filled below
  };
  candidate.checksum = computeEvolutionCandidateChecksum(candidate);
  return { kind: "ok", candidate };
}

export interface CreateHermesAdapterOptions {
  binary?: string;
  runner?: RunHermesFn;
  auditHost?: RunAuditSinkHost;
  agentIdResolver?: (event: EvolutionEvent) => string;
  artifactIdResolver?: (event: EvolutionEvent, candidate: EvolutionCandidate, now: Date) => string;
  now?: () => Date;
}

/** Build a production `HermesAdapter` that calls the upstream `hermes` binary. */
export function createHermesAdapter(options: CreateHermesAdapterOptions = {}): HermesAdapter {
  const binary = options.binary ?? "hermes";
  const runner: RunHermesFn = options.runner ?? ((event) => defaultRunHermes(binary, event));
  const auditHost = options.auditHost ?? null;
  const now = options.now ?? (() => new Date());

  return async (event: EvolutionEvent): Promise<EvolutionArtifact | null> => {
    if (!event.agentId || !event.agentId.trim()) {
      await emitBoundedRunAudit(auditHost, {
        mutationType: "evolution-hermes:refused",
        reason: "empty-agent-id",
        source: event.source,
      });
      return null;
    }
    const result = await runner(event);
    if (result.kind === "refused") {
      await emitBoundedRunAudit(auditHost, {
        mutationType: "evolution-hermes:refused",
        reason: result.reason,
        agentId: event.agentId,
        source: event.source,
      });
      return null;
    }
    const artifact = buildArtifactFromCandidate({
      agentId: event.agentId,
      candidate: result.candidate,
      proposedBy: "hermes",
      trigger: event.source === "cycle" ? "periodic" : "manual",
      now: now(),
      version: 1, // initial draft; the store assigns a real monotonic version on append
      hypothesis: `Hermes proposes ${result.candidate.changeType} change for ${result.candidate.target} based on event ${event.source}.`,
    });
    await emitBoundedRunAudit(auditHost, {
      mutationType: "evolution-hermes:produced",
      agentId: event.agentId,
      artifactId: artifact.id,
      candidateChecksum: artifact.candidate.checksum,
      source: event.source,
    });
    return artifact;
  };
}

/** Shape of the input to `buildArtifactFromCandidate`. */
export interface BuildArtifactInput {
  agentId: string;
  candidate: EvolutionCandidate;
  proposedBy: "hermes" | "herdr" | "engine-cycle";
  trigger: EvolutionTrigger;
  now: Date;
  version: number;
  hypothesis: string;
}

/**
 * Build a redacted `EvolutionArtifact` from a validated candidate. Centralized so the
 * production and fake adapters produce identical shapes. `version` is supplied by the
 * store (caller passes the value it just received from `appendArtifact`).
 */
export function buildArtifactFromCandidate(input: BuildArtifactInput): EvolutionArtifact {
  const { agentId, candidate, proposedBy, trigger, now, version, hypothesis } = input;
  const nowIso = now.toISOString();
  const artifactId = `evolution-artifact-${candidate.checksum.slice(0, 8)}`;
  const artifact: EvolutionArtifact = {
    id: artifactId,
    version,
    agentId,
    createdAt: nowIso,
    trigger,
    event: {
      summary: `${proposedBy} candidate (artifactId=${artifactId})`,
      taskIds: [],
    },
    evidence: { signals: [] },
    hypothesis,
    candidate,
    trial: {
      baselineRun: { command: "none", passed: false, metrics: {} },
      candidateRun: { command: "none", passed: false, metrics: {} },
      decisions: [],
      decision: "rejected",
      rationale: "pending trial (artifact produced by external adapter)",
    },
    approval: { status: "not-requested" },
  };
  return redactEvolutionArtifact(artifact);
}

/** Test-only adapter that returns canned artifacts. */
export class FakeHermesAdapter {
  private readonly canned: (EvolutionArtifact | null)[];
  private readonly failureMode: FakeHermesFailureMode;
  public readonly calls: EvolutionEvent[] = [];

  constructor(options: { canned: (EvolutionArtifact | null)[]; failureMode?: FakeHermesFailureMode }) {
    this.canned = options.canned;
    this.failureMode = options.failureMode ?? "return-null";
  }

  invoke: HermesAdapter = async (event) => {
    this.calls.push(event);
    if (this.failureMode === "throw") {
      throw new Error("FakeHermesAdapter configured to throw");
    }
    const idx = Math.min(this.calls.length - 1, this.canned.length - 1);
    const result = this.canned[idx] ?? null;
    if (this.failureMode === "return-garbage") {
      return null;
    }
    return result;
  };
}

/** Convenience: build a canned `EvolutionArtifact` for use in tests. */
export function makeFakeHermesArtifact(overrides: Partial<EvolutionArtifact> = {}): EvolutionArtifact {
  const now = "2026-09-04T12:00:00.000Z";
  const candidate: EvolutionCandidate = {
    changeType: "instructions",
    target: "agent/test/instructions.md",
    changeSummary: "fake hermes candidate",
    proposedDiff: "fake diff body",
    checksum: "deadbeefcafebabe1234567890abcdef1234567890abcdef1234567890abcdef",
  };
  candidate.checksum = computeEvolutionCandidateChecksum(candidate);
  const base: EvolutionArtifact = {
    id: `evolution-artifact-${candidate.checksum.slice(0, 8)}`,
    version: 1,
    agentId: "agent-test",
    createdAt: now,
    trigger: "manual",
    event: { summary: "fake hermes candidate", taskIds: [] },
    evidence: { signals: [] },
    hypothesis: "Hermes fake candidate: reduce test-failure rate by tightening test selection.",
    candidate,
    trial: {
      baselineRun: { command: "none", passed: false, metrics: {} },
      candidateRun: { command: "none", passed: false, metrics: {} },
      decisions: [],
      decision: "rejected",
      rationale: "fake — pending trial",
    },
    approval: { status: "not-requested" },
  };
  return redactEvolutionArtifact({ ...base, ...overrides });
}
