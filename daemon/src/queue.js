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
//
// One AskUserQuestion tool call carries a LIST of questions and is ONE dialog:
// the terminal walks its questions in order and ends on a "Submit answers"
// step. So it is one ask here too. Splitting it per question — which this
// used to do — left that submit step with no card, no keypress, and the
// session blocked forever on a dialog every question of which was answered.

import crypto from 'node:crypto';
import { log } from './log.js';

// Overridable so tests can watch an ask time out without waiting ten minutes.
const QUESTION_TTL_MS = Number(process.env.CLAUDE_THING_QUESTION_TTL_MS ?? 10 * 60_000);
const MAX_EXPIRED = 32;

// The keys Claude Code's question dialog takes, in one place, because this is
// the part of the system that cannot be derived from anything in this repo —
// it is the terminal UI's contract. Read out of the CLI itself (2.1.220), not
// guessed:
//
//   • single-select question — the option's digit picks it AND advances. Its
//     onAnswer defaults shouldAdvance to true, which bumps
//     currentQuestionIndex, so nothing else is needed to move on.
//
//   • multiSelect question — each digit TOGGLES its option and the dialog
//     stays put. Return does NOT commit: inside the list it activates the row
//     under the cursor, so a Return here just toggles option 1 again. The
//     list's own move-on control is a button below the options labelled
//     "Next" (or "Submit" on the last question), reachable only by walking the
//     cursor down past every option and the "Other" row. TAB is the way out
//     that does not depend on where the cursor is: a multi-question dialog
//     draws a tab strip and hints "Tab/Arrow keys to navigate", and tabs:next
//     is bound whenever the dialog is not inside a text input.
//
//   • after the last question — the tab strip's final tab is "✓ Submit", which
//     draws a "Review your answers" screen ending in a Submit answers /
//     Cancel confirm. Return takes it. A one-question dialog hides that tab
//     entirely and must not get a trailing Return.
//
// The sequence is the FINAL answer, never a replay of how the user got there.
// The device's own toggling — on, off, on again — has no business reaching the
// terminal: each stray digit would flip an option the user had already settled,
// and the sequence has to land the dialog in the state shown on the review
// step and then finish it.
export function keySequence(questions, answers) {
  const keys = [];
  questions.forEach((q, i) => {
    for (const pick of answers[i]) keys.push(String(pick + 1));
    // A single-select question has already advanced itself on the digit.
    if (q.multiSelect) keys.push('tab');
  });
  if (questions.length > 1) keys.push('return');
  return keys;
}

// Answers arrive as number[][] — one entry per question, each the option
// indices chosen for it. A pre-group client sending a bare optionIndex still
// works, as long as the ask really is one single-select question.
function normalizeAnswers(raw, questions) {
  const list = Array.isArray(raw) ? raw : [[raw]];
  if (list.length !== questions.length) return null;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const picks = Array.isArray(list[i]) ? list[i] : [list[i]];
    const q = questions[i];
    // A single-select question is exactly one option. A multiSelect may be
    // none — "none of these" is an answer, and refusing it left the device
    // with a set it could never submit.
    if (!q.multiSelect && picks.length !== 1) return null;
    for (const p of picks) {
      if (!Number.isInteger(p) || p < 0 || p >= q.options.length) return null;
    }
    // A repeated index would toggle an option off again; the device never
    // sends one, and honouring it would type a key that undoes itself.
    if (new Set(picks).size !== picks.length) return null;
    out.push(picks);
  }
  return out;
}

function shapeQuestion(q) {
  const options = (q.options || []).slice(0, 8).map((o) => ({
    label: String(o.label || '').slice(0, 60),
    description: String(o.description || '').slice(0, 120),
  }));
  return {
    header: (q.header || 'QUESTION').toUpperCase(),
    question: String(q.question || '').slice(0, 300),
    options,
    multiSelect: !!q.multiSelect,
  };
}

export function createQueue({ emit, store, focus }) {
  const questions = new Map();   // id -> ask
  const expired = new Map();     // id -> ask, timed out but still on screen

  function sessionName(sessionId) {
    const d = store.get(sessionId);
    return d ? d.name : 'session';
  }

  // What the user asked for, carried on every ask as its intent line. Empty
  // when no prompt has been seen; the device then omits the line.
  function intentFor(sessionId) {
    const s = sessionId && store.raw(sessionId);
    return s && s.lastPrompt ? `you asked: ${s.lastPrompt}` : '';
  }

  // One ask per dialog: every question the tool call carries rides on the same
  // card, and the device answers them all before anything is typed. A question
  // with no options can't be answered by a keypress, so it is dropped — and if
  // that leaves nothing, so is the whole ask.
  //
  // The top-level header/question/options/multiSelect mirror questions[0]. They
  // are what a client that predates grouping reads, and they keep the card's
  // summary line derivable without unwrapping the list.
  function onQuestion(payload) {
    const input = payload.tool_input || {};
    const list = (Array.isArray(input.questions) ? input.questions : [])
      .map(shapeQuestion)
      .filter((q) => q.options.length);
    if (!list.length) return;

    const id = crypto.randomUUID();
    const ask = {
      kind: 'question',
      id,
      sessionId: payload.session_id || null,
      sessionName: sessionName(payload.session_id),
      intent: intentFor(payload.session_id),
      questions: list,
      header: list[0].header,
      question: list[0].question,
      options: list[0].options,
      multiSelect: list[0].multiSelect,
      createdTs: Date.now(),
    };
    questions.set(id, ask);
    // unref: a pending question must never be the reason the process stays up
    setTimeout(() => expire(id), QUESTION_TTL_MS).unref();
    emit('claude.question.request', ask);
    log('QQ', `question queued: ${ask.header} (${list.length} question${list.length === 1 ? '' : 's'})`);
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
      intent: intentFor(payload.session_id),
      questions: [shapeQuestion({
        header: 'PLAN',
        question: (heading || 'Ready to code?').replace(/^#+\s*/, ''),
        options: [
          { label: 'Yes, bypass permissions', description: 'approve the plan and run without permission prompts' },
          { label: 'Yes, manually approve', description: 'approve the plan and confirm each edit' },
        ],
      })],
      createdTs: Date.now(),
    };
    // A plan is one question, so the mirrors are the whole card — and being one
    // question is what keeps it a single digit with no trailing Return.
    ask.header = ask.questions[0].header;
    ask.question = ask.questions[0].question;
    ask.options = ask.questions[0].options;
    ask.multiSelect = false;
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

  // Esc kills the terminal dialog without firing any hook — no PostToolUse, no
  // Stop — so the transcript tail's interrupt marker lands here. Unlike a
  // timeout, an interrupted ask is dead everywhere: the dialog is gone from the
  // terminal, so it leaves the expired map too — nothing to raise a window for.
  // Only asks older than the marker die: the tail replays the whole transcript
  // on catch-up, and a stale marker must not kill a fresh ask.
  function onInterrupted(sessionId, ts) {
    for (const map of [questions, expired]) {
      for (const [id, ask] of map) {
        if (ask.sessionId === sessionId && ask.createdTs <= ts) {
          map.delete(id);
          emit('claude.question.resolved', { id, resolution: 'interrupted' });
          log('QQ', `question interrupted: ${ask.header}`);
        }
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

  async function answerQuestion(id, rawAnswers) {
    const ask = questions.get(id) || expired.get(id);
    if (!ask) {
      log('QQ', `answer refused: ${id.slice(0, 8)} already resolved`);
      return { accepted: false, reason: 'already resolved' };
    }
    const timedOut = !questions.has(id);
    // Validate the whole answer set before touching the keyboard: a sequence
    // that is wrong halfway through leaves a half-answered dialog, which is
    // strictly worse than refusing it here.
    const answers = normalizeAnswers(rawAnswers, ask.questions);
    if (!answers) return { accepted: false, reason: 'bad answer shape' };
    const chosen = ask.questions
      .map((q, i) => answers[i].map((p) => q.options[p].label).join(' + ') || 'none')
      .join(' · ');

    // Focus first so the keystrokes — or the user's own — land in the right
    // window.
    const f = ask.sessionId
      ? await focus.focusSession(ask.sessionId)
      : { focused: false, reason: 'unknown session' };

    const keys = keySequence(ask.questions, answers);
    let typed = { typed: false, reason: 'not attempted' };
    if (f.focused && f.exact) {
      typed = await focus.typeSequence(keys);
    }

    if (typed.typed) {
      questions.delete(id);
      expired.delete(id);
      emit('claude.question.resolved', { id, resolution: 'answered' });
      log('QQ', `answered by keypress [${keys.join(' ')}]: ${ask.header} → ${chosen}`);
      return { accepted: true, viaKeyboard: true, option: chosen, keys };
    }

    // Focused but could not type: the human finishes it, and the ask stays in
    // the queue until the PostToolUse hook says it was answered. The sequence
    // is logged either way — a dialog left part-typed must leave behind what
    // was typed, on the machine that typed it.
    const res = {
      accepted: f.focused,
      viaKeyboard: false,
      option: chosen,
      questionCount: ask.questions.length,
      focused: f.focused,
      timedOut,
      // when focus itself failed, that is the reason worth reporting
      reason: f.focused ? (typed.reason || 'could not type') : f.reason,
    };
    // Every outcome is logged: a device that says it could not answer must
    // leave behind the reason it could not, on the machine that decided.
    log('QQ', `answer ${f.focused ? 'focused' : 'failed'}${timedOut ? ' (timed out)' : ''} [${keys.join(' ')}]: ${res.reason}`);
    return res;
  }

  function list() {
    return [...questions.values()].sort((a, b) => a.createdTs - b.createdTs);
  }

  return { onQuestion, onPlanApproval, onQuestionAnswered, onInterrupted, answerQuestion, list, size: () => questions.size };
}
