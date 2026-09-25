/**
 * FNXC:EvolutionSignalCapture 2026-09-25-10:00:
 * GDPR-075 requires every production task finalization to feed a privacy-safe
 * EvolutionSignal without mining prompts or making task completion depend on
 * best-effort telemetry. This module owns the narrow projection, redaction, and
 * at-most-once persistence seam used by the existing finalization callback.
 */
import type { Agent, Task } from "@fusion/core";
import {
  redactSecrets,
  type CreateEvolutionSignalInput,
  type EvolutionFailureCategory,
  type EvolutionSignal,
  type EvolutionSignalSource,
  type EvolutionReviewVerdict,
} from "@fusion/core";

/** Minimal store seam; the production caller supplies the real EvolutionStore. */
export interface EvolutionSignalCaptureStore {
  createSignal(input: CreateEvolutionSignalInput): Promise<EvolutionSignal>;
}

export interface TaskEvolutionSignalCaptureInput {
  task: Task;
  agent: Agent;
  startedAtMs?: number;
}

export interface TaskEvolutionSignalCaptureResult {
  signal: EvolutionSignal | null;
  deduplicated: boolean;
}

export interface TaskEvolutionSignalCaptureOptions {
  store: EvolutionSignalCaptureStore;
  now?: () => number;
  onError?: (error: unknown) => void;
}

const MAX_FEEDBACK_CHARS = 2_000;
const ATTEMPTS_IN_MEMORY = 1_000;

function safeErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message;
    return String(error);
  } catch {
    return "Unknown Evolution signal capture error";
  }
}

function aggregateTaskTokens(task: Task): number | undefined {
  const input = typeof task.tokenUsage?.inputTokens === "number" && Number.isFinite(task.tokenUsage.inputTokens)
    ? task.tokenUsage.inputTokens
    : 0;
  const output = typeof task.tokenUsage?.outputTokens === "number" && Number.isFinite(task.tokenUsage.outputTokens)
    ? task.tokenUsage.outputTokens
    : 0;
  const total = input + output;
  return total > 0 ? Math.floor(total) : undefined;
}

function failureCategory(task: Task): EvolutionFailureCategory {
  if (task.status === "timeout" || task.column === "timeout") return "timeout";
  const error = task.error?.toLowerCase() ?? "";
  if (error.includes("typecheck")) return "typecheck-failure";
  if (error.includes("lint") || error.includes("eslint")) return "lint-failure";
  if (error.includes("test failed") || error.includes("test failure")) return "test-failure";
  if (error.includes("build failed") || error.includes("build failure")) return "build-failure";
  if (error.includes("merge failed") || error.includes("merge conflict")) return "merge-failure";
  return "unknown";
}

type ReviewAwareTask = Task & {
  reviewVerdict?: string;
  humanFeedback?: string;
  review?: { decision?: string; summary?: string };
  reviewState?: { summary?: { verdict?: string; reviewDecision?: string; summary?: string } };
};

function reviewVerdict(task: ReviewAwareTask): EvolutionReviewVerdict | undefined {
  const value = task.reviewVerdict
    ?? task.review?.decision
    ?? task.reviewState?.summary?.verdict
    ?? task.reviewState?.summary?.reviewDecision;
  if (value === "approved" || value === "APPROVED") return "approved";
  if (value === "rejected" || value === "REJECTED") return "rejected";
  if (value === "revision-requested" || value === "REVISE" || value === "CHANGES_REQUESTED") return "revision-requested";
  return undefined;
}

function qualityScore(verdict: EvolutionReviewVerdict | undefined): number | undefined {
  if (verdict === "approved") return 1;
  if (verdict === "revision-requested") return 0.5;
  if (verdict === "rejected") return 0;
  return undefined;
}

/**
 * Capture one production execution/review signal. A bounded process-local key
 * prevents callback replay from duplicating the append-only signal row; the
 * stable task+attempt key is also returned for durable callers that choose to
 * record it in their execution metadata.
 */
export function createTaskEvolutionSignalCapture(options: TaskEvolutionSignalCaptureOptions): (
  input: TaskEvolutionSignalCaptureInput,
) => Promise<TaskEvolutionSignalCaptureResult> {
  const now = options.now ?? Date.now;
  const recentKeys = new Set<string>();
  const recentKeyOrder: string[] = [];

  return async ({ task, agent, startedAtMs }: TaskEvolutionSignalCaptureInput) => {
    const reviewAwareTask = task as ReviewAwareTask;
    const key = [task.id, task.updatedAt, task.status, task.column, reviewAwareTask.reviewVerdict ?? ""].join(":");
    if (recentKeys.has(key)) return { signal: null, deduplicated: true };
    recentKeys.add(key);
    recentKeyOrder.push(key);
    if (recentKeyOrder.length > ATTEMPTS_IN_MEMORY) {
      const oldest = recentKeyOrder.shift();
      if (oldest) recentKeys.delete(oldest);
    }

    const verdict = reviewVerdict(reviewAwareTask);
    const failed = task.status === "error" || task.status === "failed" || task.status === "timeout" || verdict === "rejected" || verdict === "revision-requested";
    const reviewed = Boolean(verdict) || task.column === "in-review";
    const source: EvolutionSignalSource = reviewed ? "review" : "execution";
    const rawFeedback = reviewAwareTask.humanFeedback
      ?? reviewAwareTask.review?.summary
      ?? reviewAwareTask.reviewState?.summary?.summary;
    const feedback = typeof rawFeedback === "string" && rawFeedback.trim()
      ? redactSecrets(rawFeedback.trim().slice(0, MAX_FEEDBACK_CHARS))
      : undefined;
    const durationMs = typeof startedAtMs === "number" && Number.isFinite(startedAtMs)
      ? Math.max(0, Math.floor(now() - startedAtMs))
      : undefined;

    try {
      const signal = await options.store.createSignal({
        agentId: agent.id,
        taskId: task.id,
        outcome: failed ? "failure" : "success",
        source,
        ...(qualityScore(verdict) !== undefined ? { qualityScore: qualityScore(verdict) } : {}),
        ...(verdict ? { reviewVerdict: verdict } : {}),
        ...(aggregateTaskTokens(task) !== undefined ? { costTokens: aggregateTaskTokens(task) } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(failed ? { failureCategory: failureCategory(task) } : {}),
        ...(feedback ? { humanFeedback: feedback } : {}),
      });
      return { signal, deduplicated: false };
    } catch (error) {
      options.onError?.(new Error(`Evolution signal capture failed: ${safeErrorMessage(error)}`));
      return { signal: null, deduplicated: false };
    }
  };
}
