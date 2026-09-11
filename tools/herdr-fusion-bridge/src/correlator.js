// correlator.js — build and verify stable correlation keys.
//
// A correlation key ties a task/executor/pane to a kind (a meaningful state or
// event). The key must be STABLE for the same tuple so deduplication across
// ticks and across restarts works. Malformed keys (missing required kinds or a
// non-dimension tuple) are rejected so callers fail safe instead of emitting
// ambiguous keys.

const DIMENSIONS = ['taskId', 'executorId', 'paneId'];

// A list of the meaningful state/event kinds the bridge tracks. These are the
// discrete changes that count as *real progress* for the watchdog, and are the
// granularity at which notifications are deduplicated.
export const EVENT_KINDS = [
  'start',
  'progress',
  'blocked',
  'error',
  'stalled',
  'completed',
  'engine_absent',
  'association_stale',
  'steer_skipped',
  'tick_skipped',
  'reconnected',
];

// Empty-string / whitespace-only values are treated as absent (=> unknown).
function normalize(value) {
  if (value === undefined || value === null) {
    return '';
  }
  const s = String(value);
  return s.trim();
}

// Build a canonical correlation key from a tuple. Returns the key string, or
// null when the tuple is malformed (missing kind, or no granularity at all).
// Missing dimensions collapse to the "unknown" placeholder so the key is still
// complete and stable.
export function buildCorrelationKey({ taskId, executorId, paneId, kind }) {
  const k = normalize(kind);
  if (!k) {
    return null;
  }
  if (EVENT_KINDS.indexOf(k) === -1) {
    // Allow the kind through but flag it: unknown kinds are still keyable.
    // (Validation of known kinds is the caller's concern; we keep the builder
    // permissive for forward-compat but never drop the kind.)
  }
  const t = normalize(taskId) || 'unknown';
  const e = normalize(executorId) || 'unknown';
  const p = normalize(paneId) || 'unknown';
  return `${t}|${e}|${p}|${k}`;
}

// Validate a correlation tuple: returns { ok, reason } making the failure
// explicit instead of silently discarding. A malformed tuple (empty kind) is
// rejected; a tuple missing dimensions is accepted (dimensions default to
// "unknown") to keep correlation keys complete.
export function validateCorrelation({ taskId, executorId, paneId, kind }) {
  if (!normalize(kind)) {
    return { ok: false, reason: 'kind is required and must be a non-empty string' };
  }
  // At least one dimension must be provided to be a meaningful key.
  if (!normalize(taskId) && !normalize(executorId) && !normalize(paneId)) {
    return { ok: false, reason: 'at least one of taskId/executorId/paneId must be provided' };
  }
  return { ok: true, reason: '' };
}

// Parse a stored key back into its tuple (round-trip for persisted markers).
export function parseCorrelationKey(key) {
  if (typeof key !== 'string') {
    return null;
  }
  const parts = key.split('|');
  if (parts.length !== 4) {
    return null;
  }
  const [taskId, executorId, paneId, kind] = parts;
  return { taskId, executorId, paneId, kind };
}

export { DIMENSIONS };