import { describe, expect, it } from "vitest";
import {
  LEARNING_PROPOSAL_STATES,
  LEARNING_PROPOSAL_TARGETS,
  applyProposalVersioning,
  canApplyProposal,
  createLearningProposal,
  isLearningProposalState,
  isProposalExpired,
  normalizeConfidence,
} from "../self-improve/ledger-schema.js";
import type { LearningProposal } from "../types/self-improve/learning-proposal.js";

/*
FNXC:SelfImproveLearningLedger 2026-09-29-02:38:
These tests pin the two contract invariants directly rather than through a caller, because every
later lane (gate, apply, revert) reads these helpers: if `canApplyProposal` ever stops refusing an
expired value, or `applyProposalVersioning` stops moving the old value into `priorValue`, the revert
decision silently becomes wrong instead of loudly failing. `now` is a fixed instant everywhere so
the expiry assertions cannot pass by accident against a wall clock.
*/

const CREATED_AT = "2026-09-29T00:00:00.000Z";
const BEFORE_EXPIRY = "2026-09-29T01:00:00.000Z";
const EXPIRY = "2026-09-29T02:00:00.000Z";
const AFTER_EXPIRY = "2026-09-29T03:00:00.000Z";

const buildProposal = (overrides: Partial<LearningProposal> = {}): LearningProposal => ({
  ...createLearningProposal({
    proposalId: "proposal-1",
    target: "evals",
    origin: "eval-failure",
    confidence: 0.4,
    value: 0.5,
    expiresAt: EXPIRY,
    now: CREATED_AT,
  }),
  ...overrides,
});

describe("self-improve ledger schema", () => {
  describe("record contract", () => {
    it("round-trips a proposal through createLearningProposal with every contract field", () => {
      const proposal = createLearningProposal({
        proposalId: " proposal-1 ",
        target: "skills",
        origin: "manual",
        confidence: 0.25,
        value: 0.75,
        expiresAt: EXPIRY,
        evidenceRefs: [{ surface: "evals", ref: "run-42", observedAt: CREATED_AT }],
        now: CREATED_AT,
      });

      expect(proposal).toEqual({
        proposalId: "proposal-1",
        target: "skills",
        origin: "manual",
        confidence: 0.25,
        value: 0.75,
        priorValue: null,
        expiresAt: EXPIRY,
        evidenceRefs: [{ surface: "evals", ref: "run-42", observedAt: CREATED_AT }],
        state: "proposed",
        version: 1,
        createdAt: CREATED_AT,
      });
    });

    it("confines state to the four contract members", () => {
      expect([...LEARNING_PROPOSAL_STATES].sort()).toEqual(["applied", "expired", "proposed", "reverted"]);
      for (const state of LEARNING_PROPOSAL_STATES) {
        expect(isLearningProposalState(state)).toBe(true);
      }
      expect(isLearningProposalState("mutated")).toBe(false);
      expect(isLearningProposalState(undefined)).toBe(false);
    });

    it("confines target to the three product surfaces in data-layer-first order", () => {
      expect([...LEARNING_PROPOSAL_TARGETS]).toEqual(["memory", "evals", "skills"]);
    });
  });

  describe("invariant: an expired value is never applied without reevaluation", () => {
    it("permits application before the deadline and refuses it at and after the deadline", () => {
      const proposal = buildProposal();

      expect(isProposalExpired(proposal, BEFORE_EXPIRY)).toBe(false);
      expect(canApplyProposal(proposal, BEFORE_EXPIRY)).toBe(true);

      // The deadline instant itself is already stale: it is the last instant the value is fresh.
      expect(isProposalExpired(proposal, EXPIRY)).toBe(true);
      expect(canApplyProposal(proposal, EXPIRY)).toBe(false);
      expect(isProposalExpired(proposal, AFTER_EXPIRY)).toBe(true);
      expect(canApplyProposal(proposal, AFTER_EXPIRY)).toBe(false);
    });

    it("never expires a proposal with no deadline", () => {
      const proposal = buildProposal({ expiresAt: null });

      expect(isProposalExpired(proposal, AFTER_EXPIRY)).toBe(false);
      expect(canApplyProposal(proposal, AFTER_EXPIRY)).toBe(true);
    });

    it("treats an unparseable deadline as no deadline rather than as immediately stale", () => {
      const proposal = buildProposal({ expiresAt: "not-a-timestamp" });

      expect(isProposalExpired(proposal, AFTER_EXPIRY)).toBe(false);
    });

    it("refuses to re-apply a reverted proposal, whose value was rolled back", () => {
      const proposal = buildProposal({ state: "reverted" });

      expect(canApplyProposal(proposal, BEFORE_EXPIRY)).toBe(false);
    });

    it("becomes applicable again only through a reevaluation that produces a new record", () => {
      const stale = buildProposal();
      expect(canApplyProposal(stale, AFTER_EXPIRY)).toBe(false);

      // Reevaluation is a fresh record with a fresh deadline, not a mutation of the stale one.
      const reevaluated = buildProposal({
        version: stale.version,
        expiresAt: "2026-09-30T02:00:00.000Z",
        createdAt: AFTER_EXPIRY,
      });
      expect(canApplyProposal(reevaluated, AFTER_EXPIRY)).toBe(true);
    });
  });

  describe("invariant: confidence and value are versioned on every new application", () => {
    it("moves the previous value into priorValue and increments the version", () => {
      const original = buildProposal();
      const applied = applyProposalVersioning(original, 0.9, 0.6, BEFORE_EXPIRY);

      expect(applied.value).toBe(0.9);
      expect(applied.confidence).toBe(0.6);
      expect(applied.priorValue).toBe(0.5);
      expect(applied.version).toBe(2);
      expect(applied.state).toBe("applied");
    });

    it("never mutates the input record it was versioned from", () => {
      const original = buildProposal();
      applyProposalVersioning(original, 0.9, 0.6, BEFORE_EXPIRY);

      expect(original.value).toBe(0.5);
      expect(original.priorValue).toBeNull();
      expect(original.version).toBe(1);
      expect(original.state).toBe("proposed");
    });

    it("chains priorValue back one application at a time", () => {
      const first = applyProposalVersioning(buildProposal(), 0.9, 0.6, BEFORE_EXPIRY);
      const second = applyProposalVersioning(first, 0.2, 0.3, EXPIRY);

      expect(second.version).toBe(3);
      expect(second.value).toBe(0.2);
      expect(second.confidence).toBe(0.3);
      // The value to restore on revert is the one held immediately before THIS application.
      expect(second.priorValue).toBe(0.9);
    });

    it("preserves identity, origin, target and evidence across an application", () => {
      const original = buildProposal({ evidenceRefs: [{ surface: "evals", ref: "run-42" }] });
      const applied = applyProposalVersioning(original, 0.9, 0.6, BEFORE_EXPIRY);

      expect(applied.proposalId).toBe(original.proposalId);
      expect(applied.origin).toBe(original.origin);
      expect(applied.target).toBe(original.target);
      expect(applied.evidenceRefs).toEqual(original.evidenceRefs);
      expect(applied.createdAt).toBe(original.createdAt);
    });

    it("accepts a Date as well as an ISO string for the application instant", () => {
      const applied = applyProposalVersioning(buildProposal(), 0.9, 0.6, new Date(BEFORE_EXPIRY));

      expect(applied.state).toBe("applied");
      expect(applied.version).toBe(2);
    });
  });

  describe("normalizeConfidence", () => {
    it("passes in-range values through unchanged", () => {
      expect(normalizeConfidence(0)).toBe(0);
      expect(normalizeConfidence(1)).toBe(1);
      expect(normalizeConfidence(0.42)).toBe(0.42);
    });

    it("bounds out-of-range input to the contract range", () => {
      expect(normalizeConfidence(-0.5)).toBe(0);
      expect(normalizeConfidence(17)).toBe(1);
      expect(normalizeConfidence(Number.POSITIVE_INFINITY)).toBe(0);
      expect(normalizeConfidence(Number.NaN)).toBe(0);
      expect(normalizeConfidence("not-a-number")).toBe(0);
    });

    it("falls back to the supplied default when the next confidence is unparseable", () => {
      const original = buildProposal({ confidence: 0.8 });

      expect(applyProposalVersioning(original, 0.9, Number.NaN, BEFORE_EXPIRY).confidence).toBe(0.8);
    });

    it("bounds the applied value as well as the confidence", () => {
      const applied = applyProposalVersioning(buildProposal(), 4.2, 0.6, BEFORE_EXPIRY);

      expect(applied.value).toBe(1);
    });
  });
});
