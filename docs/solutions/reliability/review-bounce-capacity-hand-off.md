---
title: "A capacity-deferred Code Review hand-off must be durable, or it strands the reviewer's work"
date: 2026-10-02
problem_type: reliability
module: "@fusion/engine"
component: review-bounce
tags:
  - lifecycle
  - capacity
  - review
  - self-healing
  - durability
  - fnxc-reviewbouncecapacityhandoff
---

# A capacity-deferred Code Review hand-off must be durable

## The defect

A Code Review REVISE does two things, in this order:

1. `reopenLastStepForRevision` appends a **pending replay occurrence** to the durable step ledger
   (under `stepReopenPolicy: "reopen-trailing"`, and per FN-180 without rewriting the completed
   occurrence it replays).
2. `scheduleWorkflowRerun` fires a best-effort `setTimeout(..., 0)` bounce that moves the card
   review → WIP.

Step 1 is a committed write. Step 2 can lose. When the WIP lane was at capacity, the move threw
`TransitionRejectionError{code:"capacity-exhausted"}`, which `moveTaskWithLifecycleReason` caught and
logged as *"destination at capacity; retrying later"*.

**Nothing retried.** The watchdog bought 15 seconds and one more identical attempt, then deleted its
own `Map` entry (process-local, gone on restart). The result was permanent:

- the replay step stayed `pending` forever;
- `hasNonTerminalSteps` is true, so `getTaskMergeBlocker` correctly returned
  `task has incomplete steps` — **the door was right, the hand-off was broken**;
- **no self-healing sweep was keyed on a non-terminal step.** `hasNonTerminalSteps` appeared in
  `self-healing.ts` only at the import and inside an unrelated `noCommitsExpected` exemption;
- every other revival sweep is keyed on a different shape (`failed pre-merge workflow steps`,
  mergeable-with-no-blocker, `todo` column), so a card with this blocker was skipped by construction;
- `surfaceInReviewStalls` — the one sweep that *could* see it — can only log and dispose.

So a real reviewer rejection was silently converted into `in-review-stall-deadlock`, with one log line
as the only evidence that the retry was coming.

## Two entry points into the same dead end

Worth naming because a fix placed in only one leaves the other stranding cards:

- **`sendTaskBackForFix`** — the self-healing / review-revise path.
- **The graph's own remediation node** — a graph run can end with the REVISE unserved and log
  `Workflow graph run ended in 'in-review' with failed pre-merge step 'Code Review' still blocking
  merge — remediation was not scheduled`, after which a separate self-healing sweep performs the
  revive and appends the step.

The durable write is unconditional; the hand-off is best-effort; nothing reconciled the two when the
hand-off lost.

## The fix reuses three lanes that already existed

This was not a new mechanism. The codebase already solves "a capacity crossing that must not be lost"
three times, and the review → WIP bounce was the one crossing with none of them:

| lane | mechanism |
| --- | --- |
| hold → WIP | **reservation-first** (`SlotReservation` in `hold-release.ts`), plus "stay held so the next sweep re-attempts" on `capacity-exhausted` |
| graph column boundary | **durable continuation** with `waitReason: "capacity"` (`workflow-column-boundary-hooks.ts` `onSuspend`) |
| stranded continuations | `reconcileStrandedWorkflowContinuations` re-queues rows orphaned by a dead process |

The fix routes the bounce through the **durable continuation** seam and adds a **shape-keyed sweep** as
backstop.

### Why not reservation-first here

`reserveSlot` (production: `scheduler.ts`) closes over `activeScopes` / `dormantScopes` /
`leaseWaiverIds` declared **inside the scheduler's dispatch-loop pass**. Grep shows exactly one
production call site. The executor's bounce — which fires from a timer after the graph has yielded —
cannot reach that state, and sharing it would mean extracting scheduler-internal scope-lease state out
of the dispatch loop: a much larger refactor than this defect warrants.

Shipping a no-op reservation would be worse than shipping none: it would make a caller believe a slot
is held when nothing was reserved. **Treat `deferred: "capacity"` as "nobody is coming unless this
caller arranged it."**

### Why the durable continuation actually re-delivers

This is the part worth being sure about, because a continuation that parks but never resumes is a
tidier version of the same bug. It does resume: `drainDuePlanningContinuations` admits **every** due
`kind: "task"` continuation *whatever* its `waitReason` — a fix made after eight cards sat
`waitReason: "capacity"` and were skipped on every poll with no state change and no audit row — and
dispatch is node-agnostic (`executor.execute(task)` re-enters the durable graph at the card's own
node), admission-gated on the real live-task cap.

### The backstop sweep

A continuation is the primary retry path, but not every lost hand-off had one written: the graph's
"remediation was not scheduled" path ends *before* the bounce, and a crash between the durable step
write and the bounce timer is a strictly narrower window. `recoverUndeliveredReviewReplaySteps` is the
backstop, and it is a **separate sweep** because
`recoverReviewTasksWithFailedPreMergeSteps` is gated on a failed pre-merge result existing — a shape
the stranded cards do not always have.

It is **predicate-based**, never a second exact-string blocker match. The exact-string comparison at
the existing sweep (`blocker !== "task has failed pre-merge workflow steps"`) is precisely the coupling
class `merge-blocker-reason-coupling.test.ts` exists to prevent: a blocker *message* is written for an
operator and will be reworded again; the *condition* is what callers mean.

## Naming the cause

The operator previously saw `task has incomplete steps` for a card whose real blocker was "the engine
dropped its own hand-off". `hasUndeliveredReplayStep` asks the different question, from the durable
**shape** available on cards stranded before the provenance field existed:

> trailing step is `pending` **and** its name equals its immediate predecessor's **and** that
> predecessor is terminal.

That surfaces as its own `InReviewStallCode` (`undelivered-replay-step`) and is deliberately **not**
badge-suppressed: the generic `merge-blocker` stays quiet because ordinary unfinished work is quiet,
while this one is the named case where a reviewer's request reached nobody.

## The `replay` provenance field is forward-only

New replay occurrences carry an additive JSONB `replay: { wave, replaysStepIndex }` so they are
distinguishable from their completed siblings.

Two deliberate constraints:

- **Not the `remediation` field.** Its presence makes `parse-steps` preserve the full step list
  forever, permanently blocking a normal re-parse after one review.
- **It revives nothing retroactively.** Already-stranded cards carry name-clone twins with no such
  field, so the predicate and diagnostic had to work from shape. A new field is an improvement for
  future cards, not a recovery mechanism for existing ones.

## Measurements that did not survive contact with the data

Two claims in the original finding were wrong, and both change how you should read a similar report:

- **"All three stranded cards have zero failed pre-merge results."** False for two of three. Two
  carried a `code-review` pre-merge `failed` result with `verdict` absent; only one had none. The
  conclusion was unchanged, but the *stated reason* was wrong — and the distinction is exactly what
  proves a shape with **no** failed result is reachable, which is why the backstop sweep had to be
  separate rather than a widening of the existing one.
- **"Parked once."** False. Each card ran the full deadlock cycle twice: auto-disposed, then **unpaused
  by an operator, then deadlocked again the same day**. An existing self-healing re-seed even ran in
  between and did not help.

That second correction is the strongest evidence the defect is real, and it is also a live control:
**an operator unpause is not a recovery.** The card returns to review, the gate is re-seeded, and the
identical deadlock recurs. Never record "unpaused" as a disposition.

The cleanest available control is one card's own history: the same card, the same mechanism, the same
step name produced a **successful** hand-off on one day (`Lifecycle move: … [source=engine]`, no
"deferred") and a **permanent strand** the next (two `Lifecycle move deferred … (destination at
capacity; retrying later)` lines, then nothing). Same code path; only capacity differed.

## Sibling work

- **FUSI-062** bounds a *recovery-loop* livelock in a different function, column and reason. Fixing it
  makes a stranded card escalate sooner; it does not deliver the pending step. This defect is the
  cause of an un-deliverable replay step.
- **FUSI-057** fixes a review that produced a verdict but persisted as `status:"failed"` with `verdict`
  absent. Different blocker, different code path.
- **FUSI-044** is the operator Retry path — an operator-initiated cycle with visible column churn,
  where this defect has no operator action at all.
- **FUSI-049** owns the unpublished-branch decision for the stranded cards. If a bounce delivers and
  the merge then fails on branch size, that is FUSI-049's finding landing, expectedly.

## The rule

**A committed pending step must never exist without a live path to the executor.**

A durable write of review work and a best-effort hand-off are not two halves of one operation. If the
work is committed first, the *delivery* must be durable too — otherwise "the reviewer asked for work
and nothing happened" is exactly what the operator sees, with a log line promising a retry that never
comes.