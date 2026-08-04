// The banner says whether the Mac is answering. It used to say whether the
// first request of the session had answered — issue #55, where one slow boot
// left DAEMON OFFLINE up for hours over a link that was working fine.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLink } from '../src/link.js';

// A link with a controllable clock and a ping whose outcome the test picks.
function harness(opts) {
  opts = opts || {};
  const changes = [];        // [connected, was]
  let clock = 1000;
  let pings = 0;
  let answer = opts.answer === undefined ? true : opts.answer;
  const link = createLink({
    quietMs: opts.quietMs || 40000,
    now: () => clock,
    onChange: (connected, was) => changes.push([connected, was]),
    ping: () => {
      pings++;
      return answer ? Promise.resolve({}) : Promise.reject(new Error('timeout'));
    },
  });
  return {
    link,
    changes,
    pings: () => pings,
    advance: (ms) => { clock += ms; },
    daemon: (up) => { answer = up; },
  };
}

test('claude.* traffic is proof enough — no ping is spent', async () => {
  const h = harness();
  h.link.seen();
  h.advance(39000);
  await h.link.tick();
  assert.equal(h.pings(), 0, 'the daemon spoke inside the quiet window');
  assert.deepEqual(h.changes, [[true, null]]);
});

test('gone quiet: the link asks, and an answer keeps the banner off', async () => {
  const h = harness();
  h.link.seen();
  h.advance(41000);
  await h.link.tick();
  assert.equal(h.pings(), 1);
  assert.equal(h.link.connected(), true);
  assert.deepEqual(h.changes, [[true, null]], 'nothing changed, so nothing was announced');
});

test('gone quiet with nobody home: the banner comes up', async () => {
  const h = harness();
  h.link.seen();
  h.daemon(false);
  h.advance(41000);
  await h.link.tick();
  assert.equal(h.link.connected(), false);
  assert.deepEqual(h.changes, [[true, null], [false, true]]);
});

test('a boot that heard nothing yet asks straight away', async () => {
  const h = harness();
  await h.link.tick();
  assert.equal(h.pings(), 1, 'never seen is not the same as seen just now');
  assert.equal(h.link.connected(), true);
});

// The bug itself: one failed request no longer decides the rest of the session.
test('a daemon that answers again clears the banner, and says it came back', async () => {
  const h = harness();
  h.daemon(false);
  await h.link.tick();
  assert.equal(h.link.connected(), false);

  h.advance(5000);
  h.link.seen();                       // any claude.* frame off the wire
  assert.equal(h.link.connected(), true);
  assert.deepEqual(h.changes, [[false, null], [true, false]],
    'was === false is what tells a recovery from a first answer');
});

test('a probe already in flight is not doubled up', async () => {
  const h = harness();
  const first = h.link.tick();
  h.link.tick();
  await first;
  assert.equal(h.pings(), 1);
});

test('the emulator relay reporting the daemon up or down lands in the same state', async () => {
  const h = harness();
  h.link.report(false);
  assert.equal(h.link.connected(), false);
  h.link.report(true);
  assert.equal(h.link.connected(), true);
  // reporting up also counts as having heard from the daemon: no ping follows
  h.advance(39000);
  await h.link.tick();
  assert.equal(h.pings(), 0);
});
