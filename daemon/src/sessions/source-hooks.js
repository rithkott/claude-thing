// Ingests Claude Code hook events POSTed to /hook and keeps the store current.
// Transcript tailing is shared with the poller through the tails registry.

import path from 'node:path';
import { ensureTail, stopTail, stopAllTails, transcriptPathFor } from './tails.js';
import { isOwnSession } from '../own-sessions.js';
import { lookupSession } from '../focus.js';
import { log } from '../log.js';

export function startHooksSource({ store, queue }) {
  function onHookEvent(event, payload) {
    const id = payload.session_id;
    if (!id || isOwnSession(id)) return;
    const cwd = payload.cwd || '';
    // A hook's cwd is wherever the session currently is, which moves as the
    // agent cds around — so it must never overwrite a real name. The poller and
    // the session registry both carry the session's actual task name; the
    // directory basename is only a fallback for a session we have never named.
    const known = store.raw(id);
    const registryName = known && known.name ? null : (lookupSession(id) || {}).name;
    const base = { cwd: cwd || undefined };
    if (!known || !known.name) {
      base.name = registryName || (cwd ? path.basename(cwd) : undefined);
    }
    ensureTail(store, id, payload.transcript_path || transcriptPathFor(id, cwd));

    switch (event) {
      case 'SessionStart':
        store.touch(id, { ...base, ended: false, startedTs: Date.now(), stoppedTs: null });
        break;
      case 'UserPromptSubmit':
        store.touch(id, { ...base, waitingForInput: false, stoppedTs: null, lastMessage: String(payload.prompt || '').slice(0, 200) });
        break;
      case 'PreToolUse':
        store.touch(id, { ...base, currentTool: payload.tool_name || null, stoppedTs: null, waitingForInput: false });
        // A multiple-choice question is a tool call, so this is where the
        // device learns about it — no hook can answer one, only surface it.
        if (queue && payload.tool_name === 'AskUserQuestion') {
          store.touch(id, { waitingForInput: true });
          queue.onQuestion(payload);
        }
        break;
      case 'PostToolUse':
        store.touch(id, { ...base, currentTool: null });
        if (queue && payload.tool_name === 'AskUserQuestion') {
          queue.onQuestionAnswered(payload);
        }
        break;
      case 'Stop':
        store.touch(id, { ...base, stoppedTs: Date.now(), currentTool: null, waitingForInput: true });
        break;
      case 'Notification':
        store.touch(id, { ...base, waitingForInput: true });
        break;
      case 'SessionEnd':
        store.upsert(id, { ...base, ended: true, currentTool: null, waitingForInput: false });
        stopTail(id);
        break;
      default:
        store.touch(id, base);
    }
    log('HK', `${event} ${id.slice(0, 8)}`);
  }

  return { onHookEvent, stop: stopAllTails };
}
