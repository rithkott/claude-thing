// The daemon's own `claude -p "/usage"` runs must never appear as sessions on
// the device — this is the guard that keeps that true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markOwnSession, isOwnSession } from '../src/own-sessions.js';

test('a marked session is recognised as ours', () => {
  markOwnSession('abc-123');
  assert.equal(isOwnSession('abc-123'), true);
  assert.equal(isOwnSession('someone-elses'), false);
});

test('the set stays bounded but keeps recent ids', () => {
  for (let i = 0; i < 200; i++) markOwnSession(`id-${i}`);
  // recent ids survive, so a poll that is still running is still filtered
  assert.equal(isOwnSession('id-199'), true);
  assert.equal(isOwnSession('id-198'), true);
  // ancient ids are dropped rather than leaking forever
  assert.equal(isOwnSession('id-0'), false);
});
