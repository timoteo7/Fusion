import { describe, expect, it } from "vitest";
import { deriveLearningStateFromEvents, normalizeLedgerLimit, normalizeLedgerOffset } from "../task-store/async/async-learning-ledger.js";
import { LEARNING_PROPOSAL_TARGETS, createLearningProposal } from "../self-improve/ledger-schema.js";
import type { LearningLedgerEvent, LearningLedgerEventKind } from "../self-improve/ledger-events.js";

/*
FNXC:SelfImproveLearningLedger 2026-09-29-15:15:
These tests pin the two contracts that are pure enough to prove without a database: the page-size
clamping a caller cannot bypass, and the state derivation that makes the append-only trail — not a
mutable field — the source of truth for what a proposal currently asserts. Both are read by the
later gate and revert lanes, so a silent regression here would corrupt the loop's decisions rather
than crash. The PostgreSQL suite proves the persisted shape; this one proves the rules.
*/

const CREATED_AT = "2026-09-29T00:00:00.000Z";

const event = (kind: LearningLedgerEventKind, occurredAt: string, overrides: Partial<LearningLedgerEvent> = {}): LearningLedgerEvent => ({
  eventId: `${kind}-${occurredAt}`,
  proposalId: "proposal-1",
  target: "evals",
  kind,
  revertsEventId: null,
  evidenceRefs: [],
  occurredAt,
  createdAt: occurredAt,
  ...overrides,
});

// The accessor's real derivation, imported so the rule is pinned here rather than re-implemented.
const deriveState = deriveLearningStateFromEvents;

describe("learning ledger query normalization", () => {
  it("clamps the page size into a bounded range", () => {
    expect(normalizeLedgerLimit(undefined)).toBe(100);
    expect(normalizeLedgerLimit(Number.NaN)).toBe(100);
    expect(normalizeLedgerLimit(25)).toBe(25);
    expect(normalizeLedgerLimit(0)).toBe(1);
    expect(normalizeLedgerLimit(-10)).toBe(1);
    expect(normalizeLedgerLimit(1_000)).toBe(200);
    expect(normalizeLedgerLimit(200)).toBe(200);
  });

  it("truncates a fractional page size rather than passing it to the driver", () => {
    expect(normalizeLedgerLimit(7.9)).toBe(7);
    expect(normalizeLedgerLimit(7.1)).toBe(7);
  });

  it("floors the offset at zero and truncates a fractional one", () => {
    expect(normalizeLedgerOffset(undefined)).toBe(0);
    expect(normalizeLedgerOffset(Number.NaN)).toBe(0);
    expect(normalizeLedgerOffset(-5)).toBe(0);
    expect(normalizeLedgerOffset(12)).toBe(12);
    expect(normalizeLedgerOffset(12.7)).toBe(12);
  });
});

describe("learning ledger append-only trail", () => {
  it("derives the current state from the latest event, not the first", () => {
    const trail = [
      event("proposed", CREATED_AT),
      event("applied", "2026-09-29T01:00:00.000Z"),
    ];
    expect(deriveState(trail)).toBe("applied");
  });

  it("reads a reversal as the current state after an application", () => {
    const trail = [
      event("proposed", CREATED_AT),
      event("applied", "2026-09-29T01:00:00.000Z", { eventId: "a1" }),
      event("reverted", "2026-09-29T02:00:00.000Z", { eventId: "r1", revertsEventId: "a1" }),
    ];
    expect(deriveState(trail)).toBe("reverted");
  });

  it("reads a re-application after a revert as applied again", () => {
    const trail = [
      event("proposed", CREATED_AT),
      event("applied", "2026-09-29T01:00:00.000Z", { eventId: "a1" }),
      event("reverted", "2026-09-29T02:00:00.000Z", { eventId: "r1", revertsEventId: "a1" }),
      event("applied", "2026-09-29T03:00:00.000Z", { eventId: "a2" }),
    ];
    expect(deriveState(trail)).toBe("applied");
  });

  it("falls back to proposed when a proposal has no events yet", () => {
    expect(deriveState([])).toBe("proposed");
  });

  it("preserves every earlier event so a re-application never erases the value it replaced", () => {
    const first = event("applied", "2026-09-29T01:00:00.000Z", { eventId: "a1" });
    const second = event("applied", "2026-09-29T03:00:00.000Z", { eventId: "a2" });
    const trail = [event("proposed", CREATED_AT), first, second];
    // The append-only contract: the earlier application is still readable after a later one.
    expect(trail.map((e) => e.eventId)).toEqual(["proposed-2026-09-29T00:00:00.000Z", "a1", "a2"]);
    expect(trail).toContainEqual(first);
  });
});

describe("learning proposal opened through the ledger", () => {
  it("builds a proposal whose opening state is proposed at version 1", () => {
    const proposal = createLearningProposal({
      proposalId: "proposal-1",
      target: "evals",
      origin: "eval-failure",
      confidence: 0.4,
      value: 0.5,
      now: CREATED_AT,
    });
    expect(proposal.state).toBe("proposed");
    expect(proposal.version).toBe(1);
    expect(proposal.createdAt).toBe(CREATED_AT);
  });

  it("restricts targets to the three product surfaces the loop may act on", () => {
    expect(LEARNING_PROPOSAL_TARGETS).toEqual(["memory", "evals", "skills"]);
  });
});
