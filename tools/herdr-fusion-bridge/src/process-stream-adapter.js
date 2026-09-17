// process-stream-adapter.js — the v2 process-observation seam.
//
// The bridge never reads a live Fusion engine's process table directly: it
// PULLS process observations through an adapter, exactly the way the v1 tick
// pulls task observations from the Fusion client. Two methods make up the
// contract:
//
//   collect(now)            -> Promise<Array<v2 process event>> | Array<...>
//       Return the process observations available at `now`. The detector calls
//       this at most once per pull window (heartbeatIntervalMs), so an adapter
//       must be cheap and must never block the tick loop for long. Returning
//       [] is always valid and is what the no-op default does. Events are
//       validated by the detector: an unvalidatable observation is rejected
//       with a warn and never emitted.
//
//   getTaskForProcess(pid)  -> Promise<string|null> | string|null
//       The process-to-task resolver, used for association only when an event
//       carries no correlationToken. `pid` is the normalized process id (null
//       and '' both arrive as '', the single "unknown process" bucket).
//       Returning null/'' means "cannot associate": the event is dropped with
//       a warn and never emitted as a notification.
//
// NullProcessStreamAdapter is the no-op default, so every bridge construction
// that predates v2 keeps working unchanged with no process stream wired.

export class ProcessStreamAdapter {
  // eslint-disable-next-line no-unused-vars
  async collect(now) {
    throw new Error('ProcessStreamAdapter.collect not implemented');
  }

  // eslint-disable-next-line no-unused-vars
  async getTaskForProcess(processId) {
    throw new Error('ProcessStreamAdapter.getTaskForProcess not implemented');
  }
}

// The default adapter: no process stream is wired. collect() always returns an
// empty observation list, so the detector emits nothing and the v1 behavior is
// preserved byte-for-byte.
export class NullProcessStreamAdapter extends ProcessStreamAdapter {
  async collect() {
    return [];
  }

  async getTaskForProcess() {
    return null;
  }
}
