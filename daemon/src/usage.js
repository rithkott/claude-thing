// Real usage, straight from Claude Code.
//
// `claude -p "/usage"` runs the slash command locally and prints the same
// figures the interactive /usage view shows — percentages against the actual
// plan limits, reset times, and the "what's contributing" breakdown. It costs
// no model tokens (no inference happens) and, with
// CLAUDE_CODE_SKIP_PROMPT_HISTORY=1, writes no transcript.
//
// Everything here is parsed from that text. We never invent a denominator.

import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { USAGE_REFRESH_MS } from './config.js';
import { markOwnSession } from './own-sessions.js';
import { readState, writeState } from './persist.js';
import { log } from './log.js';

// Where the last good reading is kept between runs.
const STATE_NAME = 'usage';

// A run costs no inference but still boots Claude Code and reads the plan, which
// takes the better part of 20 seconds on a cold start. The old 25s ceiling cut
// slower runs off, and the timeout then reported whatever stderr happened to
// hold — which is how a harmless stdin warning ended up on the usage screen as
// the failure. Well under the 60s refresh, so runs still never overlap.
const RUN_TIMEOUT_MS = 45_000;

// "Current session: 11% used · resets Jul 30 at 5:19am (America/New_York)"
const LIMIT_RE = /^\s*Current\s+(session|week[^:]*):\s*(\d+)%\s*used(?:\s*·\s*resets\s+([^(\n]+?))?\s*(?:\(([^)]+)\))?\s*$/i;
// "Last 24h · 579 requests · 8 sessions"
const WINDOW_RE = /^\s*Last\s+(\S+)\s*·\s*([\d,]+)\s+requests\s*·\s*([\d,]+)\s+sessions\s*$/i;
// "Top skills: /webapp-testing 4%, /frontend-design 1%"
const TOP_RE = /^Top\s+(skills|subagents|MCP servers):\s*(.+)$/i;

// Trailing percentage per item; anything that doesn't match that shape is kept
// with an empty value rather than dropped, so an unparsed entry still shows.
function parseTopList(rest) {
  return String(rest).split(',').map((chunk) => {
    const item = chunk.trim();
    const m = /^(.*\S)\s+(\d+%)$/.exec(item);
    return m ? { name: m[1], pct: m[2] } : { name: item, pct: '' };
  }).filter((x) => x.name);
}

function labelFor(kind) {
  const k = kind.toLowerCase();
  if (k === 'session') return 'SESSION';
  const model = /week\s*\(([^)]+)\)/i.exec(kind);
  if (model) {
    const name = model[1].trim();
    return /all models/i.test(name) ? 'WEEK · ALL MODELS' : `WEEK · ${name.toUpperCase()}`;
  }
  return kind.toUpperCase();
}

export function parseUsage(text, now = Date.now()) {
  const lines = String(text).split('\n');
  const limits = [];
  const windows = [];
  let current = null;
  let subscription = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (/subscription to power your Claude Code usage/i.test(line)) {
      subscription = line.trim();
      continue;
    }

    const limit = LIMIT_RE.exec(line);
    if (limit) {
      limits.push({
        key: limit[1].toLowerCase().replace(/[^a-z]+/g, '-'),
        label: labelFor(limit[1]),
        used: Number(limit[2]) / 100,
        detail: limit[3] ? `resets ${limit[3].trim()}` : '',
      });
      continue;
    }

    const win = WINDOW_RE.exec(line);
    if (win) {
      current = {
        window: `Last ${win[1]}`,
        requests: Number(win[2].replace(/,/g, '')),
        sessions: Number(win[3].replace(/,/g, '')),
        notes: [],
        skills: [],
        subagents: [],
        mcp: [],
      };
      windows.push(current);
      continue;
    }

    // indented bullets under a window: behaviours and top skills/subagents/MCP
    if (current && /^\s{2,}\S/.test(raw) && line.trim()) {
      const note = line.trim();
      current.notes.push(note);
      // "Top skills: /webapp-testing 4%, /deploy-to-dev 1%" is a table wearing
      // a sentence. Split it here so the device renders rows, not prose.
      const top = TOP_RE.exec(note);
      if (top) {
        const key = { skills: 'skills', subagents: 'subagents', 'mcp servers': 'mcp' }[top[1].toLowerCase()];
        if (key) current[key] = parseTopList(top[2]);
      }
    }
  }

  // A run can succeed and print no limit lines at all. Claude Code renders a
  // limit only while its reset time is still ahead, and the figures come from
  // `cachedUsageUtilization` in ~/.claude.json, which a `claude -p` run reads
  // but never refetches. So once a window rolls over, every poll comes back
  // with the breakdown intact and not one "Current session:" line, until an
  // interactive session refreshes the cache. Observed live for seven hours.
  //
  // That is a real reading of a real state — the limits are unavailable — not a
  // parse failure, and treating it as one froze the screen on the last reading
  // that happened to parse. What tells the two apart is whether /usage rendered
  // anything we recognise: a window line or the subscription sentence.
  if (!limits.length && !windows.length && !subscription) return null;

  return {
    updatedTs: now,
    // When the limits were last actually read, as opposed to when this reading
    // was taken. They diverge as soon as one is carried over.
    limitsTs: limits.length ? now : 0,
    updatedLabel: 'updated ' + hhmm(now) + ' · from claude /usage',
    subscription,
    limits,
    windows,
  };
}

function hhmm(ts) {
  return new Date(ts).toTimeString().slice(0, 5);
}

// --- keeping a reading honest across polls ------------------------------------
//
// `claude -p /usage` does not always ask the server. It prints whatever is in
// `cachedUsageUtilization` in ~/.claude.json, and that file is read-modify-
// written wholesale by every claude process on the machine. A long-lived
// session that loaded it an hour ago writes its own stale copy back over the
// fresh one, so consecutive polls a minute apart can disagree — the screen
// flips between the real figure and a stale lower one until something settles.
// Observed live: 1% used, then 0% used, inside the same five-hour window.
//
// The fix is the one fact the reading itself gives us: usage inside a window
// only ever goes up. A lower number for the same window is a stale read, not a
// refund, so the higher one stands. When the window really does roll over the
// reset clause changes with it, and the drop is taken at face value.

function sameWindow(prev, next) {
  // A reading with no reset clause carries no window identity of its own — the
  // zeroed-out shape a clobbered cache prints — so it cannot claim to be a new
  // window. Only a different, stated reset time counts as a rollover.
  if (!prev.detail || !next.detail) return true;
  return prev.detail === next.detail;
}

export function reconcileUsage(prev, next) {
  if (!next || !Array.isArray(next.limits)) return next;

  // Silence about the limits is not a report that they are gone. A reading that
  // printed none is the expired-cache shape above: its windows are fresh and
  // worth taking, but the last limits actually read still stand, dated by when
  // they were read rather than by now. Held indefinitely — a figure the device
  // labels as hours old beats a screen that stops moving altogether.
  if (!next.limits.length) {
    const held = (prev && prev.limits) || [];
    if (!held.length) return next;
    const limitsTs = (prev && (prev.limitsTs || prev.updatedTs)) || next.updatedTs;
    return {
      ...next,
      limits: held,
      limitsTs,
      stale: true,
      updatedLabel: 'limits ' + hhmm(limitsTs) + ' · from claude /usage',
    };
  }

  const before = new Map(((prev && prev.limits) || []).map((l) => [l.key, l]));
  const limits = next.limits.map((l) => {
    const p = before.get(l.key);
    if (!p || !(p.used > l.used) || !sameWindow(p, l)) return l;
    // Held: the previous reading wins, and keeps its reset clause if this one
    // arrived without any.
    return { ...l, used: p.used, detail: l.detail || p.detail };
  });
  return { ...next, limits };
}

// The last good reading, so a restart shows real figures instead of spending a
// minute on "READING USAGE…". Flagged stale until the first live poll lands.
function loadPersisted() {
  const saved = readState(STATE_NAME);
  if (!saved || !Array.isArray(saved.limits) || !saved.limits.length) return null;
  // Dated by when the limits were read, which after a carry-over is older than
  // the reading that saved them.
  const ts = saved.limitsTs || saved.updatedTs;
  const at = ts ? hhmm(ts) : '';
  return {
    ...saved,
    stale: true,
    error: undefined,
    updatedLabel: `last reading${at ? ' ' + at : ''} · from claude /usage`,
  };
}

// What actually went wrong, in the words the device has room for. A killed run
// timed out — say that, rather than quoting whichever line stderr happened to
// end on, which is how warnings get mistaken for causes.
export function describeFailure(err, stderr) {
  if (err && (err.killed || err.signal)) {
    return `timed out after ${Math.round(RUN_TIMEOUT_MS / 1000)}s`;
  }
  const line = String(stderr || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^warning:/i.test(l));
  return line || String((err && err.message) || 'unknown error').split('\n')[0];
}

export function createUsage({ emit }) {
  let latest = loadPersisted();
  let timer = null;
  let running = false;

  function run() {
    // Our own polling is still a Claude Code session. disableAllHooks stops it
    // reporting itself through the hook path, the explicit session id lets the
    // session sources recognise and skip it, and running from a temp dir keeps
    // it out of any project the user actually works in.
    const sessionId = crypto.randomUUID();
    markOwnSession(sessionId);

    return new Promise((resolve) => {
      execFile(
        'claude',
        ['--settings', '{"disableAllHooks":true}', '--session-id', sessionId, '-p', '/usage'],
        {
          timeout: RUN_TIMEOUT_MS,
          cwd: os.tmpdir(),
          env: { ...process.env, CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' },
          maxBuffer: 1024 * 1024,
          // Closed stdin, not an idle pipe. `claude -p` waits three seconds for
          // input that is never coming, warns about it, and only then starts —
          // three seconds of every run, spent on nothing.
          stdio: ['ignore', 'pipe', 'pipe'],
        },
        (err, stdout, stderr) => {
          if (err) return resolve({ error: describeFailure(err, stderr) });
          resolve({ text: String(stdout) });
        }
      );
    });
  }

  async function refresh() {
    if (running) return latest;
    running = true;
    try {
      const out = await run();
      if (out.error) {
        latest = {
          ...(latest || {}),
          stale: true,
          error: `claude /usage failed: ${out.error}`.slice(0, 120),
        };
      } else {
        const parsed = parseUsage(out.text);
        if (parsed) {
          latest = reconcileUsage(latest, parsed);
          // Nothing to carry and nothing read: say which of the two it is,
          // rather than leaving the screen on "READING USAGE…" forever. Only a
          // reading with limits is persisted — a limitless one must never
          // overwrite the saved figures a restart would otherwise recover.
          if (latest.limits.length) writeState(STATE_NAME, latest);
          else latest = { ...latest, stale: true, error: 'claude /usage printed no limits' };
        } else {
          latest = { ...(latest || {}), stale: true, error: 'could not parse /usage output' };
        }
      }
      emit('claude.usage.update', latest);
    } catch (err) {
      log('US', `usage refresh failed: ${err.message}`);
    } finally {
      running = false;
    }
    return latest;
  }

  return {
    start: () => { refresh(); timer = setInterval(refresh, USAGE_REFRESH_MS); },
    stop: () => clearInterval(timer),
    get: () => latest || { limits: [], error: 'usage not read yet' },
    refresh,
  };
}
