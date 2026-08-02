// Walking a question ask. One AskUserQuestion call is one terminal dialog and
// may hold several questions; the device walks them locally and sends nothing
// until SUBMIT. An off-by-one anywhere in here types the wrong digit into
// somebody's terminal, which is why the transitions are pure and tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  questionsOf, rowCount, needsReview, answeredLabels, isPicked,
  startWalk, openQuestionAt, pressOptionAt, pressReviewAt, backStepAt,
} from '../src/answering.js';

const group = (over = {}) => ({
  kind: 'question', id: 'g1', createdTs: 0,
  questions: [
    { header: 'AUTH', question: 'How?', multiSelect: false,
      options: [{ label: 'OAuth' }, { label: 'API keys' }] },
    { header: 'ENVS', question: 'Which?', multiSelect: true,
      options: [{ label: 'Dev' }, { label: 'Staging' }, { label: 'Production' }] },
    { header: 'ROLLOUT', question: 'How fast?', multiSelect: false,
      options: [{ label: 'All at once' }, { label: 'Canary' }] },
  ],
  ...over,
});

const lone = () => ({
  kind: 'question', id: 'q1', createdTs: 0,
  questions: [{ header: 'PICK', question: 'Which?', multiSelect: false,
    options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }],
});

// The state the store hands these, with a walk already opened on `ask`.
function walking(ask, over = {}) {
  return { queueAnswering: true, ...startWalk(ask).fields, ...over };
}

test('a card carrying only the questions[0] mirrors still walks as a group of one', () => {
  const old = { kind: 'question', id: 'x', header: 'H', question: 'q?', multiSelect: true, options: [{ label: 'a' }] };
  const qs = questionsOf(old);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].header, 'H');
  assert.equal(qs[0].multiSelect, true, 'and keeps the flag that changes how it is answered');
});

test('a walk starts on the first question with nothing answered', () => {
  const s = walking(group());
  assert.equal(s.queueQIndex, 0);
  assert.equal(s.queueReview, false);
  assert.deepEqual(s.queueAnswers, [[], [], []], 'one slot per question');
});

test('rowCount matches what each step actually draws', () => {
  const ask = group();
  assert.equal(rowCount(ask, walking(ask)), 2, 'single-select: just its options');
  assert.equal(rowCount(ask, walking(ask, { queueQIndex: 1 })), 4, 'multiSelect adds DONE');
  assert.equal(rowCount(ask, walking(ask, { queueReview: true })), 4, 'review adds SUBMIT');
});

test('a single-select press records and moves straight on', () => {
  const ask = group();
  const step = pressOptionAt(ask, walking(ask), 1);
  assert.equal(step.submit, undefined, 'nothing is sent mid-walk');
  assert.deepEqual(step.fields.queueAnswers, [[1], [], []]);
  assert.equal(step.fields.queueQIndex, 1, 'and it is on the next question');
});

test('a multiSelect press toggles and stays put', () => {
  const ask = group();
  let s = walking(ask, { queueQIndex: 1 });

  s = { ...s, ...pressOptionAt(ask, s, 0).fields };
  s = { ...s, ...pressOptionAt(ask, s, 2).fields };
  assert.deepEqual(s.queueAnswers[1], [0, 2]);
  assert.equal(s.queueQIndex, 1, 'a toggle is not a commit');

  s = { ...s, ...pressOptionAt(ask, s, 0).fields };
  assert.deepEqual(s.queueAnswers[1], [2], 'pressing a picked option takes it back off');
  assert.equal(isPicked(s, 1, 2), true);
});

test('the DONE row is what moves a multiSelect question on', () => {
  const ask = group();
  const s = walking(ask, { queueQIndex: 1, queueAnswers: [[0], [1], []] });
  const step = pressOptionAt(ask, s, 3);
  assert.equal(step.fields.queueQIndex, 2);
  assert.deepEqual(step.fields.queueAnswers, [[0], [1], []], 'picks survive the move');
});

test('past the last question a group goes to review, not to the wire', () => {
  const ask = group();
  const s = walking(ask, { queueQIndex: 2, queueAnswers: [[0], [1], []] });
  const step = pressOptionAt(ask, s, 1);
  assert.equal(step.fields.queueReview, true);
  assert.equal(step.submit, undefined, 'the dialog is not typed into until SUBMIT');
  assert.equal(step.fields.queueChoice, 3, 'the cursor lands on SUBMIT');
});

test('a lone question is answered by its press — no review step in the way', () => {
  const ask = lone();
  assert.equal(needsReview(ask), false);
  const step = pressOptionAt(ask, walking(ask), 2);
  assert.deepEqual(step.submit, [[2]], 'one press, one send');
});

test('SUBMIT sends every answer as one set', () => {
  const ask = group();
  const s = walking(ask, { queueReview: true, queueAnswers: [[1], [0, 2], [1]] });
  const step = pressReviewAt(ask, s, 3);
  assert.deepEqual(step.submit, [[1], [0, 2], [1]]);
});

test('SUBMIT with a single-select still unanswered goes there instead of sending', () => {
  const ask = group();
  const s = walking(ask, { queueReview: true, queueAnswers: [[], [0], [1]] });
  const step = pressReviewAt(ask, s, 3);
  assert.equal(step.submit, undefined, 'the daemon would only refuse the set');
  assert.equal(step.fields.queueQIndex, 0, 'and it opens the one that is missing');
  assert.equal(step.incomplete, true, 'the caller says so out loud');
});

// The trap this used to be: toggle an option on, toggle it back off, and the
// question reads as unanswered — so SUBMIT bounced you into it forever with no
// press that could get you out. Nothing ticked IS the answer.
test('a multiSelect with nothing ticked submits — it is an answer, not a gap', () => {
  const ask = group();
  let s = walking(ask, { queueQIndex: 1, queueAnswers: [[0], [], [1]] });

  s = { ...s, ...pressOptionAt(ask, s, 0).fields };      // Dev on
  s = { ...s, ...pressOptionAt(ask, s, 0).fields };      // Dev off again
  assert.deepEqual(s.queueAnswers[1], [], 'back to nothing ticked');

  s = { ...s, ...pressOptionAt(ask, s, 3).fields };      // DONE still moves on
  assert.equal(s.queueQIndex, 2);
  s = { ...s, ...pressOptionAt(ask, s, 1).fields };      // last question -> review
  assert.equal(s.queueReview, true);

  const step = pressReviewAt(ask, s, 3);
  assert.deepEqual(step.submit, [[0], [], [1]], 'and SUBMIT sends it');
  assert.equal(step.incomplete, undefined);
});

// The whole reason answers are held on the device rather than typed as they
// are picked: until SUBMIT, every one of them is still changeable.
test('a review row reopens its question with the cursor on the current answer', () => {
  const ask = group();
  const s = walking(ask, { queueReview: true, queueAnswers: [[1], [0, 2], [1]] });
  const step = pressReviewAt(ask, s, 0);
  assert.equal(step.fields.queueQIndex, 0);
  assert.equal(step.fields.queueReview, false);
  assert.equal(step.fields.queueChoice, 1, 'sitting on what it is currently answered as');
});

test('changing an earlier answer keeps every other answer', () => {
  const ask = group();
  let s = walking(ask, { queueReview: true, queueAnswers: [[1], [0, 2], [1]] });
  s = { ...s, ...pressReviewAt(ask, s, 0).fields };
  s = { ...s, ...pressOptionAt(ask, s, 0).fields };
  assert.deepEqual(s.queueAnswers, [[0], [0, 2], [1]], 'only the one being edited changed');
});

// Coming from review is an edit, not a restart of the walk: the questions after
// it are already answered and are not what you came back to change.
test('answering a question opened from review returns straight to review', () => {
  const ask = group();
  let s = walking(ask, { queueReview: true, queueAnswers: [[1], [0, 2], [1]] });
  s = { ...s, ...pressReviewAt(ask, s, 0).fields };
  assert.equal(s.queueFromReview, true);

  const step = pressOptionAt(ask, s, 0);
  assert.equal(step.fields.queueReview, true, 'not question 2');
  assert.equal(step.fields.queueFromReview, false, 'and the edit is over');
});

test('a multiSelect edit returns to review on DONE, not on each toggle', () => {
  const ask = group();
  let s = walking(ask, { queueReview: true, queueAnswers: [[1], [0], [1]] });
  s = { ...s, ...pressReviewAt(ask, s, 1).fields };

  const toggled = pressOptionAt(ask, s, 2);
  assert.equal(toggled.fields.queueReview, undefined, 'a toggle is still just a toggle');
  s = { ...s, ...toggled.fields };
  assert.equal(pressOptionAt(ask, s, 3).fields.queueReview, true, 'DONE ends the edit');
});

test('back out of an edit returns to review too', () => {
  const ask = group();
  let s = walking(ask, { queueReview: true, queueAnswers: [[1], [0, 2], [1]] });
  s = { ...s, ...pressReviewAt(ask, s, 0).fields };
  assert.equal(backStepAt(ask, s).fields.queueReview, true,
    'back from an edit goes where you came from, not to the question before it');
});

test('back steps through the walk without discarding anything', () => {
  const ask = group();
  const answers = [[1], [0], []];

  const fromReview = backStepAt(ask, walking(ask, { queueReview: true, queueAnswers: answers }));
  assert.equal(fromReview.fields.queueQIndex, 2, 'review goes back to the last question');
  assert.equal(fromReview.fields.queueReview, false);

  const mid = backStepAt(ask, walking(ask, { queueQIndex: 1, queueAnswers: answers }));
  assert.equal(mid.fields.queueQIndex, 0);
  assert.equal(mid.fields.queueChoice, 1, 'with the cursor back on that answer');

  assert.equal(backStepAt(ask, walking(ask, { queueAnswers: answers })), null,
    'from the first question there is no step left — back closes the list');
});

test('a review row reads as every option it picked', () => {
  const ask = group();
  const s = walking(ask, { queueAnswers: [[1], [0, 2], []] });
  assert.equal(answeredLabels(ask, s, 0), 'API keys');
  assert.equal(answeredLabels(ask, s, 1), 'Dev · Production');
  assert.equal(answeredLabels(ask, s, 2), '', 'unanswered says nothing rather than guessing');
});

test('openQuestionAt puts an unanswered question at the top of its list', () => {
  const s = { queueAnswers: [[], [], []] };
  assert.equal(openQuestionAt(s, 2).fields.queueChoice, 0);
});
