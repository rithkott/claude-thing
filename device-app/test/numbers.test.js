// The Mac connector's MessagePack wrapper turns any 0 or 1 into false/true on
// its way to the device (Swift casts an NSNumber of 0/1 to Bool). These cover
// the repair: numeric fields come back as numbers, real booleans survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { unbool, observeProbe, shouldUnbool, resetProbe } from '../src/numbers.js';
import { renderAmbient } from '../src/screens/ambient.js';

test('a coerced snapshot renders counts, not booleans', () => {
  const snap = unbool({
    serverNowMs: 1770000000000, tzOffsetMin: false,
    stats: { active: true, attention: true },
    sessions: [{
      id: 'a', name: 'proj', state: 'busy', lastActivityTs: 1770000000000,
      tokens: { in: true, out: false }, pendingPermission: true, ended: false,
      context: true,
    }],
  });

  // a UTC Mac sends tzOffsetMin 0, and clock.js rejects anything not a number
  assert.equal(snap.tzOffsetMin, 0);
  assert.equal(snap.stats.active, 1);
  assert.equal(snap.stats.attention, 1);
  assert.equal(snap.sessions[0].tokens.in, 1);
  assert.equal(snap.sessions[0].tokens.out, 0);
  assert.equal(snap.sessions[0].context, 1);
  // genuine booleans keep their type
  assert.equal(snap.sessions[0].pendingPermission, true);
  assert.equal(snap.sessions[0].ended, false);

  // the blocked line counts asks, so hand ambient one waiting ask
  const html = renderAmbient({ ...snap, selectedIndex: 0, asks: [{ id: 'k' }] });
  assert.match(html, /1 WORKING/);
  assert.match(html, /1 NEEDS YOU/);
  assert.ok(!html.includes('true'), 'no boolean may reach the screen');
});

test('usage counts and percentages survive the round trip', () => {
  const usage = unbool({
    updatedTs: true,
    limits: [{ key: 'session', label: 'Session', used: true }],
    windows: [{ window: 'Last 24h', requests: true, sessions: false, skills: [{ name: '/x', pct: true }] }],
  });

  assert.equal(usage.updatedTs, 1);
  assert.equal(usage.limits[0].used, 1);
  assert.equal(usage.windows[0].requests, 1);
  assert.equal(usage.windows[0].sessions, 0);
  assert.equal(usage.windows[0].skills[0].pct, 1);
});

test('unbool tolerates the frames that carry nothing', () => {
  assert.equal(unbool(undefined), undefined);
  assert.equal(unbool(null), null);
  assert.equal(unbool('busy'), 'busy');
  assert.deepEqual(unbool({ connected: true }), { connected: true });
});

// ---- the intProbe latch -----------------------------------------------------

test('with no probe ever seen, the walk stays on (old daemon)', () => {
  resetProbe();
  assert.equal(shouldUnbool(), true);
});

test('a coerced probe (true) keeps the walk on', () => {
  resetProbe();
  observeProbe(true);
  assert.equal(shouldUnbool(), true);
});

test('a clean probe (1) turns the walk off', () => {
  resetProbe();
  observeProbe(1);
  assert.equal(shouldUnbool(), false);
});

test('a DMG downgrade re-arms the walk within one snapshot', () => {
  resetProbe();
  observeProbe(1);
  assert.equal(shouldUnbool(), false, 'clean link, walk off');
  observeProbe(true);
  assert.equal(shouldUnbool(), true, 'coercing link again, walk back on');
});

test('an absent or alien probe value changes nothing', () => {
  resetProbe();
  observeProbe(undefined);
  observeProbe('1');
  assert.equal(shouldUnbool(), true, 'unknown stays unknown');
  observeProbe(1);
  observeProbe(undefined);
  assert.equal(shouldUnbool(), false, 'a known-clean link is not forgotten');
});
