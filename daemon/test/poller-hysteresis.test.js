// One registry listing is a claim, not a verdict. A read that catches the
// registry mid-write comes back empty or partial, and retiring on it wiped the
// whole grid for a poll interval — every tile vanished and reappeared. Absence
// must persist across polls before it means death.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseListing, createReconciler } from '../src/sessions/source-poller.js';
import { createStore } from '../src/sessions/store.js';
import { RETIRE_AFTER_MISSED_POLLS, EMPTY_LISTING_GRACE_POLLS } from '../src/config.js';

const CWD = '/Users/nobody/Projects/demo';
const NONE = new Set();

// kind "background" sidesteps the viewport transcript check — these tests are
// about membership, not viewports.
function entry(id, extra = {}) {
  return { id, cwd: CWD, kind: 'background', ...extra };
}

function setup() {
  const store = createStore();
  const { reconcile } = createReconciler({ store });
  return { store, reconcile };
}

// --- retire hysteresis --------------------------------------------------------

test('one missed poll does not retire a session', () => {
  const { store, reconcile } = setup();
  reconcile([entry('a'), entry('b')], NONE);
  reconcile([entry('b')], NONE);
  assert.ok(store.raw('a'), 'a survives its first missed poll');
});

test(`absence from ${RETIRE_AFTER_MISSED_POLLS} consecutive polls retires`, () => {
  const { store, reconcile } = setup();
  reconcile([entry('a'), entry('b')], NONE);
  for (let i = 0; i < RETIRE_AFTER_MISSED_POLLS; i++) reconcile([entry('b')], NONE);
  assert.equal(store.raw('a'), undefined, 'a is retired');
  assert.ok(store.raw('b'), 'b untouched');
});

test('reappearing resets the miss count', () => {
  const { store, reconcile } = setup();
  reconcile([entry('a'), entry('b')], NONE);
  reconcile([entry('b')], NONE);           // miss 1
  reconcile([entry('a'), entry('b')], NONE); // back — count resets
  reconcile([entry('b')], NONE);           // miss 1 again
  assert.ok(store.raw('a'), 'a survives non-consecutive misses');
});

// --- empty-listing grace ------------------------------------------------------

test('an empty listing against a populated store is held, not obeyed', () => {
  const { store, reconcile } = setup();
  reconcile([entry('a')], NONE);
  reconcile([], NONE);
  assert.ok(store.raw('a'), 'last known good held through the grace poll');
});

test('a persistently empty registry does eventually clear the grid', () => {
  const { store, reconcile } = setup();
  reconcile([entry('a')], NONE);
  // grace polls ignored entirely, then misses accrue as usual
  for (let i = 0; i < EMPTY_LISTING_GRACE_POLLS + RETIRE_AFTER_MISSED_POLLS; i++) {
    reconcile([], NONE);
  }
  assert.equal(store.raw('a'), undefined, 'truly-gone sessions still retire');
});

test('empty store plus empty listing is a no-op', () => {
  const { store, reconcile } = setup();
  reconcile([], NONE);
  assert.equal(store.count(), 0);
});

// --- listing shapes -----------------------------------------------------------

test('parseListing accepts the shapes the CLI actually prints', () => {
  assert.deepEqual(parseListing('[]'), []);
  assert.deepEqual(parseListing('[{"id":"a"}]'), [{ id: 'a' }]);
  assert.deepEqual(parseListing('{"agents":[{"id":"a"}]}'), [{ id: 'a' }]);
  assert.deepEqual(parseListing('{"sessions":[]}'), []);
});

test('parseListing refuses to read anything else as an empty listing', () => {
  assert.equal(parseListing('{"error":"update required"}'), null);
  assert.equal(parseListing('{}'), null);
  assert.equal(parseListing('{"agents":"nope"}'), null);
  assert.equal(parseListing('not json'), null);
  assert.equal(parseListing(''), null);
});

// --- indeterminate entries ----------------------------------------------------

test('an interactive entry without a cwd vouches for an existing session', () => {
  const { store, reconcile } = setup();
  reconcile([entry('a')], NONE);
  store.upsert('a', { name: 'real-name' });
  reconcile([{ id: 'a', kind: 'interactive' }], NONE);
  assert.ok(store.raw('a'), 'not retired');
  assert.equal(store.raw('a').name, 'real-name', 'and not overwritten');
});

test('an interactive entry without a cwd never creates a tile', () => {
  const { store, reconcile } = setup();
  reconcile([{ id: 'new', kind: 'interactive' }], NONE);
  assert.equal(store.count(), 0);
});

// --- registry verdicts stay instant -------------------------------------------

test('a finished registry verdict still removes immediately, no hysteresis', () => {
  const { store, reconcile } = setup();
  reconcile([entry('a')], NONE);
  reconcile([entry('a', { status: 'completed' })], NONE);
  assert.equal(store.raw('a'), undefined, 'positive verdicts are not absences');
});
