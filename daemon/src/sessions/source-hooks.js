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
    const known = store.raw(id);
    // A session whose very first hook is SessionEnd was never on the grid, and
    // creating it now only adds a tile that is already dead. Short-lived
    // `claude` invocations — the daemon's own registry polls among them — end
    // this way, so this is the difference between a clean grid and a phantom
    // appearing every few seconds.
    if (!known && event === 'SessionEnd') return;
    const cwd = payload.cwd || '';
    // A hook's cwd is wherever the session currently is, which moves as the
    // agent cds around — so it must never overwrite a real name. The poller and
    // the session registry both carry the session's actual task name; the
    // directory basename is only a fallback for a session we have never named.
    const registryName = known && known.name ? null : (lookupSession(id) || {}).name;
    const base = { cwd: cwd || undefined };
    // The hook names the transcript's real path; remember it so the poller can
    // recognize this session as a real conversation even when the cwd-derived
    // path guess misses.
    if (payload.transcript_path) base.transcriptPath = payload.transcript_path;
    // Builds that put the current mode on the hook payload beat the transcript
    // record to it; ones that don't leave this undefined and the tail supplies
    // the mode a moment later.
    if (payload.permission_mode) base.permissionMode = String(payload.permission_mode);
    if (!known || !known.name) {
      base.name = registryName || (cwd ? path.basename(cwd) : undefined);
    }
    // Any hook but SessionEnd is proof of life. Ended sessions are deleted, not
    // flagged, so a session the poller dropped comes back as a fresh record —
    // this only has to make sure the flag never sticks on the way in.
    if (event !== 'SessionEnd') base.ended = false;
    ensureTail(store, id, payload.transcript_path || transcriptPathFor(id, cwd));

    switch (event) {
      case 'SessionStart':
        store.touch(id, { ...base, ended: false, startedTs: Date.now(), stoppedTs: null });
        break;
      case 'UserPromptSubmit':
        // The turn has begun and stays begun until Stop. Without this the
        // session reads idle through every pause for thought, because thinking
        // writes nothing and fires no hook.
        //
        // The prompt is also kept as lastPrompt: every ask raised during this
        // turn carries it as its intent line — a command without what you
        // asked for is an approval made blind. lastMessage gets overwritten by
        // the transcript tail as the turn progresses; this field does not.
        store.touch(id, {
          ...base, waitingForInput: false, stoppedTs: null, thinking: true,
          lastMessage: String(payload.prompt || '').slice(0, 200),
          lastPrompt: String(payload.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        });
        // A new prompt means no dialog is up. A declined plan or an Esc'd
        // question fires no PostToolUse, so this is where those asks die.
        if (queue) queue.onQuestionAnswered(payload);
        break;
      case 'PreToolUse':
        store.touch(id, { ...base, currentTool: payload.tool_name || null, stoppedTs: null, waitingForInput: false, thinking: true });
        // A multiple-choice question is a tool call, so this is where the
        // device learns about it — no hook can answer one, only surface it.
        if (queue && payload.tool_name === 'AskUserQuestion') {
          store.touch(id, { waitingForInput: true });
          queue.onQuestion(payload);
        }
        break;
      case 'PostToolUse':
        store.touch(id, { ...base, currentTool: null });
        // ExitPlanMode completing means the plan dialog was answered — the
        // plan ask came in through the permission bridge, but resolves here.
        if (queue && (payload.tool_name === 'AskUserQuestion' || payload.tool_name === 'ExitPlanMode')) {
          store.touch(id, { waitingForInput: false });
          queue.onQuestionAnswered(payload);
        }
        break;
      case 'Stop':
        // A finished turn is not a block. Flagging waitingForInput here made
        // attention win the state machine's first test, so every completed turn
        // rendered ATTENTION forever instead of DONE decaying to IDLE. Reserve
        // waitingForInput for real blocks: permission asks and AskUserQuestion.
        store.touch(id, { ...base, stoppedTs: Date.now(), currentTool: null, waitingForInput: false, thinking: false });
        // The turn ending also ends any dialog we still hold an ask for.
        if (queue) queue.onQuestionAnswered(payload);
        break;
      case 'Notification': {
        // Claude Code fires Notification for two unrelated things: a permission
        // ask, and a "still waiting for your input" nudge a minute after a turn
        // ends. The nudge is not a block — reading it as one flipped every
        // finished session back to ATTENTION once the DONE window had passed,
        // and nothing but the next prompt cleared it. Only the permission
        // flavour blocks, and this is the fallback for it: the connector's
        // permission bridge carries the real ask when it is installed.
        const asking = /permission|approve|allow|confirm/i.test(String(payload.message || ''));
        store.touch(id, asking ? { ...base, waitingForInput: true } : base);
        break;
      }
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
