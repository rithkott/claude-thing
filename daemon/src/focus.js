// Bring a session's terminal window to the front, as if the user clicked it.
//
// Chain: session_id → ~/.claude/sessions/<pid>.json → pid → tty → Terminal.app
// tab. Terminal.app is the only emulator that exposes `tty` on its tabs.
//
// Ghostty gets there another way. Its scripting dictionary has no tty, but it
// does expose every terminal surface's title, and Claude Code titles a window
// with the `ai-title` it writes into that session's transcript. Matching the
// two identifies the surface exactly, and Ghostty's `focus` command raises its
// window and selects its tab in one step. Emulators with neither route still
// fall back to raising the app.
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
import { transcriptPathFor } from './sessions/tails.js';
import { log } from './log.js';

const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');

// Transcripts run to megabytes and the title is rewritten as the conversation
// moves, so the newest one is near the end. Read the tail first and only fall
// back to the whole file when a short-lived session titled itself early and
// then wrote past the window.
const TITLE_TAIL_BYTES = 256 * 1024;

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

// The last `ai-title` Claude Code wrote for a session — the string it also
// sets as the terminal title. Returns null for anything unreadable; a missing
// title only costs exactness, never correctness.
export function lastAiTitle(transcriptPath) {
  if (!transcriptPath) return null;
  const scan = (text) => {
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('"ai-title"')) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'ai-title' && obj.aiTitle) return String(obj.aiTitle);
      } catch {}
    }
    return null;
  };
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size > TITLE_TAIL_BYTES) {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const buf = Buffer.alloc(TITLE_TAIL_BYTES);
        fs.readSync(fd, buf, 0, TITLE_TAIL_BYTES, size - TITLE_TAIL_BYTES);
        // The first line of the window is almost certainly cut in half.
        const text = buf.toString('utf8');
        const found = scan(text.slice(text.indexOf('\n') + 1));
        if (found) return found;
      } finally {
        fs.closeSync(fd);
      }
    }
    return scan(fs.readFileSync(transcriptPath, 'utf8'));
  } catch {
    return null;
  }
}

// Claude Code prefixes the title with a status glyph that changes while the
// session works ("✳ ", "⠂ "), so only the body is stable enough to match on.
function titleBody(s) {
  return String(s || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

// `tab` inside a `tell application "Ghostty"` block resolves to Ghostty's own
// `tab` class rather than the character, and concatenates as the literal text
// "tab". Hence a separator built outside the block — unit separator, which no
// path or window title contains.
const SEP = '';

export function parseGhosttySurfaces(out) {
  const rows = [];
  for (const line of String(out || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(SEP);
    if (parts.length < 3) continue;
    rows.push({
      id: parts[0].trim(),
      cwd: parts[1].trim(),
      title: parts.slice(2).join(SEP).trim(),
    });
  }
  return rows;
}

// Which surface is this session? Title is the identifying signal; cwd only
// breaks a tie or stands in when the session has not been titled yet. Two
// candidates it cannot separate return null rather than a guess — raising the
// wrong tab is worse than raising the app, because `exact` also licenses a
// keystroke.
export function pickGhosttySurface(surfaces, { aiTitle, cwd } = {}) {
  const list = Array.isArray(surfaces) ? surfaces : [];
  if (aiTitle) {
    const want = titleBody(aiTitle);
    const hits = want ? list.filter((s) => titleBody(s.title) === want) : [];
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const narrowed = cwd ? hits.filter((s) => s.cwd === cwd) : [];
      return narrowed.length === 1 ? narrowed[0] : null;
    }
  }
  if (cwd) {
    const hits = list.filter((s) => s.cwd === cwd);
    if (hits.length === 1) return hits[0];
  }
  return null;
}

const GHOSTTY_LIST = `
set sep to character id 31
tell application "Ghostty"
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      set trm to focused terminal of t
      set d to ""
      try
        set d to working directory of trm
      end try
      set out to out & (id of trm) & sep & d & sep & (name of trm) & linefeed
    end repeat
  end repeat
  return out
end tell`;

const GHOSTTY_FOCUS = (id) => `
tell application "Ghostty"
  repeat with w in windows
    repeat with t in tabs of w
      set trm to focused terminal of t
      if (id of trm) is "${id}" then
        focus trm
        return "true"
      end if
    end repeat
  end repeat
  return "false"
end tell`;

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

  // Resolve a session to one Ghostty surface and focus it. Returns null when
  // the surface cannot be identified, which leaves the caller free to fall
  // back to raising the app.
  async function focusGhostty(target, viaHost) {
    const aiTitle = lastAiTitle(transcriptPathFor(target.sessionId, target.cwd));
    const listed = await osa(GHOSTTY_LIST);
    if (!listed.ok) {
      if (listed.denied) automationDenied = true;
      return null;
    }
    const surface = pickGhosttySurface(parseGhosttySurfaces(listed.out), {
      aiTitle,
      cwd: target.cwd,
    });
    if (!surface) return null;
    const r = await osa(GHOSTTY_FOCUS(surface.id.replace(/["\\]/g, '')));
    if (!r.ok || r.out !== 'true') return null;
    log('FC', `focused ${target.name || String(target.sessionId).slice(0, 8)} (ghostty ${surface.id.slice(0, 8)})${viaHost ? ' [parked host]' : ''}`);
    return { focused: true, app: 'Ghostty', exact: true, surfaceId: surface.id, viaHost };
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
    if (app === 'Ghostty') {
      const hit = await focusGhostty(target, viaHost);
      if (hit) return hit;
      // Nothing matched, or Ghostty would not say — fall through and raise it
      // like any other emulator rather than failing the press outright.
    }
    if (app && app !== 'Terminal') {
      // No per-tab handle for this emulator; raise the app and say so.
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

  return { focusSession, typeKey, lookupSession };
}
