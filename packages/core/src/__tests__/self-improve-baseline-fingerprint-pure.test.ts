import { describe, expect, it } from "vitest";
import {
  buildBaselineCacheStatus,
  computeBaselineFingerprint,
  isBaselineFingerprint,
  resolveBaselineCache,
} from "../self-improve/baseline-fingerprint.js";
import type { BaselineFingerprintInput } from "../types/self-improve/baseline-cache.js";

/*
FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
This suite is PURE — no database, no store, no clock. It is the always-on proof of the identity
contract that the whole cache rests on: the fingerprint is deterministic over its four inputs, changes
when any ONE of them changes, and refuses an unattributable identity. A cache whose fingerprint could
collide across corpora, builds, configs, or seeds would silently reuse an incomparable baseline, and
a cached-reuse bug is invisible at runtime — so the invariant is pinned here rather than only
exercised through a database round trip.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
"each single-component change produces a DIFFERENT fingerprint" is asserted by iterating all four
components, not just one. The whole feature is "reuse iff the fingerprint is identical", so a change
to ANY of the four must break it; asserting only `engineSha` changes the digest would leave
manifestVersion/configHash/seed silently excluded from the identity and the bug would ship.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
Seed normalization is asserted BOTH ways (string→same, and a real change→different) because the
string form is the double-counting hazard: if `"42"` hashed differently from `42`, the cache would
rebuild on every alternate call path and never hit. A test that only asserts "42 and '42' differ"
would lock in exactly the bug this rule prevents.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
The resolver is exercised over its full truth table (nothing cached / identical / divergent) and the
status read model is asserted to DERIVE `present` from the cached fingerprint. Those two together
are the operator contract: "may I reuse this, and why" is answerable, and it can never disagree with
itself (a status claiming a baseline exists while reporting `no-cached-baseline` is the contradiction
this derivation removes).
*/

const fingerprintOf = (overrides: Partial<BaselineFingerprintInput> = {}) =>
  computeBaselineFingerprint({
    manifestVersion: "corpus-v1",
    engineSha: "abc1234",
    configHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    seed: 42,
    ...overrides,
  });

describe("computeBaselineFingerprint (deterministic identity over the four measurement inputs)", () => {
  it("is identical for identical inputs", () => {
    expect(fingerprintOf()).toBe(fingerprintOf());
    // Independent literal re-statement of the same inputs: determinism is across CALLS, not just a
    // memoized variable. Two separately-constructed inputs with the same values must agree.
    expect(fingerprintOf({ manifestVersion: "corpus-v1", engineSha: "abc1234", seed: 42 }))
      .toBe(fingerprintOf({ manifestVersion: "corpus-v1", engineSha: "abc1234", seed: 42 }));
  });

  it("produces a well-formed sha256:<hex> fingerprint", () => {
    const fp = fingerprintOf();
    expect(isBaselineFingerprint(fp)).toBe(true);
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when ANY single component changes", () => {
    const base = fingerprintOf();
    // manifestVersion, engineSha, configHash, and seed are ALL covered by the identity.
    expect(fingerprintOf({ manifestVersion: "corpus-v2" })).not.toBe(base);
    expect(fingerprintOf({ engineSha: "def5678" })).not.toBe(base);
    expect(fingerprintOf({ configHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222" })).not.toBe(base);
    expect(fingerprintOf({ seed: 43 })).not.toBe(base);
  });

  it("normalizes seed so the string form equals the numeric form, but a real change still differs", () => {
    // A manifest carrying "42" and a runtime passing 42 are ONE measurement → same fingerprint.
    expect(fingerprintOf({ seed: "42" })).toBe(fingerprintOf({ seed: 42 }));
    // …while a genuinely different seed is a different measurement → different fingerprint.
    expect(fingerprintOf({ seed: "43" })).not.toBe(fingerprintOf({ seed: 42 }));
  });

  it("truncates a fractional seed so it matches its integer form", () => {
    expect(fingerprintOf({ seed: 42.7 })).toBe(fingerprintOf({ seed: 42 }));
  });

  it("refuses a blank identity field and a non-numeric seed", () => {
    expect(() => fingerprintOf({ manifestVersion: "" })).toThrow(/manifestVersion/);
    expect(() => fingerprintOf({ manifestVersion: "   " })).toThrow(/manifestVersion/);
    expect(() => fingerprintOf({ engineSha: "" })).toThrow(/engineSha/);
    expect(() => fingerprintOf({ configHash: "" })).toThrow(/configHash/);
    // A non-numeric seed is refused rather than hashed as 0 — it would attribute the measurement to
    // a seed it was not run with.
    expect(() => fingerprintOf({ seed: "not-a-seed" })).toThrow(/numeric seed/);
    // Zero is a legitimate seed and must NOT be refused.
    expect(fingerprintOf({ seed: 0 })).toBe(fingerprintOf({ seed: "0" }));
  });

  it("refuses a config hash that is blank even though it is sha256-shaped when populated", () => {
    expect(fingerprintOf({ configHash: "sha256:1" })).not.toBe(fingerprintOf());
    expect(() => fingerprintOf({ configHash: " " })).toThrow(/configHash/);
  });
});

describe("resolveBaselineCache (reuse/rebuild over the full truth table)", () => {
  const fp = fingerprintOf();

  it("reuses when the cached fingerprint is identical (fingerprint-matched)", () => {
    expect(resolveBaselineCache({ cachedFingerprint: fp, requestedFingerprint: fp }))
      .toEqual({ action: "reuse", reason: "fingerprint-matched" });
  });

  it("rebuilds when nothing is cached (no-cached-baseline)", () => {
    expect(resolveBaselineCache({ cachedFingerprint: null, requestedFingerprint: fp }))
      .toEqual({ action: "rebuild", reason: "no-cached-baseline" });
  });

  it("rebuilds when the cached fingerprint diverges in exactly one component (fingerprint-diverged)", () => {
    const otherEngine = fingerprintOf({ engineSha: "def5678" });
    expect(resolveBaselineCache({ cachedFingerprint: otherEngine, requestedFingerprint: fp }))
      .toEqual({ action: "rebuild", reason: "fingerprint-diverged" });
  });

  it("refuses a malformed requested fingerprint and a malformed cached fingerprint", () => {
    expect(() => resolveBaselineCache({ cachedFingerprint: null, requestedFingerprint: "not-a-digest" }))
      .toThrow(/requestedFingerprint/);
    // A drifted cached row is an error, not a silent cache miss — rebuilding over it would hide the
    // drift that produced it.
    expect(() => resolveBaselineCache({ cachedFingerprint: "garbage", requestedFingerprint: fp }))
      .toThrow(/malformed/);
  });
});

describe("buildBaselineCacheStatus (the operator read model fn_selfimprove_status renders)", () => {
  const fp = fingerprintOf();

  it("reports reuse with the requested and cached fingerprints agreeing and present=true", () => {
    const status = buildBaselineCacheStatus({ baselineKey: "baseline-1", cachedFingerprint: fp, requestedFingerprint: fp });
    expect(status).toEqual({
      baselineKey: "baseline-1",
      inputFingerprint: fp,
      cachedFingerprint: fp,
      present: true,
      action: "reuse",
      reason: "fingerprint-matched",
    });
  });

  it("reports rebuild+diverged when the cached fingerprint differs, keeping both fingerprints visible", () => {
    const otherEngine = fingerprintOf({ engineSha: "def5678" });
    const status = buildBaselineCacheStatus({ baselineKey: "baseline-1", cachedFingerprint: otherEngine, requestedFingerprint: fp });
    expect(status).toMatchObject({
      present: true,
      action: "rebuild",
      reason: "fingerprint-diverged",
      // Both fingerprints are surfaced so the operator can SEE which component moved.
      inputFingerprint: fp,
      cachedFingerprint: otherEngine,
    });
  });

  it("reports rebuild+no-cached-baseline with present=false when nothing is cached", () => {
    const status = buildBaselineCacheStatus({ baselineKey: "baseline-1", cachedFingerprint: null, requestedFingerprint: fp });
    expect(status).toMatchObject({ present: false, action: "rebuild", reason: "no-cached-baseline", cachedFingerprint: null });
  });

  it("derives present from the cached fingerprint so it can never disagree with the reason", () => {
    // present is not an independent input; a status cannot claim a baseline exists while reporting
    // no-cached-baseline. buildBaselineCacheStatus takes no `present` argument precisely to make
    // that contradiction unrepresentable.
    const absent = buildBaselineCacheStatus({ baselineKey: "b", cachedFingerprint: null, requestedFingerprint: fp });
    expect(absent.present).toBe(false);
    expect(absent.reason).toBe("no-cached-baseline");
  });

  it("refuses a blank baseline key", () => {
    expect(() => buildBaselineCacheStatus({ baselineKey: "  ", cachedFingerprint: null, requestedFingerprint: fp }))
      .toThrow(/baselineKey/);
  });
});
