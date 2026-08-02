import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, keySequence } from '../src/queue.js';
import { createStore } from '../src/sessions/store.js';

function setup(focusBehaviour = {}) {
  const events = [];
  const store = createStore();
  store.touch('sess-1', { name: 'my-project' });
  const calls = { focus: 0, typed: [] };

  // A real serializer, not a pass-through: the ordering it enforces is the
  // thing under test, so the stub must not paper over it.
  let chain = Promise.resolve();

  const focus = {
    exclusive(fn) {
      const run = chain.then(() => fn());
      chain = run.then(() => {}, () => {});
      return run;
    },
    async focusSession() {
      calls.focus++;
      if (focusBehaviour.beforeFocus) await focusBehaviour.beforeFocus();
      return focusBehaviour.focus || { focused: true, exact: true, app: 'Terminal' };
    },
    async typeKey(ch) {
      calls.typed.push(ch);
      return focusBehaviour.type || { typed: true };
    },
    async typeSequence(keys) {
      for (const k of keys) calls.typed.push(k);
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

// One AskUserQuestion call, three questions, one of them multiSelect — the
// shape that used to fan out into three cards and strand the dialog on its
// "Submit answers" step.
const MULTI_HOOK = {
  session_id: 'sess-1',
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [
      {
        header: 'Auth method',
        question: 'How should callers authenticate?',
        options: [{ label: 'OAuth' }, { label: 'API keys' }, { label: 'mTLS' }],
      },
      {
        header: 'Environments',
        question: 'Which environments get it?',
        multiSelect: true,
        options: [{ label: 'Dev' }, { label: 'Staging' }, { label: 'Production' }],
      },
      {
        header: 'Rollout',
        question: 'How fast?',
        options: [{ label: 'All at once' }, { label: 'Canary' }],
      },
    ],
  },
};

test('a multi-question tool call is ONE ask carrying every question', () => {
  const { queue, events } = setup();
  queue.onQuestion(MULTI_HOOK);

  assert.equal(queue.size(), 1, 'one dialog is one card');
  const requests = events.filter((e) => e.topic === 'claude.question.request');
  assert.equal(requests.length, 1);
  const ask = requests[0].data;
  assert.equal(ask.questions.length, 3);
  assert.equal(ask.questions[1].multiSelect, true);
  assert.equal(ask.questions[2].options.length, 2);
  assert.equal(ask.header, 'AUTH METHOD', 'mirrors questions[0]');
  assert.equal(ask.options.length, 3, 'mirrors questions[0]');
});

test('a question with no options is dropped, and its siblings survive', () => {
  const { queue } = setup();
  queue.onQuestion({
    session_id: 'sess-1',
    tool_input: {
      questions: [
        { header: 'Empty', question: 'unanswerable', options: [] },
        { header: 'Real', question: 'answerable', options: [{ label: 'ok' }] },
      ],
    },
  });
  const [ask] = queue.list();
  assert.equal(ask.questions.length, 1);
  assert.equal(ask.header, 'REAL');
});

test('answering a group types every digit and the Submit Return', async () => {
  const { queue, calls } = setup();
  queue.onQuestion(MULTI_HOOK);
  const [ask] = queue.list();

  const res = await queue.answerQuestion(ask.id, [[0], [0, 2], [1]]);
  assert.equal(res.accepted, true);
  assert.equal(res.viaKeyboard, true);
  assert.deepEqual(calls.typed, [
    '1',                  // Auth method → OAuth, advances on its own
    '1', '3', 'tab',      // Environments → Dev + Production, Tab moves on
    '2',                  // Rollout → Canary, advances itself
    'return',             // the "Submit answers" step
  ]);
  assert.equal(res.option, 'OAuth · Dev + Production · Canary');
  assert.equal(queue.size(), 0);
});

// Nothing ticked is an answer, and the sequence for it is the move-on key
// alone. Refusing it stranded the device with a set it could never submit.
test('a multiSelect answered with nothing ticked types no digits, just the move on', async () => {
  const { queue, calls } = setup();
  queue.onQuestion(MULTI_HOOK);
  const [ask] = queue.list();

  const res = await queue.answerQuestion(ask.id, [[1], [], [0]]);
  assert.equal(res.accepted, true);
  assert.deepEqual(calls.typed, ['2', 'tab', '1', 'return']);
  assert.equal(res.option, 'API keys · none · All at once');
});

test('the sequence is the final answer, never a replay of the toggling', () => {
  // Whatever the user did to arrive at {Dev, Production}, the terminal sees
  // two digits and a commit — a stray digit would flip a settled option.
  assert.deepEqual(
    keySequence([{ multiSelect: true }], [[0, 2]]),
    ['1', '3', 'tab'],
  );
});

test('keySequence: a lone question gets no trailing Return', () => {
  assert.deepEqual(keySequence([{ multiSelect: false }], [[2]]), ['3'],
    'the digit picks and advances; a trailing Return would answer whatever came next');
  // A lone multiSelect still needs a key to leave the list, but a
  // one-question dialog hides the Submit tab, so there is no submit step for
  // a trailing Return to take. Whether Tab moves anywhere with the tab strip
  // hidden is the one part of the mapping not read out of the CLI.
  assert.deepEqual(keySequence([{ multiSelect: true }], [[0, 1]]), ['1', '2', 'tab']);
});

test('an answer set that does not match the questions is refused', async () => {
  const { queue, calls } = setup();
  queue.onQuestion(MULTI_HOOK);
  const [ask] = queue.list();

  const cases = [
    [[[0], [1]], 'too few answers'],
    [[[0], [1], [0], [0]], 'too many answers'],
    [[[0], [1], [9]], 'option out of range'],
    [[[0, 1], [1], [0]], 'two picks on a single-select question'],
    [[[0], [1], []], 'no pick on a single-select question'],
    [[[0], [1, 1], [0]], 'the same option twice would toggle it back off'],
  ];
  for (const [answers, why] of cases) {
    const res = await queue.answerQuestion(ask.id, answers);
    assert.equal(res.accepted, false, why);
    assert.equal(res.reason, 'bad answer shape', why);
  }
  assert.deepEqual(calls.typed, [], 'nothing is typed until the whole set is valid');
  assert.equal(queue.size(), 1, 'and the ask is still answerable');
});

// There is one keyboard and one frontmost window. The hub handles every socket
// frame in its own task, so two answers arriving together used to run their
// focus-then-type concurrently — keystrokes interleaving into whichever window
// was in front, which across sessions means digits in the wrong terminal.
test('two answers at once are typed one after the other, never interleaved', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  let first = true;
  const { queue, calls } = setup({
    // The first answer stalls inside its focus, exactly where a slow or wedged
    // osascript would. Nothing else may type while it is in there.
    beforeFocus: () => {
      if (!first) return Promise.resolve();
      first = false;
      return held;
    },
  });
  queue.onQuestion(QUESTION_HOOK);
  queue.onQuestion({ ...QUESTION_HOOK, tool_input: {
    questions: [{ header: 'Second', question: 'later?', options: [{ label: 'a' }, { label: 'b' }] }],
  } });
  const [a, b] = queue.list();

  const pa = queue.answerQuestion(a.id, [[0]]);
  const pb = queue.answerQuestion(b.id, [[1]]);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.focus, 1, 'the second answer has not even focused yet');
  assert.deepEqual(calls.typed, [], 'and nothing has been typed');

  release();
  await Promise.all([pa, pb]);
  assert.deepEqual(calls.typed, ['1', '2'], 'in order, one sequence then the other');
  assert.equal(calls.focus, 2);
});

test('an answer resolved while it waited its turn types nothing', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  let first = true;
  const { queue, calls } = setup({
    beforeFocus: () => {
      if (!first) return Promise.resolve();
      first = false;
      return held;
    },
  });
  queue.onQuestion(QUESTION_HOOK);
  queue.onQuestion({ ...QUESTION_HOOK, tool_input: {
    questions: [{ header: 'Second', question: 'later?', options: [{ label: 'a' }, { label: 'b' }] }],
  } });
  const [a, b] = queue.list();

  const pa = queue.answerQuestion(a.id, [[0]]);
  const pb = queue.answerQuestion(b.id, [[1]]);
  await new Promise((r) => setImmediate(r));   // a is inside its turn, b is behind it
  // The terminal answers the whole session itself while b is queued behind a.
  queue.onQuestionAnswered({ session_id: 'sess-1' });
  release();
  await pa;

  const res = await pb;
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'already resolved',
    'typing into a dialog that is gone answers whatever replaced it');
  assert.deepEqual(calls.typed, ['1'], 'only the answer that got there first');
});

test('a turn that throws does not wedge every answer behind it', async () => {
  let first = true;
  const { queue, calls } = setup({
    beforeFocus: () => {
      if (!first) return Promise.resolve();
      first = false;
      return Promise.reject(new Error('osascript exploded'));
    },
  });
  queue.onQuestion(QUESTION_HOOK);
  queue.onQuestion({ ...QUESTION_HOOK, tool_input: {
    questions: [{ header: 'Second', question: 'later?', options: [{ label: 'a' }, { label: 'b' }] }],
  } });
  const [a, b] = queue.list();

  await assert.rejects(queue.answerQuestion(a.id, [[0]]));
  const res = await queue.answerQuestion(b.id, [[1]]);
  assert.equal(res.accepted, true);
  assert.deepEqual(calls.typed, ['2'], 'the chain survived the failed turn');
});

test('the terminal answering it clears our copy', () => {
  const { queue, events } = setup();
  queue.onQuestion(QUESTION_HOOK);
  queue.onQuestionAnswered({ session_id: 'sess-1' });
  assert.equal(queue.size(), 0);
  const resolved = events.find((e) => e.topic === 'claude.question.resolved');
  assert.equal(resolved.data.resolution, 'answered');
});

const PLAN_HOOK = {
  session_id: 'sess-1',
  tool_name: 'ExitPlanMode',
  tool_input: { plan: '# Fix: session tiles vanish\n\n## Context\n\nlots of detail' },
};

test('a plan approval becomes a question with the two approve choices', () => {
  const { queue, events, store } = setup();
  queue.onPlanApproval(PLAN_HOOK);

  const ev = events.find((e) => e.topic === 'claude.question.request');
  assert.ok(ev);
  assert.equal(ev.data.kind, 'question', 'renders on the device like any question');
  assert.equal(ev.data.header, 'PLAN');
  assert.equal(ev.data.question, 'Fix: session tiles vanish', 'plan heading, hashes stripped');
  assert.equal(ev.data.options.length, 2, 'only the approve paths — declining needs typed feedback');
  assert.match(ev.data.options[0].label, /bypass permissions/);
  assert.match(ev.data.options[1].label, /manually approve/);
  assert.equal(store.get('sess-1').state, 'attention', 'session shows as blocked');
});

test('answering a plan types the digit of the chosen approve option', async () => {
  const { queue, calls } = setup();
  queue.onPlanApproval(PLAN_HOOK);
  const [ask] = queue.list();

  const res = await queue.answerQuestion(ask.id, 1);
  assert.equal(res.accepted, true);
  assert.deepEqual(calls.typed, ['2'], 'option index 1 is keypress "2"');
  assert.equal(queue.size(), 0);
});

test('a plan with no heading still queues with a fallback question', () => {
  const { queue } = setup();
  queue.onPlanApproval({ ...PLAN_HOOK, tool_input: { plan: '' } });
  const [ask] = queue.list();
  assert.equal(ask.question, 'Ready to code?');
});

test('the terminal answering the plan dialog clears our copy too', () => {
  const { queue } = setup();
  queue.onPlanApproval(PLAN_HOOK);
  queue.onQuestionAnswered({ session_id: 'sess-1' });
  assert.equal(queue.size(), 0);
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

test('a question and a plan both carry the intent line when a prompt is known', () => {
  const { queue, events, store } = setup();
  store.touch('sess-1', { lastPrompt: 'migrate the schema' });
  queue.onQuestion(QUESTION_HOOK);
  const q = events.find((e) => e.topic === 'claude.question.request');
  assert.equal(q.data.intent, 'you asked: migrate the schema');
  assert.equal(queue.list()[0].intent, 'you asked: migrate the schema');

  events.length = 0;
  queue.onPlanApproval({ session_id: 'sess-1', tool_input: { plan: '# Plan\ndo it' } });
  const p = events.find((e) => e.topic === 'claude.question.request');
  assert.equal(p.data.intent, 'you asked: migrate the schema');
});

test('no prompt seen: the ask goes out with an empty intent', () => {
  const { queue, events } = setup();
  queue.onQuestion(QUESTION_HOOK);
  const q = events.find((e) => e.topic === 'claude.question.request');
  assert.equal(q.data.intent, '');
});

test('an Esc interrupt after the ask retires it', () => {
  const { queue, events } = setup();
  queue.onQuestion(QUESTION_HOOK);
  assert.equal(queue.size(), 1);

  queue.onInterrupted('sess-1', Date.now() + 1);
  assert.equal(queue.size(), 0);
  const resolved = events.find((e) => e.topic === 'claude.question.resolved');
  assert.equal(resolved.data.resolution, 'interrupted');
});

test('a replayed interrupt marker older than the ask leaves it alone', () => {
  const { queue, events } = setup();
  queue.onQuestion(QUESTION_HOOK);

  queue.onInterrupted('sess-1', Date.now() - 60_000);
  assert.equal(queue.size(), 1, 'catch-up replay of an old marker must not kill a fresh ask');
  assert.ok(!events.some((e) => e.topic === 'claude.question.resolved'));
});

test('an interrupt for another session is not ours to act on', () => {
  const { queue } = setup();
  queue.onQuestion(QUESTION_HOOK);
  queue.onInterrupted('sess-other', Date.now() + 1);
  assert.equal(queue.size(), 1);
});
