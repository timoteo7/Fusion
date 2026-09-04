/*
 * GDPR-001 — ordered fallback-model list parser.
 *
 * FNXC:FallbackModelList 2026-09-04-00:00:
 * Per-lane fallback lists are stored as `type: "text"` workflow settings because the
 * settings type system (`validateValue` in `packages/core/src/workflows/workflow-settings.ts`)
 * only accepts string/text/number/boolean/enum/multi-enum; an array-of-objects would be
 * rejected by the never-exhaustiveness default. The serialized value is a newline-separated
 * ordered list, one entry per line, format `provider:modelId[:thinkingLevel]`. The third
 * colon-separated field is the optional per-entry thinking level. Order is preserved; blank
 * lines are ignored; malformed lines are skipped with a single bounded warning per call
 * (NEVER raise — a resilience setting must not wedge session creation).
 *
 * This helper is the single source of truth for parsing, shared by the engine fallback
 * loop (`packages/engine/src/pi.ts`) and the dashboard read-side renderers
 * (`packages/dashboard/app/components/workflow-setting-display.ts` and
 * `effective-model-resolution.ts`). Keep it a pure function with no I/O so it can be
 * imported by either runtime and unit-tested without setting up engine state.
 *
 * FNXC:FallbackModelList 2026-09-04-00:01:
 * The chain loop runs ONE attempt per entry (the binding per-level single-attempt
 * semantics). On a rate-limit (`isUsageLimitError`) or transient auth failure
 * (`isTransientAuthCredentialError`) the loop SKIPS to the next entry without sleeping
 * — these are the same conditions `withRateLimitRetry` already classifies, and the
 * skip is what makes an ordered list different from "the same model with 30s backoff".
 * Any other error bubbles immediately. The primary attempt is the engine's pre-existing
 * `withRateLimitRetry`-guarded prompt path, so a primary prompt is the loop's entry
 * condition; only the fallback path is new.
 */

import { isUsageLimitError } from "../errors/usage-limit-detector.js";
import { isTransientAuthCredentialError } from "../errors/transient-error-detector.js";

export interface FallbackModelEntry {
  /** Provider id (e.g. "openrouter", "clinefree", "tokenrouter"). */
  provider: string;
  /** Model id within the provider (e.g. "anthropic/claude-3.5-sonnet"). */
  modelId: string;
  /** Optional per-entry thinking level (e.g. "high", "low", "medium"). */
  thinkingLevel?: string;
}

/** Shape returned alongside parsed entries so callers can surface a bounded warning. */
export interface ParseFallbackModelListResult {
  /** Valid entries in input order. */
  entries: FallbackModelEntry[];
  /** Count of lines that were skipped as malformed (for diagnostic logging). */
  malformedCount: number;
}

/**
 * Parse the serialized fallback-model list. Pure function; never throws.
 *
 * @param raw - The serialized value (null/undefined/empty/whitespace → empty result).
 * @returns Parsed entries in input order plus a malformed-line counter.
 */
export function parseFallbackModelList(raw: string | null | undefined): ParseFallbackModelListResult {
  if (typeof raw !== "string") {
    return { entries: [], malformedCount: 0 };
  }
  // Tolerate CRLF line endings.
  const lines = raw.split(/\r?\n/);
  const entries: FallbackModelEntry[] = [];
  let malformedCount = 0;
  for (const originalLine of lines) {
    const line = originalLine.trim();
    if (line.length === 0) continue;
    const segments = line.split(":");
    if (segments.length < 2 || segments.length > 3) {
      malformedCount++;
      continue;
    }
    const provider = segments[0].trim();
    const modelId = segments[1].trim();
    const thinkingLevel = segments.length === 3 ? segments[2].trim() : undefined;
    if (provider.length === 0 || modelId.length === 0) {
      malformedCount++;
      continue;
    }
    // Reject an empty thinkingLevel slot (e.g. "provider:model:") — that line is malformed.
    if (segments.length === 3 && (thinkingLevel === undefined || thinkingLevel.length === 0)) {
      malformedCount++;
      continue;
    }
    entries.push({ provider, modelId, ...(thinkingLevel ? { thinkingLevel } : {}) });
  }
  return { entries, malformedCount };
}

/**
 * Convenience wrapper that returns just the entries. Equivalent to
 * `parseFallbackModelList(raw).entries`; prefer this when the malformed count is
 * not needed (e.g. test fixtures, dashboard rendering).
 */
export function fallbackEntries(raw: string | null | undefined): FallbackModelEntry[] {
  return parseFallbackModelList(raw).entries;
}

/**
 * Classify a thrown error as a chain-skip signal — the same conditions
 * `withRateLimitRetry` already treats as a backoff / short-retry trigger.
 * On a skip signal the chain loop advances to the next entry WITHOUT sleeping;
 * a non-skip error bubbles immediately (the loop stops).
 *
 * This is deliberately the same predicate as the legacy single-pair fallback
 * path uses, so behavior is consistent across the two shapes.
 */
export function isFallbackChainSkipError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!message) return false;
  return isUsageLimitError(message) || isTransientAuthCredentialError(message);
}

