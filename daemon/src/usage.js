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
import { isOwnSession, markOwnSession } from './own-sessions.js';
import { log } from './log.js';

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

  if (!limits.length) return null;

  return {
    updatedTs: now,
    updatedLabel: 'updated ' + new Date(now).toTimeString().slice(0, 5) + ' · from claude /usage',
    subscription,
    limits,
    windows,
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
  let latest = null;
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
          latest = parsed;
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
