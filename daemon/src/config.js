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

// Permission timing: daemon answers "ask" at HOLD_MS if nobody responded; the
// installed hook timeout must exceed this, or Claude Code gives up first and
// the device is answering into a closed connection. Ten minutes is long enough
// to notice a prompt and walk over to the device; the session is genuinely
// blocked for that whole time, which is the cost of a longer window.
export const PERMISSION_HOLD_MS = Number(process.env.CLAUDE_THING_HOLD_MS ?? 595_000);
export const HOOK_TIMEOUT_S = 600;

// Snapshots are unbounded — the device grid scrolls sideways through however
// many sessions exist. A client on a constrained transport can still ask for a
// slice via claude.sessions.list {limit}.
export const SESSION_CAP = 0;
export const SNAPSHOT_DEBOUNCE_MS = 500;
export const BUSY_WINDOW_MS = 10_000;    // activity within this = busy
export const CELEBRATE_MS = 20_000;      // celebrate decays to idle after this
export const POLL_INTERVAL_MS = 3_000;   // claude agents --json poll
// The registry's "working" verdict is the only thing that stays true while the
// model thinks and nothing is being written. Trust it for a few poll intervals
// so one dropped poll doesn't blink a working session to idle.
export const AGENT_ACTIVE_TTL_MS = 3 * POLL_INTERVAL_MS;
// A turn normally ends at the Stop hook. If that never arrives — session killed
// mid-thought, hooks not installed — this stops the tile from claiming to work
// forever. Long enough not to cut off a genuinely slow turn.
export const THINKING_TTL_MS = 10 * 60_000;
// Long enough to watch a run finish, short enough that closing a few terminals
// doesn't leave the grid full of headstones.
export const ENDED_TTL_MS = Number(process.env.CLAUDE_THING_ENDED_TTL_MS ?? 60_000);

export const MOCK_SESSIONS = process.env.CLAUDE_THING_MOCK === '1';

// Usage screen: real plan figures read from `claude -p "/usage"` once a minute.
export const USAGE_REFRESH_MS = 60_000;
