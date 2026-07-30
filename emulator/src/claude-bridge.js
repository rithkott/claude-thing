// Bridges claude.* traffic between the emulated device WS (:5000) and the
// claude-thing daemon hub (:8790/ws) — the emulator's stand-in for the
// BT + Swift-connector relay path on real hardware.

import WebSocket from 'ws';
import { logInfo } from './log.js';

const DAEMON_URL = 'ws://127.0.0.1:8790/ws';

export function createClaudeBridge({ emit }) {
  let socket = null;
  let connected = false;
  let attempts = 0;
  const pending = new Map(); // daemon request id -> respond(frame) on device side

  function connect() {
    socket = new WebSocket(DAEMON_URL);

    socket.on('open', () => {
      attempts = 0;
      connected = true;
      socket.send(JSON.stringify({
        type: 'request', id: 'hello-emulator', method: 'bridge.hello',
        params: { role: 'emulator', info: { kind: 'carthing-emulator' } },
      }));
      logInfo('claude-bridge: daemon connected');
      emit('claude.daemon.status', { connected: true });
    });

    socket.on('message', (raw) => {
      let f;
      try { f = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (f.type === 'event') {
        if (f.topic.startsWith('claude.')) emit(f.topic, f.data);
        return;
      }
      if ((f.type === 'response' || f.type === 'error') && pending.has(f.id)) {
        const respond = pending.get(f.id);
        pending.delete(f.id);
        respond(f);
      }
    });

    const down = () => {
      if (connected) {
        connected = false;
        logInfo('claude-bridge: daemon lost');
        emit('claude.daemon.status', { connected: false });
      }
      for (const [id, respond] of pending) {
        respond({ type: 'error', id, error: 'daemon unreachable' });
      }
      pending.clear();
      attempts++;
      setTimeout(connect, Math.min(1000 * 2 ** (attempts - 1), 15000));
    };
    socket.on('close', down);
    socket.on('error', () => { try { socket.close(); } catch { socket.emit('close'); } });
  }

  connect();

  // Returns true if the frame was handled (claude.* method).
  function handle(msg, respond) {
    if (!msg.method || !msg.method.startsWith('claude.')) return false;
    if (!connected || socket.readyState !== WebSocket.OPEN) {
      respond({ type: 'error', id: msg.id, error: 'daemon unreachable' });
      return true;
    }
    pending.set(msg.id, respond);
    socket.send(JSON.stringify(msg));
    return true;
  }

  return { handle, isConnected: () => connected };
}
