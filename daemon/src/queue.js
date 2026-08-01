// Everything waiting on a human, in one list: tool permissions (held by the
// permission bridge) and multiple-choice questions (AskUserQuestion).
//
// Important asymmetry, verified against Claude Code:
//   • Permissions CAN be answered programmatically — the PermissionRequest
//     hook's response carries the decision.
//   • Questions CANNOT. No hook can supply a tool result, so answering one
//     from the device means focusing that terminal and typing the choice.
//     If macOS denies Automation, we focus the window and tell the user to
//     press the key themselves.
//   • Plan approval (ExitPlanMode) fires a PermissionRequest hook but IGNORES
//     the hook's decision — the terminal dialog stays up after behavior:"allow"
//     and the session stays blocked. So plans go through the question path:
//     surface on the device, answer by focus + keypress.

import crypto from 'node:crypto';
import { log } from './log.js';

// Overridable so tests can watch an ask time out without waiting ten minutes.
const QUESTION_TTL_MS = Number(process.env.CLAUDE_THING_QUESTION_TTL_MS ?? 10 * 60_000);
const MAX_EXPIRED = 32;

export function createQueue({ emit, store, focus }) {
  const questions = new Map();   // id -> ask
  const expired = new Map();     // id -> ask, timed out but still on screen

  function sessionName(sessionId) {
    const d = store.get(sessionId);
    return d ? d.name : 'session';
  }

  // Called from the PreToolUse hook when Claude asks a multiple-choice question.
  function onQuestion(payload) {
    const input = payload.tool_input || {};
    const list = Array.isArray(input.questions) ? input.questions : [];
    for (const q of list) {
      const id = crypto.randomUUID();
      const ask = {
        kind: 'question',
        id,
        sessionId: payload.session_id || null,
        sessionName: sessionName(payload.session_id),
        header: (q.header || 'QUESTION').toUpperCase(),
        question: String(q.question || '').slice(0, 300),
        options: (q.options || []).slice(0, 8).map((o) => ({
          label: String(o.label || '').slice(0, 60),
          description: String(o.description || '').slice(0, 120),
        })),
        multiSelect: !!q.multiSelect,
        createdTs: Date.now(),
      };
      if (!ask.options.length) continue;
      questions.set(id, ask);
      // unref: a pending question must never be the reason the process stays up
      setTimeout(() => expire(id), QUESTION_TTL_MS).unref();
      emit('claude.question.request', ask);
      log('QQ', `question queued: ${ask.header} (${ask.options.length} options)`);
    }
  }

  // Called from the PermissionRequest hook when Claude presents a plan. The
  // dialog's approve choices are always the first two entries, and picking
  // either is a single digit keypress — exactly a question. The decline paths
  // need typed feedback, so they stay on the keyboard.
  function onPlanApproval(payload) {
    const plan = String((payload.tool_input || {}).plan || '');
    const heading = plan.split('\n').find((l) => l.trim());
    const id = crypto.randomUUID();
    const ask = {
      kind: 'question',
      id,
      sessionId: payload.session_id || null,
      sessionName: sessionName(payload.session_id),
      header: 'PLAN',
      question: (heading || 'Ready to code?').replace(/^#+\s*/, '').slice(0, 300),
      options: [
        { label: 'Yes, bypass permissions', description: 'approve the plan and run without permission prompts' },
        { label: 'Yes, manually approve', description: 'approve the plan and confirm each edit' },
      ],
      multiSelect: false,
      createdTs: Date.now(),
    };
    questions.set(id, ask);
    setTimeout(() => expire(id), QUESTION_TTL_MS).unref();
    if (ask.sessionId) store.touch(ask.sessionId, { waitingForInput: true });
    emit('claude.question.request', ask);
    log('QQ', `plan queued: ${ask.question.slice(0, 60)}`);
  }

  // The terminal prompt is gone once the tool returns, so drop ours too.
  function onQuestionAnswered(payload) {
    const sessionId = payload.session_id;
    for (const [id, ask] of questions) {
      if (ask.sessionId === sessionId) {
        questions.delete(id);
        emit('claude.question.resolved', { id, resolution: 'answered' });
      }
    }
    // A timed-out ask the terminal has now answered is finished for good; it
    // must not linger as something the device can still raise a window for.
    for (const [id, ask] of expired) {
      if (ask.sessionId === sessionId) {
        expired.delete(id);
        emit('claude.question.resolved', { id, resolution: 'answered' });
      }
    }
  }

  // A timed-out question leaves the queue but stays on the device on purpose —
  // it is still up in the terminal, and the card is how you get back to it. So
  // keep the ask itself around: pressing an expired card must still raise that
  // window rather than report a generic failure. Bounded, and only until the
  // ask is twice as old as the TTL that retired it.
  function expire(id) {
    const ask = questions.get(id);
    if (!ask) return;
    questions.delete(id);
    expired.set(id, ask);
    while (expired.size > MAX_EXPIRED) expired.delete(expired.keys().next().value);
    setTimeout(() => expired.delete(id), QUESTION_TTL_MS).unref();
    emit('claude.question.resolved', { id, resolution: 'timeout' });
  }

  async function answerQuestion(id, optionIndex) {
    const ask = questions.get(id) || expired.get(id);
    if (!ask) {
      log('QQ', `answer refused: ${id.slice(0, 8)} already resolved`);
      return { accepted: false, reason: 'already resolved' };
    }
    const timedOut = !questions.has(id);
    const option = ask.options[optionIndex];
    if (!option) return { accepted: false, reason: 'no such option' };

    // Focus first so the keystroke — or the user's own keypress — lands in the
    // right window.
    const f = ask.sessionId
      ? await focus.focusSession(ask.sessionId)
      : { focused: false, reason: 'unknown session' };

    let typed = { typed: false, reason: 'not attempted' };
    if (f.focused && f.exact) {
      // Claude Code's menus take the option number as a single keypress.
      typed = await focus.typeKey(String(optionIndex + 1));
    }

    if (typed.typed) {
      questions.delete(id);
      expired.delete(id);
      emit('claude.question.resolved', { id, resolution: 'answered' });
      log('QQ', `answered by keypress: ${ask.header} → ${option.label}`);
      return { accepted: true, viaKeyboard: true, option: option.label };
    }

    // Focused but could not type: the human finishes it, and the ask stays in
    // the queue until the PostToolUse hook says it was answered.
    const res = {
      accepted: f.focused,
      viaKeyboard: false,
      option: option.label,
      focused: f.focused,
      timedOut,
      // when focus itself failed, that is the reason worth reporting
      reason: f.focused ? (typed.reason || 'could not type') : f.reason,
    };
    // Every outcome is logged: a device that says it could not answer must
    // leave behind the reason it could not, on the machine that decided.
    log('QQ', `answer ${f.focused ? 'focused' : 'failed'}${timedOut ? ' (timed out)' : ''}: ${res.reason}`);
    return res;
  }

  function list() {
    return [...questions.values()].sort((a, b) => a.createdTs - b.createdTs);
  }

  return { onQuestion, onPlanApproval, onQuestionAnswered, answerQuestion, list, size: () => questions.size };
}
