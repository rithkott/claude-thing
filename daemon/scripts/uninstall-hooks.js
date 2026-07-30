// Removes all claude-thing hook entries from ~/.claude/settings.json.

import fs from 'node:fs';
import { CLAUDE_SETTINGS, PORT } from '../src/config.js';

const BASE = `:${PORT}/hook`;

let settings;
try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); } catch {
  console.log('no settings.json — nothing to do');
  process.exit(0);
}

const backup = `${CLAUDE_SETTINGS}.claude-thing-backup-${Date.now()}`;
fs.copyFileSync(CLAUDE_SETTINGS, backup);

let removed = 0;
for (const event of Object.keys(settings.hooks || {})) {
  const before = settings.hooks[event].length;
  settings.hooks[event] = settings.hooks[event].filter(
    (e) => !JSON.stringify(e).includes(BASE)
  );
  removed += before - settings.hooks[event].length;
  if (settings.hooks[event].length === 0) delete settings.hooks[event];
}

fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
console.log(`removed ${removed} claude-thing hook entr${removed === 1 ? 'y' : 'ies'}`);
console.log(`backup: ${backup}`);
