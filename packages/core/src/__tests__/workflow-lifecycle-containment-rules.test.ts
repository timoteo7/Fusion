/*
FNXC:LifecycleContainment 2026-09-26-00:00 (FUSI-036):

THE SERVER-FREE OWNER OF THE FN-207/FN-217 CONTAINMENT INVARIANT.

Both census cases of the `lifecycle-transition-forbidden` family reach the guard
through a REAL PostgreSQL store, inside `pgDescribe`. That makes the invariant
observable only on a machine with a provisioned database — and `pnpm pg:test:up`
refuses with `refuse-unprovable` wherever the cluster's ownership cannot be proven,
so on those machines the suites AUTO-SKIP and report "N skipped", which reads like
green and proves nothing. A containment rule that is only testable through a
database is a containment rule that is only enforced where a database happens to
be.

So the invariant is pinned HERE instead, at the layer that owns it, and this file
needs no server, no `pgDescribe`, no harness, and no store. FN-5893: assert the
invariant across every surface that can violate it, not only the two that were
observed failing. A change to the rank table or the reason table now fails HERE —
naming the rule — in milliseconds, instead of surfacing as two PG suites that may
be skipped on the machine where it happened.

`workflow-lifecycle-direction.ts` is a pure, dependency-free module over plain role
and flag values, and `workflow-transition-policy.ts` adds only the postcondition
that reads it. That is what makes server-free coverage possible at all.

WHAT IS DELIBERATELY NOT HERE: the store-level integration (a `recoveryRehome`
move out of a terminal lane, a renamed board's review lane) stays in the two PG
suites. This file pins the POLICY, not the wiring, and duplicating the wiring here
would only re-create the machine dependency it exists to remove.
*/
import { describe, expect, it } from "vitest";
import {
  ENGINE_BACKWARD_MOVE_REASONS,
  LIFECYCLE_ROLE_RANK,
  classifyLifecycleDirection,
  classifyLifecycleRole,
  evaluateForbiddenLifecyclePath,
  isSanctionedEngineBackwardMove,
  type EngineBackwardMoveReason,
  type LifecycleRole,
} from "../workflows/workflow-lifecycle-direction.js";
import { evaluateLifecycleDirectionPostcondition } from "../workflows/workflow-transition-policy.js";
import type { TraitFlags } from "../workflows/trait-types.js";

/** The trait flags each policy role is reached through, in the default lineage. */
const ROLE_FLAGS: Record<LifecycleRole, TraitFlags> = {
  intake: { intake: true },
  hold: { hold: true },
  wip: { countsTowardWip: true },
  review: { mergeBlocker: true, humanReview: true },
  complete: { complete: true },
  archived: { archived: true },
};

/** A renamed review lane — the case 2 shape, whose refusal is a census row. */
const RENAMED_REVIEW: TraitFlags = { mergeOrchestration: true, mergeBlocker: true };

/**
 * A policy decision for one move. Defaults to `moveSource: "engine"` because the
 * guard binds exactly the automatic sources; the source-scoping case overrides it
 * (including with an explicit `undefined`, which the spread still applies).
 */
function decision(
  from: { columnId: string; flags: TraitFlags },
  to: { columnId: string; flags: TraitFlags },
  options: { moveSource?: "user" | "engine" | "scheduler"; lifecycleReason?: string } = {},
) {
  return evaluateLifecycleDirectionPostcondition({
    taskId: "FN-217-policy",
    from,
    to,
    mergeBlockerReason: null,
    moveSource: "engine",
    ...options,
  });
}

/**
 * Column facts for one policy role, under an optional real column id. The two are
 * separate parameters because the policy reads ROLES (from traits) while the
 * rejection message reads COLUMN IDS — conflating them is precisely the bug the
 * renamed-lane case exists to rule out, so the helper keeps them distinct.
 */
function byId(role: LifecycleRole, columnId?: string) {
  return { columnId: columnId ?? role, flags: ROLE_FLAGS[role] };
}

describe("FN-217 containment policy — the rules", () => {
  it("F1: an automatic move may never target intake, from ANY role", () => {
    /*
    The census has no F1 row, so nothing else would notice if this branch were
    reordered behind F2 — a `complete -> intake` gap of 4 would then report F2 and
    the intake ban would read as a rank rule. Cover every source role, forward and
    backward alike: the rule is about the TARGET, not the direction.
    */
    for (const from of Object.keys(ROLE_FLAGS) as LifecycleRole[]) {
      expect(evaluateForbiddenLifecyclePath(from, "intake")?.rule).toBe("F1");
    }
  });

  it("F2: an automatic move may not step backward more than one rank", () => {
    /*
    Every pair whose rank gap exceeds 1, not just the two the census caught. The
    gap is computed from the table, so this also pins the TABLE: a reordering of
    LIFECYCLE_ROLE_RANK (or a role added to it) that widened a legal single step
    would fail here rather than at a store.

    Rule PRECEDENCE is asserted too, because the deny-list is ordered and the
    first match wins: a pair that trips two rules reports the earlier one. `wip ->
    intake` has a gap of 2, so F2 would apply, but the target is the intake role,
    so F1 reports first. Asserting only "some rule fires" would let a reordering
    swap which rule a real move is attributed to without failing anything here —
    and the message a card's operator sees names that rule.
    */
    const roles = Object.keys(ROLE_FLAGS) as LifecycleRole[];
    for (const from of roles) {
      for (const to of roles) {
        if (to === "intake") continue; // F1 owns every intake target; asserted above.
        if (classifyLifecycleDirection(from, to) !== "backward") continue;
        // Direction, not arithmetic: `review -> archived` is FORWARD yet still
        // forbidden (by F3), so a gap-only test would silently drop it from F2's
        // scope and F2 would look complete while owning one pair too few.
        const gap = LIFECYCLE_ROLE_RANK[from] - LIFECYCLE_ROLE_RANK[to];
        if (gap > 1) {
          // A terminal source is still F2, not F4: the deny-list checks the rank gap
          // before the terminal-lane rule, so `complete -> wip` is attributed to F2.
          expect(evaluateForbiddenLifecyclePath(from, to)?.rule, `${from} -> ${to} (gap ${gap})`).toBe("F2");
        } else {
          // A single-rank backward step: F5 only for the one route it names, and
          // F4 only for the terminal sources (asserted in their own cases).
          const rule = evaluateForbiddenLifecyclePath(from, to)?.rule;
          expect(["F5", "F4", undefined], `${from} -> ${to} is ${rule}`).toContain(rule);
        }
      }
    }
    // F1 pre-empts F2 on an intake target, stated on the pair where both apply.
    expect(LIFECYCLE_ROLE_RANK.wip - LIFECYCLE_ROLE_RANK.intake).toBeGreaterThan(1);
    expect(evaluateForbiddenLifecyclePath("wip", "intake")?.rule).toBe("F1");
  });

  it("F2: rejects both census pairs verbatim, naming the rule and both roles", () => {
    // Row 1: live-move-path-undeclared-target.test.ts — archived (5) -> hold (1).
    expect(decision(byId("archived"), byId("hold", "todo"))).toMatchObject({
      code: "guard-rejected",
      messageKey: "transition.rejected.forbiddenLifecyclePath",
      retryable: false,
    });
    // Row 2: renamed-board-reopen.pg.test.ts — a RENAMED review lane (3) -> hold (1).
    // Traits, not ids: the renamed lane is refused by exactly the same rule.
    const renamedBounce = decision(
      { columnId: "checking", flags: RENAMED_REVIEW },
      { columnId: "queued", flags: ROLE_FLAGS.hold },
    );
    expect(renamedBounce?.messageKey).toBe("transition.rejected.forbiddenLifecyclePath");
    expect(renamedBounce?.detail).toContain("F2");
    expect(renamedBounce?.detail).toContain("'checking' (review)");
    expect(renamedBounce?.detail).toContain("'queued' (hold)");
  });

  it("F3: a review-lane card may not skip completion and archive directly", () => {
    expect(evaluateForbiddenLifecyclePath("review", "archived")?.rule).toBe("F3");
    // And the one adjacent legal step, so "review cannot reach archived" is not
    // satisfied by something that also blocks review -> complete.
    expect(evaluateForbiddenLifecyclePath("review", "complete")).toBeNull();
  });

  it("F4: a terminal-lane card may not move backward automatically, at all", () => {
    /*
    F4 is the only rule with no rank condition, but the deny-list is ORDERED, so
    F2 claims every terminal departure whose rank gap exceeds one. Only
    `complete -> review` (4 -> 3, a single rank) actually reaches F4; `archived ->
    review` is a gap of 2 and is reported as F2. Asserting F4 across the whole
    terminal surface would just re-assert F2 under another name, and would go red
    the moment the rules were reordered — the kind of over-broad expectation that
    gets deleted to reach green. So: the one pair F4 owns, plus an exhaustive
    census proving nothing else is attributed to it.
    */
    expect(evaluateForbiddenLifecyclePath("complete", "review")?.rule).toBe("F4");
    // `complete -> archived` is the one forward step out of a terminal lane, and it
    // is legal. `archived -> complete` is NOT: it is a single-rank step BACKWARD
    // (5 -> 4), so F4 owns it. There is no forward lane above `archived` at all,
    // which is the point of calling it terminal.
    expect(evaluateForbiddenLifecyclePath("complete", "archived")).toBeNull();
    expect(evaluateForbiddenLifecyclePath("archived", "complete")?.rule).toBe("F4");
    // No pair other than these three is attributed to F4; the rest of the terminal
    // surface is F2's, and F2 is asserted exhaustively in its own case.
    const roles = Object.keys(ROLE_FLAGS) as LifecycleRole[];
    const f4Pairs = roles.flatMap((from) => roles.map((to) => ({ from, to })))
      .filter(({ from, to }) => evaluateForbiddenLifecyclePath(from, to)?.rule === "F4")
      .map(({ from, to }) => `${from}->${to}`)
      .sort();
    expect(f4Pairs).toEqual(["archived->complete", "complete->review"]);
  });

  it("F5: WIP returns to a hold lane only for Plan Review REVISE", () => {
    expect(evaluateForbiddenLifecyclePath("wip", "hold")?.rule).toBe("F5");
    expect(evaluateForbiddenLifecyclePath("wip", "hold", "plan-review-revise-replan")).toBeNull();
    // No OTHER registered reason may unlock it — the ban is on the route, and a
    // reason explains a move rather than authorizing one.
    for (const reason of Object.keys(ENGINE_BACKWARD_MOVE_REASONS)) {
      if (reason === "plan-review-revise-replan") continue;
      expect(
        evaluateForbiddenLifecyclePath("wip", "hold", reason)?.rule,
        `wip -> hold with ${reason}`,
      ).toBe("F5");
    }
  });

  it("keeps the forward lifecycle and the sanctioned one-rank step legal", () => {
    // The direction that matters most: a guard that refused too much would break the
    // ordinary lifecycle, which is far worse than the defect it prevents.
    expect(classifyLifecycleDirection("intake", "hold")).toBe("forward");
    expect(classifyLifecycleDirection("hold", "wip")).toBe("forward");
    expect(classifyLifecycleDirection("wip", "review")).toBe("forward");
    expect(classifyLifecycleDirection("review", "complete")).toBe("forward");
    expect(classifyLifecycleDirection("complete", "archived")).toBe("forward");
    expect(evaluateForbiddenLifecyclePath("review", "wip")).toBeNull();
    expect(evaluateForbiddenLifecyclePath("wip", "review")).toBeNull();
    expect(evaluateForbiddenLifecyclePath("hold", "wip")).toBeNull();
  });

  it("derives roles from each column's own trait flags, so a rename obeys the same rule", () => {
    // This is the property renamed-board-reopen.pg.test.ts exists to prove, pinned
    // here where it is cheap: three different column ids carrying review traits
    // are all rank 3, and all three are refused identically on the way to a hold.
    for (const columnId of ["in-review", "checking", "signoff", "qa"]) {
      expect(classifyLifecycleRole({ mergeBlocker: true })).toBe("review");
      expect(evaluateForbiddenLifecyclePath("review", "hold")?.rule).toBe("F2");
      expect(decision(
        { columnId, flags: { mergeBlocker: true } },
        { columnId: "todo", flags: ROLE_FLAGS.hold },
        { moveSource: "engine" },
      )?.messageKey).toBe("transition.rejected.forbiddenLifecyclePath");
    }
    // A trait-less column has no role, so the policy declines to invent one.
    expect(classifyLifecycleRole({})).toBeUndefined();
    expect(evaluateForbiddenLifecyclePath(undefined, "hold")).toBeNull();
  });
});

describe("FN-217 containment policy — who it binds", () => {
  it("binds engine and scheduler sources, and no one else", () => {
    /*
    The asymmetry that makes the guard usable rather than a blanket. The identical
    `review -> hold` pair the engine path is rejected for is allowed for a human,
    because `evaluateLifecycleDirectionPostcondition` returns `null` on the first
    line for a non-engine, non-scheduler source. A rename-board-reopen.pg.test.ts
    case demonstrates the same thing end to end through a real store; this is the
    server-free half of that contrast.
    */
    const from = { columnId: "checking", flags: RENAMED_REVIEW };
    const to = { columnId: "queued", flags: ROLE_FLAGS.hold };

    expect(decision(from, to, { moveSource: "engine" })?.messageKey)
      .toBe("transition.rejected.forbiddenLifecyclePath");
    expect(decision(from, to, { moveSource: "scheduler" })?.messageKey)
      .toBe("transition.rejected.forbiddenLifecyclePath");
    for (const moveSource of ["user", undefined] as const) {
      expect(decision(from, to, { moveSource }), `moveSource ${moveSource}`).toBeNull();
    }
  });

  it("a registered reason still cannot authorize a structurally forbidden route", () => {
    // The order of operations: the deny-list runs BEFORE reason registration, so a
    // reason can explain a legal step backward but never authorize an illegal one.
    for (const reason of Object.keys(ENGINE_BACKWARD_MOVE_REASONS)) {
      expect(
        decision(byId("archived"), byId("hold", "todo"), { moveSource: "engine", lifecycleReason: reason })
          ?.messageKey,
        `archived -> hold with ${reason}`,
      ).toBe("transition.rejected.forbiddenLifecyclePath");
    }
  });

  it("each revision reason authorizes exactly its declared role pair, and nothing else", () => {
    for (const [reason, definition] of Object.entries(ENGINE_BACKWARD_MOVE_REASONS)) {
      const { from: declaredFrom, to: declaredTo, sameRoleOnly } = definition as EngineBackwardMoveReason;
      for (const from of Object.keys(ROLE_FLAGS) as LifecycleRole[]) {
        for (const to of Object.keys(ROLE_FLAGS) as LifecycleRole[]) {
          const inFrom = declaredFrom === "any" || (declaredFrom as readonly LifecycleRole[]).includes(from);
          const inTo = declaredTo === "any" || (declaredTo as readonly LifecycleRole[]).includes(to);
          /*
          Three conjuncts, matching `isSanctionedEngineBackwardMove` exactly:
          the reason must exist, `sameRoleOnly` must not be violated by a role
          change, and the pair must be the one the reason declares. Stating it as
          one formula rather than a same-role special case is what keeps this
          honest — a `sameRoleOnly` reason whose `from`/`to` sets were ever widened
          to differ would immediately fail here instead of quietly becoming a
          backward-move escape hatch.
          */
          expect(isSanctionedEngineBackwardMove(reason, from, to), `${reason}: ${from} -> ${to}`)
            .toBe((!sameRoleOnly || from === to) && inFrom && inTo);
        }
      }
    }
  });

  it("a sameRoleOnly reason crossing roles authorizes NOTHING, so recovery is never an escape hatch", () => {
    /*
    The group that stops this family recurring. Every recovery reason in the table is
    `sameRoleOnly: true` precisely so a repair sweep cannot re-introduce a backward
    move by registering a new reason: cleanup, timeout, dependency, contamination,
    branch, worktree, session, stranded, and capacity recovery all stay in the role
    they are already in. If one of these ever authorized a role change, the F2/F4
    census failures would return through a different door.

    Note the pairing of the two assertions. Crossing BACKWARD is a policy rejection
    (`unsanctionedLifecycleMove`) when the route is not itself structurally
    forbidden, and a structural rejection (`forbiddenLifecyclePath`) when it is.
    Crossing FORWARD or laterally is simply allowed — a forward move needs no
    backward authority at all, and requiring one would break the ordinary lifecycle.
    So the reason is never *consulted* off its role, and a backward crossing is
    refused whichever rule catches it first.
    */
    /*
    The table is split by KIND, and the split is asserted exactly rather than by
    count. A `>= 7` floor catches a reason vanishing but cannot say which one, and
    it would not catch a reason being RECLASSIFIED — widening one recovery reason so
    it can change roles leaves the count at 8 while quietly handing that sweep
    authority it must never have. Verified: that edit turns this exact list red with
    the offending reason named. So the invariant is the whole partition — the four
    revision reasons and nothing else, versus every recovery reason and nothing
    else — and a new reason must be declared on the correct side of it.
    */
    const REVISION_REASONS = [
      "code-review-revise-remediation",
      "verification-failure-remediation",
      "merge-fix-remediation",
      "plan-review-revise-replan",
    ] as const;
    const RECOVERY_REASONS = [
      "merge-failure-rebound",
      "self-healing-worktree-reclaim",
      "self-healing-stranded-recovery",
      "self-healing-dependency-rebound",
      "self-healing-session-recovery",
      "contamination-recovery",
      "branch-worktree-recovery",
      "capacity-hold-return",
    ] as const;

    // Every entry is one or the other, and the two sets are exhaustive over the
    // table — so a reason cannot be added, removed, or moved between kinds silently.
    expect([...REVISION_REASONS, ...RECOVERY_REASONS].sort())
      .toEqual(Object.keys(ENGINE_BACKWARD_MOVE_REASONS).sort());

    /*
    A reason is ROLE-FIXED when it authorizes no change of role at all, and the
    table pins that two ways: the `sameRoleOnly` flag, and declaring identical
    `from`/`to` sets. `merge-failure-rebound` uses the second (`review` -> `review`),
    the self-healing family uses the first. Asserting the flag alone would have
    called `merge-failure-rebound` a violation; asserting the sets alone would have
    called the family wrong. So the property is asserted directly, and both
    mechanisms are named as the ways to achieve it — a third way, or a widened set,
    fails here with the reason named.
    */
    const roles = Object.keys(ROLE_FLAGS) as LifecycleRole[];
    for (const reason of RECOVERY_REASONS) {
      for (const from of roles) {
        for (const to of roles) {
          if (from === to) continue;
          expect(isSanctionedEngineBackwardMove(reason, from, to), `${reason}: ${from} -> ${to}`).toBe(false);
        }
      }
    }
    // And the reasons that are NOT role-fixed are exactly the four revisions, so a
    // recovery reason cannot be added to the wrong side of the partition.
    const notRoleFixed = Object.keys(ENGINE_BACKWARD_MOVE_REASONS).filter((reason) =>
      roles.some((from) => roles.some((to) => from !== to && isSanctionedEngineBackwardMove(reason, from, to))),
    );
    expect(notRoleFixed.sort()).toEqual([...REVISION_REASONS].sort());

    for (const reason of RECOVERY_REASONS) {
      for (const from of Object.keys(ROLE_FLAGS) as LifecycleRole[]) {
        for (const to of Object.keys(ROLE_FLAGS) as LifecycleRole[]) {
          if (from === to) continue;
          // A BACKWARD crossing is refused, whichever rule catches it first.
          if (classifyLifecycleDirection(from, to) !== "backward") continue;
          expect(decision(byId(from), byId(to), { moveSource: "engine", lifecycleReason: reason }), reason)
            .not.toBeNull();
        }
      }
    }
  });

  it("rejects an unsanctioned single-rank backward step while permitting a sanctioned one", () => {
    // The second, softer half of the policy: F2/F4 are structural, but a one-rank
    // backward step still needs a revision behind it (AGENTS.md: "Only a revision
    // may move a card backward"). Both sides are asserted so neither can be lost.
    expect(decision(byId("review"), byId("wip", "in-progress"), { moveSource: "engine" })?.messageKey)
      .toBe("transition.rejected.unsanctionedLifecycleMove");
    expect(decision(byId("review"), byId("wip", "in-progress"), {
      moveSource: "engine",
      lifecycleReason: "code-review-revise-remediation",
    })).toBeNull();
    expect(decision(byId("wip"), byId("hold", "todo"), {
      moveSource: "engine",
      lifecycleReason: "plan-review-revise-replan",
    })).toBeNull();
    // A reason the table does not know is no reason at all.
    expect(decision(byId("review"), byId("wip", "in-progress"), {
      moveSource: "engine",
      lifecycleReason: "workflow-retry-rehome",
    })?.messageKey).toBe("transition.rejected.unsanctionedLifecycleMove");
  });
});
