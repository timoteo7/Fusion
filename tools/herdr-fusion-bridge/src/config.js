// config.js — central, env-driven configuration for the herdr-fusion-bridge.
//
// Every timeout/interval/wire address is read from HBRIDGE_* env vars with
// documented defaults. Tests always inject an `opts` override so they never
// wait on a real (long) watchdog timeout; the injectable form is also how the
// CLI layers per-invocation overrides on top of the env.

const DEFAULT_CONFIG = {
  // Liveness watchdog: a task that makes no *real progress* (discrete
  // state/event change) for this long is declared stalled/blocked.
  watchDogTimeoutMs: 60000,
  // Base cadence of the low-frequency idle supervision tick.
  tickIntervalMs: 1000,
  // Exponential reconnect/retry backoff (ms start and ms cap).
  backoffBaseMs: 500,
  backoffMaxMs: 30000,
  // Notifications/stalls whose (correlationId, kind) repeats within this window
  // are deduplicated to exactly one emission.
  dedupWindowMs: 5000,
  // How often the supervisor rechecks for the engine while it is absent.
  engineRecheckMs: 5000,
  // Integration hook URL for notification delivery (Hermes).
  integrationHookUrl: '',
  // Herdr CLI binary used for pane listing/log replication.
  herdrBin: 'herdr',
  // Fusion SSE event stream URL.
  fusionSseUrl: '',
  // Persisted bridge state file (correlation registry, markers).
  stateFile: 'herdr-fusion-bridge-state.json',
  // Safe-fail switches: when set truthy the corresponding integration is
  // disabled and the bridge fails safe instead of spinning on it.
  disableFusion: false,
  disableHerdr: false,
  disableNotifier: false,
  // Probe command used by ProcessFusionDetector (parsed as an argv array below).
  fusionProbeCmd: '',
};

// Read a numeric env var with a fallback, rejecting non-positive garbage.
function num(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function truthy(value) {
  return value === '1' || value === 'true' || value === 'TRUE' || value === 'yes';
}

// Split a whitespace-delimited command string into argv, honoring simple
// double-quoted segments. Used only for the configurable probe command.
function splitCmd(str) {
  if (!str || !str.trim()) {
    return [];
  }
  const parts = [];
  const re = /"[^"]*"|\S+/g;
  for (const m of str.matchAll(re)) {
    let s = m[0];
    if (s.startsWith('"') && s.endsWith('"')) {
      s = s.slice(1, -1);
    }
    parts.push(s);
  }
  return parts;
}

// Build the effective config. `opts` (optional) overrides individual keys and
// wins over env; env wins over defaults. Everything returned is a simple,
// JSON-serializable object so it can be handed to the CLI and fakes.
export function loadConfig(opts = {}, env = process.env) {
  const cfg = {
    watchDogTimeoutMs: num(env.HBRIDGE_WATCHDOG_TIMEOUT_MS, DEFAULT_CONFIG.watchDogTimeoutMs),
    tickIntervalMs: num(env.HBRIDGE_TICK_INTERVAL_MS, DEFAULT_CONFIG.tickIntervalMs),
    backoffBaseMs: num(env.HBRIDGE_BACKOFF_BASE_MS, DEFAULT_CONFIG.backoffBaseMs),
    backoffMaxMs: num(env.HBRIDGE_BACKOFF_MAX_MS, DEFAULT_CONFIG.backoffMaxMs),
    dedupWindowMs: num(env.HBRIDGE_DEDUP_WINDOW_MS, DEFAULT_CONFIG.dedupWindowMs),
    engineRecheckMs: num(env.HBRIDGE_ENGINE_RECHECK_MS, DEFAULT_CONFIG.engineRecheckMs),
    integrationHookUrl: env.HBRIDGE_INTEGRATION_HOOK_URL || DEFAULT_CONFIG.integrationHookUrl,
    herdrBin: env.HBRIDGE_HERDR_BIN || DEFAULT_CONFIG.herdrBin,
    fusionSseUrl: env.HBRIDGE_FUSION_SSE_URL || DEFAULT_CONFIG.fusionSseUrl,
    stateFile: env.HBRIDGE_STATE_FILE || DEFAULT_CONFIG.stateFile,
    disableFusion: truthy(env.HBRIDGE_DISABLE_FUSION) || DEFAULT_CONFIG.disableFusion,
    disableHerdr: truthy(env.HBRIDGE_DISABLE_HERDR) || DEFAULT_CONFIG.disableHerdr,
    disableNotifier: truthy(env.HBRIDGE_DISABLE_NOTIFIER) || DEFAULT_CONFIG.disableNotifier,
    fusionProbeCmd: env.HBRIDGE_FUSION_PROBE_CMD || DEFAULT_CONFIG.fusionProbeCmd,
    fusionProbeArgs: splitCmd(env.HBRIDGE_FUSION_PROBE_CMD || DEFAULT_CONFIG.fusionProbeCmd),
  };

  // Explicit opts override wins (used by tests and CLI flag layering).
  return Object.assign({}, cfg, opts);
}

export const defaults = DEFAULT_CONFIG;