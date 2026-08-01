// A background job outlives the terminal that started it — it is parented by
// `claude daemon run`, not the tty — so closing every window on the machine
// leaves it running, registered and listed. Nothing retired it: the pid is
// alive and the registry keeps vouching for it, so the grid held an idle tile
// for a job with no window to return to until the user killed it by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseForkLinks, parseForkParents, listedIds, createReconciler } from '../src/sessions/source-poller.js';
import { createStore } from '../src/sessions/store.js';
import { BUSY_WINDOW_MS, CELEBRATE_MS } from '../src/config.js';

const CWD = '/Users/nobody/Projects/demo';
const NONE = new Set();
const JOB = '47d8e0a3-19d0-4cb5-9b54-8a5a81a4d513';
const WINDOW = '0468c90f-56c1-40e4-98df-25238da608f5';
const FORK_CMD = `/Users/nobody/.local/share/claude/versions/2.1.220 --session-id ${JOB} --fork-session --resume /Users/nobody/.claude/projects/-Users-nobody-demo/${WINDOW}.jsonl --reply-on-resume --permission-mode auto`;

// kind "background" sidesteps the viewport transcript check.
function job(extra = {}) {
  return { id: 'f036b86d', sessionId: JOB, cwd: CWD, kind: 'background', ...extra };
}
function windowEntry() {
  return { sessionId: WINDOW, cwd: CWD, kind: 'interactive' };
}

function setup() {
  const store = createStore();
  const { reconcile } = createReconciler({ store });
  const links = parseForkLinks(FORK_CMD);
  return { store, reconcile, links };
}

// --- the link ------------------------------------------------------------------

test('a forked job names its own session and its window on one command line', () => {
  const links = parseForkLinks(`claude\n${FORK_CMD}\nnode index.js\n`);
  assert.equal(links.get(JOB), WINDOW);
  assert.equal(links.size, 1);
});

test('a plain resume is not a fork and links nothing', () => {
  assert.equal(parseForkLinks(FORK_CMD.replace(' --fork-session', '')).size, 0);
  assert.equal(parseForkLinks('').size, 0);
  assert.equal(parseForkLinks(null).size, 0);
});

test('a fork with no --session-id still yields its parent, under no real id', () => {
  // The parent set must stay complete however the child identifies itself, or
  // the window it forked from comes back as a duplicate tile.
  const links = parseForkLinks(FORK_CMD.replace(` --session-id ${JOB}`, ''));
  assert.deepEqual([...links.values()], [WINDOW]);
  assert.equal(links.has(JOB), false, 'and never under a session id it did not print');
});

test('parseForkParents still reports exactly the parents', () => {
  assert.deepEqual([...parseForkParents(FORK_CMD)], [WINDOW]);
});

test('every id a listing carries counts as alive', () => {
  const ids = listedIds([job(), windowEntry()]);
  assert.equal(ids.has(WINDOW), true, 'the window, by session id');
  assert.equal(ids.has(JOB), true, 'the job, by session id');
  assert.equal(ids.has('f036b86d'), true, 'and by its short job id');
  assert.equal(listedIds(null).size, 0);
});

// --- retiring the orphan -------------------------------------------------------

test('a job whose window is gone and which is idle leaves the grid', () => {
  const { store, reconcile, links } = setup();
  reconcile([job(), windowEntry()], NONE, new Map(), links);
  assert.ok(store.raw(JOB), 'while the window is listed the job is a session');

  // The window is closed some time after the job last did anything, which is
  // the shape of the report: everything quiet, one tile left over.
  store.upsert(JOB, { lastActivityTs: Date.now() - BUSY_WINDOW_MS - 1 });
  reconcile([job()], NONE, new Map(), links);
  assert.equal(store.raw(JOB), undefined, 'the window is gone, so is the tile');
});

test('an orphan is retired the first poll, without the missed-poll grace', () => {
  // Absence earns hysteresis because a listing can be read mid-write. This is
  // not absence: the job is right there in the listing saying its window is not.
  const { store, reconcile, links } = setup();
  reconcile([job()], NONE, new Map(), links);
  assert.equal(store.count(), 0, 'no tile is created for it in the first place');
});

test('a working orphan keeps its tile — the device is the only place left to watch it', () => {
  const { store, reconcile, links } = setup();
  reconcile([job({ status: 'busy' })], NONE, new Map(), links);
  assert.ok(store.raw(JOB), 'still working');
  assert.equal(store.get(JOB).state, 'busy');
});

test('a working orphan leaves once it goes quiet', () => {
  const { store, reconcile, links } = setup();
  reconcile([job({ status: 'busy' })], NONE, new Map(), links);
  // The turn ends: no more busy verdict, and the activity stamp ages out.
  store.upsert(JOB, { lastActivityTs: Date.now() - BUSY_WINDOW_MS - 1, agentActiveTs: 0, agentActive: false });
  reconcile([job({ status: 'idle' })], NONE, new Map(), links);
  assert.equal(store.raw(JOB), undefined);
});

test('an orphan blocked on a permission ask is not swept away', () => {
  const { store, reconcile, links } = setup();
  reconcile([job({ status: 'busy' })], NONE, new Map(), links);
  store.upsert(JOB, { lastActivityTs: 0, agentActive: false, pendingPermission: true });
  reconcile([job({ status: 'idle' })], NONE, new Map(), links);
  assert.ok(store.raw(JOB), 'someone still has to answer it');
  assert.equal(store.get(JOB).state, 'attention');
});

test('an orphan gets its DONE minute before it goes', () => {
  const { store, reconcile, links } = setup();
  reconcile([job({ status: 'busy' })], NONE, new Map(), links);
  store.upsert(JOB, { lastActivityTs: 0, agentActive: false, stoppedTs: Date.now() });
  reconcile([job({ status: 'idle' })], NONE, new Map(), links);
  assert.equal(store.get(JOB).state, 'celebrate', 'the finish is still worth showing');

  store.upsert(JOB, { stoppedTs: Date.now() - CELEBRATE_MS - 1 });
  reconcile([job({ status: 'idle' })], NONE, new Map(), links);
  assert.equal(store.raw(JOB), undefined, 'and then it is a receipt, not a session');
});

// --- what must not be swept ----------------------------------------------------

test('a job whose window is merely parked stays — parked is alive', () => {
  // The window is suppressed as a duplicate tile a few lines later in the same
  // reconcile, so reading "kept this poll" as "alive" would orphan every job the
  // moment it took over a turn. The raw listing is the authority.
  const { store, reconcile, links } = setup();
  reconcile([job(), windowEntry()], NONE, new Map([[WINDOW, 'f036b86d']]), links);
  assert.ok(store.raw(JOB), 'the job is the session');
  assert.equal(store.raw(WINDOW), undefined, 'the window is the duplicate');
});

test('a job nobody forked is never an orphan', () => {
  const { store, reconcile } = setup();
  reconcile([job()], NONE, new Map(), new Map());
  assert.ok(store.raw(JOB), 'no link, no claim about a window');
});

test('a ps that failed strands nothing', () => {
  const { store, reconcile } = setup();
  reconcile([job()], NONE, new Map(), parseForkLinks(''));
  assert.ok(store.raw(JOB));
});

test('an ordinary window is untouched by any of this', () => {
  const { store, reconcile, links } = setup();
  reconcile([{ ...windowEntry(), kind: 'background' }], NONE, new Map(), links);
  assert.ok(store.raw(WINDOW), 'the window is not the forked job');
});

test('a daemon restart never adopts an orphan it has no record of', () => {
  const { store, reconcile, links } = setup();
  reconcile([job({ status: 'idle', startedAt: Date.now() })], NONE, new Map(), links);
  assert.equal(store.count(), 0, 'an empty store must not read as "not working"');
});
