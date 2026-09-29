/*
FNXC:SelfImproveLearningLedger 2026-09-29-15:15:
The append-only event trail of the self-improvement ledger (FUSI-010). FUSI-009's
`project.learning_proposals` holds the CURRENT assertion; it cannot also be the history, because
overwriting it on every application would erase the very evidence the loop's revert decision
depends on. So an application and its reversal are separate immutable rows here, and a proposal's
state is always DERIVED from its latest event. That is what makes "revert to the value held
before the experiment" (FUSI-011) answerable from the trail rather than from a mutable field.

FNXC:SelfImproveLearningLedger 2026-09-29-15:15:
The `proposed` kind is not redundant with the proposal row: the row is created in the SAME
transaction as its opening event, so the event trail alone is a complete, self-sufficient record of
the proposal's whole life. Replaying the trail (the replay corpus a later gate will diff against)
therefore never has to join back to the mutable row.

FNXC:SelfImproveLearningLedger 2026-09-29-15:15:
`reverts_event_id` is required by CHECK exactly when `kind='reverted'`, which makes "a reversal
names the application it cancels" a database invariant rather than a convention the accessor might
forget. A `reverted` row with no target application is unreplayable, so it is refused at the
boundary. The converse stays permitted (a re-application has nothing to cancel).

FNXC:SelfImproveLearningLedger 2026-09-29-15:15:
Like patchnode_entries and learning_proposals, this table intentionally has no REFERENCES clause —
the ledger is a learning record about a product surface, not a child of a task, and must survive
task archive cleanup that hard-deletes task rows.

FNXC:SelfImproveLearningLedger 2026-09-29-15:15:
Three indexes, each matching one real read shape rather than being generic. (a) target+occurred_at
serves the per-target window feed; (b) project_id+proposal_id+occurred_at serves
latest-event-per-proposal, which is the `state` derivation the listing performs once per page
instead of a per-row correlated subquery; (c) target+kind+occurred_at serves filtering one
transition kind within a window. All three are ascending, matching this schema's index convention;
PostgreSQL reads (b) backwards for the newest-first ordering, which is why the column is present at
all rather than the direction.
*/
CREATE TABLE IF NOT EXISTS project.learning_ledger_events (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  event_id text NOT NULL,
  proposal_id text NOT NULL,
  target text NOT NULL,
  kind text NOT NULL,
  reverts_event_id text,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  occurred_at text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (project_id, event_id),
  CONSTRAINT learning_ledger_events_kind_check CHECK (kind IN ('proposed', 'applied', 'reverted')),
  CONSTRAINT learning_ledger_events_target_check CHECK (target IN ('memory', 'evals', 'skills')),
  CONSTRAINT learning_ledger_events_reverts_check CHECK (
    (kind = 'reverted' AND reverts_event_id IS NOT NULL) OR (kind <> 'reverted')
  )
);
CREATE INDEX IF NOT EXISTS "idxLearningLedgerEventsTargetOccurred" ON project.learning_ledger_events(project_id, target, occurred_at);
CREATE INDEX IF NOT EXISTS "idxLearningLedgerEventsProposalOccurred" ON project.learning_ledger_events(project_id, proposal_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS "idxLearningLedgerEventsTargetKindOccurred" ON project.learning_ledger_events(project_id, target, kind, occurred_at);
ALTER TABLE project.learning_ledger_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.learning_ledger_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.learning_ledger_events;
CREATE POLICY fusion_project_isolation ON project.learning_ledger_events
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.learning_ledger_events;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.learning_ledger_events
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
