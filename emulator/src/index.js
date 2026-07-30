import fs from 'node:fs';
import path from 'node:path';
import { HOST, HTTP_PORT, WS_PORT, PID_FILE, CACHE_DIR, SIM_PHONE } from './config.js';
import { resolveFirmware } from './firmware.js';
import { startHttpServer } from './static-server.js';
import { startWsServer } from './ws-server.js';
import { logInfo } from './log.js';

const firmware = resolveFirmware();
logInfo(`firmware: ${path.basename(firmware.zipPath)} slot=${firmware.slot} ` +
  `version=${firmware.version.version || 'unknown'} (${firmware.cached ? 'cache' : 'fresh extract'})`);
logInfo(`phone sim: ${SIM_PHONE ? 'ON' : 'OFF (UI will sit in onboarding, like phoneless hardware)'}`);

let httpServer, ws;
try {
  httpServer = await startHttpServer(firmware);
  ws = await startWsServer(firmware);
} catch (err) {
  console.error(`startup failed: ${err.message}`);
  process.exit(1);
}

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.writeFileSync(PID_FILE, String(process.pid));

logInfo(`http: http://${HOST}:${HTTP_PORT}/  (shell at /__emulator__/)`);
logInfo(`ws:   ws://${HOST}:${WS_PORT}`);

function shutdown() {
  try { fs.unlinkSync(PID_FILE); } catch {}
  ws.stop();
  ws.wss.close();
  httpServer.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
