// The device screens are string builders, so they can be rendered and asserted
// on without a browser. These cover the formatting and the state→sprite mapping
// that the emulator screenshots can only show one case of at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { esc, fmtTokens, fmtDuration, stateLabel, modeLabel, effortLabel, isDestructive, watchTarget } from '../src/screens/helpers.js';
import { fmtClock, setTzOffset, setServerNow, now, resetClock } from '../src/clock.js';
import { renderList } from '../src/screens/session-list.js';
import { renderQueue } from '../src/screens/queue.js';
import { renderUsage } from '../src/screens/usage.js';
import { renderAmbient } from '../src/screens/ambient.js';
import { renderDetail } from '../src/screens/session-detail.js';
import { renderAsk, setQueueContext } from '../src/screens/ask.js';
import { renderBluetooth, btMenuActions, renderBtPairing } from '../src/screens/bluetooth.js';

function baseState(over = {}) {
  return {
    sessions: [], stats: { active: 0, attention: 0 }, details: {}, asks: [],
    usage: null, daemonConnected: true, selectedIndex: 0, queueIndex: 0,
    queueAnswering: false, queueChoice: 0,
    queueQIndex: 0, queueAnswers: [], queueReview: false, queueFromReview: false,
    btDevices: [], btDiscoverable: false, btIndex: 0, btMenu: null,
    btMenuIndex: 0, btBusy: null, btPairing: null, ...over,
  };
}
const btDevice = (over = {}) => ({
  address: 'AA:BB:CC:DD:EE:99', name: 'Dev iPhone', paired: true, connected: true, ...over,
});
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
  resetClock();
});

// The device has no RTC battery and never sees NTP, so its epoch is junk. Every
// timestamp it renders against — createdTs, startedTs — came from the Mac, so
// without this correction the wall clock is wrong and every duration with it.
test('the daemon epoch corrects a device clock that is hours off', () => {
  const deviceDrift = 3 * 60 * 60_000 + 47_000;        // device believes it is 3h47s ago
  setServerNow(Date.now() + deviceDrift);
  assert.ok(Math.abs(now() - (Date.now() + deviceDrift)) < 1000, 'now() runs on Mac time');

  // Rendered through a fixed offset the clock is then absolute, not relative to
  // whatever the device booted with.
  setTzOffset(240);
  const wall = new Date(Date.UTC(2026, 6, 31, 18, 5));
  assert.equal(fmtClock(wall), '2:05 PM');

  // Relay jitter must not walk the clock; a real correction still lands.
  const before = now();
  setServerNow(Date.now() + deviceDrift + 300);
  assert.ok(Math.abs(now() - before) < 1000, 'sub-second noise is ignored');
  setServerNow(Date.now());
  assert.ok(Math.abs(now() - Date.now()) < 1000, 'a real resync applies');

  resetClock();
  assert.ok(Math.abs(now() - Date.now()) < 1000, 'unsynced falls back to the device clock');
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

test('each tile says which permission mode its window is in', () => {
  const modes = {
    plan: 'PLAN', bypassPermissions: 'BYPASS', acceptEdits: 'EDITS',
    auto: 'AUTO', default: 'MANUAL',
  };
  for (const [mode, label] of Object.entries(modes)) {
    assert.equal(modeLabel(mode), label);
    const html = renderList(baseState({ sessions: [session({ permissionMode: mode })] }));
    assert.ok(html.includes('>' + label + '<'), `${mode} tile must read ${label}`);
    assert.ok(html.includes('m-' + label.toLowerCase()), `${mode} tile needs its own class`);
  }
});

test('an unreported or unrecognised mode draws no badge rather than a guess', () => {
  assert.equal(modeLabel(undefined), null);
  assert.equal(modeLabel('someFutureMode'), null);
  const html = renderList(baseState({ sessions: [session({ permissionMode: 'someFutureMode' })] }));
  assert.ok(!html.includes('class="mode'), 'no badge for a mode we cannot name');
  assert.ok(!html.includes('someFutureMode'), 'and nothing unvetted reaches the markup');
});

test('mode and permission badges share a tile without fighting for the corner', () => {
  const html = renderList(baseState({
    sessions: [session({ permissionMode: 'plan', pendingPermission: true })],
  }));
  assert.ok(html.indexOf('class="mode') < html.indexOf('class="badge"'),
    'the mode badge comes first so the CSS sibling rule spaces the alert');
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

// Questions are not rendered here any more — an ask can hold several of them
// plus a review step, and that walk lives in the queue hero (see the hero
// tests below). main.js sends any question route back to the queue.
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

test('ambient shows a lamp per session and reads as a desk clock', () => {
  const html = renderAmbient(baseState({
    sessions: [session({ state: 'busy' }), session({ id: 'b', state: 'idle' })],
    stats: { active: 1, attention: 2 },
    asks: [{ id: 'k1' }, { id: 'k2' }],
  }));
  assert.equal((html.match(/class="lamp /g) || []).length, 2);
  assert.match(html, /1 WORKING · 1 RESTING/);
  // blocked is counted from the queue, not the attention stat, and breathes
  assert.match(html, /class="ahead blocked">2 NEED YOU/);
  assert.match(html, /press dial to answer/);

  const calm = renderAmbient(baseState({
    sessions: [session({ state: 'busy' })], stats: { active: 1, attention: 0 },
  }));
  assert.match(calm, /class="ahead">NOTHING BLOCKED/);
  assert.match(calm, /press dial for sessions/);

  // the whole screen is the sprite's switch — a tap anywhere toggles him
  assert.match(html, /data-action="mascot-toggle"/);
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
  for (const render of [renderList, renderQueue, renderBluetooth]) {
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

test('the track label is drawn twice, the dark copy clipped inside the fill', () => {
  const html = renderList(baseState({
    sessions: [{ id: 'a', name: 'proj', state: 'busy', tokens: { in: 1, out: 2 }, context: 0.34 }],
  }));
  const light = html.match(/<span class="ctxtext"><span class="ctxword">CONTEXT<\/span><span class="ctxnum">34%<\/span><\/span>/g);
  assert.equal(light && light.length, 1, 'one light copy on the bare track');
  assert.match(html,
    /<span class="ctxfill" style="width:34\.0%"><span class="ctxtext dark"><span class="ctxword">CONTEXT<\/span><span class="ctxnum">34%<\/span><\/span><\/span>/,
    'dark copy lives inside the fill so its edge clips it');
  assert.match(html, /class="ctxtext">[\s\S]*class="ctxfill"/,
    'fill paints over the light copy, never under it');
  assert.doesNotMatch(html, /ctxrow/, 'no line above the track spent on a number');
});

test('the tile names its model, even on an ended session with no meter', () => {
  const live = renderList(baseState({
    sessions: [{ id: 'a', name: 'proj', state: 'busy', tokens: { in: 1, out: 2 },
      context: 0.34, model: 'claude-fable-5' }],
  }));
  assert.match(live, /<div class="tspec">fable-5<\/div>/, 'model prefix trimmed');

  const ended = renderList(baseState({
    sessions: [{ id: 'a', name: 'proj', state: 'idle', ended: true,
      tokens: { in: 1, out: 2 }, context: null, model: 'claude-fable-5' }],
  }));
  assert.match(ended, /<div class="tspec">fable-5<\/div>/, 'spec line survives the meter');
  assert.doesNotMatch(ended, /ctxtrack/);

  const unnamed = renderList(baseState({
    sessions: [{ id: 'a', name: 'proj', state: 'busy', tokens: { in: 1, out: 2 }, context: null }],
  }));
  assert.doesNotMatch(unnamed, /tspec/, 'no model named, no line drawn');
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

// --- effort mascot ----------------------------------------------------------

test('the working mascot runs at the session effort, named on the spec line', () => {
  const levels = {
    low: 'LOW', medium: 'MEDIUM', high: 'HIGH', xhigh: 'XHIGH', max: 'MAX',
    ultrathink: 'ULTRA',
  };
  for (const [effort, label] of Object.entries(levels)) {
    assert.equal(effortLabel(effort), label);
    const html = renderList(baseState({ sessions: [session({ effort })] }));
    assert.ok(html.includes(' e-' + label.toLowerCase()), `${effort} tile needs its gait class`);
    assert.ok(html.includes('class="tspec">' + label + '<'), `${effort} tile must read ${label}`);
  }
});

test('model and effort share one spec line, dot-separated', () => {
  const html = renderList(baseState({
    sessions: [session({ effort: 'max', model: 'claude-fable-5', context: 0.5 })],
  }));
  assert.match(html, /class="tspec">fable-5  ·  MAX</);
});

test('ultrathink is abbreviated — the full word broke the 14px type floor', () => {
  assert.equal(effortLabel('ultrathink'), 'ULTRA');
});

test('no reported effort means no label and the plain working sprite', () => {
  assert.equal(effortLabel(undefined), null);
  assert.equal(effortLabel('someFutureEffort'), null);
  const html = renderList(baseState({ sessions: [session({ effort: 'someFutureEffort' })] }));
  assert.ok(!html.includes('class="tspec"'), 'no label for an effort we cannot name');
  assert.ok(!html.includes('someFutureEffort'), 'and nothing unvetted reaches the markup');
  assert.ok(!html.includes(' e-'), 'no gait class either — working.svg stands');
});

test('only a working tile runs: effort on an idle session draws nothing', () => {
  const html = renderList(baseState({ sessions: [session({ state: 'idle', effort: 'max' })] }));
  assert.ok(!html.includes('MAX'));
  assert.ok(!html.includes(' e-max'));
});

// --- questions answered inside the queue hero --------------------------------

const questionAsk = (over = {}) => ({
  kind: 'question', id: 'q1', sessionName: 'proj', question: 'Which?',
  options: [
    { label: 'One', description: 'first' },
    { label: 'Two' },
    { label: 'Three', description: 'third' },
    { label: 'Four' },
  ],
  createdTs: Date.now(),
  ...over,
});

test('an answering hero shows every option in place, one selected', () => {
  const html = renderQueue(baseState({
    asks: [questionAsk()], queueAnswering: true, queueChoice: 2,
  }));
  assert.match(html, /qhero question answering/, 'the hero funds the list by shrinking');
  assert.equal((html.match(/data-action="queue-choice"/g) || []).length, 4,
    'all options at once — no 3-wide window, no paging');
  assert.equal((html.match(/qopt selected/g) || []).length, 1);
  assert.ok(html.indexOf('Three') > 0 && /qopt selected"[^>]*data-id="2"/.test(html),
    'the selection is where the cursor is');
  assert.doesNotMatch(html, /qchip/, 'the action chip gave way to the list');
});

test('the selected option expands: label stacks over description, both in full', () => {
  const html = renderQueue(baseState({
    asks: [questionAsk()], queueAnswering: true, queueChoice: 0,
  }));
  // Only the row under the cursor gets the stacked qtext wrapper; the CSS
  // wraps its text instead of clipping it.
  assert.equal((html.match(/class="qtext"/g) || []).length, 1,
    'exactly one row is expanded');
  assert.match(html, /qopt selected"[^>]*data-id="0"[^>]*>.*?class="qtext"/,
    'and it is the selected one');
  const collapsed = /qopt" data-action="queue-choice" data-id="1"><span class="qnum">2<\/span><span class="qlabel">/;
  assert.match(html, collapsed, 'unselected rows keep the flat one-line shape');
});

test('while the list is open the stack hides but the queue context survives', () => {
  const html = renderQueue(baseState({
    asks: [questionAsk(), questionAsk({ id: 'q2' }), questionAsk({ id: 'q3' })],
    queueAnswering: true,
  }));
  assert.doesNotMatch(html, /class="qrow/, 'stack rows give the list their room');
  assert.match(html, /2 more waiting/);
  assert.match(html, /dial moves · press answers · back closes/);
});

test('answering state only applies to a live question hero', () => {
  const perm = renderQueue(baseState({
    asks: [{ kind: 'permission', id: 'p1', sessionName: 'proj', tool: 'Bash', summary: 'ls', createdTs: Date.now() }],
    queueAnswering: true,
  }));
  assert.doesNotMatch(perm, /answering/, 'a permission has no list to open');
  assert.match(perm, /ALLOW/);
});

// A timed-out question is not a spent one: the dialog is still up in the
// terminal and the daemon can still type into it. So the card says where it
// went and stays answerable, unlike a timed-out permission whose hook response
// is gone.
test('a timed-out question keeps its options and says it is still in the terminal', () => {
  const idle = renderQueue(baseState({
    asks: [questionAsk({ expired: true, expiredTs: Date.now() })],
  }));
  assert.match(idle, /STILL OPEN IN TERMINAL/);
  assert.match(idle, /qchip answer/, 'and it can still be opened');

  const open = renderQueue(baseState({
    asks: [questionAsk({ expired: true, expiredTs: Date.now() })],
    queueAnswering: true,
  }));
  assert.match(open, /qopts/, 'the list opens on a timed-out question too');
});

// One AskUserQuestion call is one dialog and one card, however many questions
// it holds. The card walks them, then shows a review step whose SUBMIT is what
// finally sends — which is the only way the dialog's own "Submit answers" step
// ever gets pressed, and the only way an earlier answer stays changeable.
const groupAsk = (over = {}) => ({
  kind: 'question', id: 'g1', sessionName: 'proj', createdTs: Date.now(),
  questions: [
    { header: 'AUTH', question: 'How should callers authenticate?', multiSelect: false,
      options: [{ label: 'OAuth' }, { label: 'API keys' }] },
    { header: 'ENVS', question: 'Which environments?', multiSelect: true,
      options: [{ label: 'Dev' }, { label: 'Staging' }, { label: 'Production' }] },
    { header: 'ROLLOUT', question: 'How fast?', multiSelect: false,
      options: [{ label: 'All at once' }, { label: 'Canary' }] },
  ],
  header: 'AUTH', question: 'How should callers authenticate?', options: [{ label: 'OAuth' }, { label: 'API keys' }],
  ...over,
});

test('a group card says how many questions it holds before it is opened', () => {
  const html = renderQueue(baseState({ asks: [groupAsk()] }));
  assert.match(html, /QUESTION · 3 PARTS/);
  assert.match(html, /3 questions · press dial/);
});

test('an opened group shows which question it is on, and only that one', () => {
  const html = renderQueue(baseState({
    asks: [groupAsk()], queueAnswering: true, queueQIndex: 1, queueAnswers: [[0], [], []],
  }));
  assert.match(html, /QUESTION · 2 OF 3/);
  assert.match(html, /Which environments\?/, 'the summary follows the walk');
  assert.doesNotMatch(html, /OAuth/, 'the answered question is not still on screen');
  assert.match(html, /Staging/);
});

test('a multiSelect question shows its picks and a DONE row to move on', () => {
  const html = renderQueue(baseState({
    asks: [groupAsk()], queueAnswering: true, queueQIndex: 1,
    queueAnswers: [[0], [0, 2], []], queueChoice: 0,
  }));
  assert.match(html, /qopt selected picked"[^>]*data-id="0"/, 'a picked row says so');
  assert.match(html, /qnum on">✓/, 'the number is a tick once it is picked');
  assert.match(html, /qopt qstep next[^>]*data-id="3"/, 'DONE sits after the three options');
  assert.match(html, /2 selected · preset 4/);
  // A press on an option only toggles it, so both the row and the hint have to
  // name what actually moves the walk on.
  assert.match(html, /press picks · preset 4 when done/);
});

test('a single-select question has no DONE row — its press is the commit', () => {
  const html = renderQueue(baseState({
    asks: [groupAsk()], queueAnswering: true, queueQIndex: 0, queueAnswers: [[], [], []],
  }));
  assert.doesNotMatch(html, /qstep/);
  assert.match(html, /press answers/);
});

test('the review step lists every answer and offers SUBMIT', () => {
  const html = renderQueue(baseState({
    asks: [groupAsk()], queueAnswering: true, queueReview: true, queueChoice: 3,
    queueAnswers: [[1], [0, 2], [1]],
  }));
  assert.match(html, /QUESTION · REVIEW/);
  assert.match(html, /AUTH/);
  assert.match(html, /API keys/);
  assert.match(html, /Dev · Production/, 'a multiSelect answer reads as all of its picks');
  assert.match(html, /Canary/);
  assert.equal((html.match(/data-action="queue-review"/g) || []).length, 4,
    'three questions to go back into, plus SUBMIT');
  assert.match(html, /qstep submit selected/, 'the cursor is on SUBMIT');
  assert.match(html, /sends all 3 answers/);
});

// Two different things, and the review step must not conflate them: a
// multiSelect with nothing ticked is an answer, an untouched single-select is
// a gap.
test('review tells "none" apart from not-answered-yet', () => {
  const html = renderQueue(baseState({
    asks: [groupAsk()], queueAnswering: true, queueReview: true,
    queueAnswers: [[], [], [1]],
  }));
  assert.match(html, /AUTH<\/span><span class="qdesc">—<\/span>/, 'single-select: a gap');
  assert.match(html, /ENVS<\/span><span class="qdesc">none<\/span>/, 'multiSelect: an answer');
});

test('a lone question renders exactly as it did — no part count, no review', () => {
  const html = renderQueue(baseState({ asks: [questionAsk()] }));
  assert.match(html, /class="qkind">QUESTION</, 'no "N PARTS" for a single question');
  assert.match(html, /4 options · press dial/);
});

test('a question hero opens its list on tap; stack rows promote to hero', () => {
  const html = renderQueue(baseState({
    asks: [questionAsk(), questionAsk({ id: 'q2' })],
  }));
  assert.match(html, /qhero question[^>]*data-action="queue-answer"/,
    'the hero tap opens options in place, not the prompt screen');
  assert.match(html, /class="qrow question"[^>]*data-action="queue-promote"/,
    'a stack tap promotes rather than opening the prompt');
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

// --- bluetooth --------------------------------------------------------------

test('empty bluetooth list points at pairing mode instead of a blank screen', () => {
  const html = renderBluetooth(baseState());
  assert.match(html, /NO PAIRED DEVICES/);
  assert.match(html, /enter pairing mode to add your phone/);
  assert.match(html, /PAIRING MODE/);
});

test('exactly one bluetooth row is selected, toggle row included', () => {
  const devices = [btDevice(), btDevice({ address: 'AA:BB:CC:DD:EE:98', connected: false })];
  const onToggle = renderBluetooth(baseState({ btDevices: devices, btIndex: 0 }));
  assert.equal((onToggle.match(/btrow[^"]* selected/g) || []).length, 1);
  assert.match(onToggle, /bttoggle selected/);

  const onDevice = renderBluetooth(baseState({ btDevices: devices, btIndex: 2 }));
  assert.equal((onDevice.match(/btrow[^"]* selected/g) || []).length, 1);
  assert.doesNotMatch(onDevice, /bttoggle selected/);
});

test('a long device list windows around the cursor and shows position', () => {
  const many = Array.from({ length: 8 }, (_, i) =>
    btDevice({ address: `AA:BB:CC:DD:EE:0${i}`, name: `phone${i}`, connected: false }));
  const html = renderBluetooth(baseState({ btDevices: many, btIndex: 8 }));
  assert.equal((html.match(/data-action="bt-device"/g) || []).length, 4, 'four visible at a time');
  assert.match(html, /phone7/, 'the cursor is on screen');
  assert.match(html, /8 \/ 8/);
});

test('device status reads CONNECTED, PAIRED, or WORKING while busy', () => {
  const devices = [btDevice(), btDevice({ address: 'AA:BB:CC:DD:EE:98', connected: false })];
  const html = renderBluetooth(baseState({ btDevices: devices }));
  assert.match(html, /CONNECTED/);
  assert.match(html, /PAIRED/);

  const busy = renderBluetooth(baseState({ btDevices: devices, btBusy: 'AA:BB:CC:DD:EE:99' }));
  assert.match(busy, /WORKING…/);
});

test('the pairing-mode pill follows discoverable state', () => {
  assert.match(renderBluetooth(baseState()), /btpill">OFF/);
  assert.match(renderBluetooth(baseState({ btDiscoverable: true })), /btpill on">DISCOVERABLE/);
});

test('the action menu leads with the state change and never hides forget', () => {
  assert.deepEqual(btMenuActions(btDevice()), ['DISCONNECT', 'FORGET', 'CANCEL']);
  assert.deepEqual(btMenuActions(btDevice({ connected: false })), ['CONNECT', 'FORGET', 'CANCEL']);
});

test('the submenu names its device and selects one action', () => {
  const html = renderBluetooth(baseState({
    btDevices: [btDevice()], btMenu: 'AA:BB:CC:DD:EE:99', btMenuIndex: 1,
  }));
  assert.match(html, /btmenutitle">Dev iPhone/);
  assert.equal((html.match(/btact selected|btact[^"]* selected/g) || []).length, 1);
  assert.match(html, /DISCONNECT/);
  assert.match(html, /FORGET/);
});

test('a submenu for a vanished device renders nothing rather than crashing', () => {
  const html = renderBluetooth(baseState({ btDevices: [btDevice()], btMenu: 'not-there' }));
  assert.doesNotMatch(html, /btmenuwrap/);
});

test('the pairing overlay shows the code and escapes a hostile device name', () => {
  const html = renderBtPairing({ address: 'X', name: '<img src=x>', pin: '424242' });
  assert.match(html, /PAIRING REQUEST/);
  assert.match(html, /424242/);
  assert.match(html, /auto-accepting/);
  assert.ok(!html.includes('<img'), 'device name must be escaped');
});

// --- 2.0 hardware: intent, destructive arming, dismissal ---------------------

const permAsk = (over = {}) => ({
  kind: 'permission', id: 'p1', sessionName: 'proj', tool: 'Bash',
  summary: 'npm test', createdTs: Date.now(), ...over,
});

test('the hero says what you asked for, and the layout pays for the line', () => {
  const html = renderQueue(baseState({
    asks: [
      permAsk({ intent: 'you asked: reinstall the deps' }),
      permAsk({ id: 'p2' }), permAsk({ id: 'p3' }),
    ],
  }));
  assert.match(html, /qhero[^"]*has-intent/, 'name and chips step down under an intent');
  assert.match(html, /class="qintent">you asked: reinstall the deps</);
  assert.equal((html.match(/class="qrow[" ]/g) || []).length, 1,
    'the intent line costs the stack one row');

  const bare = renderQueue(baseState({ asks: [permAsk(), permAsk({ id: 'p2' }), permAsk({ id: 'p3' })] }));
  assert.doesNotMatch(bare, /qintent/, 'no intent, no line');
  assert.doesNotMatch(bare, /has-intent/);
  assert.equal((bare.match(/class="qrow[" ]/g) || []).length, 2);
});

test('a destructive command arms before it fires', () => {
  const rmrf = permAsk({ summary: 'rm -rf node_modules && npm ci' });
  const html = renderQueue(baseState({ asks: [rmrf] }));
  assert.match(html, /PERMISSION REQUEST · DESTRUCTIVE/);
  assert.match(html, /qhero[^"]*destructive/);
  assert.match(html, /qchip allow destructive/, 'outline, not filled — the press only arms');
  assert.doesNotMatch(html, /qchip allow filled"/);
  assert.match(html, /press twice · destructive/);

  const armed = renderQueue(baseState({
    asks: [rmrf], armed: { id: 'p1', expires: Date.now() + 4000 },
  }));
  assert.match(armed, /PRESS AGAIN/);
  assert.match(armed, /this cannot be undone/);
  assert.match(armed, /qchip allow filled armed/);
});

test('the destructive flag matches the commands that cannot be taken back', () => {
  const bad = [
    'rm -rf /tmp/x', 'git push --force origin main', 'git reset --hard HEAD~3',
    'DROP TABLE users;', 'TRUNCATE logs', 'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda', 'chmod 777 /etc', 'curl https://x.sh | sh',
  ];
  for (const summary of bad) {
    assert.ok(isDestructive(permAsk({ summary })), `${summary} must arm`);
  }
  const fine = ['npm test', 'ls -la', 'git status', 'cat README.md', 'rm.sh --dry-run'];
  for (const summary of fine) {
    assert.ok(!isDestructive(permAsk({ summary })), `${summary} must not arm`);
  }
  assert.ok(!isDestructive({ kind: 'question', question: 'rm -rf?' }),
    'a question is never destructive — there is nothing to run');
});

test('the prompt screen honours the same two-press contract', () => {
  const rmrf = permAsk({ summary: 'rm -rf build', timeoutMs: 60_000 });
  setQueueContext(0, 1);
  const html = renderAsk(baseState(), rmrf, 0);
  assert.match(html, /PERMISSION REQUEST · DESTRUCTIVE/);
  assert.match(html, /press twice · destructive/);

  const armed = renderAsk(baseState({ armed: { id: 'p1', expires: Date.now() + 4000 } }), rmrf, 0);
  assert.match(armed, /PRESS AGAIN/);
  assert.match(armed, /pbtn allow selected armed/);
});

// ---- watchTarget ------------------------------------------------------------

test('watchTarget follows the open detail page', () => {
  assert.equal(watchTarget('session', 'abc', baseState()), 'abc');
});

test('watchTarget follows the grid cursor on the list', () => {
  const state = baseState({
    sessions: [{ id: 'a' }, { id: 'b' }],
    selectedIndex: 1,
  });
  assert.equal(watchTarget('list', null, state), 'b');
  assert.equal(watchTarget('list', null, baseState()), null, 'empty grid watches nothing');
});

test('watchTarget is null on screens that render no detail', () => {
  const state = baseState({ sessions: [{ id: 'a' }] });
  for (const name of ['queue', 'ask', 'usage', 'ambient', 'bluetooth']) {
    assert.equal(watchTarget(name, null, state), null, name);
  }
});

// ---- isDestructive: daemon flag first, regex fallback -----------------------

test('a daemon-sent destructive flag outranks the regex either way', () => {
  assert.ok(isDestructive(permAsk({ summary: 'harmless-looking', destructive: true })),
    'flag true arms, whatever the summary says');
  assert.ok(!isDestructive(permAsk({ summary: 'rm -rf /', destructive: false })),
    'flag false disarms even a scary summary — the daemon saw the whole command');
});

test('no flag falls back to the regex over the summary', () => {
  assert.ok(isDestructive(permAsk({ summary: 'git reset --hard HEAD~1' })));
  assert.ok(!isDestructive(permAsk({ summary: 'git status' })));
});
