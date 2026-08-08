// Manual smoke test of mock-nocturned WS semantics: broadcast, replay, unknown method.
import WebSocket from 'ws';

const URL = 'ws://127.0.0.1:5000';
const results = [];
function check(name, cond) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.frames = [];
    ws.on('message', (d) => ws.frames.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const a = await connect();
const b = await connect();
await sleep(200);

// 1. Broadcast: A's response also reaches B
a.send(JSON.stringify({ type: 'request', id: 'req-1', method: 'device.info', params: {} }));
await sleep(300);
check('A receives own response', a.frames.some((f) => f.id === 'req-1' && f.type === 'response'));
check('B receives A\'s response (broadcast)', b.frames.some((f) => f.id === 'req-1'));

// 2. Unknown method -> 4.1 owns no allow-list; it forwards to whatever app
// app.ready registered, and answers "No active app session" when there is
// none. Which of the two we get depends on whether the sim phone had already
// registered before this run — a connect-time app.ready replay is the tell.
const registeredAtConnect = a.frames.some((f) => f.topic === 'app.ready');
const expectedUnknown = registeredAtConnect ? 'Unknown method' : 'No active app session';
a.send(JSON.stringify({ type: 'request', id: 'req-2', method: 'spotify.player.play', params: {} }));
await sleep(300);
check(`unknown method -> forwarded, "${expectedUnknown}"`,
  a.frames.some((f) => f.id === 'req-2' && f.type === 'error' && f.error === expectedUnknown));

// 3. Malformed JSON survives
a.send('{{{not json');
a.send(JSON.stringify({ type: 'request', id: 'req-3', method: 'ping', params: {} }));
await sleep(300);
check('server survives malformed JSON', a.frames.some((f) => f.id === 'req-3'));

// 4. Late client gets cached replay (app.ready fires ~700ms after first connect)
await sleep(1000);
const c = await connect();
await sleep(300);
check('late client gets replayed app.ready', c.frames.some((f) => f.topic === 'app.ready'));
check('late client gets replayed voice.wakeword.state',
  c.frames.some((f) => f.topic === 'voice.wakeword.state'));

// 5. Once app.ready has registered a route, the same unknown method is
// forwarded and the *companion* answers — "Unknown method" is the connector's
// fallthrough, not the daemon's.
a.send(JSON.stringify({ type: 'request', id: 'req-4', method: 'spotify.player.play', params: {} }));
await sleep(300);
check('unknown method after app.ready -> forwarded, companion says "Unknown method"',
  a.frames.some((f) => f.id === 'req-4' && f.type === 'error' && f.error === 'Unknown method'));

// A method the companion does own must still resolve through the forward path.
a.send(JSON.stringify({ type: 'request', id: 'req-5', method: 'spotify.auth.getStatus', params: {} }));
await sleep(300);
check('companion-owned method forwards and resolves',
  a.frames.some((f) => f.id === 'req-5' && f.type === 'response'));

// 6. Event broadcast with server_timestamp_ms
check('app.ready carries server_timestamp_ms',
  a.frames.some((f) => f.topic === 'app.ready' && typeof f.server_timestamp_ms === 'number'));

for (const ws of [a, b, c]) ws.close();
const failed = results.filter((r) => !r.pass);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall pass');
process.exit(failed.length ? 1 : 0);
