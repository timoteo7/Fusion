import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../../postgres/data-layer.js";
import { emitBoundedRunAudit, type RunAuditSinkHost } from "../../run-audit/emit-bounded-run-audit.js";
import type { LearningProposalEvidenceRef, LearningProposalTarget } from "../../types/self-improve/learning-proposal.js";
import type { LearningLedgerEvent } from "../../self-improve/ledger-events.js";
import {
  buildLearningRevertEventId,
  isLearningRevertReason,
  type LearningRevertInput,
  type LearningRevertReason,
  type LearningRevertResult,
} from "../../self-improve/learning-revert-types.js";

/*
FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
A revert is an APPEND of a `reverted` event that names the `applied` event it cancels. Nothing in
this module ever UPDATEs or DELETEs the application or the proposal row. That is the whole point of
FUSI-010's second table: the value an application superseded survives untouched, so the reversal can
name it and an operator can replay the trail. A status flip on the application would make "applied
then reverted" indistinguishable from "never applied" and destroy the evidence the loop is audited on.

FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
The read-then-write happens inside ONE `transactionImmediate`, which is what makes a repeated (or
concurrent) revert collapse to a single reversal row instead of N indistinguishable ones. The revert
event id is DERIVED from the application it cancels (`<appliedEventId>:reverted`), so the second
insert collides on the (project_id, event_id) primary key and `onConflictDoNothing` returns no row —
which we report as `already-reverted`. A generated uuid per attempt would append N rows and the
trail could no longer answer "was this reverted, and how many times" honestly.

FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
`noLaterThan` is the retried-revert fence, mirroring the patchnode precedent. It bounds the
application lookup to events at-or-before an instant. A retried revert passes the instant of the
reversal it is retrying, so it re-affirms the ORIGINAL application rather than a re-application that
shipped afterwards; a genuine NEW revert omits the fence and pairs with the latest application. This
is what makes "revert -> re-apply -> revert" produce three ordered, non-collapsed steps.

FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
`restoredValue` is the proposal's `priorValue` returned VERBATIM, including its nullable and falsy
shapes. The surface that owns the Memory/Evals/Skills target writes it back; this layer stores no
value because M1 mutates no product surface, and a second value store here would compete with the
trail as a source of truth. A `null` priorValue is a legitimate result (nothing was held before the
first application) and is meaningfully distinct from "no revert happened".

FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
Run-audit emission is bounded and best-effort. A hostile, absent, throwing, or never-settling audit
sink must not change the revert's outcome or the ledger content — the transition is already committed
in its own transaction before emission, and the emitter absorbs sink faults. Metadata is ids/counts/
fixed-outcomes only: it never carries free prose, a verdict, or a diff.
*/

function requireProjectId(layer: AsyncDataLayer): string {
  if (!layer.projectId) throw new Error("Learning revert requires AsyncDataLayer.projectId");
  return layer.projectId;
}

type EventRow = typeof schema.project.learningLedgerEvents.$inferSelect;
type ProposalRow = typeof schema.project.learningProposals.$inferSelect;

const mapEventRow = (row: EventRow): LearningLedgerEvent => ({
  eventId: row.eventId,
  proposalId: row.proposalId,
  target: row.target as LearningProposalTarget,
  kind: row.kind as LearningLedgerEvent["kind"],
  revertsEventId: row.revertsEventId,
  revertReason: (row.revertReason as LearningRevertReason | null) ?? null,
  evidenceRefs: (row.evidenceRefs ?? []) as LearningProposalEvidenceRef[],
  occurredAt: row.occurredAt,
  createdAt: row.createdAt,
});

/** Read the proposal row scoped to BOTH project and proposal id — never addressed by id alone. */
async function readProposalWithDb(
  db: AsyncDataLayer["db"] | DbTransaction,
  projectId: string,
  proposalId: string,
): Promise<ProposalRow | undefined> {
  const rows = await db.select().from(schema.project.learningProposals).where(and(
    eq(schema.project.learningProposals.projectId, projectId),
    eq(schema.project.learningProposals.proposalId, proposalId),
  )).limit(1);
  return rows[0];
}

/**
 * The id of every `applied` event already cancelled by some reversal, for a proposal.
 *
 * The sub-select reads the set of `reverts_event_id` values among this proposal's `reverted`
 * events, so the "latest UN-reverted application" lookup can exclude them. Scoped to the project.
 */
const revertedEventIds = (projectId: string, proposalId: string) =>
  sql<string>`(
    SELECT r.reverts_event_id FROM ${schema.project.learningLedgerEvents} r
    WHERE r.project_id = ${projectId}
      AND r.proposal_id = ${proposalId}
      AND r.kind = 'reverted'
      AND r.reverts_event_id IS NOT NULL
  )`;

/**
 * Find the application a revert should cancel.
 *
 * When `appliedEventId` is given, that exact application is targeted (validated to belong to this
 * proposal and be un-reverted). When it is omitted, the LATEST un-reverted application is chosen,
 * optionally fenced by `noLaterThan`. Either way an application that is already reverted is excluded,
 * so this returns null for an "already-reverted or never-applied" proposal and the caller reports
 * the right no-op outcome rather than appending a duplicate.
 */
async function findApplicationToRevert(
  db: AsyncDataLayer["db"] | DbTransaction,
  projectId: string,
  proposalId: string,
  options: { appliedEventId?: string; noLaterThan?: string },
): Promise<EventRow | undefined> {
  const events = schema.project.learningLedgerEvents;
  const baseFilters: (SQL | undefined)[] = [
    eq(events.projectId, projectId),
    eq(events.proposalId, proposalId),
    eq(events.kind, "applied"),
  ];

  if (options.appliedEventId !== undefined) {
    const targeted = await db.select().from(events).where(and(...baseFilters, eq(events.eventId, options.appliedEventId))).limit(1);
    const application = targeted[0];
    if (!application) return undefined;
    // The targeted application must not already be cancelled, or the correct outcome is already-reverted.
    const already = await db.select({ eventId: events.eventId }).from(events).where(and(
      eq(events.projectId, projectId),
      eq(events.proposalId, proposalId),
      eq(events.kind, "reverted"),
      eq(events.revertsEventId, application.eventId),
    )).limit(1);
    return already.length ? undefined : application;
  }

  // No explicit target: choose the latest un-reverted application, optionally fenced at noLaterThan.
  const filters: (SQL | undefined)[] = [
    ...baseFilters,
    sql`${events.eventId} NOT IN ${revertedEventIds(projectId, proposalId)}`,
  ];
  // `occurredAt` is ISO-8601 text, so the latest-application ordering and the `noLaterThan` fence
  // both run on a Postgres-normalized epoch (milliseconds). Normalizing (rather than comparing the
  // text) means an offset timestamp like `...T02:00:00+01:00` fences and orders by its true instant,
  // not lexicographically. The regex guard keeps a non-ISO `occurred_at` from being coerced, and such
  // a row sorts last on `NULL` so it can never be mistaken for the latest application.
  const occurredAtEpochMs = sql<number | null>`(
    CASE WHEN ${events.occurredAt} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN EXTRACT(EPOCH FROM (${events.occurredAt})::timestamptz) * 1000 END
  )`;
  if (options.noLaterThan !== undefined) {
    // A non-numeric/undateable fence falls back to "no application" rather than to an un-fenced
    // latest, so a malformed marker can never widen a retried revert into cancelling a later
    // re-application.
    const markerMs = Date.parse(options.noLaterThan);
    if (!Number.isFinite(markerMs)) return undefined;
    // A non-ISO stored `occurred_at` yields NULL here, which fails the comparison and is excluded —
    // the same guard keeps the `::timestamptz` cast from raising on unparseable text.
    filters.push(sql<boolean>`${occurredAtEpochMs} <= ${markerMs}`);
  }
  const rows = await db.select().from(events).where(and(...filters)).orderBy(
    desc(occurredAtEpochMs),
    desc(events.eventId),
  ).limit(1);
  return rows[0];
}

/**
 * Locate the application a `noLaterThan`-fenced revert re-affirms, regardless of whether it has
 * already been reverted.
 *
 * The cancel-candidate query deliberately EXCLUDES already-reverted applications, so a retried
 * revert finds nothing there. This companion lookup answers the different question the retried caller
 * is actually asking — "which application episode am I re-affirming?" — so the result can name it
 * instead of reporting an empty id. It is bounded by the same marker, which is what keeps a retry
 * from being reported against a later re-application.
 */
async function findFencedApplication(
  db: AsyncDataLayer["db"] | DbTransaction,
  projectId: string,
  proposalId: string,
  noLaterThan: string,
): Promise<EventRow | undefined> {
  const events = schema.project.learningLedgerEvents;
  const markerMs = Date.parse(noLaterThan);
  if (!Number.isFinite(markerMs)) return undefined;
  const occurredAtEpochMs = sql<number | null>`(
    CASE WHEN ${events.occurredAt} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN EXTRACT(EPOCH FROM (${events.occurredAt})::timestamptz) * 1000 END
  )`;
  const rows = await db.select().from(events).where(and(
    eq(events.projectId, projectId),
    eq(events.proposalId, proposalId),
    eq(events.kind, "applied"),
    sql<boolean>`${occurredAtEpochMs} <= ${markerMs}`,
  )).orderBy(
    desc(occurredAtEpochMs),
    desc(events.eventId),
  ).limit(1);
  return rows[0];
}

/** Build the result object for a no-op outcome that never appended a row. */
function noResult(
  outcome: "already-reverted" | "not-applied",
  base: { proposalId: string; target?: LearningProposalTarget; appliedEventId: string; revertEventId: string; restoredValue: number | null },
): LearningRevertResult {
  return { outcome, ...base };
}

/**
 * Revert a learning application: append a `reverted` event naming it, and report the value to
 * restore.
 *
 * The returned `restoredValue` is the proposal's `priorValue` verbatim. Applying it to the product
 * surface is the caller's job — this layer never mutates Memory/Evals/Skills. Exactly one of three
 * outcomes is returned, and only `reverted` writes a row: `already-reverted` and `not-applied` are
 * honest no-ops.
 */
export async function revertLearningApplication(
  layer: AsyncDataLayer,
  input: LearningRevertInput,
  options: { auditHost?: RunAuditSinkHost } = {},
): Promise<LearningRevertResult> {
  const projectId = requireProjectId(layer);
  if (!isLearningRevertReason(input.reason)) {
    throw new Error(`Unknown learning revert reason: ${String(input.reason)}`);
  }
  const proposalId = input.proposalId?.trim();
  if (!proposalId) throw new Error("A learning revert requires a proposalId");

  const outcome = await layer.transactionImmediate(async (tx) => {
    const proposalRow = await readProposalWithDb(tx, projectId, proposalId);
    if (!proposalRow) {
      // No proposal in this project: nothing was applied, so there is nothing to cancel. This also
      // enforces project isolation — a proposalId from another project is simply absent here. The
      // result deliberately carries no `target`: a proposal that does not exist has no surface, and
      // reporting one would fabricate knowledge the ledger does not have.
      return {
        outcome: "not-applied",
        proposalId,
        appliedEventId: input.appliedEventId?.trim() ?? "",
        revertEventId: input.appliedEventId?.trim() ? buildLearningRevertEventId(input.appliedEventId) : "",
        restoredValue: null,
      } satisfies LearningRevertResult;
    }
    const target = proposalRow.target as LearningProposalTarget;
    const application = await findApplicationToRevert(tx, projectId, proposalId, {
      appliedEventId: input.appliedEventId?.trim() || undefined,
      noLaterThan: input.noLaterThan,
    });
    if (!application) {
      // Distinguish "there was never an un-reverted application" from "the targeted one is already
      // reverted" by checking whether the specific target is already cancelled. When the caller named
      // an explicit application that we could not find UN-reverted, it may be already-reverted or
      // never-applied; we report already-reverted only if a reversal already names that id.
      let outcome: "already-reverted" | "not-applied" = "not-applied";
      let appliedEventId = input.appliedEventId?.trim() ?? "";
      if (appliedEventId) {
        const already = await tx.select({ eventId: schema.project.learningLedgerEvents.eventId })
          .from(schema.project.learningLedgerEvents)
          .where(and(
            eq(schema.project.learningLedgerEvents.projectId, projectId),
            eq(schema.project.learningLedgerEvents.kind, "reverted"),
            eq(schema.project.learningLedgerEvents.revertsEventId, appliedEventId),
          )).limit(1);
        if (already.length) outcome = "already-reverted";
      } else if (input.noLaterThan !== undefined) {
        /*
        FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
        A retried revert fences on the instant of the reversal it is retrying, so the cancel lookup
        (which excludes already-cancelled applications) correctly finds nothing to cancel. Naming the
        application the fence lands on is what lets the caller see WHICH episode it re-affirmed,
        instead of a bare `already-reverted` with an empty id — the difference between "your retry
        was absorbed" and "your retry was absorbed, and it was this application".
        */
        const fenced = await findFencedApplication(tx, projectId, proposalId, input.noLaterThan);
        if (fenced) {
          appliedEventId = fenced.eventId;
          outcome = "already-reverted";
        }
      } else {
        // No explicit target and no un-reverted application: if the proposal has any reversal at all,
        // its applications are all cancelled (already-reverted); otherwise nothing was applied.
        const anyReversal = await tx.select({ eventId: schema.project.learningLedgerEvents.eventId })
          .from(schema.project.learningLedgerEvents)
          .where(and(
            eq(schema.project.learningLedgerEvents.projectId, projectId),
            eq(schema.project.learningLedgerEvents.proposalId, proposalId),
            eq(schema.project.learningLedgerEvents.kind, "reverted"),
          )).limit(1);
        if (anyReversal.length) outcome = "already-reverted";
      }
      return noResult(outcome, {
        proposalId,
        target,
        appliedEventId,
        revertEventId: appliedEventId ? buildLearningRevertEventId(appliedEventId) : "",
        restoredValue: (proposalRow.priorValue ?? null) as number | null,
      });
    }

    const appliedEventId = application.eventId;
    const revertEventId = buildLearningRevertEventId(appliedEventId);
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const inserted = await tx.insert(schema.project.learningLedgerEvents).values({
      projectId,
      eventId: revertEventId,
      proposalId,
      target,
      kind: "reverted",
      revertsEventId: appliedEventId,
      revertReason: input.reason,
      evidenceRefs: input.evidenceRefs ?? [],
      occurredAt,
      createdAt: occurredAt,
    }).onConflictDoNothing().returning();
    const stored = inserted[0];
    if (!stored) {
      // The derived id collided: this exact application was already cancelled. Report the no-op
      // without having written anything.
      return noResult("already-reverted", {
        proposalId,
        target,
        appliedEventId,
        revertEventId,
        restoredValue: (proposalRow.priorValue ?? null) as number | null,
      });
    }
    return {
      outcome: "reverted",
      proposalId,
      target,
      appliedEventId,
      revertEventId,
      restoredValue: (proposalRow.priorValue ?? null) as number | null,
      event: mapEventRow(stored),
      reason: input.reason,
      evidenceRefs: input.evidenceRefs ?? [],
    } satisfies LearningRevertResult;
  });

  // FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45: emission happens AFTER the
  // transaction commits and is bounded + best-effort. A hostile sink cannot alter the already-final
  // outcome or the committed trail. The sink is supplied by the caller (TaskStore passes `this`),
  // because the AsyncDataLayer itself has no recordRunAuditEvent — a layer cast to a host would
  // always read as `absent` and silently never emit.
  await emitRunAudit(options.auditHost, input, outcome);
  return outcome;
}

/** Emit the bounded run-audit row for a revert attempt. Never throws, never alters the outcome. */
async function emitRunAudit(
  host: RunAuditSinkHost | undefined,
  input: LearningRevertInput,
  result: LearningRevertResult,
): Promise<void> {
  // `outcome` and `reason` are fixed enums; metadata is ids only. No prose, verdict, or diff.
  await emitBoundedRunAudit(host, {
    agentId: "self-improve",
    runId: `learning-revert:${result.proposalId}`,
    domain: "database",
    mutationType: "learning:reverted",
    target: result.proposalId,
    metadata: {
      proposalId: result.proposalId,
      target: result.target,
      appliedEventId: result.appliedEventId || null,
      revertEventId: result.revertEventId || null,
      outcome: result.outcome,
      reason: input.reason,
    },
  });
}
