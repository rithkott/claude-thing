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
