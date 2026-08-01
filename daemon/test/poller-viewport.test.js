// A terminal driving a background job registers as its own "interactive" agent
// with no transcript. It is a viewport onto the job, not a second session, and
// must not become a second tile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isViewport } from '../src/sessions/source-poller.js';
import { transcriptPathFor } from '../src/sessions/tails.js';

const CWD = '/Users/nobody/Projects/demo';

test('an interactive session with no transcript is a viewport', () => {
  assert.equal(isViewport({ kind: 'interactive' }, 'no-such-session-id', CWD), true);
});

test('a background job is never a viewport, transcript or not', () => {
  assert.equal(isViewport({ kind: 'background' }, 'no-such-session-id', CWD), false);
});

test('an interactive session that owns a transcript is a real session', () => {
  const id = `viewport-test-${process.pid}`;
  const file = transcriptPathFor(id, CWD);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"type":"user"}\n');
  try {
    assert.equal(isViewport({ kind: 'interactive' }, id, CWD), false);
  } finally {
    fs.unlinkSync(file);
  }
});

test('a session with no cwd cannot be resolved and is treated as a viewport', () => {
  assert.equal(isViewport({ kind: 'interactive' }, 'some-id', ''), true);
});

// --- forked background jobs ---------------------------------------------------

import { parseForkParents } from '../src/sessions/source-poller.js';

const FORK_CMD = '/Users/nobody/.local/share/claude/versions/2.1.220 --session-id 47d8e0a3-19d0-4cb5-9b54-8a5a81a4d513 --fork-session --resume /Users/nobody/.claude/projects/-Users-nobody-demo/0468c90f-56c1-40e4-98df-25238da608f5.jsonl --reply-on-resume --permission-mode auto';

test('the window a background job forked from is named on the job command line', () => {
  const parents = parseForkParents(`claude\n${FORK_CMD}\nnode index.js\n`);
  assert.deepEqual([...parents], ['0468c90f-56c1-40e4-98df-25238da608f5']);
});

test('a plain resume is not a fork and strands no parent', () => {
  const resumed = FORK_CMD.replace(' --fork-session', '');
  assert.equal(parseForkParents(resumed).size, 0);
});

test('no processes at all yields no parents rather than throwing', () => {
  assert.equal(parseForkParents('').size, 0);
  assert.equal(parseForkParents(null).size, 0);
});

// --- parked windows -----------------------------------------------------------
//
// The registry knows a window has handed its turn away before ps can: the job's
// process does not exist yet, but `parkedJobId` is already written.

import { readParkedWindows, liveJobIds, createReconciler } from '../src/sessions/source-poller.js';
import { createStore } from '../src/sessions/store.js';

function registryDir(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-'));
  records.forEach((rec, i) => fs.writeFileSync(path.join(dir, `${1000 + i}.json`), JSON.stringify(rec)));
  return dir;
}

test('a parked window is read out of the session registry', () => {
  const dir = registryDir([
    { pid: 1, sessionId: 'window', kind: 'interactive', parkedJobId: '73953827' },
    { pid: 2, sessionId: 'plain-window', kind: 'interactive' },
    { pid: 3, sessionId: '73953827-2ff7-4eb1', kind: 'bg', jobId: '73953827' },
  ]);
  try {
    const parked = readParkedWindows(dir);
    assert.equal(parked.get('window'), '73953827');
    assert.equal(parked.has('plain-window'), false, 'an unparked window is not listed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable or absent registry is empty, not an exception', () => {
  assert.equal(readParkedWindows('/no/such/registry').size, 0);
});

test('a job is live while the listing carries its short id', () => {
  const ids = liveJobIds([
    { kind: 'interactive', sessionId: 'window' },
    { kind: 'background', id: '73953827', sessionId: '73953827-2ff7-4eb1' },
  ]);
  assert.equal(ids.has('73953827'), true);
  assert.equal(ids.size, 1, 'interactive entries claim no job id');
});

test('a window parked on a running job leaves the grid at once', () => {
  const store = createStore();
  const { reconcile } = createReconciler({ store });
  const window = { id: 'window', cwd: CWD, kind: 'background' };  // background: skips the transcript check
  const job = { id: '73953827', sessionId: 'job', cwd: CWD, kind: 'background' };

  reconcile([window], new Set());
  assert.ok(store.raw('window'), 'a window on its own is a session');

  reconcile([window, job], new Set(), new Map([['window', '73953827']]));
  assert.equal(store.raw('window'), undefined, 'no second tile for the turn the job owns');
  assert.ok(store.raw('job'), 'the job is the session now');
});

test('the parked flag is ignored once the job it names is gone', () => {
  // Nothing clears parkedJobId when a job finishes, so believing it on its own
  // would hide the window forever — the user types in that window.
  const store = createStore();
  const { reconcile } = createReconciler({ store });
  const window = { id: 'window', cwd: CWD, kind: 'background' };

  reconcile([window], new Set(), new Map([['window', '73953827']]));
  assert.ok(store.raw('window'), 'stale park claim, no job listed');
});

// --- registry verdicts --------------------------------------------------------

import { applyAgentState } from '../src/sessions/source-poller.js';

test('a busy registry verdict is proof of work, whatever the transcript says', () => {
  const fields = {};
  applyAgentState(fields, 'busy');   // the field CLI 2.1.x actually publishes
  assert.equal(fields.agentActive, true);
  assert.ok(fields.agentActiveTs > 0);
});

test('an idle verdict never ends a turn that is only thinking', () => {
  // Silence between two tool calls looks exactly like this, and used to clear
  // the flag that was holding the tile busy.
  const fields = { thinking: true };
  applyAgentState(fields, 'idle');
  assert.equal(fields.thinking, true, 'only the Stop hook ends a turn');
  assert.equal(fields.agentActive, false);
  assert.equal(fields.ended, undefined, 'idle is not gone');
});

test('a finished verdict does end the session', () => {
  const fields = { thinking: true };
  applyAgentState(fields, 'completed');
  assert.equal(fields.ended, true);
  assert.equal(fields.thinking, false);
});

test('an unknown verdict changes nothing', () => {
  const fields = { thinking: true };
  applyAgentState(fields, 'somethingelse');
  assert.deepEqual(fields, { thinking: true });
});
