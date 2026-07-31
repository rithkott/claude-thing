// Polls `claude agents --json` to discover sessions. Output schema is parsed
// defensively — unknown shapes are skipped, never crash.
// Observed shape: {id, sessionId, cwd, name, kind, startedAt, state}

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { POLL_INTERVAL_MS, RETIRE_AFTER_MISSED_POLLS, EMPTY_LISTING_GRACE_POLLS } from '../config.js';
import { isOwnSession } from '../own-sessions.js';
import { ensureTail, stopTail, transcriptPathFor } from './tails.js';
import { log } from '../log.js';

function pick(obj, keys, fallback) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return fallback;
}

// `claude agents --json` reports a coarse lifecycle verdict; map it onto ours.
// Anything unrecognized just leaves the store's activity-based derivation alone.
//
// The field to read is `status` — CLI 2.1.x publishes no `state` at all, so
// reading only that one meant this whole function received null on every poll
// and the registry never had a say in anything. `state` stays in the lookup for
// builds that do publish it.
//
// Positive verdicts are trusted; absence of one is not evidence of a finished
// turn. `busy` is exactly the signal a silent session needs, and it is
// refreshed every couple of seconds while a turn runs.
export function applyAgentState(fields, verdict) {
  switch (String(verdict || '').toLowerCase()) {
    case 'running':
    case 'working':
    case 'busy':
      fields.agentActive = true;
      fields.agentActiveTs = Date.now();
      break;
    case 'blocked':
    case 'waiting':
      fields.waitingForInput = true;
      fields.agentActive = false;
      break;
    case 'idle':
      // Silence, not a verdict. The registry says idle through every stretch of
      // thinking between two tool calls, so clearing `thinking` here is what
      // dropped a working session to an idle tile the moment it stopped
      // printing. Only the Stop hook ends a turn.
      fields.agentActive = false;
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

// The terminal you type into and the agent that answers are two different
// processes, and both register themselves. Driving a background job from a
// terminal therefore lists twice: the job (kind "background", owner of the
// transcript) and the window attached to it (kind "interactive", owner of
// nothing). Only the first is a conversation — the second is a viewport onto
// it, and putting both on the grid draws one session as two tiles.
//
// A transcript is what separates them. Every real conversation writes one; a
// viewport never does. A brand-new interactive session has none either, but it
// has nothing to show yet, so waiting for its first message is right anyway.
export function isViewport(item, id, cwd) {
  if (String(item.kind || '') !== 'interactive') return false;
  const transcript = transcriptPathFor(id, cwd);
  return !transcript || !fs.existsSync(transcript);
}

// The other way one conversation becomes two entries. A background job is
// started as a fork: `--fork-session --resume <parent transcript>`, which copies
// the window's conversation and answers in the copy. Both are registered, and
// the parent is not caught by isViewport because it does own a transcript — the
// one it wrote before the fork, frozen at that moment. The registry keeps
// calling it busy for as long as its TUI is attached, so it sat on the grid as a
// second permanently-working tile for a window the user only sees once.
//
// The fork link is on the child's command line and nowhere else: the registry
// JSON has no parent field, and the fork rewrites every sessionId in the copied
// transcript to its own. Hence reading it out of ps.
export function parseForkParents(psOutput) {
  const parents = new Set();
  for (const line of String(psOutput || '').split('\n')) {
    if (!line.includes('--fork-session')) continue;
    const m = line.match(/--resume\s+(\S+?)\.jsonl/);
    if (m) parents.add(path.basename(m[1]));
  }
  return parents;
}

// The listing arrives as whatever shape this CLI build prints. An array is the
// listing; an object with an `agents`/`sessions` array is the listing wrapped.
// Anything else — an error envelope, an update notice, an empty object — is
// *not* an empty listing, and returning [] for it meant one odd stdout retired
// every session on the grid for a poll interval. Unrecognized means null:
// skip the poll, keep the store.
export function parseListing(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  if (Array.isArray(parsed)) return parsed;
  const inner = pick(parsed, ['agents', 'sessions'], null);
  return Array.isArray(inner) ? inner : null;
}

// Apply one registry listing to the store: upsert what is live, retire what
// the registry no longer vouches for — but only once it has stopped vouching
// convincingly. Exported as a factory so tests can drive listings straight in.
export function createReconciler({ store }) {
  const missCounts = new Map(); // id -> consecutive polls absent from the listing
  let emptyStreak = 0;          // consecutive fully-empty listings

  function reconcile(list, parents) {
    if (list.length === 0 && store.count() > 0) {
      emptyStreak += 1;
      if (emptyStreak <= EMPTY_LISTING_GRACE_POLLS) {
        log('PL', `empty listing with ${store.count()} sessions in store — holding last known good`);
        return;
      }
    } else if (list.length > 0) {
      emptyStreak = 0;
    }

    const current = new Set();
    for (const item of list) {
      const id = pick(item, ['session_id', 'sessionId', 'id'], null);
      if (!id) continue;
      // the daemon's own usage polls are Claude Code sessions too
      if (isOwnSession(id)) continue;

      const cwd = pick(item, ['cwd', 'workingDirectory', 'project'], '');
      // No cwd means the transcript path cannot be derived, which makes the
      // viewport test below unanswerable — not answered "yes". Treating it as a
      // viewport retired every real session the registry listed cwd-less for
      // one tick. Indeterminate entries are vouched for but not touched: an
      // existing tile survives as it was, and a brand-new cwd-less entry has
      // nothing to show yet anyway.
      if (!cwd && String(item.kind || '') === 'interactive') {
        current.add(id);
        continue;
      }
      // Left out of `current` as well as skipped, so a viewport already in the
      // store from a previous poll gets retired rather than stranded. A hook
      // may have reported the transcript's real path directly — proof of a
      // conversation even when the cwd-derived path misses (the mangling in
      // transcriptPathFor is a guess about Claude Code's layout, not a fact).
      if (isViewport(item, id, cwd) && !hookTranscriptExists(store.raw(id))) continue;
      // A window whose conversation a background job forked is a viewport too:
      // the job owns the turn now, and this record can only ever show what the
      // window looked like before it was handed off.
      if (parents.has(id)) continue;
      current.add(id);
      const startedAt = pick(item, ['startedAt', 'startedTs'], null);
      const isNew = !store.raw(id);
      const fields = {
        name: pick(item, ['name', 'title'], null) || (cwd ? path.basename(cwd) : 'session'),
      };
      // Only what the registry actually knows. `claude agents --json` carries
      // no model at all, so writing it unconditionally meant every poll
      // blanked the model the transcript had just supplied — and the context
      // meter, which needs a model to know its own denominator, flashed on for
      // one snapshot and went dark for the next three seconds.
      if (cwd) fields.cwd = cwd;
      const model = pick(item, ['model'], '');
      if (model) fields.model = model;
      if (startedAt) fields.startedTs = startedAt;
      // Seed activity from startedAt so a daemon restart doesn't light every
      // known session up as "busy" for the busy window. Whether it is really
      // working is answered by the registry verdict below, not by this stamp.
      if (isNew) fields.lastActivityTs = startedAt || Date.now();
      applyAgentState(fields, pick(item, ['state', 'status'], null));

      // A registry entry the daemon reports as finished is dropped outright.
      // Marking it ended and letting the store delete it would still start a
      // tail below, and the next transcript line would resurrect the session
      // as live — so bail before any of that happens.
      if (fields.ended) {
        log('PL', `drop ${id.slice(0, 8)}: registry verdict ${pick(item, ['state', 'status'], '?')}`);
        stopTail(id);
        store.remove(id);
        continue;
      }

      store.upsert(id, fields);
      ensureTail(store, id, transcriptPathFor(id, cwd));
    }

    // The registry is the authority on what is alive, so reconcile the whole
    // store against it rather than only the ids this poller happened to see.
    // Sessions discovered by a hook, or inherited across a daemon restart,
    // were never seen here and so could never be retired — which is how a
    // grid of one live session ends up showing eight. But one listing's
    // absence is not death: the registry read can be mid-write, so a session
    // only goes once several polls in a row have failed to vouch for it.
    for (const [id] of store.entries()) {
      if (current.has(id)) {
        missCounts.delete(id);
        continue;
      }
      const misses = (missCounts.get(id) || 0) + 1;
      if (misses < RETIRE_AFTER_MISSED_POLLS) {
        missCounts.set(id, misses);
        continue;
      }
      missCounts.delete(id);
      stopTail(id);
      store.remove(id);
      log('PL', `retire ${id.slice(0, 8)} after ${misses} missed polls`);
    }
    // Sessions the hooks source deleted (SessionEnd) leave counters behind;
    // drop them so a returning id starts its count fresh.
    for (const id of missCounts.keys()) {
      if (!store.raw(id)) missCounts.delete(id);
    }
  }

  return { reconcile };
}

// A hook once told us exactly where this session's transcript lives. That
// beats any path derived from cwd.
function hookTranscriptExists(record) {
  return !!(record && record.transcriptPath && fs.existsSync(record.transcriptPath));
}

export function startPollerSource({ store }) {
  let warned = false;
  const { reconcile } = createReconciler({ store });

  // Only the pids the registry just reported, so this stays one short ps per
  // poll rather than a scan of every process on the machine. A job too new to be
  // listed is missed for one interval, which costs a single stale snapshot.
  function forkParents(list, done) {
    const pids = list
      .map((item) => pick(item, ['pid'], null))
      .filter((p) => Number.isInteger(p) && p > 0);
    if (!pids.length) return done(new Set());
    execFile('ps', ['-o', 'command=', '-p', pids.join(',')], { timeout: 5_000 }, (err, out) => {
      // Every pid gone is an error from ps, not a reason to drop the poll.
      done(parseForkParents(err ? '' : out));
    });
  }

  function poll() {
    // disableAllHooks matters as much as the listing itself: `claude agents`
    // boots a Claude Code process, which sometimes registers a session and
    // fires SessionEnd on exit. With the daemon's own cwd on the payload, that
    // arrives back at /hook as a phantom session named after this directory —
    // the daemon polling itself into its own grid, three seconds at a time.
    execFile('claude', ['--settings', '{"disableAllHooks":true}', 'agents', '--json'], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        if (!warned) {
          warned = true;
          log('PL', `claude agents --json unavailable (${err.message.split('\n')[0]}) — relying on hooks only`);
        }
        return;
      }
      const list = parseListing(stdout);
      if (!list) {
        // A failed poll says nothing about who is alive; it must not count
        // against anyone. Skip reconciling entirely.
        if (!warned) {
          warned = true;
          log('PL', 'claude agents --json returned an unrecognized shape — skipping poll');
        }
        return;
      }
      warned = false;

      forkParents(list, (parents) => reconcile(list, parents));
    });
  }

  const timer = setInterval(poll, POLL_INTERVAL_MS);
  poll();
  return { stop: () => clearInterval(timer) };
}
