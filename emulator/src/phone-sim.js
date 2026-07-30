// Simulated phone/connector. Mirrors the real connector cadence:
// new connection -> ~500ms -> ping/device.info -> app.ready (ui.md §6).
// app.ready is cached by the ws server and replayed to later clients,
// same as nocturned's connect-time replay.

import { SIM_PHONE, SPOTIFY_SKIPPED } from './config.js';
import { logInfo } from './log.js';

export function buildPhoneSim({ emit }) {
  let appReadySent = false;
  let heartbeatTimer = null;

  function appReadyData() {
    const d = new Date();
    return {
      platform: 'web',
      datetime: d.toISOString(),
      time: d.toTimeString().slice(0, 5),
      timezone: {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offset: -d.getTimezoneOffset(),
      },
      spotifySkipped: SPOTIFY_SKIPPED,
    };
  }

  function onClientConnect() {
    if (!SIM_PHONE || appReadySent) return;
    appReadySent = true;
    setTimeout(() => {
      logInfo('phone-sim: emitting bluetooth.connection connection_established');
      emit('bluetooth.connection', {
        event: 'connection_established',
        device: 'AA:BB:CC:DD:EE:99',
        connection_type: 'spp',
      });
    }, 400);
    setTimeout(() => {
      logInfo('phone-sim: emitting app.ready');
      emit('app.ready', appReadyData());
      heartbeatTimer = setInterval(() => emit('daemon.heartbeat', {}), 10_000);
    }, 900);
  }

  const methods = SIM_PHONE
    ? {
        ping: () => ({ result: { pong: true } }),
        'spotify.auth.getStatus': () => ({
          result: SPOTIFY_SKIPPED
            ? { authenticated: false, skipped: true, needsAuthorization: false, loading: false }
            : { authenticated: true, skipped: false, needsAuthorization: false, loading: false },
        }),
        'spotify.image.fetch': async (params = {}) => {
          try {
            const resp = await fetch(params.url);
            if (!resp.ok) throw new Error(`http ${resp.status}`);
            const buf = Buffer.from(await resp.arrayBuffer());
            return {
              result: {
                data: buf.toString('base64'),
                contentType: resp.headers.get('content-type') || 'image/jpeg',
              },
            };
          } catch (err) {
            return { error: `image fetch failed: ${err.message}` };
          }
        },
      }
    : {};

  function stop() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }

  return { methods, onClientConnect, stop };
}
