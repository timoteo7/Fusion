import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SELF_IMPROVE_GATE_RUN_AGENT_ID,
  SELF_IMPROVE_GATE_RUN_EVENT,
  emitSelfImproveGateRun,
} from "../self-improve/self-improve-gate-run-audit.js";
import { CORE_RUN_AUDIT_EMIT_TIMEOUT_MS, type RunAuditSinkHost } from "../run-audit/emit-bounded-run-audit.js";
import type { RunAuditEventInput } from "../types/audit/run-audit.js";
import type { PrimaryGateVerdict } from "../types/self-improve/primary-gate.js";

/*
FNXC:SelfImproveGateRunAudit 2026-09-30-09:50:
FUSI-016's `selfimprove:gate-run` façade inherits hostile-sink tolerance from the bounded core seam
STRUCTURALLY, but the seam's own suite exercises the generic helper with synthetic events, not this
façade with its real verdict projection. This suite closes that gap: the gate verdict a caller
already holds must be COMPLETELY UNCHANGED whether the sink is absent, throwing, rejecting, hung, or
late — that is the invariant that lets a self-improvement experiment be judged on its deterministic
verdict rather than on whether telemetry was healthy. Each mode asserts the verdict object is
deep-equal to the pre-emission copy AND that the emission resolves without rejecting.

FNXC:SelfImproveGateRunAudit 2026-09-30-09:50:
The metadata assertions are the prose-containment proof. The façade is called with a planted
multi-line `diff`, a planted `command`, and a planted `log` smuggled in as extra properties (via a
cast, simulating a caller that grows one). The captured event must contain NEITHER the values NOR the
keys, its metadata keys must equal the documented closed list exactly, and no metadata value may be a
multi-line string. That is what makes the audit edge safe: a diff or a compiler log can never reach
the queryable run-audit trail, however the input grows.
*/

const PROJECT_ID = "self-improve-gate-sink-health";
const CANDIDATE_SHA = "abc1234def5678";
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

function makeVerdict(overrides: Partial<PrimaryGateVerdict> = {}): PrimaryGateVerdict {
  return {
    passed: true,
    fingerprint: "f".repeat(64),
    candidateSha: CANDIDATE_SHA,
    steps: [
      { id: "build", outcome: "passed", passed: true },
      { id: "lint", outcome: "passed", passed: true },
      { id: "typecheck", outcome: "passed", passed: true },
      { id: "gate", outcome: "passed", passed: true },
      { id: "affected-tests", outcome: "passed", passed: true },
    ],
    failedStepCount: 0,
    affectedTestCount: 2,
    affectedScope: {
      kind: "resolved",
      testFiles: ["packages/engine/src/__tests__/alpha.test.ts", "packages/core/src/__tests__/gamma.test.ts"],
      packages: ["@fusion/core", "@fusion/engine"],
    },
    ...overrides,
  };
}

describe("selfimprove:gate-run sink health (bounded seam across every sink mode)", () => {
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
      const verdict = makeVerdict();
      const before = structuredClone(verdict);

      await settle(emitSelfImproveGateRun({ host, verdict, durationMs: 1234 }));

      // The gate verdict the caller already holds is completely untouched by the sink's health.
      expect(verdict).toEqual(before);
    });
  });

  describe("closed metadata list (ids/counts/booleans only — no diff, no command, no log prose)", () => {
    it("records exactly the documented field list", async () => {
      const { events, host } = healthyHost();
      await emitSelfImproveGateRun({ host, verdict: makeVerdict(), durationMs: 4321, projectId: PROJECT_ID, timestamp: OCCURRED_AT });

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.mutationType).toBe(SELF_IMPROVE_GATE_RUN_EVENT);
      expect(Object.keys(event.metadata!).sort()).toEqual(
        [
          "affectedScopeKind",
          "affectedTestCount",
          "candidateSha",
          "durationMs",
          "failedStepCount",
          "fingerprint",
          "passed",
          "projectId",
          "steps",
        ].sort(),
      );
      expect(event.metadata).toMatchObject({
        candidateSha: CANDIDATE_SHA,
        passed: true,
        failedStepCount: 0,
        affectedTestCount: 2,
        affectedScopeKind: "resolved",
        durationMs: 4321,
        projectId: PROJECT_ID,
      });
      // Each step is [id, boolean] — an ids/outcomes record, not a nested object of prose.
      expect(event.metadata!.steps).toEqual([
        ["build", true], ["lint", true], ["typecheck", true], ["gate", true], ["affected-tests", true],
      ]);
    });

    it("never includes diff, command, or log prose, and no metadata value is multi-line", async () => {
      const { events, host } = healthyHost();
      await emitSelfImproveGateRun({ host, verdict: makeVerdict(), durationMs: 100, ...narrativeExtras } as never);

      expect(events).toHaveLength(1);
      const event = events[0];
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

    it("records the failed verdict's boolean and per-step booleans without the richer outcome vocabulary", async () => {
      const { events, host } = healthyHost();
      const failed = makeVerdict({
        passed: false,
        failedStepCount: 1,
        steps: [
          { id: "build", outcome: "passed", passed: true },
          { id: "lint", outcome: "failed", passed: false },
          { id: "typecheck", outcome: "passed", passed: true },
          { id: "gate", outcome: "passed", passed: true },
          { id: "affected-tests", outcome: "passed", passed: true },
        ],
      });
      await emitSelfImproveGateRun({ host, verdict: failed, durationMs: 10 });

      const event = events[0];
      expect(event.metadata).toMatchObject({ passed: false, failedStepCount: 1 });
      // The step record is [id, boolean]: the boolean decision, not the timed-out/failed diagnosis.
      const steps = event.metadata!.steps as [string, boolean][];
      expect(steps.find(([id]) => id === "lint")?.[1]).toBe(false);
      expect(JSON.stringify(event.metadata)).not.toContain("timed-out");
    });

    it("uses a stable per-candidate run id and the fixed system principal", async () => {
      const { events, host } = healthyHost();
      await emitSelfImproveGateRun({ host, verdict: makeVerdict(), durationMs: 1 });
      await emitSelfImproveGateRun({ host, verdict: makeVerdict(), durationMs: 1 });

      expect(events.map((e) => e.runId)).toEqual([
        `selfimprove-gate-${CANDIDATE_SHA}`,
        `selfimprove-gate-${CANDIDATE_SHA}`,
      ]);
      expect(events.every((e) => e.agentId === SELF_IMPROVE_GATE_RUN_AGENT_ID)).toBe(true);
      // A gate run belongs to no task column.
      expect(events.every((e) => e.taskId === undefined)).toBe(true);
    });
  });
});
