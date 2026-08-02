// Run with CLAUDE_THING_HOLD_MS small so the timeout path is testable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPermissionBridge } from '../src/permission-bridge.js';
import { createStore } from '../src/sessions/store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stands in for the held HTTP response of a PermissionRequest hook.
function fakeRes() {
  const res = {
    body: null,
    status: null,
    closed: false,
    handlers: {},
    writeHead(code) { this.status = code; },
    end(body) { this.body = body; },
    on(event, fn) { this.handlers[event] = fn; },
  };
  return res;
}

function decisionOf(res) {
  return JSON.parse(res.body).hookSpecificOutput.decision.behavior;
}

function setup(queue) {
  const events = [];
  const store = createStore();
  const bridge = createPermissionBridge({
    emit: (topic, data) => events.push({ topic, data }),
    store,
    queue,
  });
  return { bridge, store, events };
}

const HOOK = {
  session_id: 'sess-1',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf node_modules' },
  cwd: '/tmp/proj',
};

test('a held request emits a request event and marks the session', () => {
  const { bridge, store, events } = setup();
  bridge.onHookRequest(HOOK, fakeRes());

  const req = events.find((e) => e.topic === 'claude.permission.request');
  assert.ok(req, 'emitted claude.permission.request');
  assert.equal(req.data.tool, 'Bash');
  assert.equal(req.data.summary, 'rm -rf node_modules', 'summary is the argument, not tool-prefixed');
  assert.ok(req.data.requestId);
  assert.equal(store.get('sess-1').pendingPermission, true);
});

test('allow answers the hook with allow and clears the session', () => {
  const { bridge, store, events } = setup();
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);
  const { requestId } = events.find((e) => e.topic === 'claude.permission.request').data;

  assert.equal(bridge.answer(requestId, 'allow'), true);
  assert.equal(decisionOf(res), 'allow');
  assert.equal(res.status, 200);
  assert.equal(store.get('sess-1').pendingPermission, false);

  const resolved = events.find((e) => e.topic === 'claude.permission.resolved');
  assert.equal(resolved.data.resolution, 'allow');
});

test('deny answers the hook with deny', () => {
  const { bridge, events } = setup();
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);
  const { requestId } = events.find((e) => e.topic === 'claude.permission.request').data;
  bridge.answer(requestId, 'deny');
  assert.equal(decisionOf(res), 'deny');
});

test('answering twice is idempotent — the second is refused', () => {
  const { bridge, events } = setup();
  bridge.onHookRequest(HOOK, fakeRes());
  const { requestId } = events.find((e) => e.topic === 'claude.permission.request').data;
  assert.equal(bridge.answer(requestId, 'allow'), true);
  assert.equal(bridge.answer(requestId, 'deny'), false);
});

test('an unknown requestId is refused, not thrown', () => {
  const { bridge } = setup();
  assert.equal(bridge.answer('nope', 'allow'), false);
});

test('a bad decision is rejected', () => {
  const { bridge, events } = setup();
  bridge.onHookRequest(HOOK, fakeRes());
  const { requestId } = events.find((e) => e.topic === 'claude.permission.request').data;
  assert.throws(() => bridge.answer(requestId, 'maybe'), /allow\|deny/);
});

test('timing out answers "ask" so the terminal decides — it never auto-denies', async () => {
  const { bridge, store, events } = setup();
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);

  await sleep(Number(process.env.CLAUDE_THING_HOLD_MS) + 60);

  assert.equal(decisionOf(res), 'ask', 'must hand back to the terminal');
  const resolved = events.find((e) => e.topic === 'claude.permission.resolved');
  assert.equal(resolved.data.resolution, 'timeout');
  assert.equal(store.get('sess-1').pendingPermission, false);
});

test('pending requests are listable for clients that connect late', () => {
  const { bridge, store } = setup();
  store.touch('sess-1', { name: 'proj' });
  bridge.onHookRequest(HOOK, fakeRes());

  const [ask] = bridge.list();
  assert.equal(ask.kind, 'permission');
  assert.equal(ask.sessionName, 'proj');
  assert.equal(ask.tool, 'Bash');
  assert.ok(ask.timeoutMs > 0);
  assert.equal(bridge.pendingCount(), 1);
});

test('the hook giving up (socket close) clears our state too', () => {
  const { bridge, store, events } = setup();
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);
  res.handlers.close();

  assert.equal(store.get('sess-1').pendingPermission, false);
  assert.equal(bridge.pendingCount(), 0);
  assert.ok(events.some((e) => e.topic === 'claude.permission.resolved'));
});

test('an Esc interrupt releases a held permission with "ask" and clears the tile', () => {
  const { bridge, store, events } = setup();
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);
  assert.equal(bridge.pendingCount(), 1);

  bridge.cancelSession('sess-1', Date.now() + 1);
  assert.equal(bridge.pendingCount(), 0);
  assert.equal(decisionOf(res), 'ask', 'never decides for a turn that is already dead');
  assert.equal(store.get('sess-1').pendingPermission, false);
  const resolved = events.find((e) => e.topic === 'claude.permission.resolved');
  assert.equal(resolved.data.resolution, 'interrupted');
});

test('a replayed interrupt marker older than the permission leaves it held', () => {
  const { bridge } = setup();
  bridge.onHookRequest(HOOK, fakeRes());
  bridge.cancelSession('sess-1', Date.now() - 60_000);
  assert.equal(bridge.pendingCount(), 1);
});

test('ExitPlanMode is never held — hook gets "ask" back, plan goes to the queue', () => {
  const planCalls = [];
  const { bridge, events } = setup({ onPlanApproval: (p) => planCalls.push(p) });
  const res = fakeRes();
  bridge.onHookRequest({
    session_id: 'sess-1',
    tool_name: 'ExitPlanMode',
    tool_input: { plan: '# Big plan' },
  }, res);

  assert.equal(decisionOf(res), 'ask', 'terminal dialog stays authoritative');
  assert.equal(res.status, 200);
  assert.equal(bridge.pendingCount(), 0, 'nothing held — the hook decision cannot approve a plan');
  assert.equal(planCalls.length, 1, 'routed to the queue as a question');
  assert.equal(planCalls[0].tool_input.plan, '# Big plan');
  assert.ok(!events.some((e) => e.topic === 'claude.permission.request'), 'no permission tile');
});

test('AskUserQuestion is never held — PreToolUse already queued the real card', () => {
  const planCalls = [];
  const { bridge, store, events } = setup({ onPlanApproval: (p) => planCalls.push(p) });
  const res = fakeRes();
  bridge.onHookRequest({
    session_id: 'sess-1',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ header: 'Task', question: 'Which?', options: [{ label: 'A' }] }] },
  }, res);

  assert.equal(decisionOf(res), 'ask', 'terminal keeps the gate');
  assert.equal(bridge.pendingCount(), 0, 'nothing held');
  assert.equal(planCalls.length, 0, 'not a plan');
  assert.ok(!events.some((e) => e.topic === 'claude.permission.request'), 'no second card');
  assert.ok(!store.get('sess-1'), 'no permission state on the session');
});

test('a tool with no salient key summarises readably, never as raw JSON', () => {
  const { bridge, events } = setup();
  bridge.onHookRequest({ ...HOOK, tool_name: 'Task', tool_input: { prompt: 'go find it' } }, fakeRes());
  bridge.onHookRequest({ ...HOOK, tool_name: 'Weird', tool_input: { questions: [{ a: 1 }], n: 2 } }, fakeRes());
  const summaries = events.filter((e) => e.topic === 'claude.permission.request').map((e) => e.data.summary);
  assert.deepEqual(summaries, ['go find it', 'questions, n']);
  assert.ok(!summaries.some((s) => s.includes('{')), 'no JSON reaches the device');
});

test('file and url tools summarise their salient argument', () => {
  const { bridge, events } = setup();
  bridge.onHookRequest({ ...HOOK, tool_name: 'Edit', tool_input: { file_path: '/tmp/a.js' } }, fakeRes());
  bridge.onHookRequest({ ...HOOK, tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }, fakeRes());
  const summaries = events.filter((e) => e.topic === 'claude.permission.request').map((e) => e.data.summary);
  assert.deepEqual(summaries, ['/tmp/a.js', 'https://example.com']);
});

test('the ask carries what the user asked for, when a prompt has been seen', () => {
  const { bridge, store, events } = setup();
  store.upsert('sess-1', { lastPrompt: 'reinstall the device-app deps' });
  bridge.onHookRequest(HOOK, fakeRes());

  const req = events.find((e) => e.topic === 'claude.permission.request');
  assert.equal(req.data.intent, 'you asked: reinstall the device-app deps');
  assert.equal(bridge.list()[0].intent, 'you asked: reinstall the device-app deps',
    'late clients get the same line from the queue list');
});

test('no prompt seen means an empty intent, never an invented one', () => {
  const { bridge, events } = setup();
  bridge.onHookRequest(HOOK, fakeRes());
  const req = events.find((e) => e.topic === 'claude.permission.request');
  assert.equal(req.data.intent, '');
  assert.equal(bridge.list()[0].intent, '');
});
