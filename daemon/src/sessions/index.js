// Session source facade. Real sources (hooks ingest, poller, transcript tail)
// and the mock source all feed the same store.

import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_SETTINGS, MOCK_SESSIONS } from '../config.js';
import { startMockSource } from './source-mock.js';
import { startPollerSource } from './source-poller.js';
import { startHooksSource } from './source-hooks.js';
import { setTailInterruptHandler } from './tails.js';
import { log } from '../log.js';

// How fresh a transcript interrupt marker must be to also clear the session's
// tile flags. Ask cleanup guards by createdTs and tolerates any age; the tile
// flags have no such anchor, so only a marker written moments ago — a live
// Esc, not catch-up replay of an old one — may clear them. The tail notices
// within its 3s poll, so this only needs to cover poll lag plus clock slop.
const INTERRUPT_FRESH_MS = 15_000;

export function createSources({ store, permissionBridge, queue }) {
  const active = [];
  let hooks = null;

  if (MOCK_SESSIONS) {
    active.push({ name: 'mock', handle: startMockSource({ store, permissionBridge, queue }) });
  } else {
    active.push({ name: 'poller', handle: startPollerSource({ store }) });
    hooks = startHooksSource({ store, queue });
    active.push({ name: 'hooks', handle: hooks });
    // Esc fires no hook, so this is the only path that retires asks and tile
    // flags for an interrupted turn.
    setTailInterruptHandler((sessionId, ts) => {
      if (queue) queue.onInterrupted(sessionId, ts);
      if (permissionBridge && permissionBridge.cancelSession) permissionBridge.cancelSession(sessionId, ts);
      if (Date.now() - ts < INTERRUPT_FRESH_MS) {
        store.touch(sessionId, { waitingForInput: false, thinking: false, currentTool: null, stoppedTs: ts });
      }
    });
  }

  function onHookEvent(event, payload) {
    if (hooks) hooks.onHookEvent(event, payload);
    else log('HK', `hook ${event} ignored (mock mode)`);
  }

  function hooksInstalled() {
    try {
      const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
      const flat = JSON.stringify((settings.hooks || {}).PermissionRequest || []);
      return flat.includes('/hook');
    } catch {
      return false;
    }
  }

  return {
    onHookEvent,
    hooksInstalled,
    status: () => active.map((s) => s.name),
    stop: () => active.forEach((s) => s.handle && s.handle.stop && s.handle.stop()),
  };
}
