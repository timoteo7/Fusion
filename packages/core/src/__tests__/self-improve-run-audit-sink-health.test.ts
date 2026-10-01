import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SELF_IMPROVE_AUDIT_AGENT_ID,
  SELF_IMPROVE_RUN_AUDIT_EVENTS,
  emitSelfImproveProposalApplied,
  emitSelfImproveProposalCreated,
  emitSelfImproveProposalReverted,
} from "../self-improve/self-improve-run-audit.js";
import { CORE_RUN_AUDIT_EMIT_TIMEOUT_MS, type RunAuditSinkHost } from "../run-audit/emit-bounded-run-audit.js";
import type { RunAuditEventInput } from "../types/audit/run-audit.js";

/*
FNXC:SelfImproveRunAudit 2026-09-29-21:49:
FUSI-015 proves the load-bearing half of the FUSI-012 contract behaviorally. The three façades are
built on the bounded core seam, which structurally inherits hostile-sink tolerance, but "structurally
inherited" is not "proven": the seam's own suite exercises the GENERIC helper with synthetic events,
not these three learning façades with their real closed metadata lists. This suite closes that gap
for exactly the selfimprove façades, so a future widening of a field list or a regression that made
one façade's emit land on a caller's success path fails HERE rather than being discovered in
production.

FNXC:SelfImproveRunAudit 2026-09-29-21:49:
Every façade is driven through the six sink modes that matter — absent (no seam), throwing
(synchronous), rejecting (async), never-settling (hung), late-settling (resolves after the
timeout), and healthy — and each must resolve to `undefined` and leave the transition input
untouched. "Never-settling" and "late-settling" are the modes that prove telemetry cannot gate the
ledger: they use fake timers to cross the seam's own `CORE_RUN_AUDIT_EMIT_TIMEOUT_MS` so the
time-box is exercised deterministically rather than by waiting on a real clock.

FNXC:SelfImproveRunAudit 2026-09-29-21:49:
The metadata assertions are the prose-containment proof. Each façade is called with a planted
`origin`, `evidenceRefs`, and `diff` smuggled in as extra properties (via a cast), and the captured
event is asserted to contain NEITHER the values NOR the keys, and its metadata keys to equal the
documented closed list exactly. This asserts the property that makes the audit edge safe: adding an
optional field to the ledger or the input can never silently widen what run-audit records, because
the façade builds metadata from an explicit list and never spreads caller input.
*/

const PROJECT_ID = "self-improve-sink-health";
const PROPOSAL_ID = "p-sink-1";
const TARGET = "evals" as const;
const OCCURRED_AT = "2026-09-29T01:00:00.000Z";

/** A distinctive sentence planted in every narrative-bearing input slot; it must never be observed. */
const PLANTED_PROSE = "PLANTED-PROSE-must-never-reach-run-audit";

/**
 * Extra narrative-shaped properties smuggled onto a façade input. The façade's declared input types
 * do not include them; the cast simulates a caller that grows one, which is exactly when a spreading
 * implementation would start leaking. None of these keys or values may appear in the captured event.
 */
const narrativeExtras = {
  origin: PLANTED_PROSE,
  evidenceRefs: [{ surface: PLANTED_PROSE, ref: PLANTED_PROSE }],
  diff: PLANTED_PROSE,
  rationale: PLANTED_PROSE,
} as const;

type Captured = { events: RunAuditEventInput[]; host: RunAuditSinkHost };

/** Healthy sink: records and resolves immediately. */
function healthyHost(): Captured {
  const events: RunAuditEventInput[] = [];
  return {
    events,
    host: { recordRunAuditEvent: (event: RunAuditEventInput) => { events.push(event); } },
  };
}

/** Absent sink: the host has no seam at all. */
function absentHost(): Captured {
  return { events: [], host: {} };
}

/** Throwing sink: the seam throws synchronously when invoked. */
function throwingHost(): Captured {
  return { events: [], host: { recordRunAuditEvent: () => { throw new Error(PLANTED_PROSE); } } };
}

/** Rejecting sink: the seam returns a rejected promise. */
function rejectingHost(): Captured {
  return { events: [], host: { recordRunAuditEvent: () => Promise.reject(new Error(PLANTED_PROSE)) } };
}

/** Never-settling sink: the seam returns a promise that never resolves. */
function neverSettlingHost(): Captured {
  return { events: [], host: { recordRunAuditEvent: () => new Promise<never>(() => { /* never settles */ }) } };
}

/** Late-settling sink: resolves only after the seam's timeout has elapsed. */
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

const createInput = (host: RunAuditSinkHost) => ({ host, proposalId: PROPOSAL_ID, target: TARGET, projectId: PROJECT_ID, timestamp: OCCURRED_AT });
const applyInput = (host: RunAuditSinkHost) => ({ ...createInput(host), version: 3, confidence: 0.7, value: 0.42, evidenceCount: 2, hasPriorValue: true });
const revertInput = (host: RunAuditSinkHost) => ({ ...createInput(host), revertedEventId: "e-applied-1", revertReason: "operator-veto" as const });

describe("selfimprove run-audit sink health (bounded seam across every sink mode)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe.each(SINK_MODES)("sink mode: %s", (_mode, makeHost) => {
    // The never-settling and late-settling modes only release the façade once the seam's own
    // timeout fires, and the seam's timeout is a real `setTimeout`. Under fake timers that only
    // runs when the clock is advanced, so EVERY mode advances past it before awaiting. For the
    // immediately-resolving modes (absent/throwing/rejecting/healthy) this is a no-op; for the hung
    // modes it is what proves the seam's time-box actually releases the façade.
    const settle = async (promise: Promise<void>) => {
      await vi.advanceTimersByTimeAsync(CORE_RUN_AUDIT_EMIT_TIMEOUT_MS + 5);
      await expect(promise).resolves.toBeUndefined();
    };

    it("created façade resolves undefined and never rejects", async () => {
      const { host } = makeHost();
      await settle(emitSelfImproveProposalCreated({ ...createInput(host), evidenceCount: 5 } as never));
    });

    it("applied façade resolves undefined and never rejects", async () => {
      const { host } = makeHost();
      await settle(emitSelfImproveProposalApplied(applyInput(host) as never));
    });

    it("reverted façade resolves undefined and never rejects", async () => {
      const { host } = makeHost();
      await settle(emitSelfImproveProposalReverted(revertInput(host) as never));
    });
  });

  describe("closed metadata lists (ids/counts/fixed outcomes only)", () => {
    it("created records exactly proposalId/target/evidenceCount/outcome/projectId — no prose, no diff", async () => {
      const { events, host } = healthyHost();
      await emitSelfImproveProposalCreated({
        ...createInput(), host, evidenceCount: 3, ...narrativeExtras,
      } as never);

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.mutationType).toBe(SELF_IMPROVE_RUN_AUDIT_EVENTS.created);
      expect(Object.keys(event.metadata!).sort()).toEqual(
        ["evidenceCount", "outcome", "projectId", "proposalId", "target"].sort(),
      );
      expect(event.metadata).toMatchObject({ evidenceCount: 3, outcome: "recorded", proposalId: PROPOSAL_ID, target: TARGET, projectId: PROJECT_ID });
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain(PLANTED_PROSE);
      for (const key of ["origin", "evidenceRefs", "diff", "rationale"]) {
        expect(event.metadata).not.toHaveProperty(key);
        expect(Object.keys(event.metadata!)).not.toContain(key);
      }
    });

    it("applied records exactly the asserted weight — no prose, no diff", async () => {
      const { events, host } = healthyHost();
      await emitSelfImproveProposalApplied({
        ...applyInput(host), ...narrativeExtras,
      } as never);

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.mutationType).toBe(SELF_IMPROVE_RUN_AUDIT_EVENTS.applied);
      expect(Object.keys(event.metadata!).sort()).toEqual(
        ["confidence", "evidenceCount", "hasPriorValue", "outcome", "projectId", "proposalId", "target", "value", "version"].sort(),
      );
      expect(event.metadata).toMatchObject({ version: 3, confidence: 0.7, value: 0.42, evidenceCount: 2, hasPriorValue: true, outcome: "applied" });
      expect(JSON.stringify(event)).not.toContain(PLANTED_PROSE);
    });

    it("reverted records exactly the pairing and fixed reason — no prose, no diff", async () => {
      const { events, host } = healthyHost();
      await emitSelfImproveProposalReverted({
        ...revertInput(host), ...narrativeExtras,
      } as never);

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.mutationType).toBe(SELF_IMPROVE_RUN_AUDIT_EVENTS.reverted);
      expect(Object.keys(event.metadata!).sort()).toEqual(
        ["outcome", "projectId", "proposalId", "revertReason", "revertedEventId", "target"].sort(),
      );
      expect(event.metadata).toMatchObject({ revertedEventId: "e-applied-1", revertReason: "operator-veto", outcome: "reverted" });
      expect(JSON.stringify(event)).not.toContain(PLANTED_PROSE);
    });

    it("uses a stable per-proposal run id and the fixed system principal so one proposal's lifecycle correlates", async () => {
      const { events, host } = healthyHost();
      await emitSelfImproveProposalCreated({ ...createInput(), host, evidenceCount: 1 } as never);
      await emitSelfImproveProposalApplied(applyInput(host) as never);
      await emitSelfImproveProposalReverted(revertInput(host) as never);

      expect(events.map((e) => e.runId)).toEqual([
        `selfimprove-${PROPOSAL_ID}`,
        `selfimprove-${PROPOSAL_ID}`,
        `selfimprove-${PROPOSAL_ID}`,
      ]);
      expect(events.every((e) => e.agentId === SELF_IMPROVE_AUDIT_AGENT_ID)).toBe(true);
    });
  });
});
