// config.test.js — verifies env-driven defaults, env overrides and the
// injectable `opts` override. No real time is waited on here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, defaults } from '../src/config.js';

test('config defaults are applied with no env and no opts', () => {
  const cfg = loadConfig({}, {});
  assert.equal(cfg.watchDogTimeoutMs, 60000);
  assert.equal(cfg.tickIntervalMs, 1000);
  assert.equal(cfg.backoffBaseMs, 500);
  assert.equal(cfg.backoffMaxMs, 30000);
  assert.equal(cfg.dedupWindowMs, 5000);
  assert.equal(cfg.engineRecheckMs, 5000);
  assert.equal(cfg.integrationHookUrl, '');
  assert.equal(cfg.herdrBin, 'herdr');
  assert.equal(cfg.fusionSseUrl, '');
  assert.equal(cfg.stateFile, 'herdr-fusion-bridge-state.json');
  assert.equal(cfg.disableFusion, false);
  assert.equal(cfg.disableHerdr, false);
  assert.equal(cfg.disableNotifier, false);
});

test('env overrides numeric config and truncates invalid values to defaults', () => {
  const env = {
    HBRIDGE_WATCHDOG_TIMEOUT_MS: '90000',
    HBRIDGE_TICK_INTERVAL_MS: '250',
    HBRIDGE_DEDUP_WINDOW_MS: '1200',
    HBRIDGE_ENGINE_RECHECK_MS: '8000',
    HBRIDGE_BACKOFF_BASE_MS: '999',
  };
  const cfg = loadConfig({}, env);
  assert.equal(cfg.watchDogTimeoutMs, 90000);
  assert.equal(cfg.tickIntervalMs, 250);
  assert.equal(cfg.dedupWindowMs, 1200);
  assert.equal(cfg.engineRecheckMs, 8000);
  assert.equal(cfg.backoffBaseMs, 999);

  // Garbage / negative numbers fall back to default.
  const bad = loadConfig({}, { HBRIDGE_WATCHDOG_TIMEOUT_MS: 'nope' });
  assert.equal(bad.watchDogTimeoutMs, defaults.watchDogTimeoutMs);
  const neg = loadConfig({}, { HBRIDGE_TICK_INTERVAL_MS: '-5' });
  assert.equal(neg.tickIntervalMs, defaults.tickIntervalMs);
});

test('env overrides string config (wire addresses, herdr bin, state file)', () => {
  const env = {
    HBRIDGE_INTEGRATION_HOOK_URL: 'https://hooks.example/h',
    HBRIDGE_HERDR_BIN: '/usr/local/bin/herdr',
    HBRIDGE_FUSION_SSE_URL: 'https://fusion.example/sse',
    HBRIDGE_STATE_FILE: '/tmp/bf-state.json',
  };
  const cfg = loadConfig({}, env);
  assert.equal(cfg.integrationHookUrl, 'https://hooks.example/h');
  assert.equal(cfg.herdrBin, '/usr/local/bin/herdr');
  assert.equal(cfg.fusionSseUrl, 'https://fusion.example/sse');
  assert.equal(cfg.stateFile, '/tmp/bf-state.json');
});

test('HBRIDGE_DISABLE_* switches become booleans (truthy set)', () => {
  const cfg = loadConfig(
    {},
    { HBRIDGE_DISABLE_FUSION: '1', HBRIDGE_DISABLE_HERDR: 'true', HBRIDGE_DISABLE_NOTIFIER: 'yes' },
  );
  assert.equal(cfg.disableFusion, true);
  assert.equal(cfg.disableHerdr, true);
  assert.equal(cfg.disableNotifier, true);
});

test('opts override wins over env and defaults (used by tests to inject short timeouts)', () => {
  const env = { HBRIDGE_WATCHDOG_TIMEOUT_MS: '60000' };
  const cfg = loadConfig({ watchDogTimeoutMs: 5, tickIntervalMs: 2 }, env);
  assert.equal(cfg.watchDogTimeoutMs, 5);
  assert.equal(cfg.tickIntervalMs, 2);
});

test('probe command string is split into an argv array, honoring quotes', () => {
  const cfg = loadConfig(
    {},
    { HBRIDGE_FUSION_PROBE_CMD: 'pgrep -f "fusion engine"' },
  );
  assert.deepEqual(cfg.fusionProbeArgs, ['pgrep', '-f', 'fusion engine']);
  assert.equal(cfg.fusionProbeCmd, 'pgrep -f "fusion engine"');
});