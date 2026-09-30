import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import type { LearningProposal, LearningProposalEvidenceRef, LearningProposalState, LearningProposalTarget } from "../../types/self-improve/learning-proposal.js";
import type {
  LearningLedgerEvent,
  LearningLedgerEventKind,
  LearningLedgerPage,
  LearningLedgerQuery,
} from "../../self-improve/ledger-events.js";
import { isLearningRevertReason, type LearningRevertReason } from "../../self-improve/learning-revert-types.js";

/*
FNXC:SelfImproveLearningLedger 2026-09-29-15:15:
Every write in this module is an INSERT. There is deliberately no update or delete path: the trial's
revert decision (FUSI-011) reads the value a proposal HELD before the experiment, which is only
answerable because the prior application row survived untouched.

FNXC:SelfImproveRunAudit 2026-09-29-23:04:
This module still emits no run-audit of its own, but the REASON changed in FUSI-015. Emission used to
be absent because FUSI-012 had only declared the contract; the `selfimprove:*` rows are now emitted,
from the TaskStore WRITE delegations in `store.ts` that call these functions, after the write has
committed and unawaited through the bounded core seam. Keeping the emission OUT OF this module is now
a layering choice rather than an absence: the ledger layer stays a pure durability boundary (INSERTs
only, no telemetry dependency), while the audit row is recorded by the owner of the store's sink. A
stalled audit sink therefore still cannot block a learning transition, and a ledger write stays
readable without any audit infrastructure present.

FNXC:SelfImproveLearningLedger 2026-09-29-15:15:
The proposal row and its opening `proposed` event are written in ONE `transactionImmediate`. A
proposal whose row committed without its event would leave the trail unable to explain how the
proposal came to exist; a proposal that existed before the trail did would be invisible to replay.
One transaction makes the trail a self-sufficient record of every proposal's whole life.
*/

function requireProjectId(layer: AsyncDataLayer): string {
  if (!layer.projectId) throw new Error("Learning ledger requires AsyncDataLayer.projectId");
  return layer.projectId;
}

type ProposalRow = typeof schema.project.learningProposals.$inferSelect;
type EventRow = typeof schema.project.learningLedgerEvents.$inferSelect;

const mapEventRow = (row: EventRow): LearningLedgerEvent => ({
  eventId: row.eventId,
  proposalId: row.proposalId,
  target: row.target as LearningProposalTarget,
  kind: row.kind as LearningLedgerEventKind,
  revertsEventId: row.revertsEventId,
  // FNXC:SelfImproveLearningRevertSemantics 2026-09-30-08:08: the reason a reversal was appended is
  // part of the event's own contract (FUSI-011), so it is mapped onto the returned event rather than
  // left for a caller to re-read from the row.
  revertReason: (row.revertReason ?? null) as LearningRevertReason | null,
  evidenceRefs: (row.evidenceRefs ?? []) as LearningProposalEvidenceRef[],
  occurredAt: row.occurredAt,
  createdAt: row.createdAt,
});

const mapProposalRow = (row: ProposalRow): LearningProposal => ({
  proposalId: row.proposalId,
  target: row.target as LearningProposalTarget,
  origin: row.origin,
  confidence: row.confidence,
  value: row.value,
  priorValue: row.priorValue,
  expiresAt: row.expiresAt,
  evidenceRefs: (row.evidenceRefs ?? []) as LearningProposalEvidenceRef[],
  state: row.state as LearningProposalState,
  version: row.version,
  createdAt: row.createdAt,
});

/**
 * Derive a proposal's CURRENT state from its trail: the kind of its latest event.
 *
 * A proposal with no events falls back to `proposed` — the state its opening event would have
 * carried — so a row written before the trail existed (or read for a proposal whose event write is
 * still in flight) never reads as an unknown state.
 *
 * FNXC:SelfImproveLearningLedger 2026-09-29-15:15: exported so the pure rule is testable without a
 * database; the accessor itself is the only production caller.
 */
export function deriveLearningStateFromEvents(events: LearningLedgerEvent[]): LearningProposalState {
  const latest = events[events.length - 1];
  return (latest?.kind ?? "proposed") as LearningProposalState;
}

/** Build the opening `proposed` event id for a proposal, keeping it stable across retries. */
function buildProposedEventId(proposalId: string): string {
  return `${proposalId}:proposed`;
}

export type AppendLearningProposalInput = {
  proposal: LearningProposal;
  /** Event id for the opening `proposed` event; defaults to `<proposalId>:proposed`. */
  eventId?: string;
};

/**
 * Insert a proposal AND its opening `proposed` event in one immediate transaction.
 *
 * Neither row is ever updated afterwards. The proposal row is the current assertion; the opening
 * event makes the trail able to explain the proposal's origin without a join back to the row.
 */
export async function appendLearningProposal(
  layer: AsyncDataLayer,
  input: AppendLearningProposalInput,
): Promise<LearningProposal> {
  const projectId = requireProjectId(layer);
  const proposal = input.proposal;
  const eventId = input.eventId?.trim() || buildProposedEventId(proposal.proposalId);
  return layer.transactionImmediate(async (tx) => {
    await tx.insert(schema.project.learningProposals).values({
      projectId,
      proposalId: proposal.proposalId,
      target: proposal.target,
      origin: proposal.origin,
      confidence: proposal.confidence,
      value: proposal.value,
      priorValue: proposal.priorValue,
      expiresAt: proposal.expiresAt,
      evidenceRefs: proposal.evidenceRefs,
      state: proposal.state,
      version: proposal.version,
      createdAt: proposal.createdAt,
    }).onConflictDoNothing();
    await tx.insert(schema.project.learningLedgerEvents).values({
      projectId,
      eventId,
      proposalId: proposal.proposalId,
      target: proposal.target,
      kind: "proposed",
      revertsEventId: null,
      evidenceRefs: proposal.evidenceRefs,
      occurredAt: proposal.createdAt,
      createdAt: proposal.createdAt,
    }).onConflictDoNothing();
    const rows = await tx.select().from(schema.project.learningProposals).where(and(
      eq(schema.project.learningProposals.projectId, projectId),
      eq(schema.project.learningProposals.proposalId, proposal.proposalId),
    ));
    const stored = rows[0];
    if (!stored) throw new Error(`Learning proposal ${proposal.proposalId} was not stored`);
    return mapProposalRow(stored);
  });
}

export type RecordLearningApplicationInput = {
  proposalId: string;
  eventId: string;
  target: LearningProposalTarget;
  evidenceRefs?: LearningProposalEvidenceRef[];
  occurredAt: string;
};

/**
 * Append an `applied` event. NEVER updates the proposal row.
 *
 * Leaving the proposal row alone is the whole point of the second table: the row keeps the value it
 * last asserted, and this event records that the application happened, so a later revert can restore
 * the prior value from the trail (FUSI-011) rather than from a field that was overwritten here.
 */
export async function recordLearningApplication(
  layer: AsyncDataLayer,
  input: RecordLearningApplicationInput,
): Promise<LearningLedgerEvent> {
  const projectId = requireProjectId(layer);
  const rows = await layer.db.insert(schema.project.learningLedgerEvents).values({
    projectId,
    eventId: input.eventId,
    proposalId: input.proposalId,
    target: input.target,
    kind: "applied",
    revertsEventId: null,
    evidenceRefs: input.evidenceRefs ?? [],
    occurredAt: input.occurredAt,
    createdAt: input.occurredAt,
  }).onConflictDoNothing().returning();
  const stored = rows[0];
  if (!stored) throw new Error(`Learning application event ${input.eventId} was not stored`);
  return mapEventRow(stored);
}

export type RecordLearningReversalInput = {
  proposalId: string;
  eventId: string;
  target: LearningProposalTarget;
  /** The `applied` event this reversal cancels. Required; the database CHECK enforces it too. */
  revertsEventId: string;
  /**
   * WHY this application was backed out, as a member of the fixed revert-reason enum.
   * Required: migration 0088 enforces that `revert_reason` is present exactly when
   * `kind='reverted'`, so a reversal that omits it is rejected at the database boundary.
   */
  revertReason: LearningRevertReason;
  evidenceRefs?: LearningProposalEvidenceRef[];
  occurredAt: string;
};

/**
 * Append a `reverted` event naming the `applied` event it cancels. NEVER updates the proposal row.
 *
 * Pairing the reversal to a specific application event — rather than to "the proposal" — is what
 * makes a re-application after a revert unambiguous: the trail shows applied → reverted(applied₁)
 * → applied₂, so the prior value each application superseded is recoverable per-episode.
 */
export async function recordLearningReversal(
  layer: AsyncDataLayer,
  input: RecordLearningReversalInput,
): Promise<LearningLedgerEvent> {
  const projectId = requireProjectId(layer);
  /*
  FNXC:SelfImproveLearningLedger 2026-09-29-15:15:
  A blank `revertsEventId` is rejected HERE, not left to the database. The CHECK constraint tests
  `IS NOT NULL`, which an empty string satisfies, so a reversal paired to nothing would otherwise
  be written as an unreplayable event that names no application. Trimming and requiring a non-empty
  pairing makes the invariant hold for every input shape, including the one the constraint misses.
  */
  const revertsEventId = input.revertsEventId?.trim();
  if (!revertsEventId) throw new Error("Learning reversal requires the event id of the application it cancels");
  /*
  FNXC:SelfImproveLearningRevertSemantics 2026-09-29-21:07:
  A reversal must name a fixed-enum reason. Migration 0088 adds a CHECK requiring `revert_reason`
  whenever `kind='reverted'`, so a store caller that omitted it would have every reversal rejected
  at the database boundary. Validating here (against the same fixed enum the CHECK allows) turns
  that into a clear caller error and keeps the column a classifiable reason, never free prose.
  */
  if (!isLearningRevertReason(input.revertReason)) {
    throw new Error(`Learning reversal requires a revert reason from the fixed enum; got ${String(input.revertReason)}`);
  }
  const rows = await layer.db.insert(schema.project.learningLedgerEvents).values({
    projectId,
    eventId: input.eventId,
    proposalId: input.proposalId,
    target: input.target,
    kind: "reverted",
    revertsEventId,
    // A reversal always carries a reason: the database CHECK requires it, and an unauditable
    // "undone, but nobody can say why" row is exactly what the enum exists to prevent.
    revertReason: input.revertReason,
    evidenceRefs: input.evidenceRefs ?? [],
    occurredAt: input.occurredAt,
    createdAt: input.occurredAt,
  }).onConflictDoNothing().returning();
  const stored = rows[0];
  if (!stored) throw new Error(`Learning reversal event ${input.eventId} was not stored`);
  return mapEventRow(stored);
}

/*
FNXC:SelfImproveRunAudit 2026-09-29-21:49:
`recordLearningApplication` appends only an EVENT, which carries the proposal's identity and the
target but NOT the weight the application asserted (`version`, `confidence`, `value`, evidence
count). The `selfimprove:proposal-applied` audit row must record that weight as bounded counts —
never a diff — so the store delegation needs a way to read the proposal row the event was appended
against. `readLearningProposal` is that read, kept as a MODULE-LEVEL export (not a new TaskStore
method) so the FN-8923 durable-write inventory surface is unchanged by this task: a store method
added for telemetry would have to be classified as a writer, and a writer that exists only to feed
audit rows would misstate the ledger's durability boundary.

FNXC:SelfImproveRunAudit 2026-09-29-21:49:
A missing proposal row returns null rather than throwing. The application EVENT append and the
proposal READ are two separate statements; if the row is absent the emission is SKIPPED (the store
delegation treats null as "no audit row") and never FABRICATED with placeholder weights. An audit
row that invents a confidence or version the ledger does not hold is worse than no audit row: it
would let an operator read a weight off the trail that no learning assertion ever made.
*/
export async function readLearningProposal(
  layer: AsyncDataLayer,
  proposalId: string,
): Promise<LearningProposal | null> {
  const projectId = requireProjectId(layer);
  const rows = await layer.db.select().from(schema.project.learningProposals).where(and(
    eq(schema.project.learningProposals.projectId, projectId),
    eq(schema.project.learningProposals.proposalId, proposalId),
  ));
  const stored = rows[0];
  return stored ? mapProposalRow(stored) : null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/** Clamp a caller-supplied page size into 1..MAX_LIMIT; non-finite falls back to the default. */
export function normalizeLedgerLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit!)));
}

/** Floor a caller-supplied offset at 0; non-finite becomes 0. */
export function normalizeLedgerOffset(offset: number | undefined): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.trunc(offset!));
}

/** The instant each proposal's state is read at: its LATEST event's `occurred_at`, else the row's `created_at`. */
const latestEventAt = (projectId: string) =>
  sql<string>`COALESCE((
    SELECT e.occurred_at FROM ${schema.project.learningLedgerEvents} e
    WHERE e.project_id = ${projectId} AND e.proposal_id = ${schema.project.learningProposals.proposalId}
    ORDER BY e.occurred_at DESC, e.event_id DESC LIMIT 1
  ), ${schema.project.learningProposals.createdAt})`;

/** The kind of each proposal's LATEST event — the source of truth for its derived state. */
const latestEventKind = (projectId: string) =>
  sql<string>`(
    SELECT e.kind FROM ${schema.project.learningLedgerEvents} e
    WHERE e.project_id = ${projectId} AND e.proposal_id = ${schema.project.learningProposals.proposalId}
    ORDER BY e.occurred_at DESC, e.event_id DESC LIMIT 1
  )`;

/**
 * List proposals filtered by target, DERIVED state, and the window of their latest event.
 *
 * `state` filters on the state derived from the latest event rather than the proposal row's own
 * `state` column, because the append-only trail is the source of truth for what is in effect. The
 * window (`from`/`to`) bounds the same latest-event instant, so a proposal that was active during
 * the window still appears even if its `createdAt` predates it. Pagination uses the `limit+1`
 * probe plus a parallel `count(*)::int` so `hasMore` and `totalEntries` come from one round trip
 * pair without a full-table scan.
 */
export async function listLearningProposals(
  layer: AsyncDataLayer,
  query: LearningLedgerQuery = {},
): Promise<LearningLedgerPage> {
  const projectId = requireProjectId(layer);
  const proposals = schema.project.learningProposals;
  const events = schema.project.learningLedgerEvents;
  const limit = normalizeLedgerLimit(query.limit);
  const offset = normalizeLedgerOffset(query.offset);

  const latestAt = latestEventAt(projectId);
  const latestKind = latestEventKind(projectId);
  const filters: (SQL | undefined)[] = [
    eq(proposals.projectId, projectId),
    query.target ? eq(proposals.target, query.target) : undefined,
    query.state ? sql`COALESCE(${latestKind}, 'proposed') = ${query.state}` : undefined,
    query.from ? sql`${latestAt} >= ${query.from}` : undefined,
    query.to ? sql`${latestAt} <= ${query.to}` : undefined,
  ];
  const where = and(...filters);

  const [rows, counts] = await Promise.all([
    layer.db.select().from(proposals).where(where).orderBy(sql`${latestAt} DESC`, sql`${proposals.proposalId} DESC`).limit(limit + 1).offset(offset),
    layer.db.select({ count: sql<number>`count(*)::int` }).from(proposals).where(where),
  ]);

  const page = rows.slice(0, limit);
  const proposalIds = page.map((row) => row.proposalId);
  // The trail is read ONCE for the whole page (index-backed on project_id+proposal_id), rather
  // than per-row, so deriving each proposal's state costs a single additional round trip per page
  // instead of a correlated subquery per row.
  const trail = proposalIds.length
    ? await layer.db.select().from(events).where(and(
      eq(events.projectId, projectId),
      inArray(events.proposalId, proposalIds),
    )).orderBy(asc(events.occurredAt), asc(events.eventId))
    : [];
  const trailByProposal = new Map<string, LearningLedgerEvent[]>();
  for (const eventRow of trail) {
    const mapped = mapEventRow(eventRow);
    const bucket = trailByProposal.get(mapped.proposalId);
    if (bucket) bucket.push(mapped);
    else trailByProposal.set(mapped.proposalId, [mapped]);
  }

  return {
    proposals: page.map((row) => {
      const base = mapProposalRow(row);
      const eventsForProposal = trailByProposal.get(row.proposalId) ?? [];
      return {
        ...base,
        derivedState: deriveLearningStateFromEvents(eventsForProposal),
        declaredState: base.state,
        events: eventsForProposal,
      };
    }),
    totalEntries: Number(counts[0]?.count ?? 0),
    hasMore: rows.length > limit,
  };
}
