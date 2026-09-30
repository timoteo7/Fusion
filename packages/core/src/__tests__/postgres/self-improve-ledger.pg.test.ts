import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import * as schema from "../../postgres/schema/index.js";

/*
FNXC:SelfImproveLearningLedger 2026-09-29-02:38:
This exercises the PERSISTED contract, not the store methods — store write/list belongs to
FUSI-010, so rows are seeded and read through Drizzle/raw SQL directly. That is deliberate: it
proves migration 0086 actually creates the table with the right shape on a real database, which a
pure-helper test can never show.

FNXC:SelfImproveLearningLedger 2026-09-29-02:38:
The CHECK constraints are asserted here rather than in the TypeScript helper test because their
whole purpose is to reject a write that the type system could not have produced. A drifted DB
constraint that silently accepts an invalid state would let the gate read back a state the domain
model forbids.

FNXC:SelfImproveLearningLedger 2026-09-29-02:38:
The rejection is matched on the CONSTRAINT NAME, and it is read through the `cause` chain rather
than the error message. Drizzle wraps every driver failure in a DrizzleQueryError whose message is
only `Failed query: <sql>`, so a `rejects.toThrow(/learning_proposals_state_check/)` fails even when
PostgreSQL rejected the row for exactly the intended reason. Matching the name (not just "it threw")
also keeps the assertion honest if a constraint is dropped and a different one starts firing.
*/

const PROPOSAL_ID = "proposal-1";
const CREATED_AT = "2026-09-29T00:00:00.000Z";
const EXPIRES_AT = "2026-09-29T02:00:00.000Z";

pgDescribe("self-improvement learning ledger (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_selfimprove",
    projectId: "self-improve-test",
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

  const proposalRow = (overrides: Partial<typeof schema.project.learningProposals.$inferInsert> = {}) => ({
    projectId: projectId(),
    proposalId: PROPOSAL_ID,
    target: "evals",
    origin: "eval-failure",
    confidence: 0.4,
    value: 0.5,
    priorValue: null,
    expiresAt: EXPIRES_AT,
    evidenceRefs: [{ surface: "evals", ref: "run-42", observedAt: CREATED_AT }],
    state: "proposed",
    version: 1,
    createdAt: CREATED_AT,
    ...overrides,
  });

  const seed = (overrides: Partial<typeof schema.project.learningProposals.$inferInsert> = {}) =>
    h.adminDb().insert(schema.project.learningProposals).values(proposalRow(overrides));

  const read = (proposalId: string) =>
    h.adminDb().select().from(schema.project.learningProposals).where(and(
      eq(schema.project.learningProposals.projectId, projectId()),
      eq(schema.project.learningProposals.proposalId, proposalId),
    ));

  /**
   * Assert that `write` is rejected by the named PostgreSQL CHECK constraint.
   *
   * Drizzle surfaces a driver failure as `DrizzleQueryError`, whose own message is only
   * `Failed query: <sql> / params: ...`. The constraint name the database actually cited lives on
   * the wrapped `cause`, one or more links down. Walk the chain so the assertion names the real
   * rejection reason instead of the transport wrapper.
   */
  const rejectsOnCheck = async (write: Promise<unknown>, constraint: string) => {
    const error = await write.then(() => null, (e: unknown) => e);
    expect(error, `expected the insert to be rejected by ${constraint}`).toBeTruthy();

    const chain: string[] = [];
    for (let current: unknown = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
      chain.push(String((current as { message?: unknown }).message ?? ""));
    }
    expect(chain.join("\n"), `no error in the cause chain cited ${constraint}`).toContain(constraint);
  };

  it("round-trips every contract field through the persisted record", async () => {
    await seed();

    const rows = await read(PROPOSAL_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: projectId(),
      proposalId: PROPOSAL_ID,
      target: "evals",
      origin: "eval-failure",
      confidence: 0.4,
      value: 0.5,
      priorValue: null,
      expiresAt: EXPIRES_AT,
      state: "proposed",
      version: 1,
      createdAt: CREATED_AT,
    });
    expect(rows[0]!.evidenceRefs).toEqual([
      { surface: "evals", ref: "run-42", observedAt: CREATED_AT },
    ]);
  });

  it("round-trips a re-applied record carrying the prior value it replaced", async () => {
    await seed({ state: "applied", version: 2, priorValue: 0.25, confidence: 0.6, value: 0.9 });

    const rows = await read(PROPOSAL_ID);

    expect(rows[0]).toMatchObject({ state: "applied", version: 2, priorValue: 0.25, value: 0.9, confidence: 0.6 });
  });

  it("defaults evidence_refs to an empty list rather than null", async () => {
    await h.adminDb()
      .insert(schema.project.learningProposals)
      .values(proposalRow({ evidenceRefs: undefined }));

    const rows = await read(PROPOSAL_ID);

    expect(rows[0]!.evidenceRefs).toEqual([]);
  });

  it("scopes reads by the composite project key, not the proposal id alone", async () => {
    await seed();
    await h.adminDb().execute(sql`
      INSERT INTO project.learning_proposals (project_id, proposal_id, target, origin, confidence, value, state, version, created_at)
      VALUES ('other-project', ${PROPOSAL_ID}, 'skills', 'manual', 0.1, 0.1, 'proposed', 1, ${CREATED_AT})
    `);

    const ownProject = await read(PROPOSAL_ID);
    const everything = await h.adminDb().select().from(schema.project.learningProposals);

    expect(ownProject).toHaveLength(1);
    expect(ownProject[0]!.projectId).toBe(projectId());
    expect(everything.filter((row) => row.proposalId === PROPOSAL_ID)).toHaveLength(2);
  });

  it("rejects a state outside the four contract members", async () => {
    await rejectsOnCheck(seed({ state: "mutated" as never }), "learning_proposals_state_check");
  });

  it("accepts each of the four contract states", async () => {
    for (const state of ["proposed", "applied", "reverted", "expired"] as const) {
      await seed({ proposalId: `proposal-${state}`, state });
    }

    const rows = await read("proposal-applied");

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("applied");
  });

  it("rejects a target outside the three product surfaces", async () => {
    await rejectsOnCheck(seed({ target: "engine" }), "learning_proposals_target_check");
  });

  it("rejects an out-of-range confidence", async () => {
    await rejectsOnCheck(seed({ confidence: 1.5 }), "learning_proposals_confidence_check");
    await rejectsOnCheck(seed({ confidence: -0.1 }), "learning_proposals_confidence_check");
  });

  it("rejects an out-of-range value", async () => {
    await rejectsOnCheck(seed({ value: 4 }), "learning_proposals_value_check");
  });

  it("keeps one live record per proposal so re-application versions in place", async () => {
    await seed();
    await h.adminDb()
      .update(schema.project.learningProposals)
      .set({ version: 2, priorValue: 0.5, value: 0.9, confidence: 0.6, state: "applied" })
      .where(and(
        eq(schema.project.learningProposals.projectId, projectId()),
        eq(schema.project.learningProposals.proposalId, PROPOSAL_ID),
      ));

    const rows = await read(PROPOSAL_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 2, priorValue: 0.5, value: 0.9 });
  });
});
