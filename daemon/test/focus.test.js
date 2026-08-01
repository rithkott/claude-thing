// The registry half of focusing: which window, if any, owns a session.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lookupSession, hostWindowFor } from '../src/focus.js';

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
