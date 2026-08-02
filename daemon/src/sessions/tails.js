// One transcript tail per session, shared by the hooks and poller sources.
// Two tails on the same file would double-count tokens, so everything goes
// through this registry.

import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_PROJECTS_DIR } from '../config.js';
import { startTranscriptTail } from './source-transcript.js';

const tails = new Map(); // sessionId -> handle

// Esc in the terminal fires no hook, so the transcript tail is the only place
// an interrupt is visible. Whoever owns the ask queue registers here; the
// registry is module-level because both the hooks source and the poller create
// tails and neither holds the queue.
let onInterrupt = null;
export function setTailInterruptHandler(fn) { onInterrupt = fn; }

// Claude Code stores transcripts at
// ~/.claude/projects/<cwd with non-alphanumerics replaced by '-'>/<sessionId>.jsonl
export function transcriptPathFor(sessionId, cwd) {
  if (!cwd) return null;
  const dir = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
}

export function ensureTail(store, sessionId, transcriptPath) {
  if (!transcriptPath || tails.has(sessionId)) return;
  if (!fs.existsSync(transcriptPath)) return;
  tails.set(sessionId, startTranscriptTail({
    store, sessionId, transcriptPath,
    onInterrupt: (ts) => { if (onInterrupt) onInterrupt(sessionId, ts); },
  }));
}

export function stopTail(sessionId) {
  const t = tails.get(sessionId);
  if (t) { t.stop(); tails.delete(sessionId); }
}

export function stopAllTails() {
  for (const t of tails.values()) t.stop();
  tails.clear();
}
