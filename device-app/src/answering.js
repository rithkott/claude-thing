// Walking one question ask.
//
// An AskUserQuestion tool call is ONE terminal dialog that may hold several
// questions, and the dialog ends on a "Submit answers" step. So the device
// walks the questions locally, holds every pick, and sends nothing until that
// submit — which is also what makes going back and changing an earlier answer
// possible at all.
//
// This module is the step model both the renderer and the input handlers read,
// so the cursor can never span a different number of rows than the screen drew.

// Older daemons send only the questions[0] mirrors; a card built from one still
// walks through here as a group of one.
export function questionsOf(ask) {
  if (ask && ask.questions && ask.questions.length) return ask.questions;
  if (!ask) return [];
  return [{
    header: ask.header,
    question: ask.question,
    options: ask.options || [],
    multiSelect: !!ask.multiSelect,
  }];
}

export function currentQuestion(ask, state) {
  var qs = questionsOf(ask);
  return qs[Math.min(state.queueQIndex, qs.length - 1)] || null;
}

export function picksAt(state, i) {
  return (state.queueAnswers && state.queueAnswers[i]) || [];
}

export function isPicked(state, i, option) {
  var picks = picksAt(state, i);
  for (var p = 0; p < picks.length; p++) if (picks[p] === option) return true;
  return false;
}

// A multiSelect question needs a row that means "these are my picks, move on",
// because pressing an option toggles it rather than committing it.
export function hasDoneRow(q) {
  return !!(q && q.multiSelect);
}

// How many rows the cursor spans in whatever step is on screen. Review adds a
// SUBMIT row after the questions; a multiSelect question adds its DONE row.
export function rowCount(ask, state) {
  var qs = questionsOf(ask);
  if (state.queueReview) return qs.length + 1;
  var q = currentQuestion(ask, state);
  return (q ? q.options.length : 0) + (hasDoneRow(q) ? 1 : 0);
}

// The review step exists to let you go back over a set of answers before it is
// sent. A single question has no set — pressing its option is the whole
// decision, and interposing a confirm screen would cost a press for nothing.
export function needsReview(ask) {
  return questionsOf(ask).length > 1;
}

// ---- transitions ------------------------------------------------------------
//
// Pure: each takes the ask and the current state and returns the fields to
// update, plus `submit` — the answers to send — when the walk is over. Pure so
// the state machine is testable without a browser, which matters more here than
// anywhere else on the device: an off-by-one in the walk types the wrong digit
// into somebody's terminal.

export function startWalk(ask) {
  var answers = [];
  var qs = questionsOf(ask);
  for (var i = 0; i < qs.length; i++) answers.push([]);
  return { fields: {
    queueAnswering: true, queueChoice: 0, queueQIndex: 0, queueAnswers: answers,
    queueReview: false, queueFromReview: false,
  } };
}

// Move to a question, putting the cursor on what it is already answered as, so
// coming back to change an answer starts from that answer.
export function openQuestionAt(state, qi, fromReview) {
  var picks = picksAt(state, qi);
  return { fields: {
    queueQIndex: qi,
    queueReview: false,
    queueFromReview: !!fromReview,
    queueChoice: picks.length ? picks[0] : 0,
  } };
}

function toReview(ask, answers) {
  return { fields: {
    queueAnswers: answers, queueReview: true, queueFromReview: false,
    queueChoice: questionsOf(ask).length,
  } };
}

// Past the last question: a group goes to review, a lone question is simply
// answered — interposing a confirm step there would cost a press for nothing.
//
// One question reached FROM the review step is an edit, not a walk: answering
// it goes straight back to review rather than marching through the questions
// after it, which were already answered and were not what you came to change.
function advance(ask, qi, answers, fromReview) {
  var qs = questionsOf(ask);
  if (fromReview && needsReview(ask)) return toReview(ask, answers);
  if (qi + 1 < qs.length) {
    var next = openQuestionAt({ queueAnswers: answers }, qi + 1);
    next.fields.queueAnswers = answers;
    return next;
  }
  if (needsReview(ask)) return toReview(ask, answers);
  return { fields: { queueAnswers: answers }, submit: answers.slice() };
}

// A press on a row of the open option list. A single-select question records
// and moves on; a multiSelect toggles and stays, and the DONE row below its
// options is what moves on.
export function pressOptionAt(ask, state, row) {
  var qs = questionsOf(ask);
  var qi = Math.min(state.queueQIndex, qs.length - 1);
  var q = qs[qi];
  if (!q) return { fields: {} };

  var answers = state.queueAnswers.slice();
  if (row >= q.options.length) {
    return hasDoneRow(q) ? advance(ask, qi, answers, state.queueFromReview) : { fields: {} };
  }
  if (!hasDoneRow(q)) {
    answers[qi] = [row];
    return advance(ask, qi, answers, state.queueFromReview);
  }
  var picks = [];
  var was = picksAt(state, qi);
  for (var i = 0; i < was.length; i++) if (was[i] !== row) picks.push(was[i]);
  if (picks.length === was.length) picks.push(row);
  answers[qi] = picks;
  return { fields: { queueAnswers: answers, queueChoice: row } };
}

// A press on the review step: a question row reopens it, SUBMIT sends — unless
// something is still unanswered, in which case it goes there instead of sending
// a set the daemon would only refuse.
export function pressReviewAt(ask, state, row) {
  var qs = questionsOf(ask);
  if (row < qs.length) return openQuestionAt(state, row, true);
  // A single-select question with no pick is genuinely unfinished. A
  // multiSelect with none picked is an ANSWER — "none of these" — and turning
  // one into the other is how the walk used to trap you: toggle an option on
  // and back off, and SUBMIT bounced you here forever with no way out.
  for (var i = 0; i < qs.length; i++) {
    if (!qs[i].multiSelect && !picksAt(state, i).length) {
      var go = openQuestionAt(state, i, true);
      go.incomplete = true;
      return go;
    }
  }
  return { fields: {}, submit: state.queueAnswers.slice() };
}

// Back never discards answers: it steps to the previous question with its pick
// still on it, and returns null from the first question — where back means
// close the list, which is the caller's business. A question opened from review
// goes back to review, not to the question before it: that is where you were.
export function backStepAt(ask, state) {
  if (!state.queueAnswering || !ask || ask.kind !== 'question') return null;
  if (state.queueReview) return openQuestionAt(state, questionsOf(ask).length - 1);
  if (state.queueFromReview) return toReview(ask, state.queueAnswers);
  if (state.queueQIndex > 0) return openQuestionAt(state, state.queueQIndex - 1);
  return null;
}

export function answeredLabels(ask, state, i) {
  var qs = questionsOf(ask);
  var q = qs[i];
  if (!q) return '';
  var picks = picksAt(state, i);
  var out = [];
  for (var p = 0; p < picks.length; p++) {
    var o = q.options[picks[p]];
    if (o) out.push(o.label);
  }
  return out.join(' · ');
}
