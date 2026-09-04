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
│   ├── state.js                # PersistentState + FsStore (atomic tmp+rename)
│   ├── steering.js             # SteeringController (engine-gated, deduped)
│   ├── bridge.js               # Supervisor (tick loop, engine detection)
│   ├── orchestrator.js         # Bridge wiring (start/stop lifecycle)
│   ├── adapters/
│   │   ├── fusion-client.js    # SseFusionClient, ProcessFusionDetector
│   │   ├── herdr-client.js     # CliHerdrClient (herdr CLI), runCaptured()
│   │   ├── notifier.js         # HttpNotifier, CliNotifier, DedupNotifier
│   │   └── fakes.js            # fakes: FakeFusionClient/Herdr/Notifier
│   └── watchers/
│       ├── sse-watcher.js      # SSE consumer with exponential backoff
│       └── orphan-recovery.js # idempotent orphan reconciliation
└── test/                       # node:test matrix (all terminating)
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

124 tests, all terminating: every time-based behavior is driven by an injected
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
- clean shutdown (handles, persistence, idempotence, signal equivalence).

### Symptom-regression checks (how the tests were verified to catch defects)

During verification each defect class was temporarily injected and the matching
symptom test went **red**, then green after restore:

| Injected regression | Symptom tests that went red |
| --- | --- |
| Log lines counted as progress | `LOG LINES DO NOT COUNT AS PROGRESS…`, `isRealStall treats log churn…` |
| SSE reconnect backoff removed | `reconnect happens after a stream ends, gated by backoff (no busy loop)`, `backoffFor is clamped to backoffMaxMs` |
| Steering engine gate removed | `steering is skipped and emits one steer_skipped…`, `heartbeat is skipped when the engine is absent` |
| Notification dedup disabled | `DedupNotifier deduplicates identical notifications within the window`, `duplicate events within the window are deduplicated…`, `the dedup window expires and the same event is re-emitted afterwards` |
