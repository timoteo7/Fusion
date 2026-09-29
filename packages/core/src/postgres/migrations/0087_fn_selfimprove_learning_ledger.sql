/*
FNXC:SelfImproveLearningLedger 2026-09-29-02:38:
The self-improvement proposal+evidence record (FUSI-009). Durable and project-scoped: a proposal's
decision must stay auditable after the narrative surface it cites (Memory/Evals/Skills) is rewritten,
re-scored, or archived, so the structured record is its own table rather than a derived view.

FNXC:SelfImproveLearningLedger 2026-09-29-02:38:
CHECK constraints restate the TS contract at the database boundary (four states, three targets,
confidence and value in 0..1) so a hand-written or drifted write is rejected rather than read back
as truth by the later gate. prior_value is nullable because no value is held before the first
application; evidence_refs is jsonb because a ref is a structured locator, not prose.

FNXC:SelfImproveLearningLedger 2026-09-29-02:38:
Like patchnode_entries, this table intentionally has no REFERENCES clause — it describes a product
surface, not a task, and must survive task archive cleanup.
*/
CREATE TABLE IF NOT EXISTS project.learning_proposals (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  proposal_id text NOT NULL,
  target text NOT NULL,
  origin text NOT NULL,
  confidence real NOT NULL,
  value real NOT NULL,
  prior_value real,
  expires_at text,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  state text NOT NULL,
  version integer NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (project_id, proposal_id),
  CONSTRAINT learning_proposals_state_check CHECK (state IN ('proposed', 'applied', 'reverted', 'expired')),
  CONSTRAINT learning_proposals_target_check CHECK (target IN ('memory', 'evals', 'skills')),
  CONSTRAINT learning_proposals_confidence_check CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT learning_proposals_value_check CHECK (value >= 0 AND value <= 1)
);
CREATE INDEX IF NOT EXISTS "idxLearningProposalsTargetState" ON project.learning_proposals(project_id, target, state);
CREATE INDEX IF NOT EXISTS "idxLearningProposalsCreated" ON project.learning_proposals(project_id, created_at);
ALTER TABLE project.learning_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.learning_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.learning_proposals;
CREATE POLICY fusion_project_isolation ON project.learning_proposals
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.learning_proposals;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.learning_proposals
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
