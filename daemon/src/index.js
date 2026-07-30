import fs from 'node:fs';
import { DAEMON_VERSION, PID_FILE, MOCK_SESSIONS } from './config.js';
import { createHub } from './hub.js';
import { createStore } from './sessions/store.js';
import { createPermissionBridge } from './permission-bridge.js';
import { createSources } from './sessions/index.js';
import { createHttpServer } from './http-server.js';
import { createFocus } from './focus.js';
import { createQueue } from './queue.js';
import { createUsage } from './usage.js';
import { log } from './log.js';

const hub = createHub();
const store = createStore();
const permissionBridge = createPermissionBridge({ emit: hub.emit, store });
const focus = createFocus();
const queue = createQueue({ emit: hub.emit, store, focus });
const usage = createUsage({ emit: hub.emit });
const sources = createSources({ store, permissionBridge, queue });

store.onSnapshot = (snap) => hub.emit('claude.sessions.update', snap);
store.onDetail = (detail) => hub.emit('claude.session.update', detail);

hub.setMethods({
  'claude.ping': async () => ({ daemonVersion: DAEMON_VERSION, sessions: store.count() }),
  'claude.sessions.list': async ({ limit } = {}) => store.snapshot(limit),
  'claude.session.get': async ({ id }) => {
    const d = store.get(id);
    if (!d) throw new Error('unknown session');
    return d;
  },
  'claude.permission.answer': async ({ requestId, decision }) => ({
    accepted: permissionBridge.answer(requestId, decision),
  }),

  // everything waiting on a human, for clients that connect mid-flight
  'claude.queue.list': async () => ({
    asks: [...permissionBridge.list(), ...queue.list()].sort((a, b) => a.createdTs - b.createdTs),
  }),
  'claude.question.answer': async ({ id, optionIndex }) => queue.answerQuestion(id, optionIndex),

  // bring a session's terminal window to the front, as if it were clicked
  'claude.session.focus': async ({ id }) => focus.focusSession(id),

  'claude.usage.get': async () => usage.get(),
});

let server;
try {
  server = await createHttpServer({ hub, store, permissionBridge, sources });
} catch (err) {
  console.error(`daemon startup failed: ${err.message}`);
  process.exit(1);
}

usage.start();
fs.writeFileSync(PID_FILE, String(process.pid));
log('--', `claude-thing daemon v${DAEMON_VERSION} (${MOCK_SESSIONS ? 'MOCK sessions' : 'real sources'})`);

function shutdown() {
  try { fs.unlinkSync(PID_FILE); } catch {}
  usage.stop();
  sources.stop();
  server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
