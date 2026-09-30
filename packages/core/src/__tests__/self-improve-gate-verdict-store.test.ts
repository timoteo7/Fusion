import { describe, expect, it } from "vitest";
import { TaskStore } from "../store.js";
import { SELF_IMPROVE_RUN_AUDIT_EVENTS } from "../self-improve/self-improve-run-audit.js";
import { resolveLearningGateVerdict } from "../self-improve/learning-gate-verdict-types.js";
import type { LearningGateVerdictInput } from "../types/self-improve/learning-gate-verdict.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import type { RunAuditEventInput } from "../types/audit/run-audit.js";

/*
FNXC:SelfImproveGateVerdict 2026-09-30-15:26:
FUSI-020 Step 3's store-level contract, proven against a real TaskStore with an injected fake
AsyncDataLayer. The pg suite (self-improve-gate-verdicts.pg.test.ts) proves the DURABLE shape against
a real database; this suite owns the parts a database cannot show:

  - the store DELEGATES to the accessor and returns its result unchanged;
  - the store emits the audit façade UNAWAITED, so the recorded verdict never waits on telemetry;
  - the emitted metadata mirrors the COMMITTED row (stored primary/canary), not the caller's raw
    input, so the audit row can never disagree with the durable verdict;
  - an `already-recorded` re-attempt still emits, with the fixed `already-recorded` outcome, so a
    repeat is visible as a repeat;
  - the three READERS are EMISSION-FREE — a pure lookup must not write a run-audit row, or "how
    many times did someone LOOK at this experiment?" would be indistinguishable from "how many
    times did the gate JUDGE it?", the exact distinction this record exists to preserve.

The fake db is a chainable stub implementing ONLY the Drizzle surface the accessor touches
(select/insert). It is intentionally minimal: if the accessor starts using another query builder
method, the cast stops type-checking and this suite is forced to teach the stub about it, which is
the maintenance cost of proving the store contract without a database.
*/

const PROJECT_ID = "proj_gate_store";

/** A primary-signal set whose every lane is green and whose budget invariants held -> KEEP. */
const greenSignals: LearningGateVerdictInput["primarySignals"] = {
  buildOk: true,
  lintOk: true,
  typecheckOk: true,
  gateOk: true,
  affectedTestsOk: true,
  testCountDelta: 0,
  costBudgetInvariantOk: true,
  corpusVersion: "corpus-v3",
  seed: 7,
};

/** A primary-signal set with a failed lane -> REVERSE, the primary gate's decisive signal. */
const redSignals: LearningGateVerdictInput["primarySignals"] = { ...greenSignals, lintOk: false };

type InsertRow = Record<string, unknown>;

/**
 * A minimal Drizzle chain stub over an in-memory verdict table.
 *
 * `onConflictDoNothing` models the real partial-unique behaviour the table's primary key gives:
 * a repeat insert of a verdict id already present yields ZERO returned rows, which is exactly how
 * the accessor learns the judgment was already recorded.
 */
function fakeDb(table: InsertRow[]): AsyncDataLayer["db"] {
  const matches = (row: InsertRow, where: unknown): boolean => {
    // The accessor only ever filters on the row's own columns, so a shallow identity match on the
    // captured predicate is unnecessary: an empty where means "all rows", which the stub models as
    // the whole table. Selects in this suite are only used to prove emission-freedom.
    void where;
    return true;
  };
  const db = {
    insert: () => {
      let pending: InsertRow = {};
      const chain = {
        values(values: InsertRow) { pending = values; return chain; },
        onConflictDoNothing() {
          return {
            async returning() {
              const verdictId = pending.verdictId as string;
              if (table.some((row) => row.verdictId === verdictId)) return [];
              const row = { ...pending };
              table.push(row);
              return [row];
            },
          };
        },
      };
      return chain;
    },
    select: () => {
      const chain = {
        from: () => chain,
        where: (where: unknown) => { void where; return chain; },
        orderBy: () => chain,
        limit: () => chain,
        offset: () => chain,
        // A bare select is only the count-probe or a reader; both resolve to a resolved-thenable.
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(table.filter(matches)).then(resolve),
      };
      return chain as never;
    },
  };
  return db as never;
}

/** A store bound to a fake layer, with its run-audit seam captured. */
function storeWithCapturedAudit(table: InsertRow[]) {
  const events: RunAuditEventInput[] = [];
  const store = new TaskStore("/tmp/fusi-020-gate-store", undefined, {
    asyncLayer: { projectId: PROJECT_ID, db: fakeDb(table) } as never,
  } as never);
  // The store emits through itself; a spy over the seam observes every attempt synchronously,
  // because the façade invokes recordRunAuditEvent before its first await.
  const seam = captureAuditSeam(store, events);
  return { store, events, seam };
}

/** Attach a capturing run-audit seam to a store, and return a teardown. */
function captureAuditSeam(store: TaskStore, events: RunAuditEventInput[]) {
  const original = (store as unknown as { recordRunAuditEvent?: unknown }).recordRunAuditEvent;
  Object.defineProperty(store, "recordRunAuditEvent", {
    configurable: true,
    value: (event: RunAuditEventInput) => { events.push(event); },
  });
  return () => {
    if (original) Object.defineProperty(store, "recordRunAuditEvent", { configurable: true, value: original });
    else Reflect.deleteProperty(store as object, "recordRunAuditEvent");
  };
}

const verdictInput = (signals: LearningGateVerdictInput["primarySignals"], canaryVerdict: "keep" | "reverse" | null = null): LearningGateVerdictInput & { occurredAt?: string } => ({
  experimentId: "exp-1",
  baselineId: "base-1",
  primarySignals: signals,
  canaryVerdict,
  occurredAt: "2026-09-30T12:00:00.000Z",
});

describe("TaskStore learning gate verdicts (FUSI-020 Step 3)", () => {
  it("records a verdict and returns the accessor's result", async () => {
    const table: InsertRow[] = [];
    const { store, events, seam } = storeWithCapturedAudit(table);
    try {
      const result = await store.recordLearningGateVerdict(verdictInput(greenSignals));
      expect(result.outcome).toBe("recorded");
      expect(result.resolution.resolvedVerdict).toBe("keep");
      expect(table).toHaveLength(1);
    } finally { seam(); }
  });

  it("reports already-recorded on an identical re-record and appends nothing", async () => {
    const table: InsertRow[] = [];
    const { store, seam } = storeWithCapturedAudit(table);
    try {
      await store.recordLearningGateVerdict(verdictInput(greenSignals));
      const again = await store.recordLearningGateVerdict(verdictInput(greenSignals));
      expect(again.outcome).toBe("already-recorded");
      expect(table).toHaveLength(1);
    } finally { seam(); }
  });

  it("mirrors the STORED primary/canary in the audit row, not the caller's input", async () => {
    const table: InsertRow[] = [];
    const { store, events, seam } = storeWithCapturedAudit(table);
    try {
      // A decisive primary REVERSE with a canary that would have said KEEP: the stored row carries
      // primary=reverse, canary=keep, resolved=reverse. The audit must report that stored triple.
      await store.recordLearningGateVerdict(verdictInput(redSignals, "keep"));
      const event = events.find((e) => e.mutationType === SELF_IMPROVE_RUN_AUDIT_EVENTS.gateVerdict);
      expect(event).toBeDefined();
      expect(event!.metadata).toMatchObject({
        experimentId: "exp-1",
        baselineId: "base-1",
        primaryVerdict: "reverse",
        canaryVerdict: "keep",
        resolvedVerdict: "reverse",
        outcome: "recorded",
      });
      // The precedence outcome is the observable that records the primary gate WON over the canary.
      expect(event!.metadata.precedenceOutcome).toBe(
        resolveLearningGateVerdict("reverse", "keep").precedenceOutcome,
      );
    } finally { seam(); }
  });

  it("emits once per attempt, so a repeat is visible as a repeat", async () => {
    const table: InsertRow[] = [];
    const { store, events, seam } = storeWithCapturedAudit(table);
    try {
      await store.recordLearningGateVerdict(verdictInput(greenSignals));
      await store.recordLearningGateVerdict(verdictInput(greenSignals));
      const emitted = events.filter((e) => e.mutationType === SELF_IMPROVE_RUN_AUDIT_EVENTS.gateVerdict);
      expect(emitted).toHaveLength(2);
      expect(emitted.map((e) => e.metadata.outcome)).toEqual(["recorded", "already-recorded"]);
    } finally { seam(); }
  });

  it("writes no run-audit row for the pure readers", async () => {
    const table: InsertRow[] = [];
    const { store, events, seam } = storeWithCapturedAudit(table);
    try {
      await store.recordLearningGateVerdict(verdictInput(greenSignals));
      const before = events.length;
      await store.readLearningGateVerdictByExperiment("exp-1");
      await store.readLearningGateVerdictByBaseline("base-1");
      await store.listLearningGateVerdicts();
      expect(events.length).toBe(before);
    } finally { seam(); }
  });
});
