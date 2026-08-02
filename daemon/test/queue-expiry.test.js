// A timed-out question leaves the queue but stays on the device, so pressing it
// must still do the one thing left: raise the terminal that is still asking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

// Short enough to watch a timeout, long enough that the tombstone the ask
// moves into (kept for another TTL) is still there when the test presses it.
process.env.CLAUDE_THING_QUESTION_TTL_MS = '200';
const { createQueue } = await import('../src/queue.js');
const { createStore } = await import('../src/sessions/store.js');

function setup(focusResult = { focused: true, exact: false, app: 'Terminal' }) {
  const events = [];
  const store = createStore();
  store.touch('sess-1', { name: 'my-project' });
  const calls = { typed: [] };
  const focus = {
    async focusSession() { return focusResult; },
    async typeKey(ch) { calls.typed.push(ch); return { typed: true }; },
    async typeSequence(keys) { for (const k of keys) calls.typed.push(k); return { typed: true }; },
  };
  const queue = createQueue({ emit: (topic, data) => events.push({ topic, data }), store, focus });
  return { queue, events, calls };
}

const HOOK = {
  session_id: 'sess-1',
  tool_input: {
    questions: [{
      header: 'Migration',
      question: 'How should the schema change be applied?',
      options: [{ label: 'Online', description: 'no downtime' }, { label: 'Window', description: 'downtime' }],
    }],
  },
};

async function queueThenExpire() {
  const s = setup();
  s.queue.onQuestion(HOOK);
  const [ask] = s.queue.list();
  await sleep(260);
  return { ...s, ask };
}

test('a timed-out question still focuses its window when answered', async () => {
  const { queue, ask } = await queueThenExpire();
  assert.equal(queue.size(), 0, 'gone from the queue');

  const res = await queue.answerQuestion(ask.id, 0);
  assert.equal(res.accepted, true, 'the window was raised');
  assert.equal(res.timedOut, true, 'and says the ask had already timed out');
  assert.equal(res.option, 'Online');
});

test('a timed-out question can still be typed into when focus is exact', async () => {
  const s = setup({ focused: true, exact: true, app: 'Terminal' });
  s.queue.onQuestion(HOOK);
  const [ask] = s.queue.list();
  await sleep(260);

  const res = await s.queue.answerQuestion(ask.id, 1);
  assert.equal(res.viaKeyboard, true);
  assert.deepEqual(s.calls.typed, ['2']);
  assert.equal((await s.queue.answerQuestion(ask.id, 1)).reason, 'already resolved', 'not answerable twice');
});

test('the terminal answering a timed-out question retires it for good', async () => {
  const { queue, ask, events } = await queueThenExpire();
  queue.onQuestionAnswered({ session_id: 'sess-1' });

  assert.ok(
    events.some((e) => e.topic === 'claude.question.resolved' && e.data.resolution === 'answered'),
    'the device is told to drop the card',
  );
  assert.equal((await queue.answerQuestion(ask.id, 0)).reason, 'already resolved');
});

test('an Esc interrupt retires a timed-out ask for good — no window left to raise', async () => {
  const { queue, ask, events } = await queueThenExpire();
  queue.onInterrupted('sess-1', Date.now());

  assert.ok(
    events.some((e) => e.topic === 'claude.question.resolved' && e.data.resolution === 'interrupted'),
    'the device is told to drop the card',
  );
  assert.equal((await queue.answerQuestion(ask.id, 0)).reason, 'already resolved',
    'pressing the dead card must not focus a window with no dialog in it');
});

test('an unknown id is still refused', async () => {
  const { queue } = setup();
  const res = await queue.answerQuestion('11111111-2222-3333-4444-555555555555', 0);
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'already resolved');
});
