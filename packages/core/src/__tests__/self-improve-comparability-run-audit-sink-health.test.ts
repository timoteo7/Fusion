import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateComparability } from "../self-improve/comparability-guard.js";
import {
  SELF_IMPROVE_AUDIT_AGENT_ID,
  SELF_IMPROVE_RUN_AUDIT_EVENTS,
  emitSelfImproveComparabilityRefused,
} from "../self-improve/self-improve-run-audit.js";
import { CORE_RUN_AUDIT_EMIT_TIMEOUT_MS, type RunAuditSinkHost } from "../run-audit/emit-bounded-run-audit.js";
import type { RunAuditEventInput } from "../types/audit/run-audit.js";
import type { ComparabilityIdentity } from "../self-improve/comparability-types.js";

/*
FNXC:SelfImproveComparability 2026-09-30-19:55:
This suite proves the refusal is NON-LOAD-BEARING and was decided BEFORE the emit was attempted. The
verdict object a caller already holds must be COMPLETELY UNCHANGED whether the sink is absent,
throwing, rejecting, never-settling, or late-settling — that is the invariant that lets a replay
experiment be judged on its deterministic comparability verdict rather than on whether telemetry was
healthy. Each mode asserts the verdict is deep-equal to the pre-emission copy AND the emission
resolves without rejecting. Because the guard is pure, the verdict is fully determined BEFORE the
façade is called, so no sink condition can soften, delay, or reverse the stop: the emission is
fire-and-forget on top of an already-decided refusal.

FNXC:SelfImproveComparability 2026-09-30-19:55:
The metadata assertions are the prose-containment proof. The façade is called with a planted
multi-line `diff`, `command`, `log`, `output`, and `rationale` smuggled in as extra properties (via a
cast, simulating a caller that grows one). The captured event must contain NEITHER the values NOR the
keys, and no metadata value may be a multi-line string. This is what keeps the audit edge safe: a diff
or a manifest body can never reach the queryable run-audit trail, however the input grows.
*/

const PROJECT_ID = "self-improve-comparability-sink-health";
const OCCURRED_AT = "2026-09-30T02:00:00.000Z";

/** A distinctive multi-line diff/log planted in narrative-bearing input slots; it must never be observed. */
const PLANTED_PROSE = "PLANTED-PROSE-must-never-reach-run-audit\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-secret-line";

/** Extra narrative-shaped properties smuggled onto the façade input; none may reach the event. */
const narrativeExtras = {
  diff: PLANTED_PROSE,
  command: PLANTED_PROSE,
  log: PLANTED_PROSE,
  output: PLANTED_PROSE,
  rationale: PLANTED_PROSE,
} as const;

const BASELINE: ComparabilityIdentity = {
  manifest: "manifest-v1:abc123",
  seed: "seed-42",
  engine: "engine-build-0001",
  config: "config-digest-xyz789",
  fingerprint: "",
};

/** A candidate whose engine build diverges, so the guard produces a refusal verdict to assert on. */
const CANDIDATE: ComparabilityIdentity = { ...BASELINE, engine: "engine-build-0002" };

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

describe("selfimprove:comparability-refused sink health (bounded seam across every sink mode)", () => {
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

    it("emits without rejecting and leaves the caller's verdict unchanged", async () => {
      const { host } = makeHost();
      // The guard decides the refusal BEFORE any emit is attempted — it is pure and reads no sink.
      const verdict = evaluateComparability({ baseline: BASELINE, candidate: CANDIDATE });
      const before = structuredClone(verdict);
      expect(verdict.verdict).toBe("not-comparable");

      await settle(
        emitSelfImproveComparabilityRefused({
          host,
          baseline: verdict.baseline,
          candidate: verdict.candidate,
          diverged: verdict.diverged,
          outcome: verdict.reason!,
        }),
      );

      // The refusal the caller already holds is completely untouched by the sink's health.
      expect(verdict).toEqual(before);
    });
  });

  describe("closed metadata list (ids/fixed-outcomes only — no diff, no command, no log prose)", () => {
    it("never includes diff, command, or log prose, and no metadata value is multi-line", async () => {
      const { events, host } = healthyHost();
      const verdict = evaluateComparability({ baseline: BASELINE, candidate: CANDIDATE });
      await emitSelfImproveComparabilityRefused({
        host,
        baseline: verdict.baseline,
        candidate: verdict.candidate,
        diverged: verdict.diverged,
        outcome: verdict.reason!,
        projectId: PROJECT_ID,
        timestamp: OCCURRED_AT,
        ...narrativeExtras,
      } as never);

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.mutationType).toBe(SELF_IMPROVE_RUN_AUDIT_EVENTS.comparabilityRefused);
      // Neither the planted values nor their keys may appear anywhere in the event.
      expect(JSON.stringify(event)).not.toContain(PLANTED_PROSE);
      expect(JSON.stringify(event)).not.toContain("secret-line");
      for (const key of ["diff", "command", "log", "output", "rationale"]) {
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

    it("uses the fixed system principal, the database domain, and no task column", async () => {
      const { events, host } = healthyHost();
      const verdict = evaluateComparability({ baseline: BASELINE, candidate: CANDIDATE });
      await emitSelfImproveComparabilityRefused({
        host,
        baseline: verdict.baseline,
        candidate: verdict.candidate,
        diverged: verdict.diverged,
        outcome: verdict.reason!,
      });

      const event = events[0];
      expect(event.agentId).toBe(SELF_IMPROVE_AUDIT_AGENT_ID);
      expect(event.domain).toBe("database");
      expect(event.taskId).toBeUndefined();
      // Stable non-clock run lineage id when the caller owns none.
      expect(event.runId).toBe("selfimprove-comparability");
    });
  });
});
