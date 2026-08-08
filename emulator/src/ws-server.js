// Mock nocturned WebSocket RPC on 127.0.0.1:5000.
// Fidelity notes (daemon.md §1): text frames only; responses AND events are
// broadcast to EVERY connected client (correlation is client-side by id);
// no subscribe protocol; on connect the server replays cached app.ready and
// voice.wakeword.state.

import { WebSocketServer } from 'ws';
import { HOST, WS_PORT } from './config.js';
import { buildMethods } from './methods.js';
import { buildPhoneSim } from './phone-sim.js';
import { createClaudeBridge } from './claude-bridge.js';
import { logWs, logInfo } from './log.js';

export function startWsServer(firmware) {
  // Bind BOTH loopbacks: firmware hardcodes ws://localhost:5000, and macOS
  // AirPlay Receiver (ControlCenter) squats *:5000 — specific loopback binds
  // coexist with its wildcard and win kernel routing for localhost.
  const servers = [
    new WebSocketServer({ host: HOST, port: WS_PORT }),
    new WebSocketServer({ host: '::1', port: WS_PORT }),
  ];
  const eventCache = new Map(); // topic -> frame (app.ready, voice.wakeword.state)
  const CACHED_TOPICS = new Set(['app.ready', 'voice.wakeword.state']);

  const allClients = () => servers.flatMap((s) => [...s.clients]);

  function broadcast(frame) {
    const text = JSON.stringify(frame);
    for (const client of allClients()) {
      if (client.readyState === client.OPEN) client.send(text);
    }
    return text;
  }

  function emit(topic, data) {
    const frame = { type: 'event', topic, data, server_timestamp_ms: Date.now() };
    if (CACHED_TOPICS.has(topic)) eventCache.set(topic, frame);
    logWs('EV', broadcast(frame));
  }

  const phoneSim = buildPhoneSim({ emit });
  const methods = buildMethods({ emit, firmware });
  const claudeBridge = createClaudeBridge({ emit });

  // voice.wakeword.state is replayed on connect by the real daemon; seed it.
  eventCache.set('voice.wakeword.state', {
    type: 'event',
    topic: 'voice.wakeword.state',
    data: { paused: false },
    server_timestamp_ms: Date.now(),
  });

  let clientSeq = 0;
  function onConnection(socket) {
    const clientId = ++clientSeq;
    logInfo(`ws client #${clientId} connected (${allClients().length} total)`);

    for (const frame of eventCache.values()) {
      socket.send(JSON.stringify(frame));
      logWs('RP', `#${clientId} <- replay ${frame.topic}`);
    }
    phoneSim.onClientConnect();

    socket.on('message', async (raw) => {
      const text = raw.toString('utf8');
      logWs('>>', `#${clientId} ${text}`);

      let msg;
      try { msg = JSON.parse(text); } catch {
        logInfo(`ws client #${clientId}: malformed JSON ignored`);
        return;
      }
      if (msg.type !== 'request' || typeof msg.method !== 'string') return;

      // claude.* rides the relay path (daemon), like BT→connector on hardware
      if (claudeBridge.handle(msg, (frame) => logWs('<<', broadcast(frame)))) return;

      // 4.1's daemon owns no method allow-list. Everything it does not answer
      // itself is forwarded verbatim to the app registered by the most recent
      // app.ready (websocket.rs handle_incoming_message, ~:1597-1665), and with
      // no app registered it answers "No active app session" — it never says
      // "Unknown method". That string is the *companion's* own fallthrough, so
      // it now only appears for methods the phone sim declines.
      let frame;
      const handler = methods[msg.method]
        || (phoneSim.isRegistered() ? phoneSim.methods[msg.method] : undefined);
      if (handler) {
        try {
          const out = await handler(msg.params);
          frame = out.error !== undefined
            ? { type: 'error', id: msg.id, error: out.error }
            : { type: 'response', id: msg.id, result: out.result };
        } catch (err) {
          frame = { type: 'error', id: msg.id, error: String(err.message || err) };
        }
      } else if (!phoneSim.isRegistered()) {
        frame = { type: 'error', id: msg.id, error: 'No active app session' };
      } else {
        frame = { type: 'error', id: msg.id, error: 'Unknown method' };
      }
      logWs('<<', broadcast(frame));
    });

    socket.on('close', () => {
      logInfo(`ws client #${clientId} disconnected (${allClients().length} total)`);
    });
    socket.on('error', (err) => {
      logInfo(`ws client #${clientId} error: ${err.message}`);
    });
  }
  for (const s of servers) s.on('connection', onConnection);

  return Promise.all(
    servers.map((s) => new Promise((resolve, reject) => {
      s.once('error', reject);
      s.once('listening', resolve);
    }))
  ).then(() => ({
    wss: { close: () => servers.forEach((s) => s.close()) },
    emit,
    stop: () => phoneSim.stop(),
  }));
}
