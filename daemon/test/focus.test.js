// The registry half of focusing: which window, if any, owns a session.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  lookupSession,
  hostWindowFor,
  lastAiTitle,
  parseGhosttySurfaces,
  pickGhosttySurface,
} from '../src/focus.js';

function registry(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-'));
  for (const rec of records) {
    fs.writeFileSync(path.join(dir, `${rec.pid}.json`), JSON.stringify(rec));
  }
  return dir;
}

const JOB = {
  pid: 65545,
  sessionId: 'f036b86d-4e37-491b-9c0c-5a851afbdab4',
  kind: 'bg',
  jobId: 'f036b86d',
  name: 'configure-model-effort',
  status: 'waiting',
};
const WINDOW = { pid: 64808, sessionId: 'ddfa1280-328c', kind: 'interactive', parkedJobId: 'f036b86d' };
const OTHER = { pid: 70824, sessionId: '2d6cdd0f-d9d7', kind: 'interactive' };

test('a background job resolves to the window parked on it', () => {
  const dir = registry([JOB, WINDOW, OTHER]);
  assert.equal(hostWindowFor(lookupSession(JOB.sessionId, dir), dir).pid, WINDOW.pid);
});

test('a parkedJobId written as the full session id still matches', () => {
  const dir = registry([JOB, { ...WINDOW, parkedJobId: JOB.sessionId }]);
  assert.equal(hostWindowFor(JOB, dir).pid, WINDOW.pid);
});

test('a job nobody parked on has no window', () => {
  const dir = registry([JOB, OTHER, { ...WINDOW, pid: 1, parkedJobId: 'deadbeef' }]);
  assert.equal(hostWindowFor(JOB, dir), null);
});

test('only interactive sessions count as windows', () => {
  const dir = registry([JOB, { ...WINDOW, kind: 'bg' }]);
  assert.equal(hostWindowFor(JOB, dir), null);
});

test('unparsable and unrelated files are skipped, not fatal', () => {
  const dir = registry([JOB, WINDOW]);
  fs.writeFileSync(path.join(dir, 'junk.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  assert.equal(hostWindowFor(JOB, dir).pid, WINDOW.pid);
  assert.equal(lookupSession('nope', dir), null);
});

// --- Ghostty: which terminal surface is this session? ---

function transcript(lines) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-')), 's.jsonl');
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

const SURFACES = [
  { id: 'A', cwd: '/repos/app', title: '✳ Publish the delivery project' },
  { id: 'B', cwd: '/repos/thing', title: '⠂ Analyze repo for data collection' },
  { id: 'C', cwd: '/repos/thing', title: 'npm --prefix /repos/thing/daemon start' },
];

test('the newest ai-title wins, and non-title records are ignored', () => {
  const f = transcript([
    { type: 'ai-title', aiTitle: 'first guess' },
    { type: 'assistant', message: { content: [] } },
    { type: 'ai-title', aiTitle: 'Analyze repo for data collection' },
  ]);
  assert.equal(lastAiTitle(f), 'Analyze repo for data collection');
});

test('an untitled or unreadable transcript costs exactness, not correctness', () => {
  assert.equal(lastAiTitle(transcript([{ type: 'assistant' }])), null);
  assert.equal(lastAiTitle('/no/such/transcript.jsonl'), null);
  assert.equal(lastAiTitle(null), null);
});

test('a title past the tail window is still found', () => {
  // Title first, then enough traffic to push it out of the 256KB tail read.
  const filler = { type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(4000) }] } };
  const f = transcript([{ type: 'ai-title', aiTitle: 'buried' }, ...Array(80).fill(filler)]);
  assert.ok(fs.statSync(f).size > 256 * 1024);
  assert.equal(lastAiTitle(f), 'buried');
});

test('surfaces parse, and a title containing a tab survives it', () => {
  const S = '';
  const rows = parseGhosttySurfaces(
    `A${S}/repos/app${S}one\n\nB${S}/repos/thing${S}two\tthree\n`
  );
  assert.deepEqual(rows, [
    { id: 'A', cwd: '/repos/app', title: 'one' },
    { id: 'B', cwd: '/repos/thing', title: 'two\tthree' },
  ]);
  assert.deepEqual(parseGhosttySurfaces(''), []);
  // A line the script could not fill in is skipped, not half-parsed.
  assert.deepEqual(parseGhosttySurfaces(`A${S}/repos/app\n`), []);
});

test('the title identifies the surface despite a changing status glyph', () => {
  const hit = pickGhosttySurface(SURFACES, {
    aiTitle: 'Analyze repo for data collection',
    cwd: '/repos/thing',
  });
  assert.equal(hit.id, 'B');
});

test('a shell sharing the cwd does not steal the match', () => {
  // C sits in the same directory as B; only the title separates them.
  const hit = pickGhosttySurface(SURFACES, { aiTitle: 'Analyze repo for data collection' });
  assert.equal(hit.id, 'B');
});

test('cwd alone resolves only when it is unambiguous', () => {
  assert.equal(pickGhosttySurface(SURFACES, { cwd: '/repos/app' }).id, 'A');
  // Two surfaces in /repos/thing — refuse rather than guess.
  assert.equal(pickGhosttySurface(SURFACES, { cwd: '/repos/thing' }), null);
});

test('two identically titled sessions fall back to cwd, then to refusing', () => {
  const twins = [
    { id: 'A', cwd: '/repos/one', title: '✳ same title' },
    { id: 'B', cwd: '/repos/two', title: '⠂ same title' },
  ];
  assert.equal(pickGhosttySurface(twins, { aiTitle: 'same title', cwd: '/repos/two' }).id, 'B');
  assert.equal(pickGhosttySurface(twins, { aiTitle: 'same title' }), null);
  assert.equal(pickGhosttySurface(twins, { aiTitle: 'same title', cwd: '/repos/three' }), null);
});

test('no surfaces, or nothing to match on, is not an error', () => {
  assert.equal(pickGhosttySurface([], { aiTitle: 'x', cwd: '/y' }), null);
  assert.equal(pickGhosttySurface(SURFACES, {}), null);
  assert.equal(pickGhosttySurface(undefined, { aiTitle: 'x' }), null);
});
