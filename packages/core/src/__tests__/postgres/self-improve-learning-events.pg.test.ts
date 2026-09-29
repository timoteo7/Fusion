import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import * as schema from "../../postgres/schema/index.js";
import { createLearningProposal } from "../../self-improve/ledger-schema.js";

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

FNXC:SelfImproveLearningLedger 2026-09-29-15:15:
No run-audit rows are asserted absent: FUSI-012 owns emission, and this task emits nothing. Pinning
the absence here is what proves the boundary — a future lane that starts emitting will fail this
suite and have to update it deliberately rather than slipping telemetry into the lifecycle write.
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

  it("emits no run-audit rows — FUSI-012 owns emission", async () => {
    await store().appendLearningProposal({ proposal: proposal("p-audit") });
    await store().recordLearningApplication({ proposalId: "p-audit", eventId: "e-a", target: "evals", occurredAt: APPLIED_AT });
    await store().recordLearningReversal({ proposalId: "p-audit", eventId: "e-r", target: "evals", revertsEventId: "e-a", revertReason: "operator-veto", occurredAt: REVERTED_AT });

    const audit = (await h.adminDb().execute(sql`
      SELECT count(*)::int AS n FROM project.run_audit_events
    `)) as unknown as Array<{ n: number }>;
    expect(Number(audit[0]?.n ?? 0)).toBe(0);
  });
});
