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
    // Typing is only synthesized into a window we know is showing this exact
    // session's prompt. A parked window is showing the job — but the daemon
    // cannot see what is on screen there, so it hands the keypress to the human.
    return viaHost
      ? { focused: true, app: 'Terminal', exact: false, tty, viaHost: true, reason: 'parked window raised' }
      : { focused: true, app: 'Terminal', exact: true, tty };
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

  return { focusSession, typeKey, lookupSession };
}
