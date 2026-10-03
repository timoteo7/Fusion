import { and, desc, eq, sql } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import { normalizeLedgerLimit, normalizeLedgerOffset } from "./async-learning-ledger.js";
import {
  buildLearningGateVerdictId,
  computeLearningGateVerdictFingerprint,
  isLearningGateVerdict,
  resolveLearningGateVerdict,
  type LearningGateVerdictResolution,
} from "../../self-improve/learning-gate-verdict-types.js";
import {
  LEARNING_GATE_PRECEDENCE_OUTCOMES,
  type LearningGatePrecedenceOutcome,
  type LearningGateVerdict,
  type LearningGateVerdictInput,
} from "../../types/self-improve/learning-gate-verdict.js";

/*
FNXC:SelfImproveGateVerdict 2026-09-30-15:26:
A gate verdict is an APPEND. `recordLearningGateVerdict` is INSERT-only and there is no accessor that
UPDATEs or DELETEs a verdict row, mirroring the ledger's append-only contract. A status flip on a
verdict would make "the gate judged this and was overruled" indistinguishable from "the gate judged
this once and the record moved", destroying the evidence the loop is audited on — and the resolved
verdict is precisely the thing an operator must be able to re-read unchanged.

FNXC:SelfImproveGateVerdict 2026-09-30-15:26:
The write is IDEMPOTENT through a DERIVED id and `onConflictDoNothing`. `verdict_id` is
buildLearningGateVerdictId(experiment, baseline, fingerprint) — never a fresh uuid per attempt — so
re-recording the SAME judgment collides on (project_id, verdict_id) and returns no row, which we
report as `already-recorded`. A re-evaluation under a changed corpus version or seed yields a
DIFFERENT fingerprint and therefore a genuinely new row, so the trail holds every judgment made
rather than the last write. This is the same derivation→collision→no-op shape FUSI-011 uses for
reversals, and it is why the recorder returns an explicit outcome instead of throwing on a repeat.

FNXC:SelfImproveGateVerdict 2026-09-30-15:26:
The RESOLUTION is computed here, in the accessor, from the caller's primary signals and canary
verdict, using the one pure function. The accessor never accepts a caller-supplied `resolvedVerdict`:
if it did, two callers could persist contradicting resolutions for the same inputs, and the record
would no longer be the output of the deterministic rule it claims to hold. The stored
primary/canary/resolved triple is therefore always self-consistent by construction.

FNXC:SelfImproveGateVerdict 2026-09-30-15:26:
Both readers are index-backed and PROJECT-SCOPED — always filtered on project_id, never addressed by
experiment or baseline id alone. That is the table's isolation model: an experiment id belonging to
another project is simply absent here, exactly as a foreign proposal id is for the ledger readers.
The readers return the newest judgment first (ORDER BY occurred_at DESC, verdict_id DESC), matching
the DESC trailing column on both indexes.

FNXC:SelfImproveGateVerdict 2026-09-30-15:26:
Pagination reuses the ledger's clamping helpers rather than introducing a second, looser pair:
`normalizeLedgerLimit`/`normalizeLedgerOffset` are the store-wide page-size contract (1..200, offset
floored at 0). A caller cannot bypass them by passing 0, a negative, or 10^9, and the paginated
list reports `hasMore`/`totalEntries` from the same `limit+1` probe plus a parallel `count(*)` the
ledger already established.
*/

function requireProjectId(layer: AsyncDataLayer): string {
  if (!layer.projectId) throw new Error("Learning gate verdict requires AsyncDataLayer.projectId");
  return layer.projectId;
}

type VerdictRow = typeof schema.project.learningGateVerdicts.$inferSelect;

/** True when `value` is one of the four fixed precedence outcomes. Guards a hand-built record. */
export function isLearningGatePrecedenceOutcome(value: unknown): value is LearningGatePrecedenceOutcome {
  return typeof value === "string" && (LEARNING_GATE_PRECEDENCE_OUTCOMES as readonly string[]).includes(value);
}

const mapVerdictRow = (row: VerdictRow): LearningGateVerdictInput & {
  verdictId: string;
  resolvedVerdict: LearningGateVerdict;
  primaryVerdict: LearningGateVerdict;
  canaryVerdict: LearningGateVerdict | null;
  precedenceOutcome: LearningGatePrecedenceOutcome;
  inputFingerprint: string;
  occurredAt: string;
  createdAt: string;
} => ({
  verdictId: row.verdictId,
  experimentId: row.experimentId,
  baselineId: row.baselineId,
  resolvedVerdict: row.resolvedVerdict as LearningGateVerdict,
  primaryVerdict: row.primaryVerdict as LearningGateVerdict,
  canaryVerdict: (row.canaryVerdict as LearningGateVerdict | null) ?? null,
  precedenceOutcome: row.precedenceOutcome as LearningGatePrecedenceOutcome,
  inputFingerprint: row.inputFingerprint,
  primarySignals: {
    buildOk: row.buildOk,
    lintOk: row.lintOk,
    typecheckOk: row.typecheckOk,
    gateOk: row.gateOk,
    affectedTestsOk: row.affectedTestsOk,
    testCountDelta: row.testCountDelta,
    costBudgetInvariantOk: row.costBudgetInvariantOk,
    corpusVersion: row.corpusVersion,
    seed: row.seed,
  },
  occurredAt: row.occurredAt,
  createdAt: row.createdAt,
});

/** A recorded gate verdict, as read back from the trail. */
export type LearningGateVerdictRecord = ReturnType<typeof mapVerdictRow>;

/** The result of recording one gate verdict. */
export type RecordLearningGateVerdictOutcome = "recorded" | "already-recorded";

/** The result of a `recordLearningGateVerdict` call. */
export interface RecordLearningGateVerdictResult {
  outcome: RecordLearningGateVerdictOutcome;
  /** The deterministic resolution, identical whether or not this call appended a row. */
  resolution: LearningGateVerdictResolution;
  /** The derived, idempotent verdict id — the same on a repeat call. */
  verdictId: string;
  /** The fingerprint the id and the stored row are keyed on. */
  inputFingerprint: string;
  /** The committed row; present only when `outcome: "recorded"`. */
  record?: LearningGateVerdictRecord;
}

/**
 * Record the deterministic gate's verdict for one experiment against one baseline.
 *
 * The resolution is computed by the ONE pure precedence function from the caller's primary signals
 * and canary verdict, so a caller cannot persist a verdict the rule would not have produced. The
 * write is idempotent: re-recording the identical judgment returns `already-recorded` and appends
 * nothing. Run-audit emission is NOT done here — the TaskStore delegation owns it, so a hostile sink
 * can never sit on the persistence path.
 */
export async function recordLearningGateVerdict(
  layer: AsyncDataLayer,
  input: LearningGateVerdictInput & { occurredAt?: string },
): Promise<RecordLearningGateVerdictResult> {
  const projectId = requireProjectId(layer);
  if (!input.experimentId?.trim()) throw new Error("A learning gate verdict requires an experimentId");
  if (!input.baselineId?.trim()) throw new Error("A learning gate verdict requires a baselineId");
  if (!input.primarySignals) throw new Error("A learning gate verdict requires the primary signals");
  if (input.canaryVerdict != null && !isLearningGateVerdict(input.canaryVerdict)) {
    throw new Error(`Unknown learning gate canary verdict: ${String(input.canaryVerdict)}`);
  }

  // The primary verdict is DERIVED from the primary signals by the same closed rule the later gate
  // feature will use: a candidate whose every lane is green and whose cost invariant held is a KEEP;
  // anything that failed a lane or moved the test count is a REVERSE; an absent signal set is an
  // honest INCONCLUSIVE. Deriving it here (rather than accepting a caller's label) means the stored
  // primary_verdict and the stored signals can never disagree.
  const primaryVerdict = derivePrimaryVerdict(input.primarySignals);
  const resolution = resolveLearningGateVerdict(primaryVerdict, input.canaryVerdict ?? null);
  const inputFingerprint = computeLearningGateVerdictFingerprint(input);
  const verdictId = buildLearningGateVerdictId(input.experimentId, input.baselineId, inputFingerprint);
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const sig = input.primarySignals;

  const inserted = await layer.db
    .insert(schema.project.learningGateVerdicts)
    .values({
      projectId,
      verdictId,
      experimentId: input.experimentId.trim(),
      baselineId: input.baselineId.trim(),
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
      occurredAt,
      createdAt: occurredAt,
    })
    .onConflictDoNothing()
    .returning();

  const row = inserted[0];
  if (!row) {
    // The derived id already existed: the identical judgment was recorded before. The resolution is
    // deterministic from the same inputs, so it is reported unchanged rather than re-read.
    return { outcome: "already-recorded", resolution, verdictId, inputFingerprint };
  }
  return { outcome: "recorded", resolution, verdictId, inputFingerprint, record: mapVerdictRow(row) };
}

/**
 * Derive the primary gate's own verdict from its deterministic signals.
 *
 * `inconclusive` is the honest abstention: it is returned only when the signals are ABSENT, not when
 * they fail, so a failing lane is a `reverse` and never silently downgraded to "we don't know".
 * A test-count delta or a broken cost invariant is a REVERSE, matching the mission's requirement
 * that the primary gate is a boolean over build/lint/typecheck/gate/affected-tests, the test-count
 * delta, and the cost-budget invariant.
 */
function derivePrimaryVerdict(signals: LearningGateVerdictInput["primarySignals"]): LearningGateVerdict {
  if (!signals) return "inconclusive";
  const allLanesGreen = signals.buildOk && signals.lintOk && signals.typecheckOk && signals.gateOk && signals.affectedTestsOk;
  if (!allLanesGreen) return "reverse";
  // A passing lane set with a moved test count or a broken cost invariant is still a rejection:
  // either means the candidate changed behaviour or cost in a way the mission's budget forbids.
  if (signals.testCountDelta !== 0) return "reverse";
  if (!signals.costBudgetInvariantOk) return "reverse";
  return "keep";
}

/**
 * Read the newest recorded verdict for one experiment.
 *
 * Project-scoped and index-backed on (project_id, experiment_id, occurred_at). An experiment id
 * belonging to another project — or one with no recorded verdict — yields an empty list, never
 * another project's row.
 */
export async function readLearningGateVerdictByExperiment(
  layer: AsyncDataLayer,
  experimentId: string,
): Promise<LearningGateVerdictRecord[]> {
  const projectId = requireProjectId(layer);
  if (!experimentId?.trim()) throw new Error("Reading a learning gate verdict requires an experimentId");
  const rows = await layer.db.select().from(schema.project.learningGateVerdicts).where(and(
    eq(schema.project.learningGateVerdicts.projectId, projectId),
    eq(schema.project.learningGateVerdicts.experimentId, experimentId.trim()),
  )).orderBy(desc(schema.project.learningGateVerdicts.occurredAt), desc(schema.project.learningGateVerdicts.verdictId));
  return rows.map(mapVerdictRow);
}

/**
 * Read every recorded verdict for one baseline, newest first.
 *
 * The second required reader: "what did the gate say about this baseline?" is what lets an operator
 * compare an experiment's judgment against the baseline it was measured from. Project-scoped and
 * index-backed on (project_id, baseline_id, occurred_at).
 */
export async function readLearningGateVerdictByBaseline(
  layer: AsyncDataLayer,
  baselineId: string,
): Promise<LearningGateVerdictRecord[]> {
  const projectId = requireProjectId(layer);
  if (!baselineId?.trim()) throw new Error("Reading a learning gate verdict requires a baselineId");
  const rows = await layer.db.select().from(schema.project.learningGateVerdicts).where(and(
    eq(schema.project.learningGateVerdicts.projectId, projectId),
    eq(schema.project.learningGateVerdicts.baselineId, baselineId.trim()),
  )).orderBy(desc(schema.project.learningGateVerdicts.occurredAt), desc(schema.project.learningGateVerdicts.verdictId));
  return rows.map(mapVerdictRow);
}

/** A page of gate verdicts, with the same shape the ledger listing returns. */
export interface LearningGateVerdictPage {
  verdicts: LearningGateVerdictRecord[];
  totalEntries: number;
  hasMore: boolean;
}

/** Query for the paginated listing. */
export interface LearningGateVerdictQuery {
  /** Optional experiment filter. */
  experimentId?: string;
  /** Optional baseline filter. */
  baselineId?: string;
  limit?: number;
  offset?: number;
}

/**
 * List recorded gate verdicts, newest first, with the ledger's page-size clamping.
 *
 * `hasMore` and `totalEntries` come from the `limit+1` probe plus a parallel `count(*)::int`, so the
 * caller learns whether more exist without a second round trip per page.
 */
export async function listLearningGateVerdicts(
  layer: AsyncDataLayer,
  query: LearningGateVerdictQuery = {},
): Promise<LearningGateVerdictPage> {
  const projectId = requireProjectId(layer);
  const verdicts = schema.project.learningGateVerdicts;
  // Reuse the ledger's clamping so a single page-size contract governs both ledgers.
  const limit = normalizeLedgerLimit(query.limit);
  const offset = normalizeLedgerOffset(query.offset);

  const where = and(
    eq(verdicts.projectId, projectId),
    query.experimentId?.trim() ? eq(verdicts.experimentId, query.experimentId.trim()) : undefined,
    query.baselineId?.trim() ? eq(verdicts.baselineId, query.baselineId.trim()) : undefined,
  );

  const [rows, counts] = await Promise.all([
    layer.db.select().from(verdicts).where(where).orderBy(desc(verdicts.occurredAt), desc(verdicts.verdictId)).limit(limit + 1).offset(offset),
    layer.db.select({ count: sql<number>`count(*)::int` }).from(verdicts).where(where),
  ]);

  return {
    verdicts: rows.slice(0, limit).map(mapVerdictRow),
    totalEntries: counts[0]?.count ?? 0,
    hasMore: rows.length > limit,
  };
}
