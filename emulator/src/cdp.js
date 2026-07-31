// Applies device-class CPU throttling to the emulator's Chrome window over
// the DevTools protocol. The same-origin screen iframe shares the faceplate
// page's renderer main thread, so throttling the top target covers the
// firmware UI too. Everything here is fail-soft: if Chrome isn't up yet (or
// was launched without the debugging port) we keep retrying quietly and the
// emulator works unthrottled.

import WebSocket from 'ws';
import { CDP_PORT, CPU_THROTTLE_RATE, EMULATOR_URL } from './config.js';
import { logInfo } from './log.js';

const POLL_MS = 2000;

async function findTarget() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  if (!r.ok) return null;
  const targets = await r.json();
  const t = targets.find((x) => x.type === 'page' && (x.url || '').startsWith(EMULATOR_URL));
  return t?.webSocketDebuggerUrl || null;
}

function attach(wsUrl, onDone) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const throttleId = () => {
    ws.send(JSON.stringify({ id: ++id, method: 'Emulation.setCPUThrottlingRate', params: { rate: CPU_THROTTLE_RATE } }));
    return id;
  };
  let pendingThrottle = 0;
  let confirmed = false;

  ws.on('open', () => {
    ws.send(JSON.stringify({ id: ++id, method: 'Page.enable' }));
    pendingThrottle = throttleId();
  });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.id === pendingThrottle && !msg.error && !confirmed) {
      confirmed = true;
      logInfo(`cdp: throttle ${CPU_THROTTLE_RATE}x applied`);
    }
    // Re-assert after every navigation (idempotent); covers reloads/reboots.
    if (msg.method === 'Page.loadEventFired') pendingThrottle = throttleId();
  });
  ws.on('close', onDone);
  ws.on('error', () => ws.close());
}

export function startCdpThrottle() {
  if (CPU_THROTTLE_RATE <= 1) {
    logInfo('cdp: throttle disabled (EMU_CPU_THROTTLE<=1)');
    return;
  }
  let announced = false;
  const loop = async () => {
    let wsUrl = null;
    try { wsUrl = await findTarget(); } catch { /* Chrome not up yet */ }
    if (!wsUrl) {
      if (!announced) { logInfo(`cdp: waiting for Chrome on :${CDP_PORT}…`); announced = true; }
      setTimeout(loop, POLL_MS);
      return;
    }
    announced = false;
    attach(wsUrl, () => setTimeout(loop, POLL_MS));
  };
  loop();
}
