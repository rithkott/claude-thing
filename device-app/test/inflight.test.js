// The wait between pressing an answer and it reaching the terminal. Two phases
// with different shapes — a known countdown, then an unknown one — and the
// screen picks its ring from which one is live, so the phases are pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inflight, undoLabel } from '../src/inflight.js';

const UNDO_MS = 6000;
const idle = { undo: null, sending: null };
const question = { kind: 'question', id: 'q1' };
const permission = { kind: 'permission', id: 'p1' };

test('nothing in flight shows nothing', () => {
  assert.equal(inflight(idle, UNDO_MS), null);
});

test('a held answer drains over exactly the undo window', () => {
  const v = inflight({ ...idle, undo: { ask: question, choice: [[0]] } }, UNDO_MS);
  assert.equal(v.phase, 'undo');
  assert.equal(v.ms, UNDO_MS);
  assert.equal(v.label, 'ANSWERED · BACK TO UNDO');
});

test('a held permission names the decision it is holding', () => {
  const allow = inflight({ ...idle, undo: { ask: permission, choice: 0 } }, UNDO_MS);
  const deny = inflight({ ...idle, undo: { ask: permission, choice: 1 } }, UNDO_MS);
  assert.equal(allow.label, 'ALLOW · BACK TO UNDO');
  assert.equal(deny.label, 'DENY · BACK TO UNDO');
});

test('on the wire, the label says which machine is working', () => {
  const q = inflight({ ...idle, sending: { id: 'q1', kind: 'question' } }, UNDO_MS);
  assert.equal(q.phase, 'sending');
  assert.equal(q.label, 'TYPING ON MAC');
  assert.equal(q.ms, 0, 'an unknown wait has no duration to animate');

  const p = inflight({ ...idle, sending: { id: 'p1', kind: 'permission' } }, UNDO_MS);
  assert.equal(p.label, 'SENDING TO MAC');
});

// An older answer flushed early to make way for a newer one leaves both fields
// set for as long as it is on the wire. What is actually happening then is the
// typing, so that is what the ring must show.
test('sending outranks a freshly held answer', () => {
  const v = inflight({
    undo: { ask: question, choice: [[0]] },
    sending: { id: 'q0', kind: 'question' },
  }, UNDO_MS);
  assert.equal(v.phase, 'sending');
});

test('an undo entry with no ask still names itself', () => {
  assert.equal(undoLabel(null), 'ANSWERED');
  assert.equal(undoLabel({}), 'ANSWERED');
});
