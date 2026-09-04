// clock.test.js — fake clock determinism: time advances only when told, and
// setTimeouts fire only after the clock advances past their delay. No real
// sleeping occurs in this file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, realClock } from '../src/clock.js';

test('realClock reports monotonic current time', () => {
  const c = realClock();
  const a = c.now();
  const b = c.now();
  assert.ok(b >= a);
});

test('fakeClock starts at time 0 and does not advance on its own', () => {
  const c = fakeClock(0);
  assert.equal(c.mode, 'fake');
  assert.equal(c.now(), 0);
  c.setTimeout(() => {}, 1000);
  assert.equal(c.now(), 0);
  assert.equal(c.pendingTimers(), 1);
});

test('fakeClock fires due timers in time order after advance', () => {
  const c = fakeClock(0);
  const order = [];
  c.setTimeout(() => order.push('first'), 500);
  c.setTimeout(() => order.push('second'), 1000);
  c.advance(500);
  assert.deepEqual(order, ['first']);
  c.advance(500);
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(c.pendingTimers(), 0);
  assert.equal(c.now(), 1000);
});

test('clearTimeout removes a pending timer', () => {
  const c = fakeClock(0);
  let fired = false;
  const handle = c.setTimeout(() => {
    fired = true;
  }, 1000);
  assert.equal(c.pendingTimers(), 1);
  c.clearTimeout(handle);
  assert.equal(c.pendingTimers(), 0);
  c.advance(2000);
  assert.equal(fired, false);
});

test('intervals fire repeatedly until cleared', () => {
  const c = fakeClock(0);
  let ticks = 0;
  const handle = c.setInterval(() => {
    ticks++;
  }, 100);
  c.advance(300);
  assert.equal(ticks, 3);
  c.clearInterval(handle);
  c.advance(500);
  assert.equal(ticks, 3);
});

test('fakeClock records every fired timer for inspection', () => {
  const c = fakeClock(0);
  c.setTimeout(() => {}, 400);
  c.advance(400);
  assert.equal(c.fired.length, 1);
  assert.equal(c.fired[0].at, 400);
});