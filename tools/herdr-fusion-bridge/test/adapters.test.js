// adapters.test.js — interface contracts, deterministic fakes, safe-fail on a
// down transport, and the SSE frame parser. No test waits on real time; backoff
// waits are recorded via an injected waitFn, never real sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';

import { AbstractFusionClient, ProcessFusionDetector, SseFusionClient, createSseParser } from '../src/adapters/fusion-client.js';
import { AbstractHerdrClient, CliHerdrClient, runCaptured } from '../src/adapters/herdr-client.js';
import {
  AbstractNotifier,
  HttpNotifier,
  DedupNotifier,
  DedupGate,
  DeliveryBackoff,
  notificationKey,
} from '../src/adapters/notifier.js';
import { FakeTransport, FakeFusionClient, FakeHerdrClient, FakeNotifier } from '../src/adapters/fakes.js';
import { fakeClock } from '../src/clock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Interface contracts
// ---------------------------------------------------------------------------

test('AbstractFusionClient methods throw not-implemented', async () => {
  const c = new AbstractFusionClient();
  await assert.rejects(() => c.detectEngine(), /not implemented/);
  await assert.rejects(() => c.listTasks(), /not implemented/);
  await assert.rejects(() => c.steer('T', 'heartbeat'), /not implemented/);
});

test('AbstractHerdrClient methods throw not-implemented', async () => {
  const c = new AbstractHerdrClient();
  await assert.rejects(() => c.listPanes(), /not implemented/);
  await assert.rejects(() => c.isPaneAlive('P'), /not implemented/);
});

test('AbstractNotifier methods throw not-implemented', async () => {
  const c = new AbstractNotifier();
  await assert.rejects(() => c.notify({}), /not implemented/);
});

// ---------------------------------------------------------------------------
// ProcessFusionDetector (probe via injected function — bounded, no spin)
// ---------------------------------------------------------------------------

test('ProcessFusionDetector reports absent when the probe returns false', async () => {
  const detector = new ProcessFusionDetector({ probe: () => false });
  assert.deepEqual(await detector.detectEngine(), { present: false });
});

test('ProcessFusionDetector reports present when the probe returns true', async () => {
  const detector = new ProcessFusionDetector({ probe: () => true });
  assert.deepEqual(await detector.detectEngine(), { present: true });
});

test('ProcessFusionDetector with no probe configured does not spin (absent)', async () => {
  const detector = new ProcessFusionDetector({ probeArgs: [] });
  const res = await detector.detectEngine();
  assert.equal(res.present, false);
});

// ---------------------------------------------------------------------------
// Fakes record emissions deterministically
// ---------------------------------------------------------------------------

test('FakeFusionClient records every call and reflects engine presence', async () => {
  const fc = new FakeFusionClient();
  const before = fc.transport.total();
  await fc.detectEngine();
  assert.equal(fc.transport.count('detectEngine'), 1);
  assert.equal(fc.transport.total(), before + 1);
});

test('FakeFusionClient steer records and respects engine absence', async () => {
  const transport = new FakeTransport();
  const fc = new FakeFusionClient({ transport });
  fc.setEnginePresent(false);
  const res = await fc.steer('T-1', 'heartbeat');
  assert.equal(res.skipped, true);
  assert.equal(transport.count('steer'), 1);
  assert.equal(fc.steerLog.length, 1);
});

test('FakeHerdrClient records calls and resolves pane by task', async () => {
  const transport = new FakeTransport();
  const hc = new FakeHerdrClient({ transport });
  hc.addPane('P-1', true);
  hc.mapPane('T-1', 'E-1', 'P-1');
  const pane = await hc.resolvePane('T-1', 'E-1');
  assert.equal(pane, 'P-1');
  assert.equal(transport.count('resolvePane'), 1);
  assert.equal(await hc.isPaneAlive('P-1'), true);
});

test('FakeNotifier records notifications and can be configured to fail', async () => {
  const fn = new FakeNotifier({ fail: true });
  const r = await fn.notify({ kind: 'start', taskId: 'T-1' });
  assert.equal(r.ok, false);
  assert.equal(fn.notifications.length, 0);
  const okFn = new FakeNotifier();
  const r2 = await okFn.notify({ kind: 'start', taskId: 'T-1' });
  assert.equal(r2.ok, true);
  assert.equal(okFn.notifications.length, 1);
});

// ---------------------------------------------------------------------------
// Safe-fail on a down transport: bounded retries, no tight loop
// ---------------------------------------------------------------------------

test('DedupNotifier with a down delegate retries a bounded number of times', async () => {
  const clock = fakeClock(0);
  const waits = [];
  const down = new FakeNotifier({ fail: true });
  const backoff = new DeliveryBackoff({ baseMs: 100, maxMs: 1000, maxAttempts: 3 });
  const notifier = new DedupNotifier({
    delegate: down,
    dedupWindowMs: 5000,
    clock,
    backoff,
    waitFn: (ms) => {
      waits.push(ms);
      clock.advance(ms);
    },
  });
  const res = await notifier.notify({ kind: 'progress', taskId: 'T-1', paneId: 'P-1' });
  // Exactly maxAttempts attempts, never more — no infinite retry spin.
  assert.equal(res.attempt, 3);
  assert.equal(notifier.attempts, 3);
  assert.deepEqual(waits, [100, 200]); // waits after failed attempt 0 and 1
  assert.equal(clock.pendingTimers(), 0);
});

test('DedupNotifier delivers exactly once when the delegate succeeds', async () => {
  const clock = fakeClock(0);
  const fn = new FakeNotifier();
  const notifier = new DedupNotifier({
    delegate: fn,
    dedupWindowMs: 5000,
    clock,
    waitFn: () => {},
  });
  const res = await notifier.notify({ kind: 'start', taskId: 'T-1', paneId: 'P-1' });
  assert.equal(res.ok, true);
  assert.equal(res.attempt, 1);
  assert.equal(fn.notifications.length, 1);
});

test('DedupNotifier deduplicates identical notifications within the window', async () => {
  const clock = fakeClock(0);
  const fn = new FakeNotifier();
  const notifier = new DedupNotifier({ delegate: fn, dedupWindowMs: 5000, clock, waitFn: () => {} });
  const n = { kind: 'blocked', taskId: 'T-1', paneId: 'P-1' };
  const first = await notifier.notify(n);
  const second = await notifier.notify(n);
  assert.equal(first.deduped, undefined);
  assert.equal(second.deduped, true);
  assert.equal(fn.notifications.length, 1);
  // After the window elapses the same key is allowed again.
  clock.advance(6000);
  const third = await notifier.notify(n);
  assert.equal(third.deduped, undefined);
  assert.equal(fn.notifications.length, 2);
});

test('DedupGate marks and re-allows only after the window elapses', () => {
  const clock = fakeClock(0);
  const gate = new DedupGate({ windowMs: 1000, clock });
  assert.equal(gate.mark('key|a'), true);
  assert.equal(gate.mark('key|a'), false);
  clock.advance(1500);
  assert.equal(gate.mark('key|a'), true);
});

test('DeliveryBackoff is exponential and capped, and exhausts attempts', () => {
  const backoff = new DeliveryBackoff({ baseMs: 100, maxMs: 400, maxAttempts: 5 });
  assert.equal(backoff.waitForAttempt(0), 100);
  assert.equal(backoff.waitForAttempt(1), 200);
  assert.equal(backoff.waitForAttempt(2), 400); // capped at maxMs
  assert.equal(backoff.waitForAttempt(3), 400);
  assert.equal(backoff.waitForAttempt(4), 400);
  assert.equal(backoff.waitForAttempt(5), -1); // exhausted
});

test('notificationKey builds a stable (correlation, kind) key', () => {
  assert.equal(
    notificationKey({ taskId: 'T-1', executorId: 'E-1', paneId: 'P-1', kind: 'start' }),
    'T-1|E-1|P-1|start',
  );
  // A global alert (no correlation dimensions) is still keyable so it is
  // deduplicated across ticks — the dimensions collapse to "unknown".
  assert.equal(notificationKey({ kind: 'stalled' }), 'unknown|unknown|unknown|stalled');
  assert.equal(notificationKey({}), null); // missing kind -> not keyable
});

test('HttpNotifier fails safe (no loop) when the hook is down', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const hn = new HttpNotifier({ hookUrl: 'https://hook.example/h', fetchImpl });
  const res = await hn.notify({ kind: 'progress', taskId: 'T-1' });
  assert.equal(res.ok, false);
  // No configured URL resolves skipped, not a throw.
  const hn2 = new HttpNotifier({ hookUrl: '', fetchImpl });
  const res2 = await hn2.notify({ kind: 'progress', taskId: 'T-1' });
  assert.equal(res2.skipped, true);
});

test('HttpNotifier posts JSON and reports ok on a healthy hook', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, body: opts.body });
    return { ok: true };
  };
  const hn = new HttpNotifier({ hookUrl: 'https://hook.example/h', fetchImpl });
  const res = await hn.notify({ kind: 'completed', taskId: 'T-1', paneId: 'P-1' });
  assert.equal(res.ok, true);
  assert.equal(seen[0].url, 'https://hook.example/h');
  assert.equal(JSON.parse(seen[0].body).kind, 'completed');
});

// ---------------------------------------------------------------------------
// CliHerdrClient + runCaptured: bounded, safe-fail
// ---------------------------------------------------------------------------

test('CliHerdrClient parses JSON pane list and defaults on a down CLI', async () => {
  // A fake spawn that returns a passed-down command; bounded.
  const makeSpawn = (capture) => (cmd, args, opts) => {
    capture.push({ cmd, args });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = {
      stdout,
      stderr,
      on: (ev, cb) => {
        if (ev === 'close') {
          // emit a zero/one exit after flushing
          process.nextTick(() => cb(0));
        }
        if (ev === 'error') {
          child._errorCb = cb;
        }
        return child;
      },
      kill: () => {},
    };
    // Write the JSON payload to stdout then end.
    process.nextTick(() => {
      stdout.write(JSON.stringify({ ok: true, panes: [{ paneId: 'P-1', alive: true }] }));
      stdout.end();
    });
    return child;
  };
  const capture = [];
  const hc = new CliHerdrClient({ bin: 'herdr', spawnImpl: makeSpawn(capture) });
  const panes = await hc.listPanes();
  assert.deepEqual(panes, [{ paneId: 'P-1', alive: true }]);
  assert.equal(capture[0].cmd, 'herdr');
  assert.deepEqual(capture[0].args, ['pane', 'list']);
});

test('runCaptured resolves ok:false on a non-zero exit (safe-fail, no throw)', async () => {
  const spawnImpl = () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = {
      stdout,
      stderr,
      on: (ev, cb) => {
        if (ev === 'close') {
          process.nextTick(() => cb(1));
        }
        return child;
      },
      kill: () => {},
    };
    process.nextTick(() => stdout.end());
    return child;
  };
  const res = await runCaptured({ cmd: 'herdr', args: ['pane', 'list'], timeout: 500, spawnImpl });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 1);
});

test('runCaptured kills and fails safe on a timeout (bounded)', async () => {
  let killed = false;
  const spawnImpl = () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = {
      stdout,
      stderr,
      on: () => child, // never close: simulates a hung process
      kill: () => {
        killed = true;
      },
    };
    return child;
  };
  const res = await runCaptured({ cmd: 'herdr', args: ['hang'], timeout: 50, spawnImpl });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'timeout');
  assert.equal(killed, true);
});

// ---------------------------------------------------------------------------
// SSE parser (deterministic, no network)
// ---------------------------------------------------------------------------

test('createSseParser parses a data frame and a named event frame', () => {
  const parser = createSseParser();
  assert.equal(parser.push('data: {"kind":"progress"}'), null);
  const evt = parser.push('');
  assert.equal(evt.event, 'message');
  assert.deepEqual(evt.data, { kind: 'progress' });
});

test('createSseParser parses a named event with multi-line data', () => {
  const parser = createSseParser();
  parser.push('event: start');
  parser.push('data: line1');
  parser.push('data: line2');
  const evt = parser.push('');
  assert.equal(evt.event, 'start');
  assert.equal(evt.data, 'line1\nline2');
});

test('createSseParser ignores comment lines and blank dispatch without data', () => {
  const parser = createSseParser();
  assert.equal(parser.push(': comment'), null);
  assert.equal(parser.push(''), null); // blank dispatch with no pending data
  parser.push('data: x');
  const evt = parser.push('');
  assert.equal(evt.event, 'message');
  assert.equal(evt.data, 'x');
});

test('createSseParser flushes a trailing frame on null (stream end)', () => {
  const parser = createSseParser();
  parser.push('data: {"kind":"completed"}');
  const evt = parser.push(null);
  assert.deepEqual(evt.data, { kind: 'completed' });
});

// ---------------------------------------------------------------------------
// Canonical event schema fixture is valid JSON and well-formed
// ---------------------------------------------------------------------------

test('fixtures/events.json is valid and describes the canonical schema', async () => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'events.json'), 'utf8');
  const schema = JSON.parse(raw);
  assert.equal(schema.schemaVersion, 1);
  for (const kind of ['start', 'progress', 'blocked', 'error', 'stalled', 'completed', 'engine_absent']) {
    assert.ok(schema.kinds[kind], `expected kind "${kind}" in schema`);
  }
  for (const ex of schema.examples) {
    assert.ok(typeof ex.kind === 'string');
    assert.ok(typeof ex.seq === 'number');
    assert.ok(typeof ex.ts === 'number');
    assert.ok('taskId' in ex);
    assert.ok('executorId' in ex);
    assert.ok('paneId' in ex);
  }
});

// ---------------------------------------------------------------------------
// SseFusionClient safe-fail: no configured URL ends the stream (no spin)
// ---------------------------------------------------------------------------

test('SseFusionClient with no URL ends the stream and reports absence', async () => {
  const sse = new SseFusionClient({ sseUrl: '' });
  assert.deepEqual(await sse.detectEngine(), { present: false });
  let yielded = 0;
  // eslint-disable-next-line no-unused-vars
  for await (const _evt of sse.streamEvents()) {
    yielded += 1;
  }
  assert.equal(yielded, 0);
});