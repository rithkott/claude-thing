// Bring a session's terminal window to the front, as if the user clicked it.
//
// Chain: session_id → ~/.claude/sessions/<pid>.json → pid → tty → Terminal.app
// tab. Terminal.app is the only mainstream emulator that exposes `tty` on its
// tabs, so other emulators fall back to raising the app.
//
// Permissions: raising Terminal needs Automation → Terminal. Typing a keystroke
// additionally needs Automation → System Events, which macOS may deny. When it
// is denied we say so and stop — the window is focused, and the user finishes
// on the keyboard. We never try to work around a denied permission.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { CLAUDE_DIR } from './config.js';
import { log } from './log.js';

const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');

// Pause between keys of a typed sequence, in seconds. Long enough for Claude
// Code's dialog to advance to the next question before the next digit lands.
const KEY_GAP_S = 0.15;

// The non-printing keys a question dialog needs, as System Events key codes.
const KEY_CODES = { return: 36, tab: 48 };

function osa(script, timeout = 5000) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout }, (err, stdout, stderr) => {
      const text = String(stderr || '');
      if (err) {
        const denied = text.includes('-1743') || text.includes('Not authorized');
        resolve({ ok: false, denied, error: text.trim().split('\n')[0] || err.message });
      } else {
        resolve({ ok: true, out: String(stdout).trim() });
      }
    });
  });
}

function ps(args) {
  return new Promise((resolve) => {
    execFile('ps', args, { timeout: 4000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout).trim());
    });
  });
}

function readRegistry(dir = SESSIONS_DIR) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    } catch {}
  }
  return out;
}

// session_id -> {pid, cwd, kind, name} from Claude Code's own registry
export function lookupSession(sessionId, dir = SESSIONS_DIR) {
  for (const rec of readRegistry(dir)) {
    if (rec.sessionId === sessionId) return rec;
  }
  return null;
}

// A background job is not always windowless. When an interactive session hands
// its turn to one it writes `parkedJobId` into its own registry file, and while
// parked that window *is* the job's UI — the question the device is answering is
// on screen there. So before declaring a background agent unfocusable, look for
// the window parked on it and raise that instead.
//
// The job id is the short form of the background session's id, carried as
// `jobId`; older records only have the sessionId, hence the prefix match.
export function hostWindowFor(rec, dir = SESSIONS_DIR) {
  if (!rec) return null;
  const jobId = String(rec.jobId || '');
  const sid = String(rec.sessionId || '');
  if (!jobId && !sid) return null;
  for (const other of readRegistry(dir)) {
    if (other.kind !== 'interactive' || !other.parkedJobId) continue;
    const parked = String(other.parkedJobId);
    if (parked === jobId || parked === sid || (parked && sid.startsWith(parked))) return other;
  }
  return null;
}

async function ttyFor(pid) {
  const out = await ps(['-o', 'tty=', '-p', String(pid)]);
  const t = out.trim();
  if (!t || t === '??') return null;
  return t.startsWith('/dev/') ? t : `/dev/${t}`;
}

// walk up the process tree to whichever app owns the terminal
async function ownerApp(pid) {
  let current = pid;
  for (let i = 0; i < 8; i++) {
    const out = await ps(['-o', 'ppid=,comm=', '-p', String(current)]);
    if (!out) return null;
    const [ppidStr, ...commParts] = out.trim().split(/\s+/);
    const comm = commParts.join(' ');
    if (/Terminal\.app/.test(comm)) return 'Terminal';
    if (/iTerm/.test(comm)) return 'iTerm2';
    if (/Ghostty/.test(comm)) return 'Ghostty';
    if (/WezTerm/.test(comm)) return 'WezTerm';
    if (/Code Helper|Visual Studio Code/.test(comm)) return 'Code';
    const ppid = Number(ppidStr);
    if (!ppid || ppid <= 1) return null;
    current = ppid;
  }
  return null;
}

const TERMINAL_RAISE = (tty) => `
tell application "Terminal"
  set matched to false
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${tty}" then
        set selected of t to true
        set frontmost of w to true
        set matched to true
      end if
    end repeat
  end repeat
  if matched then activate
  return matched
end tell`;

export function createFocus() {
  let automationDenied = false;   // sticky: a denied TCC row never re-prompts

  // There is one keyboard and one frontmost window, so there can be one of
  // these at a time. Nothing else enforces it: the hub handles every socket
  // frame in its own task, so two answers arriving close together used to run
  // their focus-then-type concurrently and interleave keystrokes into whatever
  // window happened to be in front — digits meant for one session landing in
  // another's terminal.
  //
  // Anything that raises a window or types must run inside this, and a
  // focus-then-type pair must be ONE call to it: a bare focus slipping between
  // the two halves is the same bug.
  let chain = Promise.resolve();
  function exclusive(fn) {
    const run = chain.then(() => fn());
    // The chain must survive a failed turn, so it tracks completion, not result.
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function focusSession(sessionId) {
    const rec = lookupSession(sessionId);
    if (!rec) return { focused: false, reason: 'no session registry entry' };

    // A background job borrows the window that parked on it, if one did.
    let target = rec;
    let viaHost = false;
    if (rec.kind && rec.kind !== 'interactive') {
      const host = hostWindowFor(rec);
      if (!host) return { focused: false, reason: 'background agent — no window to focus' };
      target = host;
      viaHost = true;
    }

    const tty = await ttyFor(target.pid);
    if (!tty) {
      return {
        focused: false,
        reason: viaHost ? 'background agent — parked window is gone' : 'session has no tty',
      };
    }

    const app = await ownerApp(target.pid);
    if (app && app !== 'Terminal') {
      // Only Terminal.app exposes tty per tab; raise the app and say so.
      const r = await osa(`tell application "${app}" to activate`);
      return r.ok
        ? { focused: true, app, exact: false, reason: `${app} raised (tab targeting unsupported)` }
        : { focused: false, reason: r.denied ? `automation denied for ${app}` : r.error };
    }

    const r = await osa(TERMINAL_RAISE(tty));
    if (!r.ok) {
      if (r.denied) {
        automationDenied = true;
        return {
          focused: false,
          reason: 'macOS denied Automation for Terminal — allow it in System Settings › Privacy & Security › Automation',
        };
      }
      return { focused: false, reason: r.error };
    }
    if (r.out !== 'true') return { focused: false, reason: 'no Terminal tab owns that tty' };
    log('FC', `focused ${target.name || sessionId.slice(0, 8)} (${tty})${viaHost ? ' [parked host]' : ''}`);
    // A parked window is the job's window: whatever the job is asking is what
    // is on screen there, so the keypress belongs to it exactly as much as it
    // belongs to a session's own tab. Anything less means walking to the Mac,
    // which is the one thing the device exists to avoid.
    return { focused: true, app: 'Terminal', exact: true, tty, viaHost };
  }

  // Types a single character into the focused window. Requires Automation →
  // System Events; if macOS denies it we report that and leave the prompt to
  // the keyboard rather than attempting any other injection route.
  async function typeKey(char) {
    if (automationDenied) return { typed: false, reason: 'automation denied' };
    const safe = String(char).slice(0, 1).replace(/["\\]/g, '');
    if (!safe) return { typed: false, reason: 'nothing to type' };
    const r = await osa(`tell application "System Events" to keystroke "${safe}"`);
    if (r.ok) return { typed: true };
    if (r.denied) {
      return {
        typed: false,
        reason: 'macOS denied Automation for System Events — allow it in System Settings › Privacy & Security › Automation',
      };
    }
    return { typed: false, reason: r.error };
  }

  // Types a whole sequence into the focused window in ONE osascript call.
  // One call on purpose: a multi-question dialog needs several keys landing in
  // the same window, and re-invoking osascript per key opens a gap where focus
  // can move and half the answer lands somewhere else.
  //
  // A key is either a single character (sent as `keystroke`) or one of the
  // named non-printing keys below. The delay between keys is what lets the TUI
  // redraw and move to the next question before the following key arrives.
  async function typeSequence(keys) {
    if (automationDenied) return { typed: false, reason: 'automation denied' };
    const lines = [];
    for (const key of keys) {
      if (lines.length) lines.push(`  delay ${KEY_GAP_S}`);
      if (KEY_CODES[key] !== undefined) {
        lines.push(`  key code ${KEY_CODES[key]}`);
        continue;
      }
      const safe = String(key).slice(0, 1).replace(/["\\]/g, '');
      if (!safe) return { typed: false, reason: 'nothing to type' };
      lines.push(`  keystroke "${safe}"`);
    }
    if (!lines.length) return { typed: false, reason: 'nothing to type' };

    const script = ['tell application "System Events"', ...lines, 'end tell'].join('\n');
    const r = await osa(script, 3000 + keys.length * 400);
    if (r.ok) return { typed: true };
    if (r.denied) {
      return {
        typed: false,
        reason: 'macOS denied Automation for System Events — allow it in System Settings › Privacy & Security › Automation',
      };
    }
    return { typed: false, reason: r.error };
  }

  // focusSession/typeKey/typeSequence are the primitives and do NOT take the
  // lock themselves — that would deadlock the focus-then-type pair, which has
  // to hold it across both. Callers wrap them in exclusive().
  return { exclusive, focusSession, typeKey, typeSequence, lookupSession };
}
