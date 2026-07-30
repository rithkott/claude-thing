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

const RUN_TIMEOUT_MS = 25_000;

// "Current session: 11% used · resets Jul 30 at 5:19am (America/New_York)"
const LIMIT_RE = /^\s*Current\s+(session|week[^:]*):\s*(\d+)%\s*used(?:\s*·\s*resets\s+([^(\n]+?))?\s*(?:\(([^)]+)\))?\s*$/i;
// "Last 24h · 579 requests · 8 sessions"
const WINDOW_RE = /^\s*Last\s+(\S+)\s*·\s*([\d,]+)\s+requests\s*·\s*([\d,]+)\s+sessions\s*$/i;

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
      };
      windows.push(current);
      continue;
    }

    // indented bullets under a window: behaviours and top skills/subagents/MCP
    if (current && /^\s{2,}\S/.test(raw) && line.trim()) {
      current.notes.push(line.trim());
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
        },
        (err, stdout, stderr) => {
          if (err) return resolve({ error: String(stderr || err.message).split('\n')[0] });
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
