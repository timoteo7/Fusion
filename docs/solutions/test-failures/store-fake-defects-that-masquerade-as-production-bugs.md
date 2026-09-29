---
category: test-failures
module: "@fusion/engine, @fusion/core"
date: 2026-07-28
problem_type: convention
component: test-fixtures
severity: high
applies_when:
  - "Hand-rolling a TaskStore fake with vi.fn() for a triage/scheduler/self-healing test"
  - "A new test fails and the production code looks wrong on first reading"
  - "A branch under test appears not to run, or only its first loop iteration runs"
  - "A suite exits non-zero while reporting every test green"
  - "Writing a guard/ratchet and needing to prove it fails on the original defect"
tags:
  - test-fixtures
  - taskstore-fake
  - false-red
  - false-green
  - vitest
  - guard-cannot-fire
---

# Store fakes that lie: six defects that each looked like a production bug

Over six consecutive slices of one unit (U7, workflow-owned lifecycle), **every
single slice produced a test-fixture defect that first presented as a production
bug.** Six for six. Not one was a real defect in the code under test.

Each cost between fifteen minutes and an hour of debugging the wrong file. Two
would have shipped a *false green* — a test that passes while asserting nothing —
if the failure had happened to look plausible instead of implausible.

This is not a story about carelessness. Every one of these fakes was modelled on an
existing fixture in the repo, and the repo's fixtures are inconsistent about exactly
the things that matter.

## The catalogue

| # | Defect | How it presented | Real cause |
|---|---|---|---|
| 1 | `moveTaskIf` fake ignores its predicate and always moves | Test passed. In-transaction guard was untested and indistinguishable from absent | Fake never invoked the callback it was handed |
| 2 | `updateTaskAtomic: vi.fn()` never invokes its callback | *Every* finalize reported "no longer in the planning stage" and bailed before the branch under test | `updatePlanningStateIfStillCurrent` derives success from whether the callback ran |
| 3 | Harness default parameter swallows the interesting input | "Task vanished" case silently became a duplicate of the control | `harness(undefined)` triggers the default; `null` was needed |
| 4 | `logEntry: vi.fn()` returns `undefined` | Sweep appeared to match only one column | Production does `await store.logEntry(...).catch(...)`; `.catch` on `undefined` throws and aborts the loop after its first item |
| 5 | Harness lets `poll()` reach the real `specifyTask` | **Suite exit code 1 with every test green** | Real agent path threw *asynchronously*, after the assertions had passed |
| 6 | `updateTask: vi.fn()` returns `undefined` | Branch under test "did not run" | Same as #4 — `.catch` on a non-promise |

Defects 4 and 6 are the same shape, found a week apart, because nothing prevented
the second.

## The three rules that would have prevented all six

### 1. Every store method a fake exposes must return what the real one returns

Overwhelmingly that means **a promise**. Production code routinely writes
`await store.method(...).catch(handler)` as a fail-soft idiom, and `.catch` on
`undefined` throws a `TypeError` that unwinds to the nearest `try` — which is
usually a broad "never let housekeeping break the poll" handler that swallows it.

```ts
// WRONG — throws on `.catch`, aborts the caller mid-branch
updateTask: vi.fn(),
logEntry: vi.fn(),

// RIGHT
updateTask: vi.fn().mockResolvedValue(undefined),
logEntry: vi.fn().mockResolvedValue(undefined),
```

The symptom is never "your fake is wrong". It is "the loop only processed the first
item" or "the branch didn't run" — both of which read as production bugs.

### 2. A fake that is handed a predicate or callback must invoke it

`moveTaskIf`, `updateTaskAtomic`, `deleteTaskIf`, and `withTaskLock` all take a
function and use its result. A fake that ignores it does not just lose coverage —
it makes the guarded and unguarded implementations **indistinguishable**, so a test
named for the guard cannot detect the guard's removal.

```ts
// WRONG — the conditional move is now unconditional
function createStore(task: Task): TaskStore {
  return {
    moveTaskIf: vi.fn(async (id, column) => ({ moved: true, task })),
  } as unknown as TaskStore;
}

// RIGHT — honors the predicate, and takes a hook for the racing case.
// `onLockedRead` models the row AS THE TASK LOCK SEES IT, which is not
// necessarily the snapshot the caller loaded earlier in the pass.
function createStore(
  task: Task,
  onLockedRead?: (live: Task) => Task,
): TaskStore {
  return {
    moveTaskIf: vi.fn(async (id, column, predicate) => {
      const live = onLockedRead ? onLockedRead(task) : task;
      if (!(await predicate(live))) return { moved: false, task };
      return { moved: true, task: { ...task, column } };
    }),
  } as unknown as TaskStore;
}

// A test that needs the race then supplies the divergence explicitly:
const store = createStore(card, (live) => ({ ...live, status: "awaiting-approval" }));
```

The `onLockedRead` hook matters: an in-transaction re-check exists to catch state
that changed *after* the caller's snapshot. Without a way to make the locked read
differ from the snapshot, the recheck is untestable even once the predicate is
invoked.

### 3. Stub the agent-dispatch boundary, or the real one runs past your assertion

Triage's `poll()`, the scheduler's dispatch, and the continuation drain all end in
"start an agent". In a unit test that reaches module-mocked provider code and
throws **after** the test has resolved.

```ts
vi.spyOn(processor as unknown as { specifyTask: (t: Task) => Promise<void> }, "specifyTask")
  .mockResolvedValue(undefined);
```

This is the one that produces a *false green*: `Tests 17 passed`, `exit code 1`. On
CI that reads as infrastructure noise.

> **Never accept a non-zero exit on a green run.** It is the only signal that
> something escaped your assertions entirely.

## How to tell a fixture defect from a real bug, fast

The tell is **failing for the wrong reason**. Before editing production code, ask:

1. Does the failure message match the hypothesis the test was written to check? If
   the test is about column resolution and the error is `Cannot read properties of
   undefined (reading 'catch')`, it is the fixture.
2. Does the *control* case fail too? A conversion test that runs the same scenario
   under default and renamed vocabularies should fail only on the renamed half. If
   both fail, suspect the harness — the default half is asserting today's shipped
   behavior, which is by definition working.
3. Did *only the first* item of a loop get processed? Almost always rule 1.

Point 2 is why **differential tests are worth writing even when they feel
redundant**: the control half doubles as a fixture self-check.

## The connected lesson: guards that cannot fire

The same failure mode appears in production guards, not just fixtures. On this
program six guards were found that could not fire — a flag whose body was
`return true`, a ratchet matching only a double-quoted literal, a scope list that
excluded two packages that needed it.

The discipline is identical in both cases:

> **Prove the check fails on the thing it claims to catch, before trusting that it
> passes.**

For a test: revert your production change and confirm the test goes red, and read
*which* cases went red. For a ratchet: inject the violation into real source, in the
form most likely to evade it — and confirm the injection actually landed before
trusting the red. (One injection attempt on this program silently failed to apply,
leaving a green run that would have "proven" the ratchet worked.)

## Recommended next step

The rules above want to be a shared helper —
`createTaskStoreFake({ tasks, workflowIr })` returning promise-resolving,
callback-invoking defaults — rather than prose each unit rediscovers. That is a
single small PR and it removes the whole class. It is not built yet because it is
cross-unit and needs adopters; if you are about to hand-roll a seventh store fake,
build it instead and link it here.

## FN-8949: complete self-healing fake call surfaces

`self-healing-query-filter-blindness.test.ts` required both
`transitionQueuedEpisode: vi.fn(async () => ({ appended: true }))` and
`peekMergeQueue: vi.fn(async () => [])`. The first tracks the current queued
`blockedBy` transition seam; the second prevents `surfaceInReviewStalls` from
throwing before its renamed-lane assertion. The merge-queue-peek addition was
**kept**: it changed no per-case verdict while removing the missing-method path.

See `dead-vi-mock-specifiers-fail-silently.md` for the related case where a mock
factory is unwired rather than a store fake being incomplete.

## FUSI-034: a prototype-only fake, and four more drifts that each looked like a product bug

The `assertion-no-error-line` family (FUSI-020 Step 5, family 5 of 7) resolved six
red engine suites, and five of them are this same catalogue: a hand-maintained test
double drifted from a contract that moved, and the drift surfaced as an assertion
failure attributed to production code.

**The tell.** A `TypeError: Cannot read properties of undefined (reading 'has')`
surfacing from deep inside `project-engine.ts` is a **test-double** defect, not a
product crash. `internalEnqueueMerge` read `this.mergeRetryResetTaskIds.has(taskId)`
on a receiver built by `Object.create(ProjectEngine.prototype)`, which runs **no
class field initializers**, so every merge-lane field was `undefined`. A production
`ProjectEngine` always has them. The two `Set` fields were added by FN-9317
(`706c15560`); `_project-engine-merge-lane-fixture.ts` — whose own FNXC note exists
precisely to prevent this drift — never learned them. This is the **second** time
this fixture family has fallen behind production; the first was FUSI-030's missing
`getTask` collaborator. The disappearance of the 5 unhandled rejections alongside the
8 assertion failures is the tell that they were one defect surfacing on two paths.

**The rule that generalises.** When a class field is added to a production class
whose instances are faked via `Object.create(Prototype)` plus a hand-maintained state
fixture, the fixture is now wrong — and `tsc` cannot see it. `packages/engine/tsconfig.json`
is `{"include": ["src/**/*"], "exclude": ["src/__tests__/**/*"]}`, and these fakes are
`as any`/`as never` cast anyway, so `pnpm verify:fast` is structurally blind to them and
returns 0 whether the fixture is complete or not. **The only detector is running the
suites.** A green typecheck is not evidence that a fake matches its class.

Walking the full class-field diff (FN-5893) found a second latent gap the ratchet had
not caught: `mergeBodySettleTimeoutMs` is declared at `project-engine.ts:1015` and read
at `:1037`, *outside* the region the existing drift ratchet scans. Left undefined, the
wait collapses to roughly 1 ms instead of the production 60 s, so any test that exercises
the settle would have raced silently rather than failing loudly.

**The post-merge evidence shape.** A completion guard that reads the workflow IR
(`getRequiredPostMergeEvidenceBlocker`, FN-9370) turns *any* test store that exposes
`getTaskWorkflowSelection` into a fixture that must also declare its post-merge gate
evidence — the guard early-outs entirely when that method is absent, so exposing it for
an unrelated reason silently opts the fake into a contract it never satisfied. Two
suites drifted on the same change in the same way: one went from `expected 'blocked' to
be 'done'`, the other from a merge-region node list that was one entry short. Note the
direction: these are **completeness** defects, not the missing-method defects in the
catalogue above. Exposing a method is not free.

**The environment shape.** A `password authentication failed for user "<os-user>"`
during `CREATE DATABASE` is a **provisioning gap, not a test defect**. The fixture's
maintenance URL defaults to `postgresql://localhost:5432` with no user or password, so
the client authenticates as the OS user (`mini` locally, `runner` in CI); CI is green
only because the workflows pass `FUSION_PG_TEST_URL_BASE` with an explicit `postgres`
user (`full-suite.yml:44-45`, `pr-checks.yml:206-207`). Route this to provisioning. Do
**not** wrap `createPgLayer` in `try`/`catch` or teach the fixture to tolerate auth
failure — that deletes the coverage the fixture exists to provide, and it converts a
loud provisioning error into a silently skipped suite.

**A fourth drift, from the same class, worth its own line:** a review gate's identity
is its **optional group id**, not the inner template step id, because the executor
resolves `effectiveWorkflowStepId = optionalGroupId ?? id.replace(/^graph:/, "")`. An
audit assertion and a persisted-result fixture both encoded `"code-review-step"` /
`"plan-review-step"` and went red together. When a test asserts an id that a
constructed fixture *also* sets, derive it from the fixture's own field rather than
retyping the literal — the drift is invisible precisely because the two copies agree
with each other and disagree with production.

## Related

- `docs/testing.md` — testing lanes and the taxonomy for trim-vs-keep.
- AGENTS.md → "Standing Rule: Fix the Invariant, Not the Repro" — the same
  discipline applied to regression coverage.
- `docs/solutions/test-failures/optional-flags-seam-hides-unconverted-column-guards.md` — the mirror
  image of this entry. HERE a fake is MISSING a method, so a branch silently does not run. THERE the
  fake is complete and the test is correct, but an OPTIONAL parameter is omitted, so the production path
  takes its documented legacy fallback and the suite stays green through a conversion AND through a
  broken one.
