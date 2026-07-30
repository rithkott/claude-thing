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
// Only `state` is trusted for activity. `status` reports "busy" for any session
// with a live process — a terminal left open overnight still says busy — so
// deciding "working" from it would light up the whole grid.
function applyAgentState(fields, agentState) {
  switch (String(agentState || '').toLowerCase()) {
    case 'running':
    case 'working':
      fields.ended = false;
      fields.waitingForInput = false;
      fields.agentActive = true;
      fields.agentActiveTs = Date.now();
      break;
    // These are the authoritative "not working" verdicts, and the only reliable
    // way to clear a thinking flag whose Stop hook never arrived.
    case 'blocked':
    case 'waiting':
      fields.ended = false;
      fields.waitingForInput = true;
      fields.agentActive = false;
      fields.thinking = false;
      break;
    case 'idle':
      fields.ended = false;
      fields.agentActive = false;
      fields.thinking = false;
      break;
    case 'completed':
    case 'stopped':
    case 'failed':
      fields.ended = true;
      fields.waitingForInput = false;
      fields.agentActive = false;
      fields.thinking = false;
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
        // known session up as "busy" for the busy window. Whether it is really
        // working is answered by `state` below, not by this timestamp.
        if (isNew) fields.lastActivityTs = startedAt || Date.now();
        applyAgentState(fields, pick(item, ['state'], null));

        store.upsert(id, fields);
        ensureTail(store, id, transcriptPathFor(id, cwd));
        seen.add(id);
      }

      // The registry is the authority on what is alive, so reconcile the whole
      // store against it rather than only the ids this poller happened to see.
      // Sessions discovered by a hook, or inherited across a daemon restart,
      // were never in `seen` and so could never be retired — which is how a
      // grid of one live session ends up showing eight.
      for (const [id, raw] of store.entries()) {
        if (current.has(id) || raw.ended) continue;
        seen.delete(id);
        stopTail(id);
        store.upsert(id, { ended: true, waitingForInput: false });
      }
    });
  }

  const timer = setInterval(poll, POLL_INTERVAL_MS);
  poll();
  return { stop: () => clearInterval(timer) };
}
