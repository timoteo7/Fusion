/**
 * FNXC:EvolutionPipeline 2026-09-04-03:25:
 * KB-001 Step 6 (Herdr adapter): observation-only boundary between the evolution cycle and
 * the upstream `herdr` workspace manager. Unlike the Hermes adapter (which ASKS for a
 * candidate), the Herdr adapter only READS evidence about panes, sessions, and active
 * commands; it never requests a mutation, never writes to herdr, never mutates state.
 *
 * Authority rules (enforced by the adapter, not by callers):
 *   - READ-ONLY. The adapter never sends a write command to herdr. It only calls
 *     `herdr api <read-only-subcommand>` (status, panes, sessions, etc.).
 *   - Requires `HERDR_ENV=1` — the upstream guard that herdr itself enforces on any
 *     process that talks to its server. Without it, every call refuses immediately.
 *   - All errors return `null` (with audit row). The adapter does not throw — throwing
 *     would let a herdr outage park the cycle. (Same rule as the Hermes adapter.)
 *   - Returns `EvolutionHerdrEvidence` (read-only snapshot) — never an artifact directly.
 *     The cycle consumes the evidence and decides whether to spawn an artifact.
 *
 * Production path: an injected `RunHerdrFn` invokes `herdr api ...` via async execFile
 * (NOT `execSync` — see `engine-no-blocking-shellout`). Default runner preflights the
 * `HERDR_ENV=1` env var and calls the requested subcommand.
 *
 * Test path: `FakeHerdrAdapter` returns canned evidence and can be configured to fail.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HerdrEvidence } from "@fusion/core";
import { emitBoundedRunAudit, type RunAuditSinkHost } from "../util/emit-bounded-run-audit.js";
import { createLogger } from "../logger.js";

const execFileAsync = promisify(execFile);
const herdrAdapterLog = createLogger("evolution-herdr-adapter");

/** The adapter contract: returns a read-only evidence snapshot or null. */
export type HerdrAdapter = (event: HerdrEvent) => Promise<HerdrEvidence | null>;

/** Reason the adapter returned null. Recorded in audit metadata. */
export type HerdrRefusalReason =
  | "herdr-env-missing"
  | "agent-id-missing"
  | "runner-threw"
  | "runner-returned-empty"
  | "runner-returned-garbage"
  | "binary-not-found";

/** What the runner produced. Either structured evidence or a refusal. */
export type HerdrRunnerOutput =
  | { kind: "ok"; evidence: HerdrEvidence }
  | { kind: "refused"; reason: HerdrRefusalReason };

/** A pluggable runner that invokes herdr. */
export type RunHerdrFn = (event: HerdrEvent) => Promise<HerdrRunnerOutput>;

/** The event the adapter receives. */
export interface HerdrEvent {
  agentId: string;
  /** Bounded: small number of recent panes (default 5) to summarize. */
  paneIds?: string[];
  /** Bounded: small number of recent sessions (default 5) to summarize. */
  sessionIds?: string[];
  /** Caller-requested snapshot of active commands. */
  includeActiveCommands?: boolean;
}

const DEFAULT_TIMEOUT_MS = 3_000;

/**
 * Default runner: invoke `herdr api status` to read a bounded, redacted snapshot of the
 * workspace. We intentionally do NOT pipe any write subcommand to herdr.
 */
export async function defaultRunHerdr(event: HerdrEvent, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<HerdrRunnerOutput> {
  if (!process.env.HERDR_ENV) {
    return { kind: "refused", reason: "herdr-env-missing" };
  }
  const start = Date.now();
  try {
    // `herdr api status` returns a JSON object on stdout. We pass no args to keep the
    // surface area minimal and read-only.
    const { stdout } = await execFileAsync("herdr", ["api", "status"], {
      timeout: timeoutMs,
      maxBuffer: 1 * 1024 * 1024,
      env: { ...process.env, HERDR_ENV: "1" },
    });
    return parseHerdrOutput(stdout, event, Date.now() - start);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { kind: "refused", reason: "binary-not-found" };
    }
    herdrAdapterLog.warn("herdr runner failed", error);
    return { kind: "refused", reason: "runner-threw" };
  }
}

/** Parse a `herdr api status` blob into structured evidence. Defensive against garbage. */
export function parseHerdrOutput(stdout: string, event: HerdrEvent, durationMs: number): HerdrRunnerOutput {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { kind: "refused", reason: "runner-returned-empty" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "refused", reason: "runner-returned-garbage" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { kind: "refused", reason: "runner-returned-garbage" };
  }
  const obj = parsed as Record<string, unknown>;
  const panes = Array.isArray(obj.panes) ? obj.panes.length : 0;
  const sessions = Array.isArray(obj.sessions) ? obj.sessions.length : 0;
  const activeCommands = event.includeActiveCommands === true
    ? Array.isArray(obj.active_commands) ? obj.active_commands.length : 0
    : 0;
  return {
    kind: "ok",
    evidence: { panes, sessions, activeCommands, durationMs },
  };
}

export interface CreateHerdrAdapterOptions {
  runner?: RunHerdrFn;
  auditHost?: RunAuditSinkHost;
}

/** Build a production `HerdrAdapter` that calls the upstream herdr binary. */
export function createHerdrAdapter(options: CreateHerdrAdapterOptions = {}): HerdrAdapter {
  const runner = options.runner ?? defaultRunHerdr;
  const auditHost = options.auditHost ?? null;

  return async (event: HerdrEvent): Promise<HerdrEvidence | null> => {
    if (!event.agentId || !event.agentId.trim()) {
      await emitBoundedRunAudit(auditHost, {
        mutationType: "evolution-herdr:refused",
        reason: "agent-id-missing",
      });
      return null;
    }
    const result = await runner(event);
    if (result.kind === "refused") {
      await emitBoundedRunAudit(auditHost, {
        mutationType: "evolution-herdr:refused",
        reason: result.reason,
        agentId: event.agentId,
      });
      return null;
    }
    await emitBoundedRunAudit(auditHost, {
      mutationType: "evolution-herdr:observed",
      agentId: event.agentId,
      paneCount: result.evidence.panes,
      sessionCount: result.evidence.sessions,
      activeCommandCount: result.evidence.activeCommands,
      durationMs: result.evidence.durationMs,
    });
    return result.evidence;
  };
}

/** Test-only adapter that returns canned evidence. */
export class FakeHerdrAdapter {
  private readonly canned: (HerdrEvidence | null)[];
  public readonly calls: HerdrEvent[] = [];

  constructor(options: { canned: (HerdrEvidence | null)[] }) {
    this.canned = options.canned;
  }

  invoke: HerdrAdapter = async (event) => {
    this.calls.push(event);
    const idx = Math.min(this.calls.length - 1, this.canned.length - 1);
    return this.canned[idx] ?? null;
  };
}

/** Convenience: build a canned `HerdrEvidence` for use in tests. */
export function makeFakeHerdrEvidence(overrides: Partial<HerdrEvidence> = {}): HerdrEvidence {
  return {
    panes: 3,
    sessions: 2,
    activeCommands: 1,
    durationMs: 250,
    ...overrides,
  };
}
