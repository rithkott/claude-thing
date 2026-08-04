import fs from 'node:fs';
import { DAEMON_VERSION, PID_FILE, MOCK_SESSIONS, BT_SAFE_SESSION_LIMIT } from './config.js';
import { createHub } from './hub.js';
import { createStore } from './sessions/store.js';
import { createPermissionBridge } from './permission-bridge.js';
import { createSources } from './sessions/index.js';
import { createHttpServer } from './http-server.js';
import { createFocus } from './focus.js';
import { createQueue } from './queue.js';
import { createUsage, slimUsage } from './usage.js';
import { log } from './log.js';

// Broadcast the whole waiting list whenever a client turns up, so a screen that
// watched the last daemon die stops showing asks this one has never heard of.
// Not a response to the new client alone: every screen behind the same relay is
// just as stale, and the list is small.
const hub = createHub({ onHello: () => hub.emit('claude.queue.sync', queueSnapshot()) });
const store = createStore();
const focus = createFocus();
const queue = createQueue({ emit: hub.emit, store, focus });
const permissionBridge = createPermissionBridge({ emit: hub.emit, store, queue });
const usage = createUsage({ emit: hub.emit });
const sources = createSources({ store, permissionBridge, queue });

function queueSnapshot() {
  return {
    asks: [...permissionBridge.list(), ...queue.list()].sort((a, b) => a.createdTs - b.createdTs),
  };
}

store.onSnapshot = (snap) => hub.emit('claude.sessions.update', snap);
store.onDetail = (detail) => hub.emit('claude.session.update', detail);

hub.setMethods({
  'claude.ping': async () => ({ daemonVersion: DAEMON_VERSION, sessions: store.count() }),
  // Relay roles sit behind the Bluetooth link, whose synchronous responses
  // cannot span chunks — an uncapped list past ~6 sessions simply never
  // arrives there. Cap those roles even when the client forgot to ask, and
  // follow up with the full grid as an async push (those chunk fine) so the
  // screen fills in seconds instead of waiting out the snapshot heartbeat.
  'claude.sessions.list': async ({ limit } = {}, { role }) => {
    const cap = limit || ((role === 'connector' || role === 'emulator') ? BT_SAFE_SESSION_LIMIT : 0);
    const snap = store.snapshot(cap);
    if (cap > 0 && store.count() > snap.sessions.length) {
      setTimeout(() => hub.emit('claude.sessions.update', store.snapshot()), 0);
    }
    return snap;
  },
  'claude.session.get': async ({ id }) => {
    const d = store.get(id);
    if (!d) throw new Error('unknown session');
    return d;
  },
  'claude.permission.answer': async ({ requestId, decision }) => ({
    accepted: permissionBridge.answer(requestId, decision),
  }),

  // everything waiting on a human, for clients that connect mid-flight
  'claude.queue.list': async () => queueSnapshot(),
  // answers is number[][] — one entry per question of the ask, each the option
  // indices chosen for it. optionIndex is the pre-grouping single-question form.
  'claude.question.answer': async ({ id, answers, optionIndex }) =>
    queue.answerQuestion(id, answers ?? optionIndex),

  // Bring a session's terminal window to the front, as if it were clicked.
  // Through the same lock as answering: a raise landing between an answer's
  // focus and its keystrokes would send them to the window it just raised.
  'claude.session.focus': async ({ id }) => focus.exclusive(() => focus.focusSession(id)),

  // {slim} returns the device-rendered subset — see slimUsage() — so the
  // synchronous boot response stays well inside one Bluetooth chunk.
  'claude.usage.get': async ({ slim } = {}) => (slim ? slimUsage(usage.get()) : usage.get()),
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
