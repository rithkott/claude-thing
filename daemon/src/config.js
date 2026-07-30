import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DAEMON_ROOT = path.resolve(__dirname, '..');
export const PROJECT_ROOT = path.resolve(DAEMON_ROOT, '..');

export const PORT = Number(process.env.CLAUDE_THING_PORT) || 8790;
export const HOST = '127.0.0.1';

export const DAEMON_VERSION = JSON.parse(
  fs.readFileSync(path.join(DAEMON_ROOT, 'package.json'), 'utf8')
).version;

export const WEBPAGE_DIST = path.join(PROJECT_ROOT, 'webpage', 'dist');
export const LOG_DIR = path.join(DAEMON_ROOT, 'logs');
export const PID_FILE = path.join(DAEMON_ROOT, '.daemon.pid');

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
export const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// Permission timing: daemon answers "ask" at HOLD_MS if nobody responded;
// the installed hook timeout must exceed this (60s in install-hooks).
export const PERMISSION_HOLD_MS = Number(process.env.CLAUDE_THING_HOLD_MS ?? 55_000);
export const HOOK_TIMEOUT_S = 60;

// Snapshots are unbounded — the device grid scrolls sideways through however
// many sessions exist. A client on a constrained transport can still ask for a
// slice via claude.sessions.list {limit}.
export const SESSION_CAP = 0;
export const SNAPSHOT_DEBOUNCE_MS = 500;
export const BUSY_WINDOW_MS = 10_000;    // activity within this = busy
export const CELEBRATE_MS = 20_000;      // celebrate decays to idle after this
export const POLL_INTERVAL_MS = 3_000;   // claude agents --json poll
export const ENDED_TTL_MS = Number(process.env.CLAUDE_THING_ENDED_TTL_MS ?? 15 * 60_000);

export const MOCK_SESSIONS = process.env.CLAUDE_THING_MOCK === '1';

// Usage screen: real plan figures read from `claude -p "/usage"` once a minute.
export const USAGE_REFRESH_MS = 60_000;
