// Touch drag -> dial ticks. The gesture is a pure state machine so the parts
// that are easy to get wrong — direction, tick spacing, unwinding a reversed
// drag, and telling a tap from a scroll — can be asserted without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDrag, SLOP, STEP } from '../src/gesture.js';

function harness(opts) {
  const ticks = [];
  const drag = createDrag((d) => ticks.push(d), opts);
  return { ticks, drag, sum: () => ticks.reduce((a, b) => a + b, 0) };
}

test('dragging left advances, dragging right goes back', () => {
  const h = harness();
  h.drag.start(400, 240, 0);
  h.drag.move(400 - STEP * 3, 240, 100);
  h.drag.end(1000);                      // long pause: no fling
  assert.deepEqual(h.ticks, [1, 1, 1]);

  const back = harness();
  back.drag.start(400, 240, 0);
  back.drag.move(400 + STEP * 2, 240, 100);
  back.drag.end(1000);
  assert.deepEqual(back.ticks, [-1, -1]);
});

test('dragging up advances too — the dial walks the list either way', () => {
  const h = harness();
  h.drag.start(400, 240, 0);
  h.drag.move(400, 240 - STEP * 2, 100);
  h.drag.end(1000);
  assert.deepEqual(h.ticks, [1, 1]);
});

test('travel under one step emits nothing', () => {
  const h = harness();
  h.drag.start(400, 240, 0);
  h.drag.move(400 - (STEP - 1), 240, 100);
  h.drag.end(1000);
  assert.deepEqual(h.ticks, []);
});

test('reversing a drag unwinds the ticks it produced', () => {
  const h = harness();
  h.drag.start(400, 240, 0);
  h.drag.move(400 - STEP * 3, 240, 100);
  h.drag.move(400 - STEP, 240, 200);     // back towards the start
  h.drag.end(1000);
  assert.equal(h.sum(), 1, 'net position, not total finger travel');
});

test('the axis locks once and a wandering finger does not switch it', () => {
  const h = harness();
  h.drag.start(400, 240, 0);
  h.drag.move(400 - STEP, 240, 50);              // committed sideways
  h.drag.move(400 - STEP, 240 - STEP * 5, 100);  // then wanders down the screen
  h.drag.end(1000);
  assert.equal(h.sum(), 1, 'only the locked axis counts');
});

test('a tap is not a scroll, a drag is — so the tap click still lands', () => {
  const h = harness();
  h.drag.start(400, 240, 0);
  h.drag.move(400 + SLOP - 1, 240, 30);
  h.drag.end(40);
  assert.equal(h.drag.scrolled(), false, 'jitter under the slop stays a tap');

  h.drag.start(400, 240, 100);
  h.drag.move(400 - STEP, 240, 160);
  h.drag.end(170);
  assert.equal(h.drag.scrolled(), true);

  h.drag.start(400, 240, 300);            // the next touch starts clean
  assert.equal(h.drag.scrolled(), false);
});

test('a flick adds momentum, a parked finger does not', () => {
  const fling = harness();
  fling.drag.start(400, 240, 0);
  fling.drag.move(400 - STEP, 240, 20);   // ~2.8px/ms
  fling.drag.end(25);
  assert.ok(fling.sum() > 1, 'fling carries past the finger');
  assert.ok(fling.sum() <= 1 + 4, 'momentum is capped');

  const parked = harness();
  parked.drag.start(400, 240, 0);
  parked.drag.move(400 - STEP, 240, 20);
  parked.drag.end(500);                   // held still before lifting
  assert.equal(parked.sum(), 1);
});

test('a cancelled gesture stops emitting', () => {
  const h = harness();
  h.drag.start(400, 240, 0);
  h.drag.move(400 - STEP, 240, 50);
  h.drag.cancel();
  h.drag.move(400 - STEP * 4, 240, 100);
  h.drag.end(110);
  assert.equal(h.sum(), 1, 'nothing after the cancel');
});
