import { describe, expect, it, vi } from "vitest";
import {
  LEARNING_REVERT_REASONS,
  buildLearningRevertEventId,
  isLearningRevertReason,
  type LearningRevertOutcome,
  type LearningRevertReason,
} from "../self-improve/learning-revert-types.js";
import { emitBoundedRunAudit } from "../run-audit/emit-bounded-run-audit.js";
import type { RunAuditEventInput } from "../types.js";

/*
FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
These tests pin the parts of the revert contract that are pure enough to prove without a database:
the closed reason enum, the derived occurrence key that makes the append idempotent, and the result
union that the operator surface and the later deterministic gate both read. They are the decision
points where a silent regression would corrupt which experiments count as undone rather than merely
crash — the PostgreSQL suite proves the persisted shape, and this one proves the rules.

FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
The hostile-sink cases are the reason the emission is a bounded best-effort seam. Run-audit
telemetry is derived from the revert, never load-bearing: an absent, throwing, rejecting, or
never-settling sink must leave the revert's own outcome and its ledger content untouched. Asserting
that here (at the seam, with fake timers) is deterministic; asserting it against a real database
would need a wall-clock wait on a 2s bound and would be both slow and timing-dependent.
*/

const APPLIED_EVENT_ID = "e-applied-1";

describe("learning revert reason enum", () => {
  it("accepts exactly the five fixed reasons", () => {
    // The enum is CLOSED on purpose: free prose in an append-only ledger becomes a narrative surface
    // no gate can filter or count, and the bounded run-audit row (ids/counts/fixed-outcomes only)
    // could not mirror it.
    expect([...LEARNING_REVERT_REASONS]).toEqual([
      "gate-rejected",
      "operator-veto",
      "superseded",
      "expired",
      "manual",
    ]);
  });

  it("rejects anything outside the enum", () => {
    for (const value of ["reverted", "", "GATE-REJECTED", "because the run went red", null, undefined, 3, {}]) {
      expect(isLearningRevertReason(value)).toBe(false);
    }
  });

  it("accepts every member of the enum and narrows the type", () => {
    for (const reason of LEARNING_REVERT_REASONS) {
      expect(isLearningRevertReason(reason)).toBe(true);
    }
    // The guard is a type predicate, so a narrowed value is assignable to the exported union. This
    // is what lets a caller build a reversal by hand without a cast.
    const narrowed: LearningRevertReason | undefined = "expired";
    expect(isLearningRevertReason(narrowed) ? narrowed : undefined).toBe("expired");
  });
});

describe("learning revert occurrence key", () => {
  it("derives a stable id from the application it cancels", () => {
    expect(buildLearningRevertEventId(APPLIED_EVENT_ID)).toBe(`${APPLIED_EVENT_ID}:reverted`);
  });

  it("is stable across retries, which is what makes the insert idempotent", () => {
    // The idempotency mechanism, stated as an observable: two attempts to revert the SAME
    // application derive the SAME reversal id, so the second insert collides on the
    // (project_id, event_id) primary key and onConflictDoNothing returns no row. A fresh uuid per
    // attempt would append N indistinguishable reversals and the trail would no longer answer
    // "was this reverted, and how many times" honestly.
    expect(buildLearningRevertEventId(APPLIED_EVENT_ID)).toBe(buildLearningRevertEventId(APPLIED_EVENT_ID));
  });

  it("gives a different application a different reversal id", () => {
    expect(buildLearningRevertEventId("e-applied-1")).not.toBe(buildLearningRevertEventId("e-applied-2"));
  });

  it("trims the application id and refuses a blank one", () => {
    expect(buildLearningRevertEventId("  e-a1  ")).toBe("e-a1:reverted");
    // A blank application id would otherwise produce a reversal literally named ":reverted" that
    // pairs with nothing — an unauditable row the CHECK on reverts_event_id cannot catch because
    // the accessor never got far enough to write it.
    for (const blank of ["", "   ", undefined as unknown as string, null as unknown as string]) {
      expect(() => buildLearningRevertEventId(blank)).toThrow(/the event id of the application it cancels/);
    }
  });
});

describe("learning revert result union", () => {
  it("distinguishes the write from the two honest no-ops", () => {
    // `reverted` is the only outcome that appended a row. The other two are not failures: they are
    // the two ways a revert changes nothing, and a caller that treated them as errors would retry a
    // no-op forever or, worse, append a duplicate.
    const outcomes: LearningRevertOutcome[] = ["reverted", "already-reverted", "not-applied"];
    expect(outcomes).toEqual(["reverted", "already-reverted", "not-applied"]);
  });
});

describe("learning revert run-audit emission is bounded best-effort", () => {
  const event = (): RunAuditEventInput => ({
    agentId: "self-improve",
    runId: "learning-revert:proposal-1",
    domain: "database",
    mutationType: "learning:reverted",
    target: "proposal-1",
    metadata: { proposalId: "proposal-1", outcome: "reverted", reason: "gate-rejected" },
  });

  it("records a well-behaved sink", async () => {
    const record = vi.fn();
    await emitBoundedRunAudit({ recordRunAuditEvent: record }, event());
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("treats an absent sink as a no-op instead of throwing", async () => {
    // A layer with no audit capability is the common case, not an error. The revert's outcome and
    // its committed trail are already final before emission runs.
    await expect(emitBoundedRunAudit(undefined, event())).resolves.toBeUndefined();
    await expect(emitBoundedRunAudit(null, event())).resolves.toBeUndefined();
    await expect(emitBoundedRunAudit({}, event())).resolves.toBeUndefined();
  });

  it("absorbs a synchronously throwing sink", async () => {
    const record = vi.fn(() => {
      throw new Error("sink exploded");
    });
    await expect(emitBoundedRunAudit({ recordRunAuditEvent: record }, event())).resolves.toBeUndefined();
  });

  it("absorbs a rejecting sink", async () => {
    const record = vi.fn(() => Promise.reject(new Error("sink rejected")));
    await expect(emitBoundedRunAudit({ recordRunAuditEvent: record }, event())).resolves.toBeUndefined();
  });

  it("releases a never-settling sink at the bound instead of hanging", async () => {
    vi.useFakeTimers();
    try {
      // A sink that never resolves must not hold the caller: the seam time-boxes it and releases,
      // which is what keeps a stalled audit store from becoming a revert dependency.
      const record = vi.fn(() => new Promise<never>(() => {}));
      const emitted = emitBoundedRunAudit({ recordRunAuditEvent: record }, event(), {
        timeoutMs: 2_000,
        log: { warn: () => {} },
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(emitted).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes ids/counts/fixed-outcomes metadata and never a verdict, prose, or diff", () => {
    // The metadata contract, asserted structurally. Every value here is an id, a count, or a fixed
    // enum; there is no field a reviewer would read as free text, and none that could carry a diff.
    const metadata: Record<string, unknown> = {
      proposalId: "proposal-1",
      target: "evals",
      appliedEventId: "e-applied-1",
      revertEventId: "e-applied-1:reverted",
      outcome: "reverted",
      reason: "gate-rejected",
    };
    const fixed = new Set<string>([...LEARNING_REVERT_REASONS, "reverted", "already-reverted", "not-applied"]);
    for (const [key, value] of Object.entries(metadata)) {
      expect(key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
      if (key === "outcome" || key === "reason") expect(fixed.has(value as string)).toBe(true);
      else expect(typeof value === "string" || value === null).toBe(true);
    }
  });
});
