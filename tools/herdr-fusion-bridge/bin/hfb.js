#!/usr/bin/env node
// bin/hfb.js — the herdr-fusion-bridge CLI.
//
// Subcommands:
//   run       Start long-running supervision (supervisor + SSE watcher +
//             steering). Handles SIGINT/SIGTERM with a clean, persisted
//             shutdown. OPERATOR-HOST ONLY: never launched by tests or steps.
//   status    Print the persisted correlation registry + engine/orphan state
//             as structured JSON (read-only, terminates).
//   reconcile Run ONE idempotent reconcile pass (engine-gated), persist, and
//             print the result as JSON (terminates).
//   steer     Dispatch one steering/heartbeat command: --task=<id>
//             --command=<cmd> [--force]. Engine-gated, deduped, bounded
//             retries (terminates).
//   heartbeat Dispatch a heartbeat to --task=<id> (terminates).
//
// All configuration is env-driven (HBRIDGE_*, see src/config.js and README).
// Every bounded subcommand resolves; the process always exits — `run` only
// ever blocks on its own signal-driven shutdown promise.

import { loadConfig } from '../src/config.js';
import { realClock } from '../src/clock.js';
import { createLogger } from '../src/logger.js';
import { createBridge } from '../src/orchestrator.js';
import { SseFusionClient } from '../src/adapters/fusion-client.js';
import { ProcessFusionDetector } from '../src/adapters/fusion-client.js';
import { CliHerdrClient } from '../src/adapters/herdr-client.js';
import { HttpNotifier, CliNotifier, DedupNotifier, DeliveryBackoff } from '../src/adapters/notifier.js';

function usage(exitCode = 0) {
  const text = [
    'hfb — herdr-fusion-bridge coordination CLI',
    '',
    'Usage:',
    '  hfb run                                  start long-running supervision (operator host)',
    '  hfb status                               print correlation registry + engine state (JSON)',
    '  hfb reconcile                            one idempotent reconcile pass (engine-gated)',
    '  hfb steer --task=<id> --command=<cmd>    dispatch one steering command',
    '  hfb heartbeat --task=<id>               dispatch a heartbeat command',
    '',
    'Flags:',
    '  --force           bypass steering dedup (never the engine gate)',
    '  --hook-command=<cmd>  use a CLI notifier instead of the HTTP hook',
    '  --help            this message',
    '',
    'Configuration: HBRIDGE_* environment variables (see README).',
  ].join('\n');
  if (exitCode !== 0) {
    process.stderr.write(`${text}\n`);
    process.exit(exitCode);
  }
  process.stdout.write(`${text}\n`);
  process.exit(exitCode);
}

// Parse --key=value flags into a map.
function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

// Build the real adapters from config. Disabled integrations resolve to
// safe-fail defaults (absent engine, empty panes, skipped hook) — never a spin.
function buildAdapters(config, logger, flags = null) {
  // Fusion: the SSE client is the primary adapter (engine + events); the
  // process detector supplies engine presence when a probe command is set.
  const sse = new SseFusionClient({
    sseUrl: config.disableFusion ? '' : config.fusionSseUrl,
    logger,
  });
  const detector = new ProcessFusionDetector({
    probeArgs: config.disableFusion ? [] : config.fusionProbeArgs || [],
    logger,
  });
  const fusion = {
    detectEngine: async () => {
      // Prefer the configured probe; fall back to SSE-URL presence.
      const viaProbe = config.fusionProbeArgs && config.fusionProbeArgs.length > 0;
      if (viaProbe) {
        return detector.detectEngine();
      }
      return sse.detectEngine();
    },
    listTasks: async () => sse.listTasks(),
    readTask: async (id) => sse.readTask(id),
    resolveExecutor: async (id) => sse.resolveExecutor(id),
    steer: async (id, cmd) => sse.steer(id, cmd),
    streamEvents: (opts) => sse.streamEvents(opts),
  };

  const herdr = new CliHerdrClient({
    bin: config.herdrBin,
    logger,
    timeout: 2000,
  });

  let notifier = null;
  if (!config.disableNotifier) {
    const hookCommand = flags && flags.hookCommand ? String(flags.hookCommand).split(/\s+/).filter(Boolean) : [];
    if (hookCommand.length > 0) {
      // CLI notifier fallback: spawn a command per notification (bounded).
      notifier = new CliNotifier({ command: hookCommand });
    } else if (config.integrationHookUrl) {
      const http = new HttpNotifier({ hookUrl: config.integrationHookUrl });
      notifier = new DedupNotifier({
        delegate: http,
        dedupWindowMs: config.dedupWindowMs,
        backoff: new DeliveryBackoff({
          baseMs: config.backoffBaseMs,
          maxMs: config.backoffMaxMs,
        }),
      });
    }
  }
  return { fusion, herdr, notifier };
}

async function cmdStatus(config, logger) {
  const clock = realClock();
  const { fusion, herdr, notifier } = buildAdapters(config, logger);
  const bridge = createBridge({ config, fusion, herdr, notifier, logger, clock });
  const engine = await fusion.detectEngine();
  const snapshot = bridge.status();
  const out = {
    ok: true,
    cmd: 'status',
    at: clock.now(),
    engine: { present: Boolean(engine && engine.present) },
    fusionSseConfigured: Boolean(config.fusionSseUrl),
    herdrBin: config.herdrBin,
    notifierEnabled: Boolean(notifier),
    ...snapshot,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return 0;
}

async function cmdReconcile(config, logger) {
  const clock = realClock();
  const { fusion, herdr, notifier } = buildAdapters(config, logger);
  const bridge = createBridge({ config, fusion, herdr, notifier, logger, clock });
  const result = await bridge.reconcileOnce();
  const out = {
    ok: true,
    cmd: 'reconcile',
    at: clock.now(),
    result,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return 0;
}

async function cmdSteer(config, logger, flags) {
  const taskId = flags.task;
  const command = flags.command;
  if (!taskId || !command) {
    process.stderr.write('steer requires --task=<id> and --command=<cmd>\n');
    return 2;
  }
  const clock = realClock();
  const { fusion, herdr, notifier } = buildAdapters(config, logger, flags);
  const bridge = createBridge({ config, fusion, herdr, notifier, logger, clock });
  // The daemon learns engine presence from the tick loop; the one-shot CLI has
  // no tick, so prime the steering engine-gate with ONE bounded detection.
  // Without this the gate reads the supervisor's initial false and every CLI
  // steer would skip as engine_absent even with a healthy engine.
  await bridge.supervisor.ensureEnginePresence(clock.now());
  const outcome = await bridge.steer(taskId, command, { force: flags.force === true });
  process.stdout.write(
    `${JSON.stringify({ ok: true, cmd: 'steer', outcome }, null, 2)}\n`,
  );
  // A skipped steer (engine absent / deduped) is a documented safe-fail, not a
  // process error: exit 0 with the skipped outcome so operators can script it.
  return 0;
}

async function cmdHeartbeat(config, logger, flags) {
  const taskId = flags.task;
  if (!taskId) {
    process.stderr.write('heartbeat requires --task=<id>\n');
    return 2;
  }
  const clock = realClock();
  const { fusion, herdr, notifier } = buildAdapters(config, logger);
  const bridge = createBridge({ config, fusion, herdr, notifier, logger, clock });
  // Same one-shot priming as cmdSteer — see comment there.
  await bridge.supervisor.ensureEnginePresence(clock.now());
  const outcome = await bridge.heartbeat(taskId);
  process.stdout.write(
    `${JSON.stringify({ ok: true, cmd: 'heartbeat', outcome }, null, 2)}\n`,
  );
  return 0;
}

// The long-running supervision loop. NEVER invoked by tests/steps — it blocks
// until SIGINT/SIGTERM, then shuts down cleanly (stop parts, save state, exit 0).
async function cmdRun(config, logger) {
  const clock = realClock();
  const { fusion, herdr, notifier } = buildAdapters(config, logger);
  const bridge = createBridge({ config, fusion, herdr, notifier, logger, clock });
  bridge.start();
  logger.info('bridge_started', {
    stateFile: config.stateFile,
    tickIntervalMs: config.tickIntervalMs,
  });

  let signalName = null;
  const shutdown = new Promise((resolve) => {
    const onSignal = (name) => () => {
      signalName = name;
      resolve();
    };
    process.on('SIGINT', onSignal('SIGINT'));
    process.on('SIGTERM', onSignal('SIGTERM'));
  });
  await shutdown;

  // Clean shutdown: stop the SSE watcher and supervisor, save state, release
  // handles, and exit 0. Idempotent stop() means a double signal is harmless.
  const stopped = bridge.stop();
  logger.info('bridge_stopped', {}, { signal: signalName, stopped });
  process.stdout.write(
    `${JSON.stringify({ ok: true, cmd: 'run', stopped: stopped > 0, signal: signalName }, null, 2)}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const { flags } = parseFlags(argv.slice(1));
  if (flags.help || sub === '--help' || !sub) {
    return usage(sub ? 0 : 1);
  }
  const config = loadConfig({}, process.env);
  const logger = createLogger({});

  switch (sub) {
    case 'run':
      return cmdRun(config, logger);
    case 'status':
      return cmdStatus(config, logger);
    case 'reconcile':
      return cmdReconcile(config, logger);
    case 'steer':
      return cmdSteer(config, logger, flags);
    case 'heartbeat':
      return cmdHeartbeat(config, logger, flags);
    default:
      process.stderr.write(`unknown subcommand: ${sub}\n`);
      return usage(1);
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(err && err.stack ? err.stack : err) })}\n`);
    process.exit(1);
  });
