// The device screens are string builders, so they can be rendered and asserted
// on without a browser. These cover the formatting and the state→sprite mapping
// that the emulator screenshots can only show one case of at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { esc, fmtTokens, fmtDuration, stateLabel } from '../src/screens/helpers.js';
import { renderList } from '../src/screens/session-list.js';
import { renderQueue } from '../src/screens/queue.js';
import { renderUsage } from '../src/screens/usage.js';
import { renderAmbient } from '../src/screens/ambient.js';
import { renderDetail } from '../src/screens/session-detail.js';
import { renderAsk, setQueueContext } from '../src/screens/ask.js';

function baseState(over = {}) {
  return {
    sessions: [], stats: { active: 0, attention: 0 }, details: {}, asks: [],
    usage: null, daemonConnected: true, selectedIndex: 0, queueIndex: 0, ...over,
  };
}
const session = (over = {}) => ({
  id: 'a', name: 'proj', state: 'busy', lastActivityTs: Date.now(),
  tokens: { in: 1000, out: 2000 }, pendingPermission: false, ...over,
});

test('escaping stops session text from breaking out into markup', () => {
  const html = renderList(baseState({ sessions: [session({ name: '<img src=x onerror=alert(1)>' })] }));
  assert.ok(!html.includes('<img'), 'tag must be escaped');
  assert.ok(html.includes('&lt;img'));
  assert.equal(esc('a & b'), 'a &amp; b');
});

test('token counts are humanised', () => {
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(1500), '2k');
  assert.equal(fmtTokens(2_400_000), '2.4M');
});

test('durations read as h/m', () => {
  assert.equal(fmtDuration(45_000), '0m');
  assert.equal(fmtDuration(30 * 60_000), '30m');
  assert.equal(fmtDuration(95 * 60_000), '1h 35m');
});

test('idle reads IDLE when quiet and ENDED only when actually over', () => {
  assert.equal(stateLabel('busy'), 'WORKING');
  assert.equal(stateLabel('attention'), 'ATTENTION');
  assert.equal(stateLabel('celebrate'), 'DONE');
  assert.equal(stateLabel('idle', false), 'IDLE');
  assert.equal(stateLabel('idle', true), 'ENDED');
});

test('grid marks the selected tile and only that one', () => {
  const html = renderList(baseState({
    sessions: [session({ id: 'a' }), session({ id: 'b' }), session({ id: 'c' })],
    selectedIndex: 1,
  }));
  assert.equal((html.match(/tile[^"]*selected/g) || []).length, 1);
});

test('grid scrolls sideways only once the selection leaves the visible columns', () => {
  const many = Array.from({ length: 12 }, (_, i) => session({ id: `s${i}` }));
  const near = renderList(baseState({ sessions: many, selectedIndex: 3 }));
  assert.match(near, /translateX\(-0px\)/, 'still at the start');

  const far = renderList(baseState({ sessions: many, selectedIndex: 11 }));
  const offset = Number(/translateX\(-(\d+)px\)/.exec(far)[1]);
  assert.ok(offset > 0, 'track slid to keep the selection on screen');
});

test('the scroll rail is present but blank when everything fits', () => {
  const few = renderList(baseState({ sessions: [session()] }));
  assert.match(few, /grail blank/, 'blank rail keeps the bottom spacing even');
  const many = renderList(baseState({ sessions: Array.from({ length: 12 }, (_, i) => session({ id: `s${i}` })) }));
  assert.match(many, /gthumb/, 'thumb appears once it scrolls');
});

test('grid explains itself when there are no sessions', () => {
  assert.match(renderList(baseState()), /NO SESSIONS/);
});

test('a pending permission is flagged on its tile', () => {
  const html = renderList(baseState({ sessions: [session({ pendingPermission: true })] }));
  assert.match(html, /class="badge"/);
  assert.match(html, /needs your answer/);
});

test('queue lists both kinds with their own accent and wait label', () => {
  const html = renderQueue(baseState({
    asks: [
      { kind: 'permission', id: 'p1', sessionName: 'proj', tool: 'Bash', summary: 'rm -rf x', createdTs: Date.now(), timeoutMs: 55_000 },
      { kind: 'question', id: 'q1', sessionName: 'proj', header: 'PICK', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }], createdTs: Date.now() - 5000 },
    ],
  }));
  assert.match(html, /PERMISSION/);
  assert.match(html, /QUESTION/);
  assert.match(html, /qrail question/, 'questions get their own rail colour');
  assert.doesNotMatch(html, /left/, 'no countdown — a deadline you can lose is worse than none');
  assert.match(html, /0s|\ds/, 'permissions show how long they have waited');
  assert.match(html, /\(2 options\)/);
});

test('empty queue says so plainly', () => {
  assert.match(renderQueue(baseState()), /NOTHING WAITING ON YOU/);
});

test('question ask renders every option, numbered, with one selected', () => {
  setQueueContext(0, 1);
  const ask = {
    kind: 'question', id: 'q', sessionName: 'proj', header: 'MIGRATION',
    question: 'How?', options: [{ label: 'One', description: 'first' }, { label: 'Two' }, { label: 'Three' }],
    createdTs: Date.now(),
  };
  const html = renderAsk(baseState(), ask, 1);
  assert.match(html, /One/);
  assert.match(html, /Two/);
  assert.equal((html.match(/qopt selected/g) || []).length, 1);
  assert.match(html, /press dial to answer/);
});

test('a long option list windows around the cursor and shows position', () => {
  setQueueContext(0, 1);
  const ask = {
    kind: 'question', id: 'q', header: 'PICK', question: 'Which?',
    options: Array.from({ length: 8 }, (_, i) => ({ label: `opt${i}` })), createdTs: Date.now(),
  };
  const html = renderAsk(baseState(), ask, 7);
  // `qopt` not `qopts` — the latter is the container
  assert.equal((html.match(/class="qopt[ "]/g) || []).length, 3, 'three visible at a time');
  assert.match(html, /opt7/, 'the cursor is on screen');
  assert.match(html, /8 \/ 8/);
});

test('permission ask keeps allow / deny / skip with their hardware hints', () => {
  setQueueContext(0, 1);
  const ask = { kind: 'permission', id: 'p', sessionName: 'proj', tool: 'Bash', summary: 'ls', createdTs: Date.now() };
  const html = renderAsk(baseState(), ask, 0);
  assert.match(html, /ALLOW/);
  assert.match(html, /press dial/);
  assert.match(html, /DENY/);
  assert.match(html, /preset 4/);
  assert.match(html, /answers in terminal/);
});

test('usage shows each limit as a bar with its reset time', () => {
  const html = renderUsage(baseState({
    usage: {
      updatedLabel: 'updated 01:46 · from claude /usage',
      limits: [
        { key: 'session', label: 'SESSION', used: 0.11, detail: 'resets Jul 30 at 5:19am' },
        { key: 'week', label: 'WEEK · ALL MODELS', used: 0.21, detail: 'resets Aug 4 at 5pm' },
      ],
      windows: [{ window: 'Last 24h', requests: 579, sessions: 8, notes: ['95% subagent-heavy'] }],
    },
  }));
  assert.match(html, /SESSION/);
  assert.match(html, /11%/);
  assert.match(html, /resets Jul 30 at 5:19am/);
  assert.match(html, /width:11\.0%/);
  assert.match(html, /Last 24h · 579 requests · 8 sessions/);
  assert.match(html, /95% subagent-heavy/);
});

test('usage bar colour and mascot mood escalate with the fullest limit', () => {
  const at = (used) => renderUsage(baseState({ usage: { limits: [{ label: 'X', used, detail: '' }], windows: [] } }));
  assert.match(at(0.1), /ufill cool/);
  assert.match(at(0.1), /mood-calm/);
  assert.match(at(0.5), /mood-warm/);
  assert.match(at(0.7), /ufill warm/);
  assert.match(at(0.8), /mood-hot/);
  assert.match(at(0.95), /ufill hot/);
  assert.match(at(0.95), /mood-max/);
  assert.match(at(0.95), /AT THE LIMIT/);
});

test('usage says what is wrong instead of rendering empty bars', () => {
  assert.match(renderUsage(baseState({ usage: { limits: [], error: 'claude /usage failed' } })), /claude \/usage failed/);
  assert.match(renderUsage(baseState()), /READING USAGE/);
});

test('ambient shows a lamp per session and the working count', () => {
  const html = renderAmbient(baseState({
    sessions: [session({ state: 'busy' }), session({ id: 'b', state: 'idle' })],
    stats: { active: 1, attention: 2 },
  }));
  assert.equal((html.match(/class="lamp /g) || []).length, 2);
  assert.match(html, /1 WORKING/);
  assert.match(html, /2 NEED YOU/);
});

test('detail shows tokens, cache and state, and waits politely before loading', () => {
  const loading = renderDetail(baseState(), 'a');
  assert.match(loading, /LOADING/);

  const html = renderDetail(baseState({
    details: { a: {
      id: 'a', name: 'proj', state: 'busy', tokens: { in: 266_000, out: 54_000 },
      cacheRead: 16_500_000, cwd: '/tmp/proj', model: 'claude-fable-5',
      startedTs: Date.now() - 90 * 60_000, currentTool: 'Bash', lastMessage: 'working', permission: null,
    } },
  }), 'a');
  assert.match(html, /54k/);
  assert.match(html, /266k/);
  assert.match(html, /16\.5M/);
  assert.match(html, /cache read/);
  assert.match(html, /1h 30m/);
  assert.match(html, /fable-5/, 'model prefix trimmed');
});

test('the connection dot reflects the daemon link on every screen', () => {
  for (const render of [renderList, renderQueue]) {
    assert.match(render(baseState({ daemonConnected: true })), /class="conn ok"/);
    assert.match(render(baseState({ daemonConnected: false })), /class="conn"/);
  }
});

test('a timed-out permission says where the decision went', () => {
  setQueueContext(0, 1);
  const ask = {
    kind: 'permission', id: 'p', sessionName: 'proj', tool: 'Bash', summary: 'ls',
    createdTs: Date.now() - 600_000, expired: true, expiredTs: Date.now(),
  };
  const html = renderAsk(baseState(), ask, 0);
  assert.match(html, /HOOK TIMED OUT — ANSWER IN TERMINAL/);
  // Allow/deny would write to a hook response that is already closed.
  assert.doesNotMatch(html, /ALLOW/, 'no allow button once the hook has gone');
  assert.doesNotMatch(html, /DENY/, 'no deny button either');
  assert.match(html, /DISMISS/, 'the only thing left to do is clear it');
});

test('the queue marks an expired permission as living in the terminal', () => {
  const html = renderQueue(baseState({
    asks: [{
      kind: 'permission', id: 'p1', sessionName: 'proj', tool: 'Bash', summary: 'ls',
      createdTs: Date.now() - 600_000, expired: true, expiredTs: Date.now(),
    }],
  }));
  assert.match(html, /IN TERMINAL/);
});
