// Session source facade. Real sources (hooks ingest, poller, transcript tail)
// and the mock source all feed the same store.

import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_SETTINGS, MOCK_SESSIONS } from '../config.js';
import { startMockSource } from './source-mock.js';
import { startPollerSource } from './source-poller.js';
import { startHooksSource } from './source-hooks.js';
import { log } from '../log.js';

export function createSources({ store, permissionBridge, queue }) {
  const active = [];
  let hooks = null;

  if (MOCK_SESSIONS) {
    active.push({ name: 'mock', handle: startMockSource({ store, permissionBridge, queue }) });
  } else {
    active.push({ name: 'poller', handle: startPollerSource({ store }) });
    hooks = startHooksSource({ store, queue });
    active.push({ name: 'hooks', handle: hooks });
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
