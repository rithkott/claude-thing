import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../src/queue.js';
import { createStore } from '../src/sessions/store.js';

function setup(focusBehaviour = {}) {
  const events = [];
  const store = createStore();
  store.touch('sess-1', { name: 'my-project' });
  const calls = { focus: 0, typed: [] };

  const focus = {
    async focusSession() {
      calls.focus++;
      return focusBehaviour.focus || { focused: true, exact: true, app: 'Terminal' };
    },
    async typeKey(ch) {
      calls.typed.push(ch);
      return focusBehaviour.type || { typed: true };
    },
  };

  const queue = createQueue({ emit: (topic, data) => events.push({ topic, data }), store, focus });
  return { queue, events, calls, store };
}

const QUESTION_HOOK = {
  session_id: 'sess-1',
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [{
      header: 'Migration',
      question: 'How should the schema change be applied?',
      multiSelect: false,
      options: [
        { label: 'Online migration', description: 'No downtime.' },
        { label: 'Maintenance window', description: 'Fast, some downtime.' },
      ],
    }],
  },
};

test('a question becomes a queued ask with its options', () => {
  const { queue, events } = setup();
  queue.onQuestion(QUESTION_HOOK);

  const ev = events.find((e) => e.topic === 'claude.question.request');
  assert.ok(ev);
  assert.equal(ev.data.kind, 'question');
  assert.equal(ev.data.header, 'MIGRATION');
  assert.equal(ev.data.sessionName, 'my-project');
  assert.equal(ev.data.options.length, 2);
  assert.equal(ev.data.options[0].label, 'Online migration');
  assert.equal(queue.size(), 1);
});

test('questions with no options are ignored', () => {
  const { queue, events } = setup();
  queue.onQuestion({ session_id: 'sess-1', tool_input: { questions: [{ question: 'hm', options: [] }] } });
  assert.equal(queue.size(), 0);
  assert.equal(events.length, 0);
});

test('long labels and huge option lists are clamped for the BT link', () => {
  const { queue } = setup();
  queue.onQuestion({
    session_id: 'sess-1',
    tool_input: {
      questions: [{
        question: 'q'.repeat(500),
        options: Array.from({ length: 20 }, (_, i) => ({
          label: `l${i}`.padEnd(120, 'x'),
          description: 'd'.repeat(400),
        })),
      }],
    },
  });
  const [ask] = queue.list();
  assert.equal(ask.options.length, 8, 'option list capped');
  assert.equal(ask.question.length, 300, 'question clamped');
  assert.equal(ask.options[0].label.length, 60, 'label clamped');
  assert.equal(ask.options[0].description.length, 120, 'description clamped');
});

test('answering focuses the session and types the option number', async () => {
  const { queue, calls, events } = setup();
  queue.onQuestion(QUESTION_HOOK);
  const [ask] = queue.list();

  const res = await queue.answerQuestion(ask.id, 1);
  assert.equal(res.accepted, true);
  assert.equal(res.viaKeyboard, true);
  assert.equal(res.option, 'Maintenance window');
  assert.equal(calls.focus, 1);
  assert.deepEqual(calls.typed, ['2'], 'option index 1 is keypress "2"');
  assert.equal(queue.size(), 0, 'resolved once typed');
  assert.ok(events.some((e) => e.topic === 'claude.question.resolved'));
});

test('when typing is denied the ask stays for the human, and says why', async () => {
  const { queue } = setup({ type: { typed: false, reason: 'macOS denied Automation for System Events' } });
  queue.onQuestion(QUESTION_HOOK);
  const [ask] = queue.list();

  const res = await queue.answerQuestion(ask.id, 0);
  assert.equal(res.accepted, true, 'the window was still focused');
  assert.equal(res.viaKeyboard, false);
  assert.match(res.reason, /denied/);
  assert.equal(queue.size(), 1, 'stays queued until the terminal answers it');
});

test('with no window to focus, the focus reason is what surfaces', async () => {
  const { queue, calls } = setup({ focus: { focused: false, reason: 'background agent — no window to focus' } });
  queue.onQuestion(QUESTION_HOOK);
  const [ask] = queue.list();

  const res = await queue.answerQuestion(ask.id, 0);
  assert.equal(res.accepted, false);
  assert.match(res.reason, /background agent/, 'not masked by "not attempted"');
  assert.deepEqual(calls.typed, [], 'never tries to type into a window it could not raise');
});

test('a bad option index or unknown id is refused', async () => {
  const { queue } = setup();
  queue.onQuestion(QUESTION_HOOK);
  const [ask] = queue.list();
  assert.equal((await queue.answerQuestion(ask.id, 99)).accepted, false);
  assert.equal((await queue.answerQuestion('nope', 0)).accepted, false);
});

test('the terminal answering it clears our copy', () => {
  const { queue, events } = setup();
  queue.onQuestion(QUESTION_HOOK);
  queue.onQuestionAnswered({ session_id: 'sess-1' });
  assert.equal(queue.size(), 0);
  const resolved = events.find((e) => e.topic === 'claude.question.resolved');
  assert.equal(resolved.data.resolution, 'answered');
});

test('list is oldest-first', () => {
  const { queue } = setup();
  queue.onQuestion(QUESTION_HOOK);
  queue.onQuestion({ ...QUESTION_HOOK, tool_input: {
    questions: [{ header: 'Second', question: 'later?', options: [{ label: 'ok' }] }],
  } });
  const asks = queue.list();
  assert.equal(asks.length, 2);
  assert.ok(asks[0].createdTs <= asks[1].createdTs);
});
