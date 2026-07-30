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

import crypto from 'node:crypto';
import { log } from './log.js';

const QUESTION_TTL_MS = 10 * 60_000;

export function createQueue({ emit, store, focus }) {
  const questions = new Map();   // id -> ask

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

  // The terminal prompt is gone once the tool returns, so drop ours too.
  function onQuestionAnswered(payload) {
    const sessionId = payload.session_id;
    for (const [id, ask] of questions) {
      if (ask.sessionId === sessionId) {
        questions.delete(id);
        emit('claude.question.resolved', { id, resolution: 'answered' });
      }
    }
  }

  function expire(id) {
    if (!questions.has(id)) return;
    questions.delete(id);
    emit('claude.question.resolved', { id, resolution: 'timeout' });
  }

  async function answerQuestion(id, optionIndex) {
    const ask = questions.get(id);
    if (!ask) return { accepted: false, reason: 'already resolved' };
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
      emit('claude.question.resolved', { id, resolution: 'answered' });
      return { accepted: true, viaKeyboard: true, option: option.label };
    }

    // Focused but could not type: the human finishes it, and the ask stays in
    // the queue until the PostToolUse hook says it was answered.
    return {
      accepted: f.focused,
      viaKeyboard: false,
      option: option.label,
      focused: f.focused,
      // when focus itself failed, that is the reason worth reporting
      reason: f.focused ? (typed.reason || 'could not type') : f.reason,
    };
  }

  function list() {
    return [...questions.values()].sort((a, b) => a.createdTs - b.createdTs);
  }

  return { onQuestion, onQuestionAnswered, answerQuestion, list, size: () => questions.size };
}
