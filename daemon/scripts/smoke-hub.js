// Smoke test: hub semantics + mock permission round trip.
// Run with the daemon up in mock mode: CLAUDE_THING_MOCK=1 node src/index.js
import WebSocket from 'ws';
import http from 'node:http';

const URL = 'ws://127.0.0.1:8790/ws';
const results = [];
const check = (name, cond) => {
  results.push(cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(role) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.frames = [];
    ws.on('message', (d) => ws.frames.push(JSON.parse(d.toString())));
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'request', id: `hello-${role}`, method: 'bridge.hello', params: { role } }));
      resolve(ws);
    });
    ws.on('error', reject);
  });
}
const req = (ws, id, method, params = {}) =>
  ws.send(JSON.stringify({ type: 'request', id, method, params }));

const a = await connect('emulator');
const b = await connect('webpage');
await sleep(300);

check('hello acked', a.frames.some((f) => f.id === 'hello-emulator' && f.result && f.result.ok));

req(a, 'r1', 'claude.ping');
req(a, 'r2', 'claude.sessions.list');
await sleep(300);
check('ping works', a.frames.some((f) => f.id === 'r1' && f.result && f.result.daemonVersion));
const list = a.frames.find((f) => f.id === 'r2');
check('sessions.list returns mock sessions', list && list.result.sessions.length >= 3);
check('responses NOT broadcast to other socket', !b.frames.some((f) => f.id === 'r1'));

req(a, 'r3', 'claude.session.get', { id: list.result.sessions[0].id });
await sleep(200);
check('session.get returns detail', a.frames.some((f) => f.id === 'r3' && f.result && 'cwd' in f.result));

req(a, 'r4', 'claude.nonexistent');
await sleep(200);
check('unknown method -> error', a.frames.some((f) => f.id === 'r4' && f.type === 'error'));

// permission round trip via a synthetic held hook request
const held = new Promise((resolve) => {
  const post = http.request({
    host: '127.0.0.1', port: 8790, path: '/hook/PermissionRequest', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve(JSON.parse(body)));
  });
  post.end(JSON.stringify({
    session_id: list.result.sessions[0].id,
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf node_modules' },
    cwd: '/Users/dev/claude-thing',
  }));
});
await sleep(400);
const permEvent = [...a.frames, ...b.frames].find((f) => f.topic === 'claude.permission.request');
check('permission.request event broadcast to all', !!permEvent &&
  b.frames.some((f) => f.topic === 'claude.permission.request'));

req(a, 'r5', 'claude.permission.answer', { requestId: permEvent.data.requestId, decision: 'allow' });
const hookAnswer = await held;
await sleep(300);
check('hook got allow decision',
  hookAnswer.hookSpecificOutput && hookAnswer.hookSpecificOutput.decision.behavior === 'allow');
check('answer accepted', a.frames.some((f) => f.id === 'r5' && f.result && f.result.accepted === true));
check('resolved event broadcast', b.frames.some((f) => f.topic === 'claude.permission.resolved' &&
  f.data.resolution === 'allow'));

req(a, 'r6', 'claude.permission.answer', { requestId: permEvent.data.requestId, decision: 'deny' });
await sleep(200);
check('second answer rejected (idempotent)', a.frames.some((f) => f.id === 'r6' && f.result && f.result.accepted === false));

const snap = a.frames.find((f) => f.topic === 'claude.sessions.update');
check('snapshot events flow', !!snap);

a.close(); b.close();
const failed = results.filter((x) => !x).length;
console.log(failed ? `\n${failed} FAILED` : '\nall pass');
process.exit(failed ? 1 : 0);
