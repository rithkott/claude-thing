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
// Daemon state that outlives the process (see persist.js). Overridable so tests
// never touch the real one.
export const STATE_DIR = process.env.CLAUDE_THING_STATE_DIR || path.join(DAEMON_ROOT, '.state');

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
// The Bluetooth relay cannot split a *synchronous* response across its 2000-byte
// chunks (carthing-knowledge/daemon.md), so a sessions.list response must fit
// one chunk: 2000 minus ~160 of response envelope + snapshot fields, over a
// worst-case ~355-byte SessionSummary (measured by chunk-fit.test.js), is four
// sessions. Relay-role clients that forget to pass a limit get this cap instead
// of a response that silently never arrives; the full grid follows as a chunked
// async snapshot push.
export const BT_SAFE_SESSION_LIMIT = 4;
export const SNAPSHOT_DEBOUNCE_MS = 500;
// Detail events are per-session and fire on every store write. A streaming
// transcript writes several times a second, and every write used to go out as
// its own claude.session.update — the device full-repaints per frame, so N busy
// sessions multiplied into a render flood that froze the UI. Per-session
// trailing debounce: the latest state still arrives within a blink, the flood
// does not. Ended sessions bypass this — that farewell must not lose a race
// with the record's deletion.
export const DETAIL_DEBOUNCE_MS = 200;
// A snapshot whose content hasn't changed still used to go out every 5s (the
// state re-derive tick), repainting every connected screen overnight. Unchanged
// snapshots are skipped, but not forever: one still goes out at this interval
// so the device's clock-skew correction (serverNowMs) stays fresh.
export const SNAPSHOT_HEARTBEAT_MS = 30_000;
export const BUSY_WINDOW_MS = 10_000;    // activity within this = busy
// A finished turn is worth glancing at, and twenty seconds was shorter than the
// time it takes to look up at the device. A minute is long enough to notice.
export const CELEBRATE_MS = 60_000;      // celebrate decays to idle after this
export const POLL_INTERVAL_MS = 3_000;   // claude agents --json poll
// One listing is a claim, not a verdict. The registry is rewritten by every
// claude process on the machine — including the daemon's own usage and poll
// invocations — so a single read can catch it mid-write and come back empty or
// partial. Retiring on one such read wiped the whole grid for a poll interval.
// A session must be missing from this many consecutive good polls before it is
// retired (cost: a genuinely-gone session lingers one extra interval)...
export const RETIRE_AFTER_MISSED_POLLS = 2;
// ...and a listing that claims *nothing at all* is alive while the store says
// otherwise is suspect enough to ignore entirely this many times in a row
// before its absences start counting.
export const EMPTY_LISTING_GRACE_POLLS = 1;
// The registry's "working" verdict is the only thing that stays true while the
// model thinks and nothing is being written. Trust it for a few poll intervals
// so one dropped poll doesn't blink a working session to idle.
export const AGENT_ACTIVE_TTL_MS = 3 * POLL_INTERVAL_MS;
// A turn normally ends at the Stop hook. If that never arrives — session killed
// mid-thought, hooks not installed — this stops the tile from claiming to work
// forever. Long enough not to cut off a genuinely slow turn.
export const THINKING_TTL_MS = 10 * 60_000;
// Ended sessions are dropped the instant they end — no grace period. A tile you
// can't act on is noise, and a lingering headstone reads as a live session.

export const MOCK_SESSIONS = process.env.CLAUDE_THING_MOCK === '1';

// Usage screen: real plan figures read from `claude -p "/usage"` once a minute.
export const USAGE_REFRESH_MS = 60_000;
