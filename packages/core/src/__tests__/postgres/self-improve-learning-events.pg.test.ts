import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import * as schema from "../../postgres/schema/index.js";
import { createLearningProposal } from "../../self-improve/ledger-schema.js";
import { SELF_IMPROVE_RUN_AUDIT_EVENTS } from "../../self-improve/self-improve-run-audit.js";
import { CORE_RUN_AUDIT_EMIT_TIMEOUT_MS } from "../../run-audit/emit-bounded-run-audit.js";
import type { RunAuditEventInput } from "../../types/audit/run-audit.js";

/*
FNXC:SelfImproveLearningLedger 2026-09-29-15:15:
This exercises the PERSISTED contract through the real public store methods, not through direct
Drizzle inserts. FUSI-009's suite already proved the proposal row's shape at the SQL level; what is
new here is that the four store methods write and read it correctly — the accessor, the state
derivation, the pagination, and the CHECK constraints all meet at the database.

FNXC:SelfImproveLearningLedger 2026-09-29-15:15:
The central assertion is that the proposal row is BYTE-IDENTICAL after proposed -> applied ->
reverted -> re-applied. That is the append-only contract stated as an observable: a learning
application must not silently rewrite the record it acts on, because the revert decision (FUSI-011)
depends on the prior value still being there to restore. Asserting the full row, not just the
events, is what makes a destructive update fail this suite.

FNXC:SelfImproveLearningLedger 2026-09-29-15:15:
Index use is proven through `pg_indexes` rather than EXPLAIN. EXPLAIN's plan is cost-model dependent
and would make this suite fail on a statistics change with no code change; the structural question
here is only whether the indexes this feature claims to back its reads actually EXIST. The spec's
requirement — index-backed reads, no full scan — is satisfied by their presence plus the fact that
every listing filters on the composite project key.

FNXC:SelfImproveRunAudit 2026-09-29-21:49:
FUSI-015 wires the run-audit emission, so this suite no longer pins the ABSENCE of `selfimprove:*`
rows. The former `emits no run-audit rows — FUSI-012 owns emission` test is INVERTED: a proposed ->
applied -> reverted lifecycle now asserts the three `selfimprove:*` rows are present, in order,
FILTERED by `mutation_type` prefix (never a total count, so an unrelated audit row — e.g. the
`store:open` provenance row every TaskStore.init emits — cannot make this brittle). Because the
emits are fire-and-forget, the rows are read with a bounded `expect.poll`.

FNXC:SelfImproveRunAudit 2026-09-29-21:49:
The hostile-sink cases drive `store.recordRunAuditEvent` into throw / reject / never-settle and
prove every ledger transition still COMMITS and remains readable from the trail. That is the
load-bearing property: telemetry is never on the transition's success path, so a learning experiment
is judged on its deterministic gate verdict rather than on whether the audit sink was healthy.
*/

const CREATED_AT = "2026-09-29T00:00:00.000Z";
const APPLIED_AT = "2026-09-29T01:00:00.000Z";
const REVERTED_AT = "2026-09-29T02:00:00.000Z";
const REAPPLIED_AT = "2026-09-29T03:00:00.000Z";

pgDescribe("self-improvement learning ledger events (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_selfimprove_events",
    projectId: "self-improve-events-test",
  });

  beforeAll(async () => {
    await h.beforeAll();
    await applySchemaBaseline(h.adminDb());
  });
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });
  afterAll(h.afterAll);

  const projectId = () => h.layer().projectId!;
  const store = () => h.store();

  const proposal = (proposalId: string, overrides: { target?: "memory" | "evals" | "skills"; createdAt?: string } = {}) =>
    createLearningProposal({
      proposalId,
      target: overrides.target ?? "evals",
      origin: "eval-failure",
      confidence: 0.4,
      value: 0.5,
      now: overrides.createdAt ?? CREATED_AT,
    });

  const readEvents = (proposalId: string) =>
    h.adminDb()
      .select()
      .from(schema.project.learningLedgerEvents)
      .where(and(
        eq(schema.project.learningLedgerEvents.projectId, projectId()),
        eq(schema.project.learningLedgerEvents.proposalId, proposalId),
      ))
      .orderBy(schema.project.learningLedgerEvents.occurredAt);

  it("writes the proposal row and its opening proposed event in one call", async () => {
    const stored = await store().appendLearningProposal({ proposal: proposal("p-open") });

    expect(stored).toMatchObject({ proposalId: "p-open", target: "evals", state: "proposed", version: 1 });

    const events = await readEvents("p-open");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "proposed", revertsEventId: null, occurredAt: CREATED_AT });
  });

  it("appends an application without changing the proposal row", async () => {
    await store().appendLearningProposal({ proposal: proposal("p-apply") });
    const before = await h.adminDb().select().from(schema.project.learningProposals);

    const applied = await store().recordLearningApplication({
      proposalId: "p-apply",
      eventId: "e-apply-1",
      target: "evals",
      occurredAt: APPLIED_AT,
    });
    expect(applied.kind).toBe("applied");

    const after = await h.adminDb().select().from(schema.project.learningProposals);
    expect(after).toEqual(before);
    expect(await readEvents("p-apply")).toHaveLength(2);
  });

  it("appends a reversal that names the application it cancels", async () => {
    await store().appendLearningProposal({ proposal: proposal("p-revert") });
    await store().recordLearningApplication({ proposalId: "p-revert", eventId: "e-a1", target: "evals", occurredAt: APPLIED_AT });

    const reverted = await store().recordLearningReversal({
      proposalId: "p-revert",
      eventId: "e-r1",
      target: "evals",
      revertsEventId: "e-a1",
      revertReason: "operator-veto",
      occurredAt: REVERTED_AT,
    });
    expect(reverted).toMatchObject({ kind: "reverted", revertsEventId: "e-a1", revertReason: "operator-veto" });

    const events = await readEvents("p-revert");
    expect(events.map((e) => e.kind)).toEqual(["proposed", "applied", "reverted"]);
  });

  it("rejects a reversal that names no application", async () => {
    await store().appendLearningProposal({ proposal: proposal("p-badrevert") });
    // A blank pairing is refused by the accessor, not by the CHECK: the constraint tests
    // IS NOT NULL, which an empty string satisfies, so an unpaired reversal would otherwise be
    // written as an unreplayable event.
    await expect(
      store().recordLearningReversal({ proposalId: "p-badrevert", eventId: "e-r", target: "evals", revertsEventId: "", revertReason: "gate-rejected", occurredAt: REVERTED_AT }),
    ).rejects.toThrow(/the event id of the application it cancels/);
    expect(await readEvents("p-badrevert")).toHaveLength(1);
  });

  it("refuses a reversal whose reason is outside the fixed enum", async () => {
    await store().appendLearningProposal({ proposal: proposal("p-badreason") });
    await store().recordLearningApplication({ proposalId: "p-badreason", eventId: "e-a1", target: "evals", occurredAt: APPLIED_AT });
    /*
    FNXC:SelfImproveLearningRevertSemantics 2026-09-29-21:07:
    `revert_reason` is a classifiable fixed enum, never free prose. The database CHECK already
    refuses anything outside it, so the accessor refuses first with a caller-facing message: a
    rejection at the DB boundary would surface as a constraint violation rather than naming the
    valid members. A reversal that names no reason at all is refused the same way, because
    migration 0088 requires the column exactly when kind='reverted'.
    */
    await expect(
      store().recordLearningReversal({ proposalId: "p-badreason", eventId: "e-r", target: "evals", revertsEventId: "e-a1", revertReason: "because-i-said-so" as never, occurredAt: REVERTED_AT }),
    ).rejects.toThrow(/revert reason from the fixed enum/);
    await expect(
      store().recordLearningReversal({ proposalId: "p-badreason", eventId: "e-r2", target: "evals", revertsEventId: "e-a1", revertReason: undefined as never, occurredAt: REVERTED_AT }),
    ).rejects.toThrow(/revert reason from the fixed enum/);
    expect(await readEvents("p-badreason")).toHaveLength(2);
  });

  it("stores the fixed-enum reason on the reversal it accepts", async () => {
    await store().appendLearningProposal({ proposal: proposal("p-reason") });
    await store().recordLearningApplication({ proposalId: "p-reason", eventId: "e-a1", target: "evals", occurredAt: APPLIED_AT });
    await store().recordLearningReversal({ proposalId: "p-reason", eventId: "e-r1", target: "evals", revertsEventId: "e-a1", revertReason: "gate-rejected", occurredAt: REVERTED_AT });
    const events = await readEvents("p-reason");
    expect(events.find((e) => e.kind === "reverted")).toMatchObject({ revertReason: "gate-rejected" });
  });

  it("keeps the proposal row byte-identical across proposed -> applied -> reverted -> re-applied", async () => {
    await store().appendLearningProposal({ proposal: proposal("p-trail") });
    const before = await h.adminDb().select().from(schema.project.learningProposals);

    await store().recordLearningApplication({ proposalId: "p-trail", eventId: "e-a1", target: "evals", occurredAt: APPLIED_AT });
    await store().recordLearningReversal({ proposalId: "p-trail", eventId: "e-r1", target: "evals", revertsEventId: "e-a1", revertReason: "operator-veto", occurredAt: REVERTED_AT });
    await store().recordLearningApplication({ proposalId: "p-trail", eventId: "e-a2", target: "evals", occurredAt: REAPPLIED_AT });

    const after = await h.adminDb().select().from(schema.project.learningProposals);
    expect(after).toEqual(before);
    expect(await readEvents("p-trail")).toHaveLength(4);
  });

  it("lists a proposal with state derived from its latest event and the full trail attached", async () => {
    await store().appendLearningProposal({ proposal: proposal("p-list") });
    await store().recordLearningApplication({ proposalId: "p-list", eventId: "e-a1", target: "evals", occurredAt: APPLIED_AT });

    const page = await store().listLearningProposals();
    const found = page.proposals.find((p) => p.proposalId === "p-list");

    expect(found).toBeDefined();
    expect(found!.derivedState).toBe("applied");
    expect(found!.events.map((e) => e.kind)).toEqual(["proposed", "applied"]);
    expect(page.totalEntries).toBe(1);
  });

  it("filters by target", async () => {
    await store().appendLearningProposal({ proposal: proposal("p-mem", { target: "memory" }) });
    await store().appendLearningProposal({ proposal: proposal("p-evals", { target: "evals" }) });

    const page = await store().listLearningProposals({ target: "memory" });

    expect(page.proposals.map((p) => p.proposalId)).toEqual(["p-mem"]);
  });

  it("filters by derived state", async () => {
    await store().appendLearningProposal({ proposal: proposal("p-st-proposed") });
    await store().appendLearningProposal({ proposal: proposal("p-st-applied") });
    await store().recordLearningApplication({ proposalId: "p-st-applied", eventId: "e-a", target: "evals", occurredAt: APPLIED_AT });

    const applied = await store().listLearningProposals({ state: "applied" });
    const proposed = await store().listLearningProposals({ state: "proposed" });

    expect(applied.proposals.map((p) => p.proposalId)).toEqual(["p-st-applied"]);
    expect(proposed.proposals.map((p) => p.proposalId)).toEqual(["p-st-proposed"]);
  });

  it("filters by the window of the latest event", async () => {
    await store().appendLearningProposal({ proposal: proposal("p-early") });
    await store().appendLearningProposal({ proposal: proposal("p-late") });
    await store().recordLearningApplication({ proposalId: "p-late", eventId: "e-a", target: "evals", occurredAt: REAPPLIED_AT });

    // p-early's latest event is its CREATED_AT opening; p-late's is REAPPLIED_AT.
    const window = await store().listLearningProposals({ from: REAPPLIED_AT, to: REAPPLIED_AT });

    expect(window.proposals.map((p) => p.proposalId)).toEqual(["p-late"]);
  });

  it("paginates with a stable total and a has-more flag", async () => {
    for (const id of ["p-p1", "p-p2", "p-p3"]) {
      await store().appendLearningProposal({ proposal: proposal(id, { createdAt: CREATED_AT }) });
    }

    const first = await store().listLearningProposals({ limit: 2 });
    const second = await store().listLearningProposals({ limit: 2, offset: 2 });

    expect(first.proposals).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.totalEntries).toBe(3);
    expect(second.proposals).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.totalEntries).toBe(3);
  });

  it("creates the indexes that back the target window, latest-event, and kind-window reads", async () => {
    const rows = (await h.adminDb().execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'project' AND tablename = 'learning_ledger_events'
    `)) as unknown as Array<{ indexname: string }>;
    const names = rows.map((r) => r.indexname);

    expect(names).toContain("idxLearningLedgerEventsTargetOccurred");
    expect(names).toContain("idxLearningLedgerEventsProposalOccurred");
    expect(names).toContain("idxLearningLedgerEventsTargetKindOccurred");
  });

  it("isolates another project's rows from this layer's reads", async () => {
    await store().appendLearningProposal({ proposal: proposal("p-rls") });
    // Insert a row in a different project directly; the RLS policy must hide it from the layer.
    await h.adminDb().execute(sql`
      INSERT INTO project.learning_ledger_events (project_id, event_id, proposal_id, target, kind, evidence_refs, occurred_at, created_at)
      VALUES ('other-project', 'x-1', 'p-foreign', 'skills', 'proposed', '[]'::jsonb, ${CREATED_AT}, ${CREATED_AT})
    `);

    const visible = await readEvents("p-foreign");
    expect(visible).toHaveLength(0);
  });

  /**
   * Read the `selfimprove:*` audit rows for one proposal, ordered by the transition's own durable
   * instant. Filtered by the mutation-type PREFIX rather than counting every row in the table, so an
   * unrelated audit row (the `store:open` provenance row every TaskStore.init writes) can never make
   * this brittle.
   */
  const readSelfImproveAudit = async (proposalId: string) => {
    const rows = await h.adminDb()
      .select()
      .from(schema.project.runAuditEvents)
      .where(and(
        eq(schema.project.runAuditEvents.projectId, projectId()),
        eq(schema.project.runAuditEvents.target, proposalId),
        like(schema.project.runAuditEvents.mutationType, "selfimprove:%"),
      ))
      .orderBy(schema.project.runAuditEvents.timestamp);
    return rows;
  };

  it("emits one selfimprove row per ledger transition, in order, with ids/counts-only metadata", async () => {
    await store().appendLearningProposal({ proposal: proposal("p-audit") });
    await store().recordLearningApplication({ proposalId: "p-audit", eventId: "e-a", target: "evals", occurredAt: APPLIED_AT });
    await store().recordLearningReversal({ proposalId: "p-audit", eventId: "e-r", target: "evals", revertsEventId: "e-a", revertReason: "operator-veto", occurredAt: REVERTED_AT });

    // The emits are fire-and-forget, so the rows land shortly AFTER the awaited writes return.
    await expect.poll(
      async () => (await readSelfImproveAudit("p-audit")).map((row) => row.mutationType),
      { timeout: 10_000, interval: 50 },
    ).toEqual([
      SELF_IMPROVE_RUN_AUDIT_EVENTS.created,
      SELF_IMPROVE_RUN_AUDIT_EVENTS.applied,
      SELF_IMPROVE_RUN_AUDIT_EVENTS.reverted,
    ]);

    const rows = await readSelfImproveAudit("p-audit");
    // Timestamps are the transitions' OWN durable instants, so the audit trail orders against the
    // ledger it observes rather than against wall-clock emission time.
    expect(rows.map((r) => r.timestamp)).toEqual([CREATED_AT, APPLIED_AT, REVERTED_AT]);
    // Metadata is ids/counts/fixed outcomes only — never proposal prose, evidence text, or a diff.
    expect(rows[0].metadata).toMatchObject({ proposalId: "p-audit", target: "evals", evidenceCount: 0, outcome: "recorded" });
    expect(rows[1].metadata).toMatchObject({ proposalId: "p-audit", version: 1, confidence: 0.4, value: 0.5, hasPriorValue: false, outcome: "applied" });
    expect(rows[2].metadata).toMatchObject({ proposalId: "p-audit", revertedEventId: "e-a", revertReason: "operator-veto", outcome: "reverted" });
    for (const row of rows) {
      const metadata = row.metadata as Record<string, unknown>;
      for (const forbidden of ["origin", "evidenceRefs", "diff", "rationale", "priorValue", "expiresAt"]) {
        expect(metadata).not.toHaveProperty(forbidden);
      }
    }
  });

  /*
  FNXC:SelfImproveRunAudit 2026-09-29-23:04:
  The negative control for the never-fabricate guard. `learning_ledger_events` deliberately has no
  REFERENCES clause (migrations 0086/0087), so an `applied` event appended against a proposalId that
  has NO proposal row commits successfully while `readLearningProposal` returns null. That is the
  exact branch the `applied` delegation guards, and this is the only way to reach it without faking
  the ledger write: the write succeeds, so the emission must be SKIPPED rather than filled with
  version/confidence/value. Without this case the guard could be inverted to emit placeholder weights
  (0 / 0 / 0) and every other test would stay green — a missing audit row is honest, a fabricated one
  would let an operator read a weight off the trail that no learning assertion ever made.
  FNXC:SelfImproveRunAudit 2026-09-29-23:19:
  The proof is taken at the SINK BOUNDARY, not by sleeping and then looking for a row. The bounded
  seam invokes `recordRunAuditEvent` synchronously (before its first await), so a pass-through spy
  observes every emission attempt the moment the awaited write returns — no wall-clock budget, no
  flake margin, and it catches an emission from ANY caller rather than only the expected façade.
  The durable-table read stays as the operator-facing half of the claim: what matters is that no row
  is ever written, not merely that one code path declined to try.
  */
  it("skips the applied audit row rather than fabricating weights for a proposal that does not exist", async () => {
    // A pass-through spy: it records every sink invocation and still calls the real store method, so
    // the ledger write and any (incorrect) emit run for real underneath it.
    const spy = vi.spyOn(store(), "recordRunAuditEvent");
    try {
      const applied = await store().recordLearningApplication({ proposalId: "p-no-row", eventId: "e-orphan", target: "skills", occurredAt: APPLIED_AT });
      // The transition itself is unaffected: the event committed and is readable from the trail.
      expect(applied.kind).toBe("applied");
      expect((await readEvents("p-no-row")).map((e) => e.kind)).toEqual(["applied"]);

      const emittedTypes = spy.mock.calls.map(([input]) => input.mutationType);
      expect(emittedTypes.filter((type) => type.startsWith("selfimprove:"))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    const auditRows = await readSelfImproveAudit("p-no-row");
    expect(auditRows).toHaveLength(0);
  });

  describe("hostile run-audit sinks never alter a ledger transition", () => {
    const runLifecycle = async (proposalId: string) => {
      await store().appendLearningProposal({ proposal: proposal(proposalId) });
      const applied = await store().recordLearningApplication({ proposalId, eventId: "e-a", target: "evals", occurredAt: APPLIED_AT });
      const reverted = await store().recordLearningReversal({ proposalId, eventId: "e-r", target: "evals", revertsEventId: "e-a", revertReason: "gate-rejected", occurredAt: REVERTED_AT });
      return { applied, reverted };
    };

    it("commits every transition when the audit sink throws synchronously", async () => {
      const spy = vi.spyOn(store(), "recordRunAuditEvent").mockImplementation(() => { throw new Error("sink is down"); });
      try {
        const { applied, reverted } = await runLifecycle("p-throw");
        expect(applied.kind).toBe("applied");
        expect(reverted.kind).toBe("reverted");
      } finally {
        spy.mockRestore();
      }
      // The trail holds all three events and the derived state is the terminal reversion.
      const trail = await readEvents("p-throw");
      expect(trail.map((e) => e.kind)).toEqual(["proposed", "applied", "reverted"]);
      const page = await store().listLearningProposals();
      expect(page.proposals.find((p) => p.proposalId === "p-throw")?.derivedState).toBe("reverted");
    });

    it("commits every transition when the audit sink rejects", async () => {
      const spy = vi.spyOn(store(), "recordRunAuditEvent").mockImplementation((_input: RunAuditEventInput) => Promise.reject(new Error("sink rejected")));
      try {
        const { applied, reverted } = await runLifecycle("p-reject");
        expect(applied.kind).toBe("applied");
        expect(reverted.kind).toBe("reverted");
      } finally {
        spy.mockRestore();
      }
      expect((await readEvents("p-reject")).map((e) => e.kind)).toEqual(["proposed", "applied", "reverted"]);
    });

    it("commits every transition when the audit sink never settles", async () => {
      const spy = vi.spyOn(store(), "recordRunAuditEvent").mockImplementation(() => new Promise<never>(() => { /* never settles */ }));
      try {
        /*
        FNXC:SelfImproveRunAudit 2026-09-29-21:49:
        The proof for a hung sink is TIMING, not waiting for the seam's own time-box to expire. The
        emits are fire-and-forget, so the awaited lifecycle must return while all three sinks are
        still hung: asserting the whole three-write lifecycle finishes well inside ONE seam timeout
        shows the write path never sat behind a hung sink (had the façade been awaited serially,
        three hung emits would push this past 3x the bound). The seam's internal time-box release is
        exercised deterministically with fake timers in `self-improve-run-audit-sink-health.test.ts`;
        sleeping a real 2s here would only add wall-clock to the pg lane without asserting more.
        */
        const startedAt = performance.now();
        const { applied, reverted } = await runLifecycle("p-hang");
        const elapsedMs = performance.now() - startedAt;
        expect(applied.kind).toBe("applied");
        expect(reverted.kind).toBe("reverted");
        // Three real DB writes complete in milliseconds; a blocked emit path would exceed one bound.
        expect(elapsedMs).toBeLessThan(CORE_RUN_AUDIT_EMIT_TIMEOUT_MS);
      } finally {
        spy.mockRestore();
      }
      expect((await readEvents("p-hang")).map((e) => e.kind)).toEqual(["proposed", "applied", "reverted"]);
    });
  });
});
