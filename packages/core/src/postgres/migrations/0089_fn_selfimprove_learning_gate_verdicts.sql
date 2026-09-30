/*
FNXC:SelfImproveGateVerdict 2026-09-30-15:26:
FUSI-020 persists the deterministic gate's DECISION. The primary gate and the replay canary
(FUSI-016/017/018/019) compute a verdict in memory; without this table the loop cannot answer
"what did the gate decide about this experiment, against this baseline, from which inputs?" after
the process that ran it is gone. This is the record that makes a learning experiment auditable and
REPRODUCIBLE: the resolved verdict, BOTH inputs' verdicts, the input fingerprint, and the primary
signals the fingerprint was computed over.

FNXC:SelfImproveGateVerdict 2026-09-30-15:26:
A verdict is APPEND-ONLY. The PRIMARY KEY (project_id, verdict_id) is built on a DERIVED id
(experiment_id + baseline_id + input_fingerprint, via buildLearningGateVerdictId), never a fresh
uuid per attempt. That is the idempotency boundary: re-recording the SAME judgment collides and the
accessor's `onConflictDoNothing` absorbs it, while a re-evaluation under a changed corpus version or
seed produces a DIFFERENT fingerprint and therefore a NEW row. A uuid-per-attempt would append N
indistinguishable verdicts and the trail could no longer answer "was this exact judgment recorded,
and how many times" honestly — nor could it hold the first judgment at all once a second overwrote
it.

FNXC:SelfImproveGateVerdict 2026-09-30-15:26:
The PRECEDENCE rule is what this table exists to make auditable, so both inputs are stored beside
the resolved verdict. `primary_verdict` and `canary_verdict` are recorded alongside
`resolved_verdict` so a reader can see the conflict that produced the decision without re-running
the gate. A row that stored only the resolved verdict would make "the primary gate prevailed over
the canary" unfalsifiable — the very claim this feature exists to guarantee. `canary_verdict` is
NULL exactly when no canary ran, which `precedence_outcome='canary-absent'` names.

FNXC:SelfImproveGateVerdict 2026-09-30-15:26:
CHECK constraints mirror the TypeScript contract EXACTLY (three resolved verdicts, three primary
verdicts, the nullable canary verdict, four precedence outcomes) so a drifted row is rejected by
the DATABASE rather than read back as truth by the very gate that is supposed to be deterministic.
The pairing CHECK additionally enforces what per-enum CHECKs cannot: a canary verdict is present
exactly when the outcome says a canary was consulted, so `canary-absent` can never carry one and
`primary-prevailed` can never lack one.

FNXC:SelfImproveGateVerdict 2026-09-30-15:26:
The primary signals are stored denormalized next to the fingerprint. A sha256 is one-way: without
the signals, a reader could confirm two records came from the SAME inputs but not WHAT those inputs
were. Storing them makes the verdict self-describing — the booleans, the test-count delta, the
corpus version and the seed are all readable without a re-run, while the fingerprint still proves
input identity. A fingerprint CHECK (`^[0-9a-f]{64}$`) keeps a non-digest from being written.

FNXC:SelfImproveGateVerdict 2026-09-30-15:26:
Like the other learning tables, this one intentionally has no REFERENCES clause: a gate verdict is a
learning record about a product surface, not a child of a task or a proposal row, and must survive
task archive cleanup that hard-deletes task rows. The experiment/baseline ids are text identity, not
foreign keys, because the loop may judge an experiment whose proposal was rolled back, or a baseline
that predates the current ledger.

FNXC:SelfImproveGateVerdict 2026-09-30-15:26:
Two indexes, one per required reader, both project-scoped with project_id FIRST so a lookup is never
bounded by experiment/baseline id alone: (a) (project_id, experiment_id, occurred_at DESC) serves
"what did the gate say about this experiment?"; (b) (project_id, baseline_id, occurred_at DESC)
serves "what did the gate say about this baseline?". Both take occurred_at DESC because each
reader's terminal ordering is newest-first, so the newest verdict is served straight from the index
without a backward scan. This mirrors 0087's `idxLearningLedgerEventsProposalOccurred` DESC trailing
column (the Drizzle model declares these ascending; the raw migration is the database truth and
PostgreSQL ignores the unsupported DESC keyword inside CREATE INDEX, so the stored index order is
identical either way).

FNXC:SelfImproveGateVerdict 2026-09-30-15:26:
The full RLS block is issued because this migration CREATES the table (unlike 0088's column ALTER):
ENABLE/FORCE ROW LEVEL SECURITY, the fusion_project_isolation policy, and the fusion_assign_project_id
trigger all match the other learning tables so a verdict is project-scoped exactly like the proposal
and trail rows it judges.
*/
CREATE TABLE IF NOT EXISTS project.learning_gate_verdicts (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  verdict_id text NOT NULL,
  experiment_id text NOT NULL,
  baseline_id text NOT NULL,
  resolved_verdict text NOT NULL,
  primary_verdict text NOT NULL,
  canary_verdict text,
  precedence_outcome text NOT NULL,
  input_fingerprint text NOT NULL,
  build_ok boolean NOT NULL,
  lint_ok boolean NOT NULL,
  typecheck_ok boolean NOT NULL,
  gate_ok boolean NOT NULL,
  affected_tests_ok boolean NOT NULL,
  test_count_delta integer NOT NULL,
  cost_budget_invariant_ok boolean NOT NULL,
  corpus_version text NOT NULL,
  seed integer NOT NULL,
  occurred_at text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (project_id, verdict_id),
  CONSTRAINT learning_gate_verdicts_resolved_verdict_check CHECK (resolved_verdict IN ('keep', 'reverse', 'inconclusive')),
  CONSTRAINT learning_gate_verdicts_primary_verdict_check CHECK (primary_verdict IN ('keep', 'reverse', 'inconclusive')),
  CONSTRAINT learning_gate_verdicts_canary_verdict_check CHECK (canary_verdict IS NULL OR canary_verdict IN ('keep', 'reverse', 'inconclusive')),
  CONSTRAINT learning_gate_verdicts_precedence_outcome_check CHECK (precedence_outcome IN ('canary-absent', 'agreed', 'primary-prevailed', 'primary-abstained')),
  -- A canary verdict is present exactly when the outcome says a canary was consulted. Without this,
  -- `canary-absent` could arrive with a canary verdict attached and `primary-prevailed` could arrive
  -- without one, and the stored precedence claim would not be self-consistent.
  CONSTRAINT learning_gate_verdicts_canary_pairing_check CHECK (
    (canary_verdict IS NOT NULL AND precedence_outcome <> 'canary-absent')
    OR (canary_verdict IS NULL AND precedence_outcome = 'canary-absent')
  ),
  CONSTRAINT learning_gate_verdicts_fingerprint_check CHECK (input_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS "idxLearningGateVerdictsExperimentOccurred" ON project.learning_gate_verdicts(project_id, experiment_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS "idxLearningGateVerdictsBaselineOccurred" ON project.learning_gate_verdicts(project_id, baseline_id, occurred_at DESC);

ALTER TABLE project.learning_gate_verdicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.learning_gate_verdicts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.learning_gate_verdicts;
CREATE POLICY fusion_project_isolation ON project.learning_gate_verdicts
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.learning_gate_verdicts;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.learning_gate_verdicts
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
