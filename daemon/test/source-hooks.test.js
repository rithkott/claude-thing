// The daemon shells out to `claude` to poll the registry, and those short-lived
// processes fire SessionEnd hooks carrying the daemon's own cwd. Nothing here is
// about display logic — it is about never inventing a session from that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/sessions/store.js';
import { startHooksSource } from '../src/sessions/source-hooks.js';
import { markOwnSession } from '../src/own-sessions.js';

const DAEMON_CWD = '/Users/dev/claude-thing/daemon';

test('a SessionEnd for a session we never saw creates nothing', () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  onHookEvent('SessionEnd', { session_id: 'ghost-1', cwd: DAEMON_CWD });
  assert.equal(store.count(), 0, 'no phantom named after the daemon directory');
  assert.equal(store.snapshot().sessions.length, 0);
});

test('a SessionEnd for a live session still retires it', () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  onHookEvent('SessionStart', { session_id: 'real-1', cwd: '/Users/dev/proj' });
  assert.equal(store.count(), 1);
  onHookEvent('SessionEnd', { session_id: 'real-1', cwd: '/Users/dev/proj' });
  assert.equal(store.count(), 0, 'gone the moment it ends');
});

test("the daemon's own usage runs are ignored whatever hook they fire", () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  markOwnSession('ours-1');
  onHookEvent('SessionStart', { session_id: 'ours-1', cwd: '/tmp' });
  onHookEvent('UserPromptSubmit', { session_id: 'ours-1', cwd: '/tmp', prompt: '/usage' });
  assert.equal(store.count(), 0);
});
