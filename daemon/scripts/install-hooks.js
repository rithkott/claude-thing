// Merges claude-thing hooks into ~/.claude/settings.json (backup written).
// Uses Claude Code's native type:"http" hooks POSTing to the daemon's bare
// /hook endpoint (event identified by hook_event_name in the payload).
// Failures are non-blocking for Claude Code, and the PermissionRequest flow
// answers "ask" whenever the daemon is absent or silent, so the terminal
// prompt always remains the fallback.

import fs from 'node:fs';
import { CLAUDE_SETTINGS, PORT, HOOK_TIMEOUT_S } from '../src/config.js';

const HOOK_URL = `http://127.0.0.1:${PORT}/hook`;

function httpHook(timeout) {
  return { matcher: '*', hooks: [{ type: 'http', url: HOOK_URL, timeout }] };
}

const EVENTS = {
  PermissionRequest: httpHook(HOOK_TIMEOUT_S),   // held by the daemon ≤55s
  SessionStart: httpHook(5),
  SessionEnd: httpHook(3),
  UserPromptSubmit: httpHook(5),
  PreToolUse: httpHook(5),
  PostToolUse: httpHook(5),
  Stop: httpHook(5),
};

let settings = {};
try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); } catch {}

const backup = `${CLAUDE_SETTINGS}.claude-thing-backup-${Date.now()}`;
if (fs.existsSync(CLAUDE_SETTINGS)) fs.copyFileSync(CLAUDE_SETTINGS, backup);

settings.hooks = settings.hooks || {};
for (const [event, entry] of Object.entries(EVENTS)) {
  const list = settings.hooks[event] = settings.hooks[event] || [];
  // remove any previous claude-thing entry (old curl or http form), then add
  settings.hooks[event] = list.filter((e) => !JSON.stringify(e).includes(`:${PORT}/hook`));
  settings.hooks[event].push(entry);
}
// sweep stale claude-thing entries from events we no longer register
for (const event of Object.keys(settings.hooks)) {
  if (!EVENTS[event]) {
    settings.hooks[event] = settings.hooks[event].filter(
      (e) => !JSON.stringify(e).includes(`:${PORT}/hook`)
    );
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
}

fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
console.log(`hooks installed into ${CLAUDE_SETTINGS}`);
console.log(`backup: ${backup}`);
console.log('note: hooks apply to Claude Code sessions started from now on.');
