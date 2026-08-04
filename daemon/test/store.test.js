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

  // Comfortably past CELEBRATE_MS rather than exactly on it, so raising the
  // window doesn't leave this asserting against a boundary it lands on.
  store.upsert('b', {
    name: 'proj',
    stoppedTs: Date.now() - 5 * 60 * ONE_SEC,
    lastActivityTs: Date.now() - 5 * 60 * ONE_SEC,
    waitingForInput: false,
  });
  assert.equal(stateOf(store, 'b'), 'idle');
});

test('an ended session leaves the store at once, however recent', () => {
  const store = createStore();
  store.touch('a', { name: 'proj' });
  store.touch('a', { ended: true });
  assert.equal(store.get('a'), null, 'gone, not a headstone');
  assert.equal(store.snapshot().sessions.length, 0);
});

test('the last detail event for an ended session says it ended and is idle', () => {
  const store = createStore();
  const seen = [];
  store.onDetail = (d) => seen.push(d);
  store.touch('a', { name: 'proj' });
  store.touch('a', { ended: true });
  const last = seen[seen.length - 1];
  assert.equal(last.ended, true, 'a device on the detail screen learns why it vanished');
  assert.equal(last.state, 'idle', 'never busy, however recent the activity');
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

// A live session that keeps working must not keep jumping the queue: the list
// is something you aim a finger at, so live tiles hold their wake order.
test('a working session never overtakes another working session', () => {
  const store = createStore();
  store.touch('a', { name: 'a' });
  store.snapshot();                       // a wakes first
  store.touch('b', { name: 'b' });
  store.snapshot();                       // b wakes second
  store.touch('b', { name: 'b' });        // ...and keeps working
  const ids = store.snapshot().sessions.map((s) => s.id);
  assert.deepEqual(ids, ['a', 'b'], 'later activity does not reorder live sessions');
});

test('a waking session overtakes idle sessions only', () => {
  const store = createStore();
  store.touch('live', { name: 'live' });
  store.upsert('idle', { name: 'idle', lastActivityTs: Date.now() - 60 * ONE_SEC });
  store.upsert('waking', { name: 'waking', lastActivityTs: Date.now() - 60 * ONE_SEC });
  store.snapshot();
  store.touch('waking');
  const ids = store.snapshot().sessions.map((s) => s.id);
  assert.deepEqual(ids, ['live', 'waking', 'idle'], 'past the idle one, behind the live one');
});

test('a session that goes idle and wakes again re-enters at the back of the live group', () => {
  const store = createStore();
  store.touch('a', { name: 'a' });
  store.touch('b', { name: 'b' });
  store.snapshot();
  store.upsert('a', { lastActivityTs: Date.now() - 60 * ONE_SEC });
  store.snapshot();                       // a drops to idle, losing its stamp
  store.touch('a');
  assert.deepEqual(store.snapshot().sessions.map((s) => s.id), ['b', 'a']);
});

test('snapshot honours an explicit limit for constrained transports', () => {
  const store = createStore();
  for (let i = 0; i < 30; i++) store.upsert(`s${i}`, { name: `s${i}`, lastActivityTs: 1000 + i });
  assert.equal(store.snapshot(5).sessions.length, 5);
});

// The device's own clock is wrong in both axes, so the snapshot is the only
// place it learns what time it actually is.
test('every snapshot carries the Mac epoch and UTC offset', () => {
  const store = createStore();
  store.touch('a', { name: 'proj' });
  const snap = store.snapshot();
  assert.ok(Math.abs(snap.serverNowMs - Date.now()) < 1000, 'Mac epoch, freshly read');
  assert.equal(snap.tzOffsetMin, new Date().getTimezoneOffset());
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
    'context', 'effort', 'ended', 'id', 'lastActivityTs', 'model', 'name',
    'pendingPermission', 'permissionMode', 'state', 'tokens',
  ]);
  assert.deepEqual(s.tokens, { in: 5, out: 7 });
  assert.equal(s.context, null, 'no model, no window size, so no fraction');
});

test('effort rides the summary, null until a transcript reports one', () => {
  const store = createStore();
  store.touch('a', { name: 'proj' });
  assert.equal(store.snapshot().sessions[0].effort, null,
    'no guess for a session nothing has said an effort for');
  store.upsert('a', { effort: 'xhigh' });
  assert.equal(store.snapshot().sessions[0].effort, 'xhigh');
  store.upsert('a', { effort: 'ultrathink' });
  assert.equal(store.snapshot().sessions[0].effort, 'ultrathink', 'an effort change follows');
});

test('model rides the summary, empty until a source names one', () => {
  const store = createStore();
  store.touch('a', { name: 'proj' });
  assert.equal(store.snapshot().sessions[0].model, '',
    'no guess for a session nothing has named a model for');
  store.upsert('a', { model: 'claude-fable-5' });
  assert.equal(store.snapshot().sessions[0].model, 'claude-fable-5');
  assert.equal(store.get('a').model, 'claude-fable-5', 'detail carries it too');
});

test('permission mode rides the summary, null until a source reports one', () => {
  const store = createStore();
  store.touch('a', { name: 'proj' });
  assert.equal(store.snapshot().sessions[0].permissionMode, null,
    'no guess for a session nothing has said a mode for');
  store.upsert('a', { permissionMode: 'bypassPermissions' });
  assert.equal(store.snapshot().sessions[0].permissionMode, 'bypassPermissions');
  assert.equal(store.get('a').permissionMode, 'bypassPermissions', 'detail carries it too');
  store.upsert('a', { permissionMode: 'plan' });
  assert.equal(store.snapshot().sessions[0].permissionMode, 'plan', 'a mode change follows');
});

test('context is a fraction of the model window, or null when unknowable', () => {
  const store = createStore();
  store.touch('a', { name: 'proj', model: 'claude-opus-5', contextTokens: 250_000 });
  assert.equal(store.snapshot().sessions[0].context, 0.25);

  store.touch('b', { name: 'proj', model: 'some-future-model', contextTokens: 250_000 });
  assert.equal(store.snapshot().sessions.filter((x) => x.id === 'b')[0].context, null,
    'an unknown model gets no meter rather than a meter against a guess');
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

test('a session that ends mid-thought does not linger as a thinking tile', () => {
  const store = createStore();
  store.upsert('a', { name: 'proj', thinking: true });
  store.upsert('a', { ended: true });
  assert.equal(store.raw('a'), undefined);
  assert.equal(store.snapshot().stats.active, 0);
});

// --- removal -----------------------------------------------------------------

test('an ended session takes no space at all, so one-shot runs cannot pile up', () => {
  const store = createStore();
  for (let i = 0; i < 30; i++) {
    store.upsert(`s${i}`, { name: `s${i}` });
    store.upsert(`s${i}`, { ended: true });
  }
  assert.equal(store.count(), 0);
});

test('a session that starts again after ending comes back as a live record', () => {
  const store = createStore();
  store.upsert('a', { name: 'proj', ended: true });
  assert.equal(store.raw('a'), undefined);
  store.touch('a', { name: 'proj', ended: false });
  const s = store.snapshot().sessions[0];
  assert.equal(s.id, 'a');
  assert.equal(s.ended, false);
  assert.equal(s.state, 'busy');
});

test('entries() exposes every session so the poller can retire strays', () => {
  const store = createStore();
  store.upsert('a', { name: 'one' });
  store.upsert('b', { name: 'two' });
  assert.deepEqual(store.entries().map(([id]) => id).sort(), ['a', 'b']);
});

test('a blank field from one source never erases what another source knew', () => {
  // The poller has no model to offer; the transcript does. A poll must not undo
  // it, or the context meter loses its denominator every three seconds.
  const store = createStore();
  store.touch('a', { name: 'proj', model: 'claude-opus-5', contextTokens: 250_000 });
  assert.equal(store.snapshot().sessions[0].context, 0.25);
  store.touch('a', { name: 'proj' });
  assert.equal(store.snapshot().sessions[0].context, 0.25, 'meter survives a poll');
});

test('a turn longer than the thinking TTL stays busy while hooks keep arriving', () => {
  const store = createStore();
  store.upsert('a', { name: 'proj', thinking: true, lastActivityTs: Date.now() - 60 * ONE_SEC });
  store.raw('a').thinkingTs = Date.now() - 11 * 60 * ONE_SEC;   // turn began long ago
  assert.equal(stateOf(store, 'a'), 'idle', 'stale with no further proof of life');

  // A PreToolUse hook re-asserting "thinking" is that proof, and restamps.
  store.upsert('a', { thinking: true, lastActivityTs: Date.now() - 60 * ONE_SEC });
  assert.equal(stateOf(store, 'a'), 'busy', 'silence since the last hook is what counts');
});

test('a limited snapshot caps the list but stats count everything', () => {
  const store = createStore();
  for (let i = 0; i < 8; i++) store.touch(`s${i}`, { name: `proj${i}` });
  store.touch('p', { name: 'asker', pendingPermission: true });

  const snap = store.snapshot(5);
  assert.equal(snap.sessions.length, 5, 'list capped at the limit');
  assert.equal(snap.stats.active, 8, 'busy count covers sessions beyond the cap');
  assert.equal(snap.stats.attention, 1, 'attention counted even when sliced out');

  const full = store.snapshot();
  assert.equal(full.sessions.length, 9, 'no limit = everything');
});
