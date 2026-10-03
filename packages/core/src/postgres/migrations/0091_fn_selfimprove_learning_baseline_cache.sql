/*
FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
FUSI-031 persists the MEASURED BASELINE the replay corpus runs against. Without it the loop re-measures
the corpus for every candidate, which is slow and, worse, leaves no proof that a candidate was
compared against a baseline produced under the same corpus/engine/config/seed. This table is that
proof: it stores the baseline payload OPAQUELY beside the `input_fingerprint` derived from those four
components, so a later comparison can ask "was this baseline measured under the inputs I am about to
use?" and get a decidable answer instead of silently mixing incomparable measurements.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
The PRIMARY KEY is (project_id, baseline_key) — ONE cached baseline per baseline key per project, not
a uuid-per-attempt trail. This table is a CACHE, not an append-only ledger: its whole value is that a
second measurement under the same key REPLACES the first, and the newest entry is the only valid one.
An append-only shape would leave N entries per key with no defined "current" row, and every reader
would have to guess which one to reuse. The write path uses ON CONFLICT DO UPDATE, making an
identical re-store a no-op and a changed fingerprint an in-place replacement — see
`async-learning-baseline-cache.ts`.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
The four measurement components (manifest_version, engine_sha, config_hash, seed) are stored
DENORMALIZED next to the fingerprint, exactly as 0089 stores the primary signals beside its
fingerprint. A sha256 is one-way: without the components a reader could confirm two runs came from the
SAME inputs but not WHICH inputs they were, and "which component moved?" is precisely the question an
operator asks when a rebuild is forced. The columns make the entry self-describing while the
fingerprint still proves input identity.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
`input_fingerprint` carries a CHECK that accepts ONLY the `sha256:<64 hex>` shape produced by
`computeBaselineFingerprint`. A bare-hex digest, an arbitrary string, or a hash from another scheme
would be indistinguishable from a real one at read time and would either poison a reuse decision or be
silently rebuilt over — either way hiding a drifted row behind a plausible value. The CHECK rejects
it at the DATABASE, so a drifted writer fails loudly instead of being read back as truth.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
`payload jsonb` is deliberately OPAQUE. The cached baseline's shape is owned by the measurement layer
(FUSI-030's corpus manifest and whatever metrics derive from it), not by this table: this feature
caches and invalidates, it does not interpret. Pinning columns here would couple the cache to one
corpus schema and force a migration every time a metric is added. Storing jsonb keeps the cache
decoupled, while the fingerprint — not the payload — is what governs reuse, so the payload's internal
shape can never affect whether a reuse is valid.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
`created_at` is set ONCE (it is not in the DO UPDATE SET list in the accessor) and `updated_at` moves
on every replacement, so "when was this baseline first measured" and "when was it last re-measured"
are both answerable. Collapsing them into one column would make a forced rebuild indistinguishable
from the original measurement.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
Like the other learning tables, this one intentionally has NO REFERENCES clause: a cached baseline is a
measurement about a product surface, not a child of a task or a proposal row, and must survive task
archive cleanup that hard-deletes task rows.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
The full RLS block is issued because this migration CREATES the table (like 0086/0087/0089):
ENABLE/FORCE ROW LEVEL SECURITY, the fusion_project_isolation policy, and the fusion_assign_project_id
trigger, so a cached baseline is project-scoped exactly like the proposal, trail, and verdict rows it
sits beside.
*/
CREATE TABLE IF NOT EXISTS project.learning_baseline_cache (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  baseline_key text NOT NULL,
  manifest_version text NOT NULL,
  engine_sha text NOT NULL,
  config_hash text NOT NULL,
  seed integer NOT NULL,
  input_fingerprint text NOT NULL,
  payload jsonb NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, baseline_key),
  -- Only the canonical `sha256:<64 hex>` fingerprint shape is a valid measurement identity.
  CONSTRAINT learning_baseline_cache_fingerprint_check CHECK (input_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  -- A blank baseline key could never be addressed by a reader, so its row would be unreachable garbage.
  CONSTRAINT learning_baseline_cache_key_check CHECK (length(btrim(baseline_key)) > 0)
);

ALTER TABLE project.learning_baseline_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.learning_baseline_cache FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.learning_baseline_cache;
CREATE POLICY fusion_project_isolation ON project.learning_baseline_cache
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.learning_baseline_cache;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.learning_baseline_cache
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
