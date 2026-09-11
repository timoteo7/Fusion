// logger.js — structured JSON logger with an in-memory sink for tests.
//
// Every record carries correlation fields { taskId, executorId, paneId, event }.
// Missing correlation fields are replaced with the literal "unknown" so the
// correlation key is always complete and never silently dropped.

export const UNKNOWN = 'unknown';

function fillUnknown(fields) {
  const out = Object.assign({}, fields);
  if (!out.taskId) {
    out.taskId = UNKNOWN;
  }
  if (!out.executorId) {
    out.executorId = UNKNOWN;
  }
  if (!out.paneId) {
    out.paneId = UNKNOWN;
  }
  if (!out.event) {
    out.event = UNKNOWN;
  }
  return out;
}

// In-memory sink: an array the test can assert on. `onWrite` is called for each
// record (the bridge uses it to observe/tick). It is a plain Array so tests can
// inspect `.length` and the last entry.
export function memorySink() {
  const records = [];
  const sink = {
    records,
    write(record) {
      records.push(Object.assign({}, record));
    },
    clear() {
      records.length = 0;
    },
  };
  return sink;
}

// Structured logger. `sink` is a { write(record) } object; default is a stdout
// JSON writer. `clock` is used for the `ts` timestamp when provided.
export function createLogger({ sink = null, clock = null, stream = process.stdout } = {}) {
  const activeSink =
    sink ||
    {
      write(record) {
        stream.write(`${JSON.stringify(record)}\n`);
      },
    };

  function emit(event, fields = {}, extra = {}) {
    const filled = fillUnknown(fields);
    const record = {
      ts: clock ? clock.now() : Date.now(),
      event,
      taskId: filled.taskId,
      executorId: filled.executorId,
      paneId: filled.paneId,
      ...extra,
    };
    activeSink.write(record);
    return record;
  }

  return {
    emit,
    info: (event, fields, extra) => emit(event, fields, extra),
    warn: (event, fields, extra) => emit(event, fields, extra),
    error: (event, fields, extra) => emit(event, fields, extra),
    // Convenience for logging correlation fields without an event label.
    record: (fields) => emit(fields.event || UNKNOWN, fields),
  };
}

export { fillUnknown };