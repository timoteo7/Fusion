// process-events.js — the v2 process-event schema and its validator.
//
// A process event describes ONE Fusion process (an agent invocation, a
// workflow session, an executor run) at a point in time, independent of the
// task-board state the v1 stream reports. Every v2 event carries
// schemaVersion 2 so a v1 consumer can never mistake it for a v1 task event,
// and a mismatched version is rejected outright rather than coerced.
//
// Canonical kinds — exactly six, a seventh must never be emitted:
//   process.started    the process is running
//   process.heartbeat  the process is alive and reports its progress cursor
//   process.stalled    the process made no REAL progress within the window
//   process.completed  the process finished successfully (terminal)
//   process.failed     the process failed (terminal)
//   process.exited     the process exited / was reaped (terminal)
//
// The optional payload is restricted to the two progress fields
// { lastProgressMs, timeoutMs }. Any third field (the prohibited "three-field
// variant") is rejected: progress timing is the only structured data a process
// event may carry, everything else is carried by the kind.

export const PROCESS_SCHEMA_VERSION = 2;

export const PROCESS_KINDS = [
  'process.started',
  'process.heartbeat',
  'process.stalled',
  'process.completed',
  'process.failed',
  'process.exited',
];

// Terminal kinds end a process episode. The detector clears its tracked state
// for them so a later process.started re-arms as a fresh episode.
export const TERMINAL_PROCESS_KINDS = ['process.completed', 'process.failed', 'process.exited'];

// The ONLY payload fields a v2 process event may carry.
export const PROGRESS_PAYLOAD_FIELDS = ['lastProgressMs', 'timeoutMs'];

export function isProcessKind(kind) {
  return PROCESS_KINDS.indexOf(kind) !== -1;
}

export function isTerminalProcessKind(kind) {
  return TERMINAL_PROCESS_KINDS.indexOf(kind) !== -1;
}

// Normalize a processId for signatures and tracking. null and '' are the SAME
// "unknown process" bucket: they must produce an identical signature and dedup
// against each other instead of forming two half-populated groups.
export function normalizeProcessId(processId) {
  if (processId === null || processId === undefined) {
    return '';
  }
  return String(processId);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Validate a v2 process event. Returns { ok, reason } — the same shape as
// correlator.js's validateCorrelation, so callers fail safe with an explicit
// reason instead of an exception inside the tick loop.
export function validateProcessEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, reason: 'event must be an object' };
  }
  if (event.schemaVersion !== PROCESS_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `schemaVersion must be ${PROCESS_SCHEMA_VERSION} (got ${JSON.stringify(event.schemaVersion)})`,
    };
  }
  if (!isProcessKind(event.kind)) {
    return { ok: false, reason: `kind must be one of: ${PROCESS_KINDS.join(' | ')}` };
  }
  if (!Object.prototype.hasOwnProperty.call(event, 'processId')) {
    return { ok: false, reason: 'processId is required' };
  }
  // '' and null are both valid: they are the single "unknown process" bucket.
  if (event.processId !== null && typeof event.processId !== 'string') {
    return { ok: false, reason: 'processId must be a string or null' };
  }
  if (!isFiniteNumber(event.timestamp)) {
    return { ok: false, reason: 'timestamp must be a finite epoch-millis number' };
  }
  if (
    event.correlationToken !== undefined &&
    event.correlationToken !== null &&
    (typeof event.correlationToken !== 'string' || event.correlationToken.trim() === '')
  ) {
    return { ok: false, reason: 'correlationToken must be a non-empty string when present' };
  }
  if (event.payload !== undefined && event.payload !== null) {
    const payload = event.payload;
    if (typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, reason: 'payload must be an object' };
    }
    const keys = Object.keys(payload);
    const unexpected = keys.filter((k) => PROGRESS_PAYLOAD_FIELDS.indexOf(k) === -1);
    if (unexpected.length > 0) {
      return {
        ok: false,
        reason: `payload may only carry ${PROGRESS_PAYLOAD_FIELDS.join(', ')} (unexpected: ${unexpected.join(', ')})`,
      };
    }
    for (const key of keys) {
      if (!isFiniteNumber(payload[key])) {
        return { ok: false, reason: `payload.${key} must be a finite number` };
      }
    }
  }
  return { ok: true, reason: '' };
}
