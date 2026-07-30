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
