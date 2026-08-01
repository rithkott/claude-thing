// The transcript tail is the only source that knows a session's permission
// mode — `claude agents --json` carries no such field — so the record shape it
// reads is worth pinning down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../src/sessions/store.js';
import { startTranscriptTail } from '../src/sessions/source-transcript.js';

const settle = () => new Promise((r) => setTimeout(r, 120));

function tmpTranscript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-tail-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('a permission-mode record lands on the session, later ones replace it', async () => {
  const store = createStore();
  const transcriptPath = tmpTranscript([
    { type: 'permission-mode', permissionMode: 'plan', sessionId: 'a' },
  ]);
  const tail = startTranscriptTail({ store, sessionId: 'a', transcriptPath });
  await settle();
  assert.equal(store.get('a').permissionMode, 'plan');

  fs.appendFileSync(transcriptPath,
    JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'a' }) + '\n');
  await settle();
  assert.equal(store.get('a').permissionMode, 'bypassPermissions');
  tail.stop();
});

test('an assistant record\'s effort lands on the session, later ones replace it', async () => {
  const store = createStore();
  const transcriptPath = tmpTranscript([
    { type: 'assistant', effort: 'high', message: { model: 'claude-fable-5' } },
  ]);
  const tail = startTranscriptTail({ store, sessionId: 'a', transcriptPath });
  await settle();
  assert.equal(store.get('a').effort, 'high');

  fs.appendFileSync(transcriptPath,
    JSON.stringify({ type: 'assistant', effort: 'ultrathink', message: {} }) + '\n');
  await settle();
  assert.equal(store.get('a').effort, 'ultrathink');
  tail.stop();
});

test('a mode record is not mistaken for a message and harvested for usage', async () => {
  const store = createStore();
  const transcriptPath = tmpTranscript([
    { type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: 100, output_tokens: 20 } } },
    { type: 'permission-mode', permissionMode: 'auto', sessionId: 'a' },
  ]);
  const tail = startTranscriptTail({ store, sessionId: 'a', transcriptPath });
  await settle();
  const d = store.get('a');
  assert.equal(d.permissionMode, 'auto');
  assert.equal(d.model, 'claude-opus-5', 'the mode record must not blank the model');
  assert.equal(d.tokens.in, 100, 'nor disturb the token counters');
  tail.stop();
});
