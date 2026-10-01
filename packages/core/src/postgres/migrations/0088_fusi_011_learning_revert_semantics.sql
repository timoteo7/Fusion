/*
FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
FUSI-011 adds the REASON a learning application was reverted to the append-only event trail that
FUSI-010 created. The trail row itself is unchanged in kind and pairing: a reversal is still a NEW
`kind='reverted'` event naming the `applied` event it cancels via `reverts_event_id`, and the
application row is still never updated or deleted. What is new is that the reversal now carries a
fixed-enum `revert_reason` so an operator asking "why was this undone?" gets a classifiable answer
instead of a blank cell, and so the ledger row and the run-audit row (which records the same reason
code) can never disagree.

FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
The reason is a FIXED ENUM, not free prose. An append-only ledger that accepts arbitrary text in this
column becomes an unbounded narrative surface that no later gate can filter or count, and run-audit
(which records ids/counts/fixed-outcomes only) could not mirror it. The enum keeps the "why" answer
classifiable and keeps the run-audit contract honest.

FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
`revert_reason` is required exactly when kind='reverted', mirroring the existing reverts_event_id
invariant. A reversal with no reason is unauditable ("it was undone, but nobody can say why"), and a
non-reversal row has no reason to give — so both directions are refused at the database boundary
rather than left to an accessor convention. ALTER TABLE ADD COLUMN is nullable by default so this
migration applies to a database that already has trail rows; the required-for-reverted invariant is
then enforced for every row written after it, and pre-existing non-reverted rows already carry NULL.

FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
This table already has ENABLE/FORCE ROW LEVEL SECURITY, the fusion_project_isolation policy, and the
fusion_assign_project_id trigger from 0087. Adding a column, two CHECKs, and an index does not change
any existing row's project scope, so this migration deliberately does NOT re-issue the RLS block —
re-creating the policy would be a no-op that risks a needless privilege window. The new index is
project-scoped on project_id first, matching the table's isolation model: a lookup is always bounded
by the caller's project, never by event id alone.

FNXC:SelfImproveLearningRevertRevertReason 2026-09-29-15:45:
idxLearningLedgerEventsReverts serves the read the revert operation performs on every call — "does a
reversal already name this application?" — as an index-backed lookup on (project_id,
reverts_event_id, occurred_at). That lookup is what makes a repeated revert collapse to
`already-reverted` in one transaction instead of a table scan, and it is the exact read shape the
idempotency check performs before appending.
*/
ALTER TABLE project.learning_ledger_events ADD COLUMN IF NOT EXISTS revert_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'learning_ledger_events_revert_reason_check'
  ) THEN
    ALTER TABLE project.learning_ledger_events
      ADD CONSTRAINT learning_ledger_events_revert_reason_check
      CHECK (revert_reason IS NULL OR revert_reason IN ('gate-rejected', 'operator-veto', 'superseded', 'expired', 'manual'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'learning_ledger_events_revert_reason_required_check'
  ) THEN
    ALTER TABLE project.learning_ledger_events
      ADD CONSTRAINT learning_ledger_events_revert_reason_required_check
      CHECK (
        (kind = 'reverted' AND revert_reason IS NOT NULL) OR (kind <> 'reverted' AND revert_reason IS NULL)
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "idxLearningLedgerEventsReverts" ON project.learning_ledger_events(project_id, reverts_event_id, occurred_at);
