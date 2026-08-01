// The device screens are string builders, so they can be rendered and asserted
// on without a browser. These cover the formatting and the state→sprite mapping
// that the emulator screenshots can only show one case of at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { esc, fmtTokens, fmtDuration, fmtClock, setTzOffset, stateLabel } from '../src/screens/helpers.js';
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

test('clock renders daemon-local time from the snapshot offset, UTC-clock proof', () => {
  const t = new Date(Date.UTC(2026, 6, 31, 18, 5));   // 18:05 UTC
  setTzOffset(240);                                    // EDT: UTC-4
  assert.equal(fmtClock(t), '2:05 PM');
  setTzOffset(-330);                                   // IST: UTC+5:30
  assert.equal(fmtClock(t), '11:35 PM');
  setTzOffset(undefined);                              // old daemon: fall back to local
  const local = new Date(2026, 6, 31, 9, 7);
  assert.equal(fmtClock(local), '9:07 AM');
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

test('no scroll rail — the next column peeking past the bezel is the affordance', () => {
  const many = renderList(baseState({ sessions: Array.from({ length: 12 }, (_, i) => session({ id: `s${i}` })) }));
  assert.doesNotMatch(many, /grail|gthumb/, 'no rail eating vertical space');
  // Every session is in the track, so the column after the visible two is laid
  // out just off the right edge and shows as a sliver.
  assert.equal((many.match(/data-action="open"/g) || []).length, 12);
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
  // Hero + stack, not a list of equals: the first owns the page and carries
  // its own actions, the rest preview underneath.
  assert.match(html, /PERMISSION REQUEST/, 'the hero names its kind in full');
  assert.match(html, /class="qhero/);
  assert.match(html, /qrow question/, 'the stacked question keeps its own accent');
  assert.match(html, /ALLOW/, 'a permission is answerable from the queue itself');
  assert.match(html, /DENY/);
  assert.doesNotMatch(html, /left/, 'no countdown — a deadline you can lose is worse than none');
  assert.match(html, /waiting \d+s/, 'asks show how long they have waited');
  assert.match(html, /2 waiting on you/);
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
  assert.match(html, /dial answers/);
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
  assert.match(html, /SKIP/);
});

test('usage shows each limit as a bar with its reset time', () => {
  const html = renderUsage(baseState({
    usage: {
      updatedLabel: 'updated 01:46 · from claude /usage',
      limits: [
        { key: 'session', label: 'SESSION', used: 0.11, detail: 'resets Jul 30 at 5:19am' },
        { key: 'week', label: 'WEEK · ALL MODELS', used: 0.21, detail: 'resets Aug 4 at 5pm' },
      ],
      windows: [{
        window: 'Last 24h', requests: 579, sessions: 8, notes: ['95% subagent-heavy'],
        skills: [{ name: '/deploy-to-dev', pct: '1%' }],
        subagents: [{ name: 'Explore', pct: '7%' }],
      }],
    },
  }));
  assert.match(html, /SESSION/);
  assert.match(html, /11%/);
  assert.match(html, /resets Jul 30 at 5:19am/);
  assert.match(html, /width:11\.0%/);
  assert.match(html, /Last 24h · 579 requests · 8 sessions/);
  assert.match(html, /SKILLS/);
  assert.match(html, /\/deploy-to-dev/);
  assert.match(html, /SUBAGENTS/);
  assert.match(html, /Explore/);
});

test('each bar carries its own mood, so one full limit does not condemn the rest', () => {
  const at = (used) => renderUsage(baseState({ usage: { limits: [{ label: 'X', used, detail: '' }], windows: [] } }));
  // Under 80% clear, 80-99% sweating, 100% fainted — fill and sprite always agree.
  assert.match(at(0.1), /ufill mood-clear/);
  assert.match(at(0.1), /usprite mood-clear/);
  assert.match(at(0.5), /ALL CLEAR/);
  assert.match(at(0.85), /ufill mood-low/);
  assert.match(at(0.85), /RUNNING OUT/);
  assert.match(at(1), /ufill mood-out/);
  assert.match(at(1), /OUT OF USAGE/);

  const mixed = renderUsage(baseState({
    usage: { limits: [{ label: 'A', used: 1, detail: '' }, { label: 'B', used: 0.1, detail: '' }], windows: [] },
  }));
  assert.match(mixed, /mood-out/);
  assert.match(mixed, /mood-clear/, 'a maxed weekly limit says nothing about the session limit');
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

// --- v2 redesign ------------------------------------------------------------

test('a tile shows its context meter, neutral until it is nearly full', () => {
  const calm = renderList(baseState({
    sessions: [{ id: 'a', name: 'proj', state: 'busy', tokens: { in: 1, out: 2 }, context: 0.34 }],
  }));
  assert.match(calm, /34%/);
  assert.match(calm, /class="ctx"/, 'a filling window is normal, not an alarm');
  assert.match(calm, /width:34\.0%/);

  const hot = renderList(baseState({
    sessions: [{ id: 'a', name: 'proj', state: 'busy', tokens: { in: 1, out: 2 }, context: 0.88 }],
  }));
  assert.match(hot, /class="ctx hot"/, 'red only once it is close to compacting');
});

test('no context reading means no meter, never a meter against a guess', () => {
  const html = renderList(baseState({
    sessions: [{ id: 'a', name: 'proj', state: 'busy', tokens: { in: 1, out: 2 }, context: null }],
  }));
  assert.doesNotMatch(html, /ctxtrack/);
});

test('the top bar counts what it is listing', () => {
  const html = renderList(baseState({
    sessions: [
      { id: 'a', name: 'one', state: 'busy', tokens: { in: 1, out: 2 } },
      { id: 'b', name: 'two', state: 'idle', tokens: { in: 1, out: 2 } },
    ],
  }));
  assert.match(html, /class="tcount">2</);
});

test('the queue hero offers a question its options rather than allow/deny', () => {
  const html = renderQueue(baseState({
    asks: [{
      kind: 'question', id: 'q1', sessionName: 'proj', question: 'Which?',
      options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], createdTs: Date.now(),
    }],
  }));
  assert.match(html, /ANSWER/);
  assert.match(html, /3 options · press dial/);
  assert.doesNotMatch(html, /ALLOW/, 'a question cannot be answered by allow/deny');
});

test('an expired hero drops its actions and says where the decision went', () => {
  const html = renderQueue(baseState({
    asks: [{
      kind: 'permission', id: 'p1', sessionName: 'proj', tool: 'Bash', summary: 'ls',
      createdTs: Date.now() - 600_000, expired: true, expiredTs: Date.now(),
    }],
  }));
  assert.match(html, /HOOK TIMED OUT — ANSWER IN TERMINAL/);
  assert.doesNotMatch(html, /qchip/, 'nothing left to press once the hook is gone');
});

test('the empty queue is a state, not a blank screen', () => {
  const html = renderQueue(baseState());
  assert.match(html, /NOTHING WAITING ON YOU/);
  assert.match(html, /permissions and questions land here/);
  assert.match(html, /qemptysprite/);
});

test('the prompt keeps its countdown — here you act against a live deadline', () => {
  setQueueContext(0, 1);
  const ask = {
    kind: 'permission', id: 'p', sessionName: 'proj', tool: 'Bash', summary: 'ls',
    createdTs: Date.now(), timeoutMs: 600_000,
  };
  const html = renderAsk(baseState(), ask, 0);
  assert.match(html, /cdtrack/);
  assert.match(html, /left/);
});

test('a countdown with no deadline left to run is not drawn', () => {
  setQueueContext(0, 1);
  const ask = {
    kind: 'permission', id: 'p', sessionName: 'proj', tool: 'Bash', summary: 'ls',
    createdTs: Date.now(), timeoutMs: 600_000, expired: true,
  };
  assert.doesNotMatch(renderAsk(baseState(), ask, 0), /cdtrack/);
});
