// WS hub at /ws. Clients: emulator relay, Swift connector relay, webpage.
// First frame must be bridge.hello {role}. Responses go ONLY to the requesting
// socket (avoids request-id collisions between relays); events broadcast to all.

import { WebSocketServer } from 'ws';
import { DAEMON_VERSION } from './config.js';
import { log } from './log.js';

export function createHub() {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map(); // socket -> {role, info, connectedAt}
  let methods = {};          // method -> async handler(params, ctx)
  let connectorStatus = null; // last bridge.status from a connector

  // A relay on a slow link (bluetooth to the device) that stops draining
  // must not buffer an unbounded backlog of state frames it will replay in
  // slow motion once it catches up. Session snapshots and details supersede
  // each other, so for a backed-up socket the newest one later is strictly
  // better than every stale one now. Asks and their resolutions are NOT
  // superseding — those always go out.
  const MAX_BUFFERED_STATE_BYTES = 64 * 1024;
  const SUPERSEDING = /^claude\.(sessions?|usage)\./;

  function emit(topic, data) {
    const frame = JSON.stringify({
      type: 'event', topic, data, server_timestamp_ms: Date.now(),
    });
    const droppable = SUPERSEDING.test(topic);
    for (const socket of clients.keys()) {
      if (socket.readyState !== socket.OPEN) continue;
      if (droppable && socket.bufferedAmount > MAX_BUFFERED_STATE_BYTES) continue;
      socket.send(frame);
    }
    // Session snapshots fire constantly and would drown the log — but they are
    // also the one event class you need when tiles misbehave, so the flag
    // un-silences them.
    if (!topic.startsWith('claude.sessions.') || process.env.CLAUDE_THING_DEBUG_EVENTS === '1') log('EV', topic);
  }

  function rolesOnline() {
    const roles = {};
    for (const meta of clients.values()) {
      roles[meta.role] = (roles[meta.role] || 0) + 1;
    }
    return roles;
  }

  wss.on('connection', (socket) => {
    clients.set(socket, { role: 'unknown', info: {}, connectedAt: Date.now() });

    socket.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (msg.type !== 'request' || typeof msg.method !== 'string') return;

      const meta = clients.get(socket);
      const respond = (frame) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
      };

      if (msg.method === 'bridge.hello') {
        meta.role = (msg.params && msg.params.role) || 'unknown';
        meta.info = (msg.params && msg.params.info) || {};
        log('--', `client hello: ${meta.role}`);
        emit('bridge.clients', rolesOnline());
        return respond({ type: 'response', id: msg.id, result: { ok: true, daemonVersion: DAEMON_VERSION } });
      }
      if (msg.method === 'bridge.status') {
        connectorStatus = { ...(msg.params || {}), updatedTs: Date.now() };
        emit('bridge.connector', connectorStatus);
        return respond({ type: 'response', id: msg.id, result: { ok: true } });
      }

      const handler = methods[msg.method];
      if (!handler) {
        return respond({ type: 'error', id: msg.id, error: 'Unknown method' });
      }
      try {
        const result = await handler(msg.params || {}, { role: meta.role });
        respond({ type: 'response', id: msg.id, result });
      } catch (err) {
        respond({ type: 'error', id: msg.id, error: String(err.message || err) });
      }
      if (msg.method !== 'claude.sessions.list') log('RQ', `${meta.role} ${msg.method}`);
    });

    socket.on('close', () => {
      const meta = clients.get(socket);
      clients.delete(socket);
      log('--', `client gone: ${meta ? meta.role : '?'}`);
      emit('bridge.clients', rolesOnline());
    });
    socket.on('error', () => {});
  });

  return {
    wss,
    emit,
    rolesOnline,
    connectorStatus: () => connectorStatus,
    setMethods: (m) => { methods = m; },
  };
}
