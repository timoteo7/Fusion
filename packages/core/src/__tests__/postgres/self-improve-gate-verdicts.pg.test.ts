import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import * as schema from "../../postgres/schema/index.js";
import {
  buildLearningGateVerdictId,
  computeLearningGateVerdictFingerprint,
  resolveLearningGateVerdict,
  type LearningGatePrimarySignals,
  type LearningGateVerdictInput,
} from "../../self-improve/learning-gate-verdict-types.js";

/*
FNXC:SelfImproveGateVerdict 2026-09-30-15:26:
This exercises the PERSISTED contract, not the store accessor — the accessor belongs to FUSI-020's
store layer, so rows are seeded and read through Drizzle directly here. That is deliberate: it
proves migration 0089 actually creates project.learning_gate_verdicts with the right shape on a real
database, which a pure-helper test can never show.

FNXC:SelfImproveGateVerdict 2026-09-30-15:26:
The seeded verdict id and fingerprint are computed by the REAL pure helpers rather than hand-written
strings. That is the point: this test then proves the derivation the accessor uses is the same one
that produces a row the database accepts, so a drift between the id derivation and the persisted
identity would surface here rather than only in production.

FNXC:SelfImproveGateVerdict 2026-09-30-15:26:
The CHECK constraints are asserted here rather than in the TypeScript helper test because their whole
purpose is to reject a write that the type system could not have produced. A drifted DB constraint
that silently accepts an invalid state would let the gate read back a verdict the domain model
forbids. The rejection is matched on the CONSTRAINT NAME, read through the `cause` chain rather than
the error message, because Drizzle wraps every driver failure in a DrizzleQueryError whose own
message is only `Failed query: <sql>`.
*/

const EXPERIMENT_ID = "exp-1";
const BASELINE_ID = "baseline-1";
const OCCURRED_AT = "2026-09-30T00:00:00.000Z";
const CREATED_AT = "2026-09-30T00:00:01.000Z";

const signals = (overrides: Partial<LearningGatePrimarySignals> = {}): LearningGatePrimarySignals => ({
  buildOk: true,
  lintOk: true,
  typecheckOk: true,
  gateOk: true,
  affectedTestsOk: true,
  testCountDelta: 0,
  costBudgetInvariantOk: true,
  corpusVersion: "corpus-v1",
  seed: 42,
  ...overrides,
});

const input = (overrides: Partial<LearningGateVerdictInput> = {}): LearningGateVerdictInput => ({
  experimentId: EXPERIMENT_ID,
  baselineId: BASELINE_ID,
  primarySignals: signals(),
  ...overrides,
});

pgDescribe("self-improvement learning gate verdicts (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_selfimprove_gate",
    projectId: "self-improve-gate-test",
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

  const readByExperiment = (experimentId: string) =>
    h.adminDb().select().from(schema.project.learningGateVerdicts).where(and(
      eq(schema.project.learningGateVerdicts.projectId, projectId()),
      eq(schema.project.learningGateVerdicts.experimentId, experimentId),
    ));

  const readByBaseline = (baselineId: string) =>
    h.adminDb().select().from(schema.project.learningGateVerdicts).where(and(
      eq(schema.project.learningGateVerdicts.projectId, projectId()),
      eq(schema.project.learningGateVerdicts.baselineId, baselineId),
    ));

  /**
   * Build a seed row through the REAL derivation helpers, so the persisted identity is the one the
   * accessor would produce.
   *
   * The default row is the no-canary case (primary `keep`, resolved `keep`, `canary-absent`), which
   * is what a first evaluation before any replay canary has run looks like. Tests that need a
   * divergence pass the three verdicts through `overrides` explicitly — the resolution is then only
   * a default for the common case, never an authority over what a test declares.
   */
  const seed = (overrides: Partial<typeof schema.project.learningGateVerdicts.$inferInsert> = {}, inputOverrides: Partial<LearningGateVerdictInput> = {}) => {
    const verdictInput = input(inputOverrides);
    const inputFingerprint = computeLearningGateVerdictFingerprint(verdictInput);
    const resolution = resolveLearningGateVerdict("keep", null);
    const sig = verdictInput.primarySignals;
    return h.adminDb().insert(schema.project.learningGateVerdicts).values({
      projectId: projectId(),
      verdictId: overrides.verdictId ?? buildLearningGateVerdictId(EXPERIMENT_ID, BASELINE_ID, inputFingerprint),
      experimentId: EXPERIMENT_ID,
      baselineId: BASELINE_ID,
      resolvedVerdict: resolution.resolvedVerdict,
      primaryVerdict: resolution.primaryVerdict,
      canaryVerdict: resolution.canaryVerdict,
      precedenceOutcome: resolution.precedenceOutcome,
      inputFingerprint,
      buildOk: sig.buildOk,
      lintOk: sig.lintOk,
      typecheckOk: sig.typecheckOk,
      gateOk: sig.gateOk,
      affectedTestsOk: sig.affectedTestsOk,
      testCountDelta: sig.testCountDelta,
      costBudgetInvariantOk: sig.costBudgetInvariantOk,
      corpusVersion: sig.corpusVersion,
      seed: sig.seed,
      occurredAt: OCCURRED_AT,
      createdAt: CREATED_AT,
      ...overrides,
    });
  };

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

    const rows = await readByExperiment(EXPERIMENT_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: projectId(),
      experimentId: EXPERIMENT_ID,
      baselineId: BASELINE_ID,
      resolvedVerdict: "keep",
      primaryVerdict: "keep",
      canaryVerdict: null,
      precedenceOutcome: "canary-absent",
      buildOk: true,
      lintOk: true,
      typecheckOk: true,
      gateOk: true,
      affectedTestsOk: true,
      testCountDelta: 0,
      costBudgetInvariantOk: true,
      corpusVersion: "corpus-v1",
      seed: 42,
      occurredAt: OCCURRED_AT,
      createdAt: CREATED_AT,
    });
    // The stored fingerprint is the one the derivation produced, so the row is provably about the
    // inputs it claims — not a hand-written string that merely looks like a digest.
    expect(rows[0]!.inputFingerprint).toBe(computeLearningGateVerdictFingerprint(input()));
  });

  it("is readable by experiment AND by baseline — the two required readers", async () => {
    await seed();

    // Same single row, reached through both required index-backed lookups.
    expect(await readByExperiment(EXPERIMENT_ID)).toHaveLength(1);
    expect(await readByBaseline(BASELINE_ID)).toHaveLength(1);
    // A foreign id in either reader returns nothing: the reads are project-scoped, not global.
    expect(await readByExperiment("exp-other")).toHaveLength(0);
    expect(await readByBaseline("baseline-other")).toHaveLength(0);
  });

  it("persists BOTH inputs' verdicts so the precedence conflict is auditable", async () => {
    // The primary said reverse, the canary said keep — the load-bearing divergence case. The row
    // must hold all three verdicts so a reader sees the conflict WITHOUT re-running the gate.
    await seed(
      { resolvedVerdict: "reverse", primaryVerdict: "reverse", canaryVerdict: "keep", precedenceOutcome: "primary-prevailed" },
      { canaryVerdict: "keep" },
    );

    const rows = await readByExperiment(EXPERIMENT_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resolvedVerdict: "reverse",
      primaryVerdict: "reverse",
      canaryVerdict: "keep",
      precedenceOutcome: "primary-prevailed",
    });
  });

  it("persists the mirror divergence with the primary winning the other way", async () => {
    await seed(
      { resolvedVerdict: "keep", primaryVerdict: "keep", canaryVerdict: "reverse", precedenceOutcome: "primary-prevailed" },
      { canaryVerdict: "reverse" },
    );

    const rows = await readByExperiment(EXPERIMENT_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resolvedVerdict: "keep", primaryVerdict: "keep", canaryVerdict: "reverse", precedenceOutcome: "primary-prevailed" });
  });

  it("holds two DIFFERENT judgments about the same experiment as two rows", async () => {
    // Same experiment/baseline, different corpus version → different fingerprint → different derived
    // id. The append-only trail keeps BOTH, so "what did the gate say first, and what did it say
    // after the corpus changed?" is answerable.
    await seed({}, { primarySignals: signals({ corpusVersion: "corpus-v1" }) });
    await seed({}, { primarySignals: signals({ corpusVersion: "corpus-v2" }) });

    const rows = await readByExperiment(EXPERIMENT_ID);

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.verdictId)).size).toBe(2);
    expect(new Set(rows.map((r) => r.inputFingerprint)).size).toBe(2);
    expect(rows.map((r) => r.corpusVersion).sort()).toEqual(["corpus-v1", "corpus-v2"]);
  });

  it("absorbs an idempotent re-record of the SAME judgment on the derived primary key", async () => {
    // Same inputs derive the same verdict id, so a second insert collides on (project_id,
    // verdict_id). `onConflictDoNothing` is the ACCESSOR's own idempotency boundary, exercised here
    // with the same clause so this proves the derived id genuinely collides rather than proving a
    // no-op the accessor never uses. The trail holds one judgment, not N indistinguishable copies.
    await seed();
    const fingerprint = computeLearningGateVerdictFingerprint(input());
    await h.adminDb()
      .insert(schema.project.learningGateVerdicts)
      .values({
        projectId: projectId(),
        verdictId: buildLearningGateVerdictId(EXPERIMENT_ID, BASELINE_ID, fingerprint),
        experimentId: EXPERIMENT_ID,
        baselineId: BASELINE_ID,
        resolvedVerdict: "keep",
        primaryVerdict: "keep",
        canaryVerdict: null,
        precedenceOutcome: "canary-absent",
        inputFingerprint: fingerprint,
        buildOk: true,
        lintOk: true,
        typecheckOk: true,
        gateOk: true,
        affectedTestsOk: true,
        testCountDelta: 0,
        costBudgetInvariantOk: true,
        corpusVersion: "corpus-v1",
        seed: 42,
        occurredAt: OCCURRED_AT,
        createdAt: CREATED_AT,
      })
      .onConflictDoNothing();

    // The row count is asserted through a READ rather than the driver's result object: the
    // postgres-js driver does not populate `rowCount` on an `onConflictDoNothing` insert, and what
    // the idempotency contract actually promises is that the trail still holds ONE judgment. That
    // is the observable the accessor and the audit depend on, so it is what gets asserted.
    expect(await readByExperiment(EXPERIMENT_ID)).toHaveLength(1);
  });

  it("accepts every legal verdict and precedence outcome the TS contract allows", async () => {
    // A drifted CHECK is more damaging than a crash: it would let a verdict the domain model
    // forbids be read back as truth by the very gate that is supposed to be deterministic.
    await seed({ verdictId: "v-keep-absent", resolvedVerdict: "keep", primaryVerdict: "keep", canaryVerdict: null, precedenceOutcome: "canary-absent" });
    await seed({ verdictId: "v-keep-agreed", resolvedVerdict: "keep", primaryVerdict: "keep", canaryVerdict: "keep", precedenceOutcome: "agreed" });
    await seed({ verdictId: "v-rev-prevailed", resolvedVerdict: "reverse", primaryVerdict: "reverse", canaryVerdict: "keep", precedenceOutcome: "primary-prevailed" });
    await seed({ verdictId: "v-keep-abstained", resolvedVerdict: "keep", primaryVerdict: "inconclusive", canaryVerdict: "keep", precedenceOutcome: "primary-abstained" });
    await seed({ verdictId: "v-inc-abstained", resolvedVerdict: "inconclusive", primaryVerdict: "inconclusive", canaryVerdict: "inconclusive", precedenceOutcome: "agreed" });

    expect(await readByExperiment(EXPERIMENT_ID)).toHaveLength(5);
  });

  it("rejects a resolved verdict outside the closed enum", async () => {
    await rejectsOnCheck(seed({ verdictId: "v-bad", resolvedVerdict: "merged" }), "learning_gate_verdicts_resolved_verdict_check");
  });

  it("rejects a primary verdict outside the closed enum", async () => {
    await rejectsOnCheck(seed({ verdictId: "v-bad", primaryVerdict: "shipped" }), "learning_gate_verdicts_primary_verdict_check");
  });

  it("rejects a canary verdict outside the closed enum", async () => {
    await rejectsOnCheck(
      seed({ verdictId: "v-bad", canaryVerdict: "maybe", precedenceOutcome: "agreed" }),
      "learning_gate_verdicts_canary_verdict_check",
    );
  });

  it("rejects a precedence outcome outside the closed enum", async () => {
    // A canary verdict is supplied so the PAIRING check passes and the outcome is the ONLY thing
    // wrong with the row. Without it, a NULL canary would trip pairing first and the assertion
    // would pass for the wrong reason - proving the pairing invariant, not the enum.
    await rejectsOnCheck(
      seed({ verdictId: "v-bad", canaryVerdict: "keep", precedenceOutcome: "canary-won" }),
      "learning_gate_verdicts_precedence_outcome_check",
    );
  });

  it("rejects a canary verdict attached to a canary-absent outcome", async () => {
    // The pairing invariant the per-enum CHECKs alone cannot express: the row would otherwise claim
    // "no canary ran" while carrying one, making the stored precedence story self-contradictory.
    await rejectsOnCheck(
      seed({ verdictId: "v-bad", canaryVerdict: "keep", precedenceOutcome: "canary-absent" }),
      "learning_gate_verdicts_canary_pairing_check",
    );
  });

  it("rejects a non-canary-absent outcome with NO canary verdict attached", async () => {
    // The mirror: `primary-prevailed`/`agreed`/`primary-abstained` all mean a canary was consulted,
    // so none of them may arrive with a NULL canary.
    await rejectsOnCheck(
      seed({ verdictId: "v-bad", canaryVerdict: null, precedenceOutcome: "primary-prevailed" }),
      "learning_gate_verdicts_canary_pairing_check",
    );
  });

  it("rejects an input fingerprint that is not a sha256 hex digest", async () => {
    await rejectsOnCheck(seed({ verdictId: "v-bad", inputFingerprint: "not-a-digest" }), "learning_gate_verdicts_fingerprint_check");
  });
});
