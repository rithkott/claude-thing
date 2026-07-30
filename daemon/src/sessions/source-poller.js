// Polls `claude agents --json` to discover sessions. Output schema is parsed
// defensively — unknown shapes are skipped, never crash.
// Observed shape: {id, sessionId, cwd, name, kind, startedAt, state}

import { execFile } from 'node:child_process';
import path from 'node:path';
import { POLL_INTERVAL_MS } from '../config.js';
import { isOwnSession } from '../own-sessions.js';
import { ensureTail, stopTail, transcriptPathFor } from './tails.js';
import { log } from '../log.js';

function pick(obj, keys, fallback) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return fallback;
}

// `claude agents --json` reports a coarse lifecycle state; map it onto ours.
// Anything unrecognized just leaves the store's activity-based derivation alone.
function applyAgentState(fields, agentState) {
  switch (String(agentState || '').toLowerCase()) {
    case 'running':
    case 'working':
      fields.ended = false;
      fields.waitingForInput = false;
      break;
    case 'blocked':
    case 'waiting':
      fields.ended = false;
      fields.waitingForInput = true;
      break;
    case 'completed':
    case 'stopped':
    case 'failed':
      fields.ended = true;
      fields.waitingForInput = false;
      break;
  }
}

export function startPollerSource({ store }) {
  let warned = false;
  const seen = new Set();

  function poll() {
    execFile('claude', ['agents', '--json'], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        if (!warned) {
          warned = true;
          log('PL', `claude agents --json unavailable (${err.message.split('\n')[0]}) — relying on hooks only`);
        }
        return;
      }
      warned = false;
      let list;
      try {
        const parsed = JSON.parse(stdout);
        list = Array.isArray(parsed) ? parsed : pick(parsed, ['agents', 'sessions'], []);
      } catch { return; }
      if (!Array.isArray(list)) return;

      const current = new Set();
      for (const item of list) {
        const id = pick(item, ['session_id', 'sessionId', 'id'], null);
        if (!id) continue;
        // the daemon's own usage polls are Claude Code sessions too
        if (isOwnSession(id)) continue;
        current.add(id);

        const cwd = pick(item, ['cwd', 'workingDirectory', 'project'], '');
        const startedAt = pick(item, ['startedAt', 'startedTs'], null);
        const isNew = !store.raw(id);
        const fields = {
          name: pick(item, ['name', 'title'], null) || (cwd ? path.basename(cwd) : 'session'),
          cwd,
          model: pick(item, ['model'], ''),
        };
        if (startedAt) fields.startedTs = startedAt;
        // Seed activity from startedAt so a daemon restart doesn't light every
        // known session up as "busy" for the busy window.
        if (isNew) fields.lastActivityTs = startedAt || Date.now();
        applyAgentState(fields, pick(item, ['state', 'status'], null));

        store.upsert(id, fields);
        ensureTail(store, id, transcriptPathFor(id, cwd));
        seen.add(id);
      }

      // sessions the poller used to see but no longer does = ended
      for (const id of seen) {
        if (!current.has(id)) {
          seen.delete(id);
          stopTail(id);
          const raw = store.raw(id);
          if (raw && !raw.ended) store.upsert(id, { ended: true, waitingForInput: false });
        }
      }
    });
  }

  const timer = setInterval(poll, POLL_INTERVAL_MS);
  poll();
  return { stop: () => clearInterval(timer) };
}
