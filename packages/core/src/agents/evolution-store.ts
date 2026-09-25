/**
 * FNXC:EvolutionPipeline 2026-09-03-09:05:
 * KB-001 (Safe, Testable Self-Improvement MVP): append-only JSONL store for evolution signals and
 * versioned artifacts. Mirrors the ReflectionStore pattern (EventEmitter, per-agent lock, explicit
 * rootDir under VITEST) so the evolution subsystem does not invent a second persistence primitive.
 *
 * Storage layout:
 * - `.fusion/evolution/{agentId}-signals.jsonl`      (append-only signal lines)
 * - `.fusion/evolution/{agentId}-evolution.jsonl`    (append-only artifact lines)
 *
 * Artifacts are immutable once written EXCEPT the mutable status fields on the latest artifact line
 * (`approval.status`, `publishedAt`, `appliedAt`), which are rewritten in place under the agent lock,
 * never reordered. Signal lines are strictly append-only.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createLogger } from "../process/logger.js";
import { redactSecrets } from "../secrets/redact-secrets.js";
import { redactEvolutionArtifact } from "./evolution-types.js";
import type {
  EvolutionApproval,
  EvolutionArtifact,
  EvolutionSignal,
} from "./evolution-types.js";

const evolutionStoreLog = createLogger("core-evolution-store");

/** Events emitted by EvolutionStore. */
export interface EvolutionStoreEvents {
  "evolution:signal-created": (signal: EvolutionSignal) => void;
  "evolution:artifact-created": (artifact: EvolutionArtifact) => void;
}

/** Constructor options for EvolutionStore. */
export interface EvolutionStoreOptions {
  /** Root fn data directory (default: .fusion). */
  rootDir?: string;
}

/** Input for appending a normalized signal. */
export interface CreateEvolutionSignalInput {
  agentId: string;
  taskId?: string;
  outcome: EvolutionSignal["outcome"];
  qualityScore?: number;
  reviewVerdict?: EvolutionSignal["reviewVerdict"];
  costTokens?: number;
  durationMs?: number;
  failureCategory?: EvolutionSignal["failureCategory"];
  humanFeedback?: string;
  source: EvolutionSignal["source"];
}

/** Input for appending a versioned artifact. */
export interface AppendEvolutionArtifactInput {
  agentId: string;
  trigger: EvolutionArtifact["trigger"];
  event: EvolutionArtifact["event"];
  evidence: EvolutionArtifact["evidence"];
  hypothesis: string;
  candidate: EvolutionArtifact["candidate"];
  trial: EvolutionArtifact["trial"];
  lastCycleSummary?: string;
  createdAt?: string;
}

/** Filter options for reading signals. */
export interface EvolutionSignalFilter {
  outcome?: EvolutionSignal["outcome"];
  taskId?: string;
  source?: EvolutionSignal["source"];
}

interface AgentLock {
  promise: Promise<unknown>;
}

const DEFAULT_SIGNAL_LIMIT = 100;
const DEFAULT_ARTIFACT_LIMIT = 50;

/**
 * FNXC:EvolutionSignalDedupe 2026-09-25-11:05:
 * How far back `createSignal` looks for an identical observation. Replay is a
 * near-term event (a retried or duplicated finalization), so a recent window catches
 * it while keeping the per-finalization read bounded as the log grows.
 */
const SIGNAL_DEDUPE_WINDOW = 1_000;

/**
 * FNXC:EvolutionCycleLease 2026-09-25-10:50:
 * A cycle lease older than this is assumed to belong to a crashed holder. It bounds how
 * long one wedged process can hold an agent's evolution lane, and is deliberately far
 * below the 4h cycle interval so a stale lease is always recoverable well before the next
 * eligible cycle.
 */
export const DEFAULT_CYCLE_LEASE_STALE_MS = 15 * 60_000;

/** Outcome of a cross-process cycle claim. */
export interface EvolutionCycleClaim {
  claimed: boolean;
  /** Idempotent release; a no-op when the claim was not won. */
  released: () => Promise<void>;
  /** Present when the claim was refused, for audit/diagnostics. */
  heldBy?: string;
  lastCycleAt?: string;
}

function sameEvolutionSignal(left: EvolutionSignal, right: EvolutionSignal): boolean {
  return left.agentId === right.agentId
    && left.taskId === right.taskId
    && left.outcome === right.outcome
    && left.source === right.source
    && left.qualityScore === right.qualityScore
    && left.reviewVerdict === right.reviewVerdict
    && left.costTokens === right.costTokens
    && left.durationMs === right.durationMs
    && left.failureCategory === right.failureCategory
    && left.humanFeedback === right.humanFeedback;
}

/**
 * EvolutionStore persists normalized signals and versioned evolution artifacts in append-only
 * JSONL files under `.fusion/evolution/`.
 */
export class EvolutionStore extends EventEmitter {
  private rootDir: string;
  private evolutionDir: string;
  private locks: Map<string, AgentLock> = new Map();

  constructor(options: EvolutionStoreOptions = {}) {
    super();

    if (!options.rootDir && process.env.VITEST === "true") {
      throw new Error(
        "EvolutionStore requires an explicit rootDir during test execution. Pass an absolute path to avoid writing to unintended locations.",
      );
    }

    this.rootDir = options.rootDir ?? resolve(".fusion");
    this.evolutionDir = join(this.rootDir, "evolution");
  }

  override on(event: "evolution:signal-created", listener: EvolutionStoreEvents["evolution:signal-created"]): this;
  override on(
    event: "evolution:artifact-created",
    listener: EvolutionStoreEvents["evolution:artifact-created"],
  ): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override emit(event: "evolution:signal-created", signal: EvolutionSignal): boolean;
  override emit(event: "evolution:artifact-created", artifact: EvolutionArtifact): boolean;
  override emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  /** Ensure the evolution directory exists. */
  async init(): Promise<void> {
    await mkdir(this.evolutionDir, { recursive: true });
  }

  /** Append a normalized signal (strictly append-only). */
  async createSignal(input: CreateEvolutionSignalInput): Promise<EvolutionSignal> {
    if (!input.agentId?.trim()) {
      throw new Error("agentId is required");
    }

    return this.withLock(input.agentId, async () => {
      const signal: EvolutionSignal = {
        id: `evolution-signal-${randomUUID().slice(0, 8)}`,
        agentId: input.agentId,
        timestamp: new Date().toISOString(),
        outcome: input.outcome,
        source: input.source,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.qualityScore !== undefined ? { qualityScore: input.qualityScore } : {}),
        ...(input.reviewVerdict ? { reviewVerdict: input.reviewVerdict } : {}),
        ...(input.costTokens !== undefined ? { costTokens: input.costTokens } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        ...(input.failureCategory ? { failureCategory: input.failureCategory } : {}),
        // Free-text fields are redacted at the store boundary (KB-001 Step 8).
        // Without this, a human reviewer's `humanFeedback` could carry an AWS
        // key or bearer token into the JSONL file unredacted.
        ...(input.humanFeedback ? { humanFeedback: redactSecrets(input.humanFeedback) } : {}),
      };

      // Identical observations are idempotent at the durable boundary. The
      // generated id/timestamp are intentionally excluded from the comparison;
      // replaying the same task finalization must not grow the signal history.
      //
      // FNXC:EvolutionSignalDedupe 2026-09-25-11:05:
      // The dedupe window is bounded to the most recent SIGNAL_DEDUPE_WINDOW entries
      // rather than the whole file. A replay is a near-term event, so scanning all
      // history on every task finalization would grow the read cost without making
      // the guarantee stronger.
      const existing = await this.getSignals(input.agentId, {}, SIGNAL_DEDUPE_WINDOW);
      const duplicate = existing.find((candidate) => sameEvolutionSignal(candidate, signal));
      if (duplicate) return duplicate;

      await writeFile(this.signalsPath(input.agentId), `${JSON.stringify(signal)}\n`, { flag: "a" });

      this.emit("evolution:signal-created", signal);
      return signal;
    });
  }

  /** Get recent signals for an agent (newest first), optionally filtered. */
  async getSignals(
    agentId: string,
    filter: EvolutionSignalFilter = {},
    limit = DEFAULT_SIGNAL_LIMIT,
  ): Promise<EvolutionSignal[]> {
    if (!agentId?.trim()) {
      return [];
    }

    const signalPath = this.signalsPath(agentId);
    if (!existsSync(signalPath)) {
      return [];
    }

    const all = await this.readSignalsFromFile(agentId);
    const filtered = all.filter((signal) => {
      if (filter.outcome && signal.outcome !== filter.outcome) return false;
      if (filter.taskId && signal.taskId !== filter.taskId) return false;
      if (filter.source && signal.source !== filter.source) return false;
      return true;
    });

    return filtered.slice(0, Math.max(0, limit));
  }

  /**
   * Append a versioned artifact. Idempotent: if the artifact for `(agentId, version)` already
   * exists and is published with an unchanged candidate checksum and trial rationale, the existing
   * artifact line is returned without adding a duplicate line.
   */
  async appendArtifact(input: AppendEvolutionArtifactInput): Promise<EvolutionArtifact> {
    if (!input.agentId?.trim()) {
      throw new Error("agentId is required");
    }

    return this.withLock(input.agentId, async () => {
      const existing = await this.getArtifactsUnlocked(input.agentId);
      const nextVersion = existing.length > 0 ? existing[0].version + 1 : 1;

      const last = existing[0];
      if (last) {
        const sameCandidate =
          last.candidate.checksum === input.candidate.checksum &&
          last.trial.rationale === input.trial.rationale;
        if (sameCandidate && last.publishedAt) {
          return last;
        }
      }

      // Redact the artifact at the store boundary (KB-001 Step 8). Every
      // free-text field on the artifact (event.summary, hypothesis, evidence,
      // candidate.changeSummary, candidate.proposedDiff, trial.rationale) passes
      // through `redactEvolutionArtifact` before being persisted. Without this,
      // a hand-crafted candidate could carry a secret into the JSONL.
      const draft: EvolutionArtifact = {
        id: `evolution-artifact-${randomUUID().slice(0, 8)}`,
        version: nextVersion,
        agentId: input.agentId,
        createdAt: input.createdAt ?? new Date().toISOString(),
        trigger: input.trigger,
        event: input.event,
        evidence: input.evidence,
        hypothesis: input.hypothesis,
        candidate: input.candidate,
        trial: input.trial,
        approval: { status: "not-requested" },
        ...(input.lastCycleSummary !== undefined
          ? { lastCycleSummary: input.lastCycleSummary }
          : {}),
      };
      const artifact = redactEvolutionArtifact(draft);

      await writeFile(this.artifactsPath(input.agentId), `${JSON.stringify(artifact)}\n`, { flag: "a" });

      this.emit("evolution:artifact-created", artifact);
      return artifact;
    });
  }

  /**
   * Return the newest signal ids already persisted for an agent. The cycle uses
   * this durable read to make signal dedupe survive process restarts instead of
   * relying only on its in-memory replay set.
   */
  async getSeenSignalIds(agentId: string): Promise<readonly string[]> {
    return (await this.getCycleCursor(agentId))?.seenSignalIds ?? [];
  }

  /** Return the newest artifact's creation time, if this agent has one. */
  async getLastCycleAt(agentId: string): Promise<string | undefined> {
    return (await this.getLatestArtifact(agentId))?.createdAt;
  }

  /** Delete the cycle cursor without touching signals or artifacts. */
  async clearCycleCursor(agentId: string): Promise<void> {
    if (!agentId?.trim()) return;
    await this.withLock(agentId, async () => {
      await this.unlinkIfExists(this.cyclePath(agentId));
    });
  }

  /** Get recent artifacts for an agent (newest first). */
  async getArtifacts(agentId: string, limit = DEFAULT_ARTIFACT_LIMIT): Promise<EvolutionArtifact[]> {
    if (!agentId?.trim()) {
      return [];
    }
    return this.getArtifactsUnlocked(agentId).then((all) => all.slice(0, Math.max(0, limit)));
  }

  /** Get the most recent artifact for an agent. */
  async getLatestArtifact(agentId: string): Promise<EvolutionArtifact | null> {
    const artifacts = await this.getArtifacts(agentId, 1);
    return artifacts[0] ?? null;
  }

  /** Get a specific artifact by version. */
  async getArtifactByVersion(agentId: string, version: number): Promise<EvolutionArtifact | null> {
    const all = await this.getArtifactsUnlocked(agentId);
    return all.find((artifact) => artifact.version === version) ?? null;
  }

  /** Idempotently set the approval state on the latest artifact line. */
  async markApprovalState(agentId: string, version: number, approval: EvolutionApproval): Promise<EvolutionArtifact | null> {
    return this.withLock(agentId, async () => {
      const all = await this.getArtifactsUnlocked(agentId);
      const target = all.find((artifact) => artifact.version === version);
      if (!target) {
        return null;
      }
      if (target.version !== all[0].version) {
        return target;
      }
      const updated: EvolutionArtifact = { ...target, approval };
      return this.rewriteLatestArtifact(agentId, updated);
    });
  }

  /** Idempotently mark the latest artifact published. */
  async markPublished(agentId: string, version: number): Promise<EvolutionArtifact | null> {
    return this.withLock(agentId, async () => {
      const all = await this.getArtifactsUnlocked(agentId);
      const target = all.find((artifact) => artifact.version === version);
      if (!target) return null;
      if (target.version !== all[0].version) return target;
      if (target.publishedAt) return target;
      const updated: EvolutionArtifact = { ...target, publishedAt: new Date().toISOString() };
      return this.rewriteLatestArtifact(agentId, updated);
    });
  }

  /** Idempotently set appliedAt on the latest artifact (only after an approved decision). */
  async markApplied(agentId: string, version: number): Promise<EvolutionArtifact | null> {
    return this.withLock(agentId, async () => {
      const all = await this.getArtifactsUnlocked(agentId);
      const target = all.find((artifact) => artifact.version === version);
      if (!target) return null;
      if (target.version !== all[0].version) return target;
      if (target.appliedAt) return target;
      const updated: EvolutionArtifact = { ...target, appliedAt: new Date().toISOString() };
      return this.rewriteLatestArtifact(agentId, updated);
    });
  }

  /** Delete all persisted signals + artifacts for an agent (test/support helper). */
  async deleteAll(agentId: string): Promise<void> {
    if (!agentId?.trim()) return;

    await this.withLock(agentId, async () => {
      await this.unlinkIfExists(this.signalsPath(agentId));
      await this.unlinkIfExists(this.artifactsPath(agentId));
      await this.unlinkIfExists(this.cyclePath(agentId));
    });
  }

  /**
   * FNXC:EvolutionCycleLease 2026-09-25-10:50:
   * Cross-process claim for one cycle. `withLock` is per-process, so a CLI run and a
   * dashboard/heartbeat run could both read the same cursor, both pass the 4h window
   * check, and both append an artifact for the same agent. An exclusive `wx` create is
   * the atomic primitive the filesystem already gives us, so the claim serializes
   * ACROSS processes without inventing a second locking service.
   *
   * The lease is intentionally time-boxed and self-releasing: a crashed holder must
   * never wedge the agent's evolution lane permanently. A lease older than
   * `staleAfterMs` is treated as abandoned and taken over.
   */
  async claimCycle(agentId: string, options: { holder: string; nowMs: number; staleAfterMs?: number }): Promise<EvolutionCycleClaim> {
    const empty = { claimed: false as const, released: async () => {} };
    if (!agentId?.trim()) return empty;
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_CYCLE_LEASE_STALE_MS;
    await mkdir(this.evolutionDir, { recursive: true });
    const path = this.cycleLeasePath(agentId);
    const payload = `${JSON.stringify({ holder: options.holder, claimedAtMs: options.nowMs })}\n`;

    // Only one process can win the exclusive create; everyone else observes EEXIST.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(path, payload, { flag: "wx" });
        let released = false;
        return {
          claimed: true,
          released: async () => {
            if (released) return;
            released = true;
            await this.unlinkIfExists(path);
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const holder = await this.readCycleLease(path);
        const age = holder ? options.nowMs - holder.claimedAtMs : Number.POSITIVE_INFINITY;
        if (attempt === 0 && (!holder || age > staleAfterMs)) {
          // Abandoned lease from a crashed holder: break it once and retry the claim.
          await this.unlinkIfExists(path);
          continue;
        }
        return { claimed: false, released: empty.released, lastCycleAt: undefined, heldBy: holder?.holder };
      }
    }
    return empty;
  }

  private cycleLeasePath(agentId: string): string {
    return join(this.evolutionDir, `${agentId}-cycle.lock`);
  }

  private async readCycleLease(path: string): Promise<{ holder: string; claimedAtMs: number } | null> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { holder?: unknown; claimedAtMs?: unknown };
      if (typeof parsed.holder !== "string" || typeof parsed.claimedAtMs !== "number") return null;
      return { holder: parsed.holder, claimedAtMs: parsed.claimedAtMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // A truncated/invalid lease reads as absent so a crash mid-write cannot wedge the lane.
      return null;
    }
  }

  /**
   * Atomically replace the cycle cursor after a successful cycle. This is a
   * small metadata file rather than a second signal/artifact history, so the
   * append-only domain records remain unchanged.
   */
  async markCycle(agentId: string, input: { ranAt: string; seenSignalIds: readonly string[] }): Promise<void> {
    if (!agentId?.trim()) return;
    await this.withLock(agentId, async () => {
      await mkdir(this.evolutionDir, { recursive: true });
      const path = this.cyclePath(agentId);
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ ranAt: input.ranAt, seenSignalIds: [...input.seenSignalIds] })}\n`, { flag: "wx" });
      await rename(temporary, path);
    });
  }

  async getCycleCursor(agentId: string): Promise<{ ranAt: string; seenSignalIds: string[] } | null> {
    if (!agentId?.trim()) return null;
    try {
      const parsed = JSON.parse(await readFile(this.cyclePath(agentId), "utf8")) as { ranAt?: unknown; seenSignalIds?: unknown };
      if (typeof parsed.ranAt !== "string") return null;
      return { ranAt: parsed.ranAt, seenSignalIds: Array.isArray(parsed.seenSignalIds) ? parsed.seenSignalIds.filter((id): id is string => typeof id === "string") : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private signalsPath(agentId: string): string {
    return join(this.evolutionDir, `${agentId}-signals.jsonl`);
  }

  private artifactsPath(agentId: string): string {
    return join(this.evolutionDir, `${agentId}-evolution.jsonl`);
  }

  private cyclePath(agentId: string): string {
    return join(this.evolutionDir, `${agentId}-cycle.json`);
  }

  private async getArtifactsUnlocked(agentId: string): Promise<EvolutionArtifact[]> {
    const artifactPath = this.artifactsPath(agentId);
    if (!existsSync(artifactPath)) {
      return [];
    }
    return this.readJsonlLines<EvolutionArtifact>(artifactPath, agentId, "artifact");
  }

  private async readSignalsFromFile(agentId: string): Promise<EvolutionSignal[]> {
    return this.readJsonlLines<EvolutionSignal>(this.signalsPath(agentId), agentId, "signal");
  }

  private async readJsonlLines<T>(path: string, agentId: string, kind: "signal" | "artifact"): Promise<T[]> {
    try {
      const content = await readFile(path, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      const items: T[] = [];
      for (const [index, line] of lines.entries()) {
        try {
          items.push(JSON.parse(line) as T);
        } catch (error) {
          evolutionStoreLog.warn(
            `[EvolutionStore] Skipping malformed ${kind} line ${index + 1} for ${agentId}`,
            error,
          );
        }
      }
      return items.reverse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async rewriteLatestArtifact(agentId: string, latest: EvolutionArtifact): Promise<EvolutionArtifact> {
    const path = this.artifactsPath(agentId);
    const all = await this.readJsonlLines<EvolutionArtifact>(path, agentId, "artifact").then((arr) => arr.reverse());
    // Re-read to reconstruct the lines excluding the last, then rewrite the tail.
    const updated = all.slice(0, -1);
    updated.push(latest);
    await writeFile(path, updated.map((artifact) => JSON.stringify(artifact)).join("\n") + "\n");
    return latest;
  }

  private async unlinkIfExists(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async withLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    let lock = this.locks.get(agentId);
    if (!lock) {
      lock = { promise: Promise.resolve() };
      this.locks.set(agentId, lock);
    }

    const operation = lock.promise.then(fn, fn);
    lock.promise = operation;

    return operation as Promise<T>;
  }
}