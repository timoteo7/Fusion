# herdr-fusion-bridge

An event- and liveness-driven coordination bridge between **Herdr panes**, the
**Fusion engine** (process + task board), and **Hermes notification delivery**.

The bridge is a small Node.js (ESM, zero-dependency) supervision daemon plus a
CLI. It watches task events, correlates tasks → executors → panes, persists an
idempotent reconciliation registry, detects real stalls, delivers deduplicated
notifications, and offers safe steering — while **failing safe** whenever any
integration is unavailable, and **never busy-looping** on a down endpoint.

> **OPERATOR-HOST ONLY.** The `run` subcommand is a long-lived supervision
> daemon. It is started and stopped **by an operator on the host**, by hand or
> via their process manager of choice. It must never be launched by automated
> tests, build steps, or agent sessions — every bridge test terminates without
> ever starting the daemon.

---

## Layout

```
tools/herdr-fusion-bridge/
├── bin/hfb.js                  # CLI entrypoint (run/status/reconcile/steer/heartbeat)
├── src/
│   ├── config.js               # env-driven config (HBRIDGE_*), loadConfig()
│   ├── clock.js                # realClock()/fakeClock() (injected time)
│   ├── logger.js               # structured JSON logger, createLogger()
│   ├── correlator.js           # correlation keys + event kinds
│   ├── watchdog.js             # liveness watchdog (discrete change = progress)
│   ├── process-events.js       # v2 process-event schema + validateProcessEvent
│   ├── process-stream-adapter.js # v2 process-observation seam (+ Null default)
│   ├── process-detector.js     # v2 ProcessDetector (dedup + association + stalls)
│   ├── state.js                # PersistentState + FsStore (atomic tmp+rename)
│   ├── steering.js             # SteeringController (engine-gated, deduped)
│   ├── bridge.js               # Supervisor (tick loop, engine detection)
│   ├── orchestrator.js         # Bridge wiring (start/stop lifecycle)
│   ├── adapters/
│   │   ├── fusion-client.js    # SseFusionClient, ProcessFusionDetector
│   │   ├── herdr-client.js     # CliHerdrClient (herdr CLI), runCaptured()
│   │   ├── notifier.js         # HttpNotifier, CliNotifier, DedupNotifier, ProcessEventStream
│   │   └── fakes.js            # fakes: FakeFusionClient/Herdr/Notifier
│   └── watchers/
│       ├── sse-watcher.js      # SSE consumer with exponential backoff
│       └── orphan-recovery.js # idempotent orphan reconciliation
└── test/                       # node:test matrix (all terminating)
    ├── adapters/fake-process-stream.js # deterministic v2 stream adapter
    └── fixtures/process-events.json    # v2 schema (schemaVersion 2) + stream
```

## Quick start (operator)

```bash
# 1. Inspect the registry and integration health (read-only, terminates):
HBRIDGE_STATE_FILE=/var/lib/hfb/state.json \
HBRIDGE_FUSION_SSE_URL=http://127.0.0.1:4040/api/events \
HBRIDGE_FUSION_PROBE_CMD="pgrep -x fusion" \
node tools/herdr-fusion-bridge/bin/hfb.js status

# 2. Run one idempotent reconcile pass (engine-gated, persists state):
node tools/herdr-fusion-bridge/bin/hfb.js reconcile

# 3. Steer a task safely (engine-gated, deduped):
node tools/herdr-fusion-bridge/bin/hfb.js steer --task=FN-123 --command=heartbeat

# 4. Start the daemon (operator host only):
node tools/herdr-fusion-bridge/bin/hfb.js run
# stop with Ctrl-C (SIGINT) or kill -TERM — shutdown is clean and persisted.
```

---

## Configuration (HBRIDGE_* environment)

All knobs are env-driven with safe defaults; the CLI prints its effective
settings in `status`. Every interval accepts milliseconds.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HBRIDGE_WATCHDOG_TIMEOUT_MS` | `60000` | No *real progress* within this window ⇒ `stalled`. |
| `HBRIDGE_TICK_INTERVAL_MS` | `1000` | Idle supervision tick cadence (low-frequency). |
| `HBRIDGE_BACKOFF_BASE_MS` | `500` | Exponential backoff start (SSE reconnect, delivery retries). |
| `HBRIDGE_BACKOFF_MAX_MS` | `30000` | Backoff cap. |
| `HBRIDGE_DEDUP_WINDOW_MS` | `5000` | Same (correlation, kind) within the window ⇒ exactly one emission. |
| `HBRIDGE_ENGINE_RECHECK_MS` | `5000` | Recheck engine presence at most this often while absent. |
| `HBRIDGE_INTEGRATION_HOOK_URL` | *(empty)* | Hermes hook URL for notification delivery. Empty ⇒ notifications are skipped (logged only). |
| `HBRIDGE_HERDR_BIN` | `herdr` | herdr CLI binary. |
| `HBRIDGE_FUSION_SSE_URL` | *(empty)* | Fusion SSE event stream URL. Empty ⇒ safe idle. |
| `HBRIDGE_FUSION_PROBE_CMD` | *(empty)* | Shell-free argv probe for engine presence (e.g. `pgrep -x fusion`). Empty ⇒ SSE-URL presence is used. |
| `HBRIDGE_STATE_FILE` | `herdr-fusion-bridge-state.json` | Persisted registry + markers (atomic tmp+rename writes). |
| `HBRIDGE_DISABLE_FUSION` | `false` | Safe-fail switch: suspend all Fusion work. |
| `HBRIDGE_DISABLE_HERDR` | `false` | Safe-fail switch: suspend all Herdr work. |
| `HBRIDGE_DISABLE_NOTIFIER` | `false` | Safe-fail switch: skip notification delivery. |

Truthiness for the disable switches: `1`, `true`, `TRUE`, `yes`.

---

## Event schema

Every event carries a correlation tuple and a monotonic `seq`; the canonical
schema (with per-kind payloads and examples) is
[`test/fixtures/events.json`](test/fixtures/events.json).

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | string | start / progress / blocked / error / stalled / completed / engine_absent / association_stale |
| `seq` | number | Monotonic per emitter. |
| `taskId` | string | Correlation dimension; `"unknown"` when unresolvable (never dropped). |
| `executorId` | string | Correlation dimension; `"unknown"` when unresolvable. |
| `paneId` | string | Correlation dimension; `"unknown"` is forced when unresolvable. |
| `ts` | number | Epoch millis when observed. |
| `payload` | object | Optional; shape depends on `kind`. |

### The defining rule: REAL progress

> **"Real progress" is a discrete state/event change — a task's state or seq
> signature moving. A log line is NEVER progress.**

The watchdog records the timestamp of the last *discrete change*; log volume is
tracked as context only and never resets the stall window. A task that
generates an unbounded stream of log lines while making no state change is
exactly the "real stall" this bridge reports after `HBRIDGE_WATCHDOG_TIMEOUT_MS`.

### Wired stall detection (Watchdog → Supervisor)

The watchdog is constructed **before** the supervisor and passed in as an
optional dependency (`new Supervisor({ ..., watchdog })`). Each tick runs a
bounded stall scan AFTER the reconcile step:

1. **Poll path signatures.** The supervisor's `reconcileOne` calls
   `watchdog.observeSignature(taskId, taskSignature({state, seq}))` after the
   correlation state is updated, so a discrete change observed on the poll
   path (e.g. Fusion listTasks) re-arms the stall window. The shared
   `taskSignature({state, seq})` helper in `src/watchdog.js` is the single
   source of truth for the (state, seq) pair the watchdog diffs; the SSE
   onEvent path in `src/orchestrator.js` calls the same helper, so SSE and
   poll paths converge on identical signatures.
2. **Bounded scan.** After the reconcile loop, the supervisor iterates the
   poll observations and for each task with `watchdog.hasProgress(taskId)`
   and a non-terminal state, asks `watchdog.isStalled(taskId, now)`. A stall
   emits one `stalled` notification per scan with the fixture's two-field
   payload `{ lastProgressMs, timeoutMs }` (see `test/fixtures/events.json`).
3. **Dedup.** The `DedupNotifier` gate owns the dedup window
   (`dedupWindowMs`, default 5000ms); a per-tick re-emit while a stall
   persists collapses to a single operator-visible notification per
   `dedupWindowMs` episode. A persisting stall re-emits after the window
   expires; a discrete state/seq change (which re-credits `lastProgressAt`)
   re-arms the window so a fresh stall re-emits cleanly.
4. **Terminal exclusion.** Tasks in `completed` / `done` / `error` / `failed`
   are skipped by the scan. A terminal task sits frozen forever and would be
   a false positive. `blocked` is **not** terminal — a stuck blocked task
   is a real stall and the spec classifies it as a separate event kind.
5. **Early-return safety.** The engine-absent and transport-cooldown
   early-returns in `_tickOnce` precede the stall scan, so a down engine or
   cooled-down transport never produces a stall scan iteration and never
   emits a spurious `stalled`.

The supervisor is backwards compatible: `watchdog` is optional and the
existing Supervisor call sites that do not pass it (or do not need stall
reporting) continue to work unchanged.

### Steering contract

`steer --task=<id> --command=<cmd>` (`--force` bypasses the dedup window, but
NEVER the engine gate):

- **engine-gated** — never dispatches when the Fusion engine is absent (logs
  `steer_skipped` + `engine_absent`);
- **deduped** — an identical (task, command) within `dedupWindowMs` is skipped;
- **bounded retries** — delivery retries grow exponentially and are capped;
  a persistent failure fails safe (never a tight loop);
- **heartbeat** — a lightweight command variant with the same guarantees.

---

## v2 process detection (`processEvents`)

The event schema above reports **task-board state**. v2 adds a second, parallel
stream that reports **process state** — the agent invocation, workflow session,
or executor run working a task — so an operator can tell whether the process
behind a card is running, progressing, stalled, failed, or exited, instead of
only which column the card sits in.

**Schema isolation.** v1 task events keep the schema above and the
`schemaVersion: 1` fixture; every v2 process event is `schemaVersion: 2` and
carries a `process.*` kind. The validator rejects a mismatched version rather
than coercing it, so a v1 consumer can never mistake a process event for a task
event. The canonical v2 schema (per-kind meanings, the two-field payload) is
[`test/fixtures/process-events.json`](test/fixtures/process-events.json).

### The six process kinds (exactly six — no seventh may be emitted)

| `kind` | Terminal | Meaning |
| --- | --- | --- |
| `process.started` | no | The process is running. |
| `process.heartbeat` | no | The process is alive and reports its progress cursor. A heartbeat alone is **not** real progress. |
| `process.stalled` | no | No **real** progress within the process's stall window. |
| `process.completed` | yes | The process finished successfully. |
| `process.failed` | yes | The process failed. |
| `process.exited` | yes | The process exited / was reaped. |

### What a v2 event carries

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | number | Always `2`. |
| `kind` | string | One of the six kinds above. |
| `processId` | string | The process identity; `""` when unknown. `null` and `""` are the **same** bucket and dedup against each other. |
| `timestamp` | number | Epoch millis when the process emitted the observation. |
| `taskId` | string | The Fusion task the process serves — always non-empty, because an unassociated event is never emitted. |
| `associationSource` | string | `correlationToken`, `adapter`, or `stall-scan`. |
| `correlationToken` | string | Optional; echoed from the observation when present. |
| `payload` | object | Optional; **exactly** `{ lastProgressMs, timeoutMs }`. A three-field variant is prohibited. |

### Reading the stream

- **`bridge.processEvents`** — an `EventEmitter` (via `createBridge`). Listen on
  the whole stream (`stream.on('processEvent', (e) => …)`) or per kind
  (`stream.on('process.stalled', (e) => …)`); `stream.published`,
  `stream.kinds()` and `stream.count(kind)` expose what was delivered.
- **`result.processEvents`** — the same events for one tick, alongside the
  untouched v1 `result.events`. Process kinds never appear in `result.events`.
- **Notifications** — each process event also goes through the configured
  notifier sink with `kind` set to the process kind (e.g. `process.started`),
  so an operator's existing hook receives both streams.

Dedup is done by the detector, not the sink: a consumer sees exactly one event
per process-kind rise, the same guarantee the v1 notification stream gets from
`DedupNotifier`.

### The adapter seam

`ProcessStreamAdapter` (`src/process-stream-adapter.js`) is the process
observation source — the bridge never reads a live process table directly:

- `collect(now)` → an array of process observations for this pull;
- `getTaskForProcess(processId)` → the `taskId` that process serves, or `null`.

`NullProcessStreamAdapter` is the default: `collect()` always returns `[]`, so a
bridge built without a process stream behaves exactly as it did before v2.

### Wiring

```js
const bridge = createBridge({
  config, fusion, herdr, notifier, logger, clock, state,
  processStreamAdapter,   // optional; defaults to NullProcessStreamAdapter
});
```

`processStreamAdapter` is **optional** — `fusion` and `herdr` stay required
exactly as in v1. Lower-level wiring, for tests: `new Supervisor({ …,
processDetector, processEvents })`, both optional.

> **Not yet live.** The real Fusion/Herdr process stream is a later task; the
> CLI currently constructs the null default, so today's daemon emits **no**
> process events. This release ships the detection contract — proven by the
> deterministic fake adapter plus the fixture — not a live attachment.

### Association precedence

An event is emitted only once it is bound to the task it serves:

1. `correlationToken` on the observation — wins outright, the adapter resolver
   is never consulted;
2. `adapter.getTaskForProcess(processId)`;
3. otherwise **DROP** with a `console.warn`. A dropped event is never emitted,
   never published on the stream, and never delivered as a notification.

### Rising-edge dedup

Repeated observations of the same `kind` for the same process are **not**
re-emitted (a chatty process stream cannot become a chatty notification
stream); they are still tracked, because a heartbeat carries the progress
cursor. Terminal kinds (`process.completed`, `process.failed`,
`process.exited`) clear the episode, so a later `process.started` re-arms as a
fresh rise. `null` and `""` process ids share one bucket.

### Stall detection

- `heartbeatIntervalMs` (**default 30000**) bounds the pull: at most one
  `collect()` per window, never a tight probe loop.
- `stallTimeoutMs` (**default 120000**) is the stall window used when an event
  carries no `timeoutMs` of its own; an event's own window wins.
- A stall is one `process.stalled` per episode: an advancing progress cursor
  clears the marker (and an event that already reports the stall marks it, so
  it is never synthesized twice). A heartbeat with a frozen cursor changes
  nothing — exactly the v1 rule that **log churn is never progress**.

The detector holds no timers: it is driven by the Supervisor's tick with an
injectable `now`, so every time-based behavior is testable on a fake clock.

---

## Safe-fail matrix

The bridge NEVER spins on a down integration. Behavior when an integration is
unavailable:

| Situation | Behavior |
| --- | --- |
| Fusion engine absent (probe/SSE absent) | All engine-dependent work is suspended: ticks log `engine_absent` at most once per recheck window, reconcile and steering skip with `engine_absent`, no dispatch, no orphaning. |
| Fusion SSE stream down / erroring | Watcher counts failures, reconnects with exponential backoff + jitter (base→cap), resets on first successful event. Never a busy loop. |
| herdr CLI unavailable | `listPanes` returns empty and the failure is logged; correlation reports `association_stale` instead of throwing. |
| Hermes hook down | Notification delivery retries with bounded exponential backoff, then fails safe (logged, not thrown); the supervision loop keeps running. |
| Correlation unresolvable | The unresolvable dimension becomes `"unknown"` (never dropped); the event is still correlated on the remaining dimensions. |
| Process observation unresolvable (v2) | The process event is dropped with a `console.warn`; it is never emitted, published, or notified. The rest of the tick continues. |
| Process stream `collect()` throws (v2) | The detector warns and returns no events for that tick; the tick loop logs `process_stream_error` and keeps running. |
| State file unwritable | Reconcile still runs, save is skipped with a logged error, shutdown never blocks. |
| Disabled via HBRIDGE_DISABLE_* | The integration is skipped entirely (logged once); the rest of the bridge keeps supervising. |

Additional hard guarantees:

- **No busy loops.** Every retry/reconnect/recheck is spaced by at least the
  configured base backoff (min 1ms), capped at `backoffMaxMs`. Overlapping
  ticks are gagged (`tick_skipped`), never stacked.
- **Idempotent reconcile.** Re-running reconcile over the same registry makes
  no further side effects; markers persist across restarts so dedup survives a
  daemon restart.
- **Clean shutdown.** `stop()` is idempotent, aborts the in-flight SSE stream,
  cancels every timer, saves state once, and releases the notifier delegate.
  SIGINT/SIGTERM both drive the same clean stop sequence; the process exits 0.
- **No dangling handles.** After shutdown the process holds no pending timer,
  stream, or un-reaped child (asserted by the shutdown tests via
  `clock.pendingTimers() === 0`).

---

## Wire contract (adapters)

- **Fusion (in)**: `SseFusionClient.streamEvents({signal})` yields SSE frames
  (`{id?, event?, data}`); `detectEngine()` reports presence via the configured
  probe or the SSE URL. `steer`/`heartbeat` dispatch through the same client.
- **Herdr (in)**: `CliHerdrClient` shells out to `herdr` (bounded by
  `runCaptured` timeouts) for pane listing, resolution, log tailing, liveness.
- **Hermes (out)**: `HttpNotifier` POSTs a JSON notification to the
  integration hook; `CliNotifier` is the CLI fallback. Both are wrapped in
  `DedupNotifier` (window dedup + bounded delivery backoff).
- **Process stream (in, v2)**: `ProcessStreamAdapter.collect(now)` yields v2
  process observations and `getTaskForProcess(pid)` resolves the task they
  serve. `NullProcessStreamAdapter` is the no-op default; `ProcessEventStream`
  is the outbound sink the detector publishes to.

## CLI reference

```
hfb run                                   # operator host ONLY — long-lived daemon
hfb status                                # registry + engine state (JSON, read-only)
hfb reconcile                             # one idempotent reconcile pass (engine-gated)
hfb steer --task=<id> --command=<cmd>      # safe steering (engine-gated, deduped)
hfb steer --task=<id> --command=<cmd> --force   # bypass dedup (never the engine gate)
hfb heartbeat --task=<id>                 # heartbeat variant
```

Flags: `--force` (bypass the steering dedup window — never the engine gate),
`--hook-command=<cmd>` (use a CLI notifier instead of the HTTP hook),
`--help`.

All subcommands except `run` terminate. A skipped steer/reconcile (engine
absent or dedup) exits 0 with the `skipped` outcome JSON so operators can
script it; invalid usage exits 2.

## Tests

```bash
# Always wrap the test command in an explicit timeout. The suite is fully
# terminating (~200ms on this worktree) so a real hang would be a regression —
# treat a `timeout`-observed hang as a FAILURE and debug the un-reaped handle.
timeout 150 node --test "tools/herdr-fusion-bridge/test/**/*.test.js"
```

(The glob form is required on Node 24 — the bare directory form fails with
`MODULE_NOT_FOUND`. If a subshell expansion does not work in your shell, pass
the expanded list directly: `timeout 150 node --test tools/herdr-fusion-bridge/test/*.test.js`.)

173 tests, all terminating: every time-based behavior is driven by an injected
fake clock (no real sleeps), every stream/stream-loop is gated by test-controlled
releases, and shutdown tests assert zero pending timers. The matrix covers:

- engine detection spacing and the `engine_absent` skip path (no busy loop),
- correlation (task → executor → pane) with caching and `association_stale`,
- state transitions and event-kind mapping with per-kind notifications,
- the liveness watchdog — including the **log-churn-never-masks-a-stall** proof,
- idempotent reconcile + orphan recovery, with markers surviving a restart,
- SSE reconnect backoff (monotonic, capped, jittered), dedup, clean abort,
- steering (engine gate, dedup, force, bounded retries, monotonic seq),
- notification dedup + bounded delivery backoff over a down hook,
- clean shutdown (handles, persistence, idempotence, signal equivalence),
- **v2 process detection** — the validator (six kinds, `schemaVersion: 2`,
  two-field payload), rising-edge dedup, terminal re-arm, `null`/`""`
  equivalence, one stall per episode on a fake clock, association precedence
  and drop-with-warn, and the bridge-level contract: fixture replay, v1 stream
  isolation inside the same tick, and `createBridge` with and without a
  `processStreamAdapter`.

### Symptom-regression checks (how the tests were verified to catch defects)

During verification each defect class was temporarily injected and the matching
symptom test went **red**, then green after restore:

| Injected regression | Symptom tests that went red |
| --- | --- |
| Log lines counted as progress | `LOG LINES DO NOT COUNT AS PROGRESS…`, `isRealStall treats log churn…` |
| SSE reconnect backoff removed | `reconnect happens after a stream ends, gated by backoff (no busy loop)`, `backoffFor is clamped to backoffMaxMs` |
| Steering engine gate removed | `steering is skipped and emits one steer_skipped…`, `heartbeat is skipped when the engine is absent` |
| Notification dedup disabled | `DedupNotifier deduplicates identical notifications within the window`, `duplicate events within the window are deduplicated…`, `the dedup window expires and the same event is re-emitted afterwards` |
| v2 rising-edge gate removed (`repeated` forced false) | `emits a repeated same-kind observation exactly once`, `a null and an empty processId dedup against each other (one emission)`, `a repeated terminal kind stays deduped`, `the v2 fixture exercises all six kinds…`, `process events: repeated same-kind observations rise once at the bridge surface`, `process events: null and empty processId dedup against each other` |
| v2 stall marker not set by a reported `process.stalled` | `a stall reported by the stream is never synthesized twice by the scan`, `process events: consumers can listen per kind on the processEvents stream` |
