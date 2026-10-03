import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SELF_IMPROVE_BASELINE_CACHE_AGENT_ID,
  SELF_IMPROVE_BASELINE_CACHE_EVENT,
  emitSelfImproveBaselineCacheResolved,
} from "../self-improve/self-improve-baseline-cache-run-audit.js";
import {
  buildBaselineCacheStatus,
  computeBaselineFingerprint,
} from "../self-improve/baseline-fingerprint.js";
import { CORE_RUN_AUDIT_EMIT_TIMEOUT_MS, type RunAuditSinkHost } from "../run-audit/emit-bounded-run-audit.js";
import type { RunAuditEventInput } from "../types/audit/run-audit.js";
import type { BaselineFingerprintInput } from "../types/self-improve/baseline-cache.js";

/*
FNXC:SelfImproveBaselineCacheRunAudit 2026-09-30-18:53:
The façade inherits hostile-sink tolerance from the bounded core seam STRUCTURALLY, but the seam's own
suite exercises the generic helper with synthetic events, not this façade with a real resolution
projection. This suite closes that gap: the reuse/rebuild decision the caller already holds must be
COMPLETELY UNCHANGED whether the sink is absent, throwing, rejecting, hung, or late — that is the
invariant that lets a loop reuse a cached baseline on its deterministic fingerprint rather than on
whether telemetry was healthy. Each mode asserts the status object is deep-equal to the
pre-emission copy AND that the emission resolves without rejecting.

FNXC:SelfImproveBaselineCacheRunAudit 2026-09-30-18:53:
The measured PAYLOAD is the thing this audit edge must never carry, so the containment proof plants a
multi-line payload/diff/log onto the façade input (via a cast, simulating a caller that grows one
field) and asserts neither the values nor their keys reach the captured event. A baseline payload is
an opaque measured blob that may contain corpus contents and command output; the fingerprint, never
the payload, is what governs reuse, so what must stay observable is WHICH fingerprint is in play.
A spreading implementation would leak it the moment `BaselineCacheStatus` grew a field, which is why
the metadata is asserted as an EXACT closed key list rather than by spot checks.

FNXC:SelfImproveBaselineCacheRunAudit 2026-09-30-18:53:
Both outcomes are exercised — reuse and rebuild — across the three fixed reasons, because the reason
vocabulary is the operator's only way to count why comparisons were refused. A façade that recorded
`reuse` correctly but mangled `fingerprint-diverged` (the whole point of the event) would still pass a
single-mode suite.
*/

const PROJECT_ID = "self-improve-baseline-sink-health";
const BASELINE_KEY = "baseline-1";
const OCCURRED_AT = "2026-09-30T14:00:00.000Z";

const fingerprintInput = (overrides: Partial<BaselineFingerprintInput> = {}): BaselineFingerprintInput => ({
  manifestVersion: "corpus-v1",
  engineSha: "abc1234",
  configHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  seed: 42,
  ...overrides,
});

/** A distinctive multi-line payload planted in narrative-bearing input slots; it must never be observed. */
const PLANTED_PROSE = "PLANTED-PROSE-must-never-reach-run-audit\n{\"corpus\":\"fixtures/a.ts\"}\n--- a/x.ts\n+++ b/x.ts\n-secret-line";

const narrativeExtras = {
  payload: PLANTED_PROSE,
  diff: PLANTED_PROSE,
  log: PLANTED_PROSE,
  measurement: PLANTED_PROSE,
  output: PLANTED_PROSE,
} as const;

type Captured = { events: RunAuditEventInput[]; host: RunAuditSinkHost };

function healthyHost(): Captured {
  const events: RunAuditEventInput[] = [];
  return { events, host: { recordRunAuditEvent: (event: RunAuditEventInput) => { events.push(event); } } };
}
function absentHost(): Captured {
  return { events: [], host: {} };
}
function throwingHost(): Captured {
  return { events: [], host: { recordRunAuditEvent: () => { throw new Error(PLANTED_PROSE); } } };
}
function rejectingHost(): Captured {
  return { events: [], host: { recordRunAuditEvent: () => Promise.reject(new Error(PLANTED_PROSE)) } };
}
function neverSettlingHost(): Captured {
  return { events: [], host: { recordRunAuditEvent: () => new Promise<never>(() => { /* never settles */ }) } };
}
function lateSettlingHost(): Captured {
  const events: RunAuditEventInput[] = [];
  return {
    events,
    host: {
      recordRunAuditEvent: (event: RunAuditEventInput) =>
        new Promise<void>((resolve) => {
          setTimeout(() => { events.push(event); resolve(); }, CORE_RUN_AUDIT_EMIT_TIMEOUT_MS + 10);
        }),
    },
  };
}

const SINK_MODES = [
  ["absent", absentHost],
  ["throwing", throwingHost],
  ["rejecting", rejectingHost],
  ["never-settling", neverSettlingHost],
  ["late-settling", lateSettlingHost],
  ["healthy", healthyHost],
] as const;

/** A real resolver output for the given cached fingerprint, so the façade is driven by a genuine decision. */
const statusFor = (cachedFingerprint: string | null, overrides: Partial<BaselineFingerprintInput> = {}) =>
  buildBaselineCacheStatus({
    baselineKey: BASELINE_KEY,
    cachedFingerprint,
    requestedFingerprint: computeBaselineFingerprint(fingerprintInput(overrides)),
  });

const REUSE = statusFor(computeBaselineFingerprint(fingerprintInput()));
const REBUILD_ABSENT = statusFor(null);
const REBUILD_DIVERGED = statusFor(computeBaselineFingerprint(fingerprintInput({ engineSha: "def5678" })));

describe("selfimprove:baseline-cache-resolved sink health (bounded seam across every sink mode)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe.each(SINK_MODES)("sink mode: %s", (_mode, makeHost) => {
    // The hung modes only release the façade once the seam's own timeout fires; the seam's timeout is
    // a real setTimeout, so every mode advances the fake clock past it before awaiting. For the
    // immediately-resolving modes this is a no-op; for the hung modes it proves the time-box works.
    const settle = async (promise: Promise<void>) => {
      await vi.advanceTimersByTimeAsync(CORE_RUN_AUDIT_EMIT_TIMEOUT_MS + 5);
      await expect(promise).resolves.toBeUndefined();
    };

    it.each([
      ["reuse", REUSE],
      ["rebuild+absent", REBUILD_ABSENT],
      ["rebuild+diverged", REBUILD_DIVERGED],
    ])("emits without rejecting and leaves the caller's %s resolution unchanged", async (_name, status) => {
      const { host } = makeHost();
      const before = structuredClone(status);

      await settle(emitSelfImproveBaselineCacheResolved({ host, status }));

      // The reuse/rebuild decision the caller already holds is untouched by the sink's health.
      expect(status).toEqual(before);
    });
  });

  describe("closed metadata list (ids/fixed outcomes only — no payload, no diff, no log prose)", () => {
    it("records exactly the documented field list", async () => {
      const { events, host } = healthyHost();
      await emitSelfImproveBaselineCacheResolved({ host, status: REBUILD_DIVERGED, projectId: PROJECT_ID, timestamp: OCCURRED_AT });

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.mutationType).toBe(SELF_IMPROVE_BASELINE_CACHE_EVENT);
      expect(Object.keys(event.metadata!).sort()).toEqual(
        [
          "action",
          "baselineKey",
          "cachedFingerprint",
          "inputFingerprint",
          "present",
          "projectId",
          "reason",
        ].sort(),
      );
      expect(event.metadata).toMatchObject({
        baselineKey: BASELINE_KEY,
        action: "rebuild",
        reason: "fingerprint-diverged",
        present: true,
        projectId: PROJECT_ID,
      });
      // Both fingerprints are recorded so a reader can see WHICH measurement is cached vs requested.
      expect(event.metadata!.inputFingerprint).toBe(computeBaselineFingerprint(fingerprintInput()));
      expect(event.metadata!.cachedFingerprint).toBe(computeBaselineFingerprint(fingerprintInput({ engineSha: "def5678" })));
    });

    it("never includes payload, diff, or log prose, and no metadata value is multi-line", async () => {
      const { events, host } = healthyHost();
      await emitSelfImproveBaselineCacheResolved({
        host,
        status: REUSE,
        ...narrativeExtras,
      } as never);

      expect(events).toHaveLength(1);
      const event = events[0];
      // Neither the planted values nor their keys may appear anywhere in the event.
      expect(JSON.stringify(event)).not.toContain(PLANTED_PROSE);
      expect(JSON.stringify(event)).not.toContain("secret-line");
      expect(JSON.stringify(event)).not.toContain("fixtures/a.ts");
      for (const key of ["payload", "diff", "log", "measurement", "output"]) {
        expect(event.metadata).not.toHaveProperty(key);
        expect(Object.keys(event.metadata!)).not.toContain(key);
      }
      // No metadata value may be a multi-line string.
      for (const value of Object.values(event.metadata!)) {
        if (typeof value === "string") {
          expect(value).not.toContain("\n");
        }
      }
    });

    it("records reuse and the no-cached-baseline rebuild with their fixed reasons", async () => {
      const { events, host } = healthyHost();
      await emitSelfImproveBaselineCacheResolved({ host, status: REUSE });
      await emitSelfImproveBaselineCacheResolved({ host, status: REBUILD_ABSENT });

      expect(events.map((e) => e.metadata)).toMatchObject([
        { action: "reuse", reason: "fingerprint-matched", present: true, cachedFingerprint: expect.any(String) },
        { action: "rebuild", reason: "no-cached-baseline", present: false, cachedFingerprint: null },
      ]);
    });

    it("uses a stable per-baseline run id and the fixed system principal", async () => {
      const { events, host } = healthyHost();
      await emitSelfImproveBaselineCacheResolved({ host, status: REUSE });
      await emitSelfImproveBaselineCacheResolved({ host, status: REBUILD_DIVERGED });

      expect(events.map((e) => e.runId)).toEqual([
        `selfimprove-baseline-${BASELINE_KEY}`,
        `selfimprove-baseline-${BASELINE_KEY}`,
      ]);
      expect(events.every((e) => e.agentId === SELF_IMPROVE_BASELINE_CACHE_AGENT_ID)).toBe(true);
      // A baseline cache entry belongs to no task column.
      expect(events.every((e) => e.taskId === undefined)).toBe(true);
      expect(events.every((e) => e.target === BASELINE_KEY)).toBe(true);
    });

    it("refuses a status carrying an unknown action/reason pair instead of emitting it", async () => {
      const { events, host } = healthyHost();
      // A status outside the closed vocabulary is a CALLER programming error, not a sink-health
      // condition, so the façade rejects it synchronously rather than emitting an outcome the
      // resolver would never produce. The "never throws" contract covers SINK health; this is an
      // input assertion and is deliberately loud.
      expect(() => emitSelfImproveBaselineCacheResolved({
        host,
        status: { ...REUSE, action: "maybe" },
      } as never)).toThrow(/action\/reason/);
      expect(events).toHaveLength(0);
    });
  });
});
