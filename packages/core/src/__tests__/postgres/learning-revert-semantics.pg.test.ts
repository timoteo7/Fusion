import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { createConnectionSetFromUrl } from "../../postgres/connection.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import { TaskStore } from "../../store.js";
import * as schema from "../../postgres/schema/index.js";
import { applyProposalVersioning, createLearningProposal } from "../../self-improve/ledger-schema.js";
import { buildLearningRevertEventId } from "../../self-improve/learning-revert-types.js";
import type { LearningProposal } from "../../types/self-improve/learning-proposal.js";

/*
FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
This exercises the PERSISTED revert contract through the real public store method, not through
direct Drizzle inserts. The central assertion is that a revert is a NEW appended event naming the
application it cancels, that the proposal's prior value is returned verbatim, and that a second
revert is a true no-op. FUSI-010 proved the four ledger accessors write and read the proposal/event
rows; what is new here is the revert OPERATION and its idempotency, the loop's only authoritative undo.

FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
The exact-priorValue cases are the point of the feature. A revert that "mostly" restores — rounding,
coercing a null to zero, or dropping a value the proposal held — would silently corrupt the product
surface the value belongs to, so null and falsy shapes are asserted verbatim rather than by a single
happy-path number.

FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
Run-audit rows are counted with `store:open` FILTERED OUT: every TaskStore.init() emits one, so a
reader that counts the whole table sees a phantom row and both the count and the ORDER of the mutation
types become wrong. Filtering to the learning mutation type is what makes the ordered-sequence
assertion below meaningful.

FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
Project isolation is proven by driving a SECOND AsyncDataLayer bound to a different projectId and
showing it can neither see nor revert the first project's proposal. This is what enforces that no
ledger read or write is ever addressed by id alone.
*/

const CREATED_AT = "2026-09-29T00:00:00.000Z";
const APPLIED_AT = "2026-09-29T01:00:00.000Z";
const REVERTED_AT = "2026-09-29T02:00:00.000Z";
const REAPPLIED_AT = "2026-09-29T03:00:00.000Z";
const REVERTED_AGAIN_AT = "2026-09-29T04:00:00.000Z";

pgDescribe("learning revert semantics (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_learning_revert",
    projectId: "learning-revert-test",
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

  /**
   * Store a proposal carrying a `priorValue`, the way a real application does.
   * `applyProposalVersioning` moves the asserted value into priorValue and bumps version/state —
   * exactly the record the revert later reads to know what to restore.
   */
  const appliedProposal = (proposalId: string, priorValue: number | null): LearningProposal => {
    const fresh = createLearningProposal({ proposalId, target: "evals", origin: "eval-failure", confidence: 0.4, value: 0.9, now: CREATED_AT });
    if (priorValue === null) return fresh;
    const versioned = applyProposalVersioning(fresh, 0.9, 0.4, CREATED_AT);
    return { ...versioned, priorValue };
  };

  const readEvents = (proposalId: string) =>
    h.adminDb()
      .select()
      .from(schema.project.learningLedgerEvents)
      .where(and(
        eq(schema.project.learningLedgerEvents.projectId, projectId()),
        eq(schema.project.learningLedgerEvents.proposalId, proposalId),
      ))
      .orderBy(schema.project.learningLedgerEvents.occurredAt, schema.project.learningLedgerEvents.eventId);

  const readAudit = async () =>
    (await h.adminDb().execute(sql`
      SELECT mutation_type, metadata
      FROM project.run_audit_events
      WHERE project_id = ${projectId()}
        AND mutation_type LIKE 'learning:%'
        AND mutation_type <> 'store:open'
      ORDER BY timestamp, id
    `)) as unknown as Array<{ mutation_type: string; metadata: Record<string, unknown> | null }>;

  it("appends a reversal naming the application and returns the exact priorValue", async () => {
    await store().appendLearningProposal({ proposal: appliedProposal("p-restore", 0.4) });
    await store().recordLearningApplication({ proposalId: "p-restore", eventId: "e-a1", target: "evals", occurredAt: APPLIED_AT });

    const result = await store().revertLearningApplication({ proposalId: "p-restore", reason: "gate-rejected", occurredAt: REVERTED_AT });

    expect(result.outcome).toBe("reverted");
    // The value to restore is the proposal's priorValue verbatim — 0.4, not the applied 0.9 and not
    // a hardcoded zero. This is what the owning surface writes back to the product.
    expect(result.restoredValue).toBe(0.4);
    expect(result.appliedEventId).toBe("e-a1");
    expect(result.revertEventId).toBe(buildLearningRevertEventId("e-a1"));
    expect(result.reason).toBe("gate-rejected");

    const events = await readEvents("p-restore");
    expect(events.map((e) => e.kind)).toEqual(["proposed", "applied", "reverted"]);
    const reversal = events[2];
    expect(reversal.revertsEventId).toBe("e-a1");
    expect(reversal.revertReason).toBe("gate-rejected");
  });

  it("restores a null priorValue verbatim, distinct from a missing revert", async () => {
    // Nothing was held before the first application, so priorValue is null. The revert must return
    // that null — not coerce it to zero — and must still be recorded as a real reversal.
    await store().appendLearningProposal({ proposal: appliedProposal("p-null", null) });
    await store().recordLearningApplication({ proposalId: "p-null", eventId: "e-a1", target: "evals", occurredAt: APPLIED_AT });

    const result = await store().revertLearningApplication({ proposalId: "p-null", reason: "manual", occurredAt: REVERTED_AT });

    expect(result.outcome).toBe("reverted");
    expect(result.restoredValue).toBeNull();
    expect((await readEvents("p-null")).map((e) => e.kind)).toEqual(["proposed", "applied", "reverted"]);
  });

  it("restores a falsy priorValue of exactly 0, not null and not a truthy default", async () => {
    // Zero is a real prior value (the surface held 0 before the experiment). Coercing it to null or
    // to the applied value would silently corrupt the restored surface.
    await store().appendLearningProposal({ proposal: appliedProposal("p-zero", 0) });
    await store().recordLearningApplication({ proposalId: "p-zero", eventId: "e-a1", target: "evals", occurredAt: APPLIED_AT });

    const result = await store().revertLearningApplication({ proposalId: "p-zero", reason: "superseded", occurredAt: REVERTED_AT });

    expect(result.outcome).toBe("reverted");
    expect(result.restoredValue).toBe(0);
  });

  it("is idempotent: a second revert changes nothing and reports already-reverted", async () => {
    await store().appendLearningProposal({ proposal: appliedProposal("p-idem", 0.4) });
    await store().recordLearningApplication({ proposalId: "p-idem", eventId: "e-a1", target: "evals", occurredAt: APPLIED_AT });

    const first = await store().revertLearningApplication({ proposalId: "p-idem", reason: "gate-rejected", occurredAt: REVERTED_AT });
    const countAfterFirst = (await readEvents("p-idem")).length;
    const second = await store().revertLearningApplication({ proposalId: "p-idem", reason: "gate-rejected", occurredAt: REVERTED_AGAIN_AT });
    const countAfterSecond = (await readEvents("p-idem")).length;

    expect(first.outcome).toBe("reverted");
    expect(second.outcome).toBe("already-reverted");
    // The decisive assertion: the repeat appended NOTHING, so the trail cannot be inflated by a
    // second indistinguishable reversal.
    expect(countAfterSecond).toBe(countAfterFirst);
    expect(countAfterSecond).toBe(3);
    // The no-op still reports what the surface would restore, so a retried revert is answerable.
    expect(second.restoredValue).toBe(0.4);
  });

  it("reverting an already-reverted application is a no-op even when targeted by id", async () => {
    await store().appendLearningProposal({ proposal: appliedProposal("p-target-idem", 0.4) });
    await store().recordLearningApplication({ proposalId: "p-target-idem", eventId: "e-a1", target: "evals", occurredAt: APPLIED_AT });
    await store().revertLearningApplication({ proposalId: "p-target-idem", reason: "manual", occurredAt: REVERTED_AT });

    const repeat = await store().revertLearningApplication({ proposalId: "p-target-idem", appliedEventId: "e-a1", reason: "manual", occurredAt: REVERTED_AGAIN_AT });

    expect(repeat.outcome).toBe("already-reverted");
    expect((await readEvents("p-target-idem")).map((e) => e.kind)).toEqual(["proposed", "applied", "reverted"]);
  });

  it("returns not-applied and writes nothing for a proposal that was never applied", async () => {
    await store().appendLearningProposal({ proposal: appliedProposal("p-never", 0.4) });

    const result = await store().revertLearningApplication({ proposalId: "p-never", reason: "manual", occurredAt: REVERTED_AT });

    expect(result.outcome).toBe("not-applied");
    // Only the opening proposed event exists — the no-op revert wrote nothing.
    expect((await readEvents("p-never")).map((e) => e.kind)).toEqual(["proposed"]);
  });

  it("returns not-applied and writes nothing for a proposal that does not exist", async () => {
    const result = await store().revertLearningApplication({ proposalId: "p-nonexistent", reason: "manual", occurredAt: REVERTED_AT });

    expect(result.outcome).toBe("not-applied");
    // A proposal that does not exist has no target; the result must not invent one.
    expect(result.target).toBeUndefined();
    expect(result.restoredValue).toBeNull();
    expect(await readEvents("p-nonexistent")).toHaveLength(0);
  });

  it("orders application and reversal as distinct, ordered events in the trail", async () => {
    await store().appendLearningProposal({ proposal: appliedProposal("p-trail", 0.4) });
    await store().recordLearningApplication({ proposalId: "p-trail", eventId: "e-a1", target: "evals", occurredAt: APPLIED_AT });
    await store().revertLearningApplication({ proposalId: "p-trail", reason: "gate-rejected", occurredAt: REVERTED_AT });

    const events = await readEvents("p-trail");
    expect(events.map((e) => e.kind)).toEqual(["proposed", "applied", "reverted"]);
    // The application is NOT mutated by the revert: its own occurredAt and its (absent) reason are
    // untouched, proving the revert is an append and not an in-place status flip.
    const applied = events.find((e) => e.kind === "applied");
    expect(applied?.occurredAt).toBe(APPLIED_AT);
    expect(applied?.revertReason).toBeNull();
  });

  it("supports revert -> re-apply -> revert as ordered steps, not a collapsed trail", async () => {
    await store().appendLearningProposal({ proposal: appliedProposal("p-multi", 0.4) });
    await store().recordLearningApplication({ proposalId: "p-multi", eventId: "e-a1", target: "evals", occurredAt: APPLIED_AT });
    await store().revertLearningApplication({ proposalId: "p-multi", reason: "gate-rejected", occurredAt: REVERTED_AT });
    await store().recordLearningApplication({ proposalId: "p-multi", eventId: "e-a2", target: "evals", occurredAt: REAPPLIED_AT });
    const second = await store().revertLearningApplication({ proposalId: "p-multi", reason: "operator-veto", occurredAt: REVERTED_AGAIN_AT });

    // The second revert pairs with the SECOND (latest un-reverted) application, not the first.
    expect(second.outcome).toBe("reverted");
    expect(second.appliedEventId).toBe("e-a2");
    const events = await readEvents("p-multi");
    expect(events.map((e) => e.kind)).toEqual(["proposed", "applied", "reverted", "applied", "reverted"]);
    expect(events.filter((e) => e.kind === "reverted").map((e) => e.revertsEventId)).toEqual(["e-a1", "e-a2"]);
  });

  it("noLaterThan makes a retried revert re-affirm the original application, not a later re-application", async () => {
    await store().appendLearningProposal({ proposal: appliedProposal("p-fence", 0.4) });
    await store().recordLearningApplication({ proposalId: "p-fence", eventId: "e-a1", target: "evals", occurredAt: APPLIED_AT });
    await store().revertLearningApplication({ proposalId: "p-fence", reason: "gate-rejected", occurredAt: REVERTED_AT });
    await store().recordLearningApplication({ proposalId: "p-fence", eventId: "e-a2", target: "evals", occurredAt: REAPPLIED_AT });

    // A retried revert of the FIRST episode, fenced at the moment of the first reversal, must not
    // cancel the re-application that shipped afterwards. e-a1 is already reverted, so the correct
    // result is a no-op re-affirming it.
    const retried = await store().revertLearningApplication({ proposalId: "p-fence", noLaterThan: REVERTED_AT, reason: "gate-rejected", occurredAt: REVERTED_AGAIN_AT });

    expect(retried.outcome).toBe("already-reverted");
    expect(retried.appliedEventId).toBe("e-a1");
    // e-a2 is still un-reverted: the fence did not cancel the later application.
    expect((await readEvents("p-fence")).filter((e) => e.kind === "reverted").map((e) => e.revertsEventId)).toEqual(["e-a1"]);

    // A GENUINE new revert (no fence) still pairs with the latest application.
    const genuine = await store().revertLearningApplication({ proposalId: "p-fence", reason: "operator-veto", occurredAt: REVERTED_AGAIN_AT });
    expect(genuine.outcome).toBe("reverted");
    expect(genuine.appliedEventId).toBe("e-a2");
  });

  it("carries every fixed reason through to the stored reversal", async () => {
    for (const reason of ["gate-rejected", "operator-veto", "superseded", "expired", "manual"] as const) {
      await store().appendLearningProposal({ proposal: appliedProposal(`p-${reason}`, 0.4) });
      /*
      FNXC:SelfImproveLearningRevertSemantics 2026-10-02-23:05:
      Migration 0088 declares PRIMARY KEY (project_id, event_id), so an event id is unique per
      project and CANNOT be reused: recordLearningApplication is onConflictDoNothing().returning(),
      so a repeated "e-a1" across the five iterations makes iterations 2..5 store nothing at all.
      Each iteration therefore applies its own event id, and the assertions below pin that the
      reversal names THAT application instead of merely carrying the reason through.
      */
      const eventId = `e-applied-${reason}`;
      await store().recordLearningApplication({ proposalId: `p-${reason}`, eventId, target: "evals", occurredAt: APPLIED_AT });
      const result = await store().revertLearningApplication({ proposalId: `p-${reason}`, reason, occurredAt: REVERTED_AT });

      expect(result.outcome).toBe("reverted");
      expect(result.reason).toBe(reason);
      expect(result.appliedEventId).toBe(eventId);
      expect(result.revertEventId).toBe(buildLearningRevertEventId(eventId));
      const reversal = (await readEvents(`p-${reason}`)).find((e) => e.kind === "reverted");
      expect(reversal?.revertReason).toBe(reason);
      expect(reversal?.revertsEventId).toBe(eventId);
    }
  });

  it("refuses a reason outside the fixed enum before writing anything", async () => {
    await store().appendLearningProposal({ proposal: appliedProposal("p-bad-reason", 0.4) });
    await store().recordLearningApplication({ proposalId: "p-bad-reason", eventId: "e-a1", target: "evals", occurredAt: APPLIED_AT });

    await expect(
      store().revertLearningApplication({ proposalId: "p-bad-reason", reason: "because it looked wrong" as never, occurredAt: REVERTED_AT }),
    ).rejects.toThrow(/Unknown learning revert reason/);
    // The refusal happened before any append, so the application is still live and un-reverted.
    expect((await readEvents("p-bad-reason")).map((e) => e.kind)).toEqual(["proposed", "applied"]);
  });

  it("emits one bounded run-audit row per attempt, ordered, with store:open filtered out", async () => {
    await store().appendLearningProposal({ proposal: appliedProposal("p-audit", 0.4) });
    await store().recordLearningApplication({ proposalId: "p-audit", eventId: "e-a1", target: "evals", occurredAt: APPLIED_AT });
    await store().revertLearningApplication({ proposalId: "p-audit", reason: "gate-rejected", occurredAt: REVERTED_AT });
    await store().revertLearningApplication({ proposalId: "p-audit", reason: "gate-rejected", occurredAt: REVERTED_AGAIN_AT });

    const audit = await readAudit();
    // Two ATTEMPTS, two rows: the no-op attempt is still recorded, so "was this reverted, and how
    // many times" is answerable from telemetry alone. The store:open filter is what keeps the count
    // honest — without it the harness's TaskStore.init() row would be counted as a phantom.
    expect(audit.map((row) => row.mutation_type)).toEqual(["learning:reverted", "learning:reverted"]);
    // Metadata is ids/counts/fixed-outcomes only. Every key is a bare identifier and every value is
    // an id, a null, or a fixed enum — never a verdict, free prose, or a diff.
    expect(audit[0].metadata).toMatchObject({
      proposalId: "p-audit",
      target: "evals",
      appliedEventId: "e-a1",
      revertEventId: buildLearningRevertEventId("e-a1"),
      outcome: "reverted",
      reason: "gate-rejected",
    });
    // The no-op attempt carries no ids of its own, and the seam records an absent id as an explicit
    // null rather than dropping or faking the key — so the nulls are pinned here, not just tolerated.
    expect(audit[1].metadata).toMatchObject({ outcome: "already-reverted", appliedEventId: null, revertEventId: null });
    for (const row of audit) {
      for (const value of Object.values(row.metadata ?? {})) {
        /*
        FNXC:SelfImproveLearningRevertSemantics 2026-10-02-23:05:
        The authored contract is "an id, a null, or a fixed enum". JS reports typeof null as
        "object", so the whitelist must accept a null scalar EXPLICITLY while still rejecting a
        real object/array (prose, diffs, nested payloads). Emitting a null for an absent id is the
        seam's deliberate shape, not a defect, so this assertion follows the authored comment.
        */
        const scalar = value === null || ["string", "number", "boolean"].includes(typeof value);
        expect(scalar, "run-audit metadata value must be an id, a null, or a fixed enum — never an object, array, or prose").toBe(true);
      }
    }
  });
});

/*
FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
Isolation gets its own suite because it needs a SECOND data layer, not a second assertion. A revert
is the loop's only undo, so a layer bound to another project must be unable to cancel it: if the
proposal were addressable by id alone, a cross-project revert would silently restore a value on a
surface it has no authority over. The second layer points at the SAME database under a different
projectId, so the only thing being tested is the project partition.
*/
pgDescribe("learning revert project isolation (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_learning_revert_iso",
    projectId: "learning-revert-iso-a",
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

  const OTHER_PROJECT = "learning-revert-iso-b";
  let otherLayer: AsyncDataLayer | undefined;
  let otherStore: TaskStore | undefined;

  beforeAll(async () => {
    const backend: ResolvedBackend = {
      mode: "external", runtimeUrl: h.testUrl(), migrationUrl: h.testUrl(), migrationUrlOverridden: false,
    };
    const connections = await createConnectionSetFromUrl(backend, { poolMax: 1, connectTimeoutSeconds: 5, projectId: OTHER_PROJECT });
    otherLayer = createAsyncDataLayer(connections, { projectId: OTHER_PROJECT });
    otherStore = new TaskStore(h.rootDir(), undefined, { asyncLayer: otherLayer });
    await otherStore.init();
  });

  it("cannot see or revert another project's proposal, even by exact id", async () => {
    const fresh = createLearningProposal({ proposalId: "shared-id", target: "evals", origin: "eval-failure", confidence: 0.4, value: 0.9, now: CREATED_AT });
    const versioned = { ...applyProposalVersioning(fresh, 0.9, 0.4, CREATED_AT), priorValue: 0.4 };
    await h.store().appendLearningProposal({ proposal: versioned });
    await h.store().recordLearningApplication({ proposalId: "shared-id", eventId: "e-a1", target: "evals", occurredAt: APPLIED_AT });

    // The other layer sees nothing of it: the proposal is invisible across the project partition.
    const page = await otherStore!.listLearningProposals();
    expect(page.proposals.map((p) => p.proposalId)).not.toContain("shared-id");

    // And a revert naming the OTHER project's exact proposal and application ids is a no-op, not a
    // cross-project cancellation.
    const crossProject = await otherStore!.revertLearningApplication({
      proposalId: "shared-id", appliedEventId: "e-a1", reason: "operator-veto", occurredAt: REVERTED_AT,
    });
    expect(crossProject.outcome).toBe("not-applied");
    expect(crossProject.restoredValue).toBeNull();

    // The owning project still sees its application as un-reverted, and a genuine revert still works.
    const own = await h.store().revertLearningApplication({ proposalId: "shared-id", reason: "operator-veto", occurredAt: REVERTED_AT });
    expect(own.outcome).toBe("reverted");
    expect(own.restoredValue).toBe(0.4);
  });
});
