/*
 * FNXC:FallbackModelList 2026-09-04-00:00:
 * Unit tests for the GDPR-001 ordered fallback-model list parser. The parser
 * is the single source of truth shared by the engine fallback loop and the
 * dashboard read-side renderers; these tests lock the parsing contract
 * (newline-separated `provider:modelId[:thinkingLevel]`, malformed-line
 * tolerance, CRLF tolerance, optional thinking level) and the chain-skip
 * classifier (rate-limit + transient-auth → skip-to-next, others → bubble).
 */
import { describe, it, expect } from "vitest";

import {
  parseFallbackModelList,
  fallbackEntries,
  isFallbackChainSkipError,
} from "../util/fallback-model-list.js";

describe("parseFallbackModelList", () => {
  it("returns an empty list for null, undefined, and non-string inputs (never throws)", () => {
    for (const v of [null, undefined, 42, true, {}, []]) {
      const result = parseFallbackModelList(v as never);
      expect(result.entries).toEqual([]);
      expect(result.malformedCount).toBe(0);
    }
  });

  it("returns an empty list for an empty string", () => {
    const result = parseFallbackModelList("");
    expect(result.entries).toEqual([]);
    expect(result.malformedCount).toBe(0);
  });

  it("parses a single `provider:modelId` line", () => {
    const result = parseFallbackModelList("openrouter:anthropic/claude-3.5-sonnet");
    expect(result.entries).toEqual([{ provider: "openrouter", modelId: "anthropic/claude-3.5-sonnet" }]);
    expect(result.malformedCount).toBe(0);
  });

  it("parses a single `provider:modelId:thinkingLevel` line", () => {
    const result = parseFallbackModelList("openrouter:anthropic/claude-3.5-sonnet:high");
    expect(result.entries).toEqual([{ provider: "openrouter", modelId: "anthropic/claude-3.5-sonnet", thinkingLevel: "high" }]);
    expect(result.malformedCount).toBe(0);
  });

  it("preserves input order across multiple lines", () => {
    const raw = [
      "openrouter:anthropic/claude-3.5-sonnet",
      "clinefree:z-ai/glm-5.3-flash",
      "tokenrouter:google/gemini-2.5-flash:medium",
    ].join("\n");
    const result = parseFallbackModelList(raw);
    expect(result.entries.map((e) => e.provider)).toEqual([
      "openrouter", "clinefree", "tokenrouter",
    ]);
    expect(result.malformedCount).toBe(0);
  });

  it("ignores blank lines and trims whitespace", () => {
    const raw = "\n  openrouter:anthropic/claude-3.5-sonnet  \n\n  \n  clinefree:z-ai/glm-5.3-flash  \n";
    const result = parseFallbackModelList(raw);
    expect(result.entries).toEqual([
      { provider: "openrouter", modelId: "anthropic/claude-3.5-sonnet" },
      { provider: "clinefree", modelId: "z-ai/glm-5.3-flash" },
    ]);
    expect(result.malformedCount).toBe(0);
  });

  it("tolerates CRLF line endings (Windows-pasted text)", () => {
    const raw = "openrouter:anthropic/claude-3.5-sonnet\r\nclinefree:z-ai/glm-5.3-flash";
    const result = parseFallbackModelList(raw);
    expect(result.entries).toHaveLength(2);
  });

  it("skips malformed lines (wrong segment count) and reports the count", () => {
    const result = parseFallbackModelList(
      "openrouter:anthropic/claude-3.5-sonnet\nno-colons-here\nfour:segment:line:is:bad",
    );
    expect(result.entries).toEqual([{ provider: "openrouter", modelId: "anthropic/claude-3.5-sonnet" }]);
    expect(result.malformedCount).toBe(2);
  });

  it("skips lines with empty provider or model id", () => {
    const result = parseFallbackModelList(":anthropic/claude-3.5-sonnet\nopenrouter:");
    expect(result.entries).toEqual([]);
    expect(result.malformedCount).toBe(2);
  });

  it("skips a line with a trailing colon and empty thinking level", () => {
    const result = parseFallbackModelList("openrouter:anthropic/claude-3.5-sonnet:");
    expect(result.entries).toEqual([]);
    expect(result.malformedCount).toBe(1);
  });

  it("preserves the empty thinkingLevel as undefined when omitted", () => {
    const result = parseFallbackModelList("openrouter:anthropic/claude-3.5-sonnet");
    expect(result.entries[0].thinkingLevel).toBeUndefined();
  });

  it("preserves the empty thinkingLevel as undefined when only whitespace is provided", () => {
    const result = parseFallbackModelList("openrouter:anthropic/claude-3.5-sonnet:   ");
    expect(result.entries).toEqual([]);
    expect(result.malformedCount).toBe(1);
  });

  it("handles the GDPR-001 planning-lane spec (an openrouter free model fallback)", () => {
    const result = parseFallbackModelList("openrouter:minimax/minimax-m3-free");
    expect(result.entries).toEqual([{ provider: "openrouter", modelId: "minimax/minimax-m3-free" }]);
  });
});

describe("fallbackEntries (convenience wrapper)", () => {
  it("returns just the entries, omitting the malformed count", () => {
    const entries = fallbackEntries("openrouter:a\nbad\nclinefree:b");
    expect(entries).toEqual([
      { provider: "openrouter", modelId: "a" },
      { provider: "clinefree", modelId: "b" },
    ]);
  });
});

describe("isFallbackChainSkipError", () => {
  it("classifies a rate-limit error as a skip signal", () => {
    expect(isFallbackChainSkipError(new Error("rate limit exceeded (429)"))).toBe(true);
    expect(isFallbackChainSkipError(new Error("HTTP 429 too many requests"))).toBe(true);
    expect(isFallbackChainSkipError(new Error("anthropic API quota exceeded for this account"))).toBe(true);
  });

  it("classifies a transient auth error as a skip signal", () => {
    expect(isFallbackChainSkipError(new Error('{"type":"authentication_error","message":"token expired"}'))).toBe(true);
    expect(isFallbackChainSkipError(new Error("invalid authentication credentials"))).toBe(true);
  });

  it("returns false for a context-limit error (not skip; should bubble)", () => {
    expect(isFallbackChainSkipError(new Error("context length exceeded"))).toBe(false);
  });

  it("returns false for a generic provider error (not skip; should bubble)", () => {
    expect(isFallbackChainSkipError(new Error("provider returned 500"))).toBe(false);
  });

  it("returns false for non-Error, non-string inputs", () => {
    expect(isFallbackChainSkipError(null)).toBe(false);
    expect(isFallbackChainSkipError(undefined)).toBe(false);
    expect(isFallbackChainSkipError(42)).toBe(false);
    expect(isFallbackChainSkipError({ message: "rate limit" })).toBe(false);
  });

  it("accepts a string error directly", () => {
    expect(isFallbackChainSkipError("rate limit 429")).toBe(true);
  });
});
