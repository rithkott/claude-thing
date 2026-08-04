// The Bluetooth relay cannot split a synchronous response across its 2000-byte
// chunks, so a claude.sessions.list response at BT_SAFE_SESSION_LIMIT must fit
// one chunk with headroom. Measured against JSON, which is a pessimistic proxy
// for the MsgPack actually on the wire (MsgPack drops the quotes and colons of
// this string-keyed shape), so passing the JSON budget guarantees the MsgPack
// one. Budget 1800 of the 2000 cap, leaving slack for fields this test didn't
// foresee growing by a few characters.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/sessions/store.js';
import { BT_SAFE_SESSION_LIMIT } from '../src/config.js';

const BUDGET_BYTES = 1800;

test(`a ${BT_SAFE_SESSION_LIMIT}-session worst-case list response fits the BT chunk budget`, () => {
  const store = createStore();
  for (let i = 0; i < BT_SAFE_SESSION_LIMIT; i++) {
    store.touch(`f47ac10b-58cc-4372-a567-0e02b2c3d4${String(i).padStart(2, '0')}`, {
      name: 'x'.repeat(32),                          // summary() caps at 32
      model: 'us.anthropic.claude-opus-4-1-20250805-v1:0', // longest realistic id
      contextTokens: 999_999,                        // long context fraction float
      tokensIn: 999_999_999,
      tokensOut: 999_999_999,
      pendingPermission: true,
      permissionMode: 'bypassPermissions',           // longest mode string
      effort: 'ultrathink',                          // longest effort string
    });
  }

  const envelope = {
    type: 'response',
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    result: store.snapshot(BT_SAFE_SESSION_LIMIT),
  };
  const bytes = Buffer.byteLength(JSON.stringify(envelope));
  assert.ok(
    bytes < BUDGET_BYTES,
    `response is ${bytes} bytes; over the ${BUDGET_BYTES}-byte budget — ` +
    'either lower BT_SAFE_SESSION_LIMIT or shrink SessionSummary'
  );
});
