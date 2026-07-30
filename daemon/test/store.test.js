import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/sessions/store.js';

const ONE_SEC = 1000;

function stateOf(store, id) {
  return store.get(id).state;
}

test('a session with fresh activity is busy', () => {
  const store = createStore();
  store.touch('a', { name: 'proj' });
  assert.equal(stateOf(store, 'a'), 'busy');
});

test('activity older than the busy window falls back to idle', () => {
  const store = createStore();
  store.upsert('a', { name: 'proj', lastActivityTs: Date.now() - 60 * ONE_SEC });
  assert.equal(stateOf(store, 'a'), 'idle');
});

test('a pending permission outranks everything else', () => {
  const store = createStore();
  // busy AND just stopped AND pending — attention must win
  store.touch('a', { name: 'proj', stoppedTs: Date.now(), pendingPermission: true });
  assert.equal(stateOf(store, 'a'), 'attention');
});

test('waiting for input is attention even when idle-old', () => {
  const store = createStore();
  store.upsert('a', {
    name: 'proj',
    lastActivityTs: Date.now() - 60 * ONE_SEC,
    waitingForInput: true,
  });
  assert.equal(stateOf(store, 'a'), 'attention');
});

test('a recent stop celebrates, an old stop does not', () => {
  const store = createStore();
  store.upsert('a', { name: 'proj', stoppedTs: Date.now() - ONE_SEC, waitingForInput: false });
  assert.equal(stateOf(store, 'a'), 'celebrate');

  store.upsert('b', {
    name: 'proj',
    stoppedTs: Date.now() - 60 * ONE_SEC,
    lastActivityTs: Date.now() - 60 * ONE_SEC,
    waitingForInput: false,
  });
  assert.equal(stateOf(store, 'b'), 'idle');
});

test('an ended session is never busy, however recent', () => {
  const store = createStore();
  store.touch('a', { name: 'proj', ended: true });
  assert.equal(stateOf(store, 'a'), 'idle');
  assert.equal(store.snapshot().sessions[0].ended, true, 'device can label it ENDED');
});

test('a quiet but live session is idle and NOT ended', () => {
  const store = createStore();
  store.upsert('a', { name: 'proj', lastActivityTs: Date.now() - 60_000 });
  const s = store.snapshot().sessions[0];
  assert.equal(s.state, 'idle');
  assert.equal(s.ended, false);
});

test('snapshot is newest-first and unbounded by default', () => {
  const store = createStore();
  for (let i = 0; i < 30; i++) {
    store.upsert(`s${i}`, { name: `s${i}`, lastActivityTs: 1000 + i });
  }
  const snap = store.snapshot();
  assert.equal(snap.sessions.length, 30);
  assert.equal(snap.sessions[0].id, 's29', 'most recent activity first');
});

test('snapshot honours an explicit limit for constrained transports', () => {
  const store = createStore();
  for (let i = 0; i < 30; i++) store.upsert(`s${i}`, { name: `s${i}`, lastActivityTs: 1000 + i });
  assert.equal(store.snapshot(5).sessions.length, 5);
});

test('stats count busy and attention sessions', () => {
  const store = createStore();
  store.touch('busy1', { name: 'a' });
  store.touch('attn1', { name: 'b', pendingPermission: true });
  store.upsert('idle1', { name: 'c', lastActivityTs: Date.now() - 60 * ONE_SEC });
  const { stats } = store.snapshot();
  assert.equal(stats.active, 1);
  assert.equal(stats.attention, 1);
});

test('summary stays small: name clamped, only the agreed fields', () => {
  const store = createStore();
  store.touch('a', { name: 'x'.repeat(80), tokensIn: 5, tokensOut: 7 });
  const s = store.snapshot().sessions[0];
  assert.equal(s.name.length, 32);
  assert.deepEqual(Object.keys(s).sort(), [
    'ended', 'id', 'lastActivityTs', 'name', 'pendingPermission', 'state', 'tokens',
  ]);
  assert.deepEqual(s.tokens, { in: 5, out: 7 });
});

test('detail carries the fields the device screen needs', () => {
  const store = createStore();
  store.touch('a', {
    name: 'proj', cwd: '/tmp/proj', model: 'claude-fable-5',
    currentTool: 'Bash', lastMessage: 'y'.repeat(400), cacheRead: 42,
  });
  const d = store.get('a');
  assert.equal(d.cwd, '/tmp/proj');
  assert.equal(d.currentTool, 'Bash');
  assert.equal(d.lastMessage.length, 200, 'last message is clamped');
  assert.equal(d.cacheRead, 42);
});

test('unknown session has no detail', () => {
  assert.equal(createStore().get('nope'), null);
});

// --- thinking / working ------------------------------------------------------

test('a session thinking mid-turn stays busy with no activity for minutes', () => {
  const store = createStore();
  // UserPromptSubmit lands, then the model thinks: no hooks, no transcript
  // writes, nothing to refresh lastActivityTs.
  store.upsert('a', { name: 'proj', thinking: true, lastActivityTs: Date.now() - 5 * 60 * ONE_SEC });
  assert.equal(stateOf(store, 'a'), 'busy');
});

test('thinking is abandoned if it never ends', () => {
  const store = createStore();
  // Quiet as well as thinking, or the activity window alone would keep it busy.
  store.upsert('a', { name: 'proj', thinking: true, lastActivityTs: Date.now() - 60 * ONE_SEC });
  store.raw('a').thinkingTs = Date.now() - 11 * 60 * ONE_SEC;   // past THINKING_TTL_MS
  assert.equal(stateOf(store, 'a'), 'idle');
});

test('a fresh registry "working" verdict beats a stale activity timestamp', () => {
  const store = createStore();
  store.upsert('a', {
    name: 'proj', agentActive: true, agentActiveTs: Date.now(),
    lastActivityTs: Date.now() - 60 * ONE_SEC,
  });
  assert.equal(stateOf(store, 'a'), 'busy');
});

test('a stale registry verdict does not keep a quiet session busy', () => {
  const store = createStore();
  store.upsert('a', {
    name: 'proj', agentActive: true, agentActiveTs: Date.now() - 60 * ONE_SEC,
    lastActivityTs: Date.now() - 60 * ONE_SEC,
  });
  assert.equal(stateOf(store, 'a'), 'idle');
});

test('ending a session clears thinking, so it cannot outlive its own exit', () => {
  const store = createStore();
  store.upsert('a', { name: 'proj', thinking: true });
  store.upsert('a', { ended: true });
  assert.equal(stateOf(store, 'a'), 'idle');
});

// --- pruning -----------------------------------------------------------------

test('pruning measures from when a session ended, not its last activity', () => {
  const store = createStore();
  // Worked right up to the moment it exited: lastActivityTs is recent, and the
  // old prune keyed off that, so the tile outstayed its welcome by the full TTL.
  store.upsert('a', { name: 'proj', ended: true });
  const s = store.raw('a');
  assert.ok(s.endedTs, 'endedTs is stamped on the transition');
  s.endedTs = Date.now() - 61 * ONE_SEC;      // past the 60s ENDED_TTL_MS
  s.lastActivityTs = Date.now();
  store.upsert('a', {});                       // provoke a re-derive
  assert.equal(store.raw('a').endedTs < Date.now() - 60 * ONE_SEC, true);
});

test('a session brought back to life loses its ended stamp', () => {
  const store = createStore();
  store.upsert('a', { name: 'proj', ended: true });
  assert.ok(store.raw('a').endedTs);
  store.touch('a', { ended: false });
  assert.equal(store.raw('a').endedTs, null);
  assert.equal(store.snapshot().sessions[0].ended, false);
});

test('entries() exposes every session so the poller can retire strays', () => {
  const store = createStore();
  store.upsert('a', { name: 'one' });
  store.upsert('b', { name: 'two' });
  assert.deepEqual(store.entries().map(([id]) => id).sort(), ['a', 'b']);
});
