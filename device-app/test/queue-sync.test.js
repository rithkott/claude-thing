// The daemon's waiting list is authoritative. Anything it no longer vouches for
// is a card nothing can ever resolve — the shape a daemon restart leaves behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as store from '../src/store.js';

function ask(id, over = {}) {
  return { kind: 'question', id, sessionId: 'sess-1', header: 'Q', question: 'q', options: [], createdTs: 1, ...over };
}

function seed(asks) {
  store.update({ asks: asks.slice(), queueIndex: 0, queueAnswering: false, queueChoice: 0 });
}

const ids = () => store.get().asks.map((a) => a.id);

test('an ask the daemon no longer lists is dropped', () => {
  seed([ask('a'), ask('b')]);
  store.reconcileAsks([ask('b')]);
  assert.deepEqual(ids(), ['b']);
});

test('asks the daemon lists but the screen has never seen are added', () => {
  seed([ask('a')]);
  store.reconcileAsks([ask('a'), ask('c')]);
  assert.deepEqual(ids(), ['a', 'c']);
});

test('a locally expired card survives — the daemon never lists those', () => {
  seed([ask('a'), ask('gone', { expired: true, expiredTs: 1 })]);
  store.reconcileAsks([ask('a')]);
  assert.deepEqual(ids(), ['a', 'gone'], 'the timeout notice is not a stale card');
});

test('an empty list from a restarted daemon clears the queue', () => {
  seed([ask('a'), ask('b')]);
  store.reconcileAsks([]);
  assert.deepEqual(ids(), []);
  assert.equal(store.get().queueIndex, 0);
});

test('the cursor never points past the end, and an open option list is closed', () => {
  seed([ask('a'), ask('b'), ask('c')]);
  store.update({ queueIndex: 2, queueAnswering: true, queueChoice: 1 });
  store.reconcileAsks([ask('a')]);
  assert.equal(store.get().queueIndex, 0);
  assert.equal(store.get().queueAnswering, false);
});

test('an unchanged list leaves the queue exactly as it was', () => {
  var a = ask('a');
  seed([a]);
  store.update({ queueIndex: 0, queueAnswering: true, queueChoice: 1 });
  store.reconcileAsks([ask('a')]);
  assert.equal(store.get().asks[0], a, 'same object, not a re-added copy');
  assert.equal(store.get().queueAnswering, true, 'an open option list is not closed for nothing');
});

test('an answer held in its undo window is not resurrected by a sync', () => {
  const held = ask('held');
  seed([ask('a')]);
  store.update({ undo: { ask: held, index: 0, choice: 0, expires: Date.now() + 6000 } });
  // the daemon still vouches for it — the decision has not been sent yet
  store.reconcileAsks([ask('a'), held]);
  assert.deepEqual(ids(), ['a'], 'the held card must not come back mid-undo');
  store.update({ undo: null });
});
