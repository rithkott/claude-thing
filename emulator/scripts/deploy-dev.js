// One-command deploy: latest firmware zip -> extract -> build + graft the
// Claude device app into it -> (re)start daemon + emulator server -> open
// Chrome app-mode window on the faceplate.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  HOST, HTTP_PORT, WS_PORT, PID_FILE, LOG_DIR,
  CHROME_PROFILE_DIR, EMULATOR_URL, CACHE_DIR, PROJECT_ROOT,
  WINDOW_W, WINDOW_H, CDP_PORT, JS_HEAP_MB, CPU_THROTTLE_RATE,
} from '../src/config.js';
import { resolveFirmware } from '../src/firmware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, '..', 'src', 'index.js');
const serverLog = path.join(LOG_DIR, 'server.log');
const DEVICE_APP = path.join(PROJECT_ROOT, 'device-app');
const DAEMON_DIR = path.join(PROJECT_ROOT, 'daemon');
const DAEMON_PID = path.join(DAEMON_DIR, '.daemon.pid');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: HOST, port, timeout: 500 });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

async function stopPrevious() {
  let pid = null;
  try { pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10); } catch {}
  if (pid && pidAlive(pid)) {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(100);
    if (pidAlive(pid)) process.kill(pid, 'SIGKILL');
    console.log(`stopped previous emulator (pid ${pid})`);
  }
  try { fs.unlinkSync(PID_FILE); } catch {}

  if (await portInUse(HTTP_PORT)) {
    throw new Error(
      `port ${HTTP_PORT} is held by another process (not the emulator). ` +
      `Check: lsof -nP -iTCP:${HTTP_PORT} -sTCP:LISTEN`
    );
  }
  // NOTE: port 5000 check skipped — macOS AirPlay Receiver holds *:5000;
  // the emulator's loopback-specific binds coexist with it.
}

async function waitReady(timeoutMs = 15000) {
  const url = `http://${HOST}:${HTTP_PORT}/__emulator__/config.json`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
    } catch {}
    await sleep(100);
  }
  let tail = '';
  try { tail = fs.readFileSync(serverLog, 'utf8').split('\n').slice(-15).join('\n'); } catch {}
  throw new Error(`emulator server did not become ready in ${timeoutMs / 1000}s.\n--- server.log tail ---\n${tail}`);
}

function buildAndGraftClaudeApp(uiDir) {
  console.log('building claude device app…');
  if (!fs.existsSync(path.join(DEVICE_APP, 'node_modules'))) {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: DEVICE_APP, stdio: 'pipe' });
  }
  execFileSync('npm', ['run', 'build'], { cwd: DEVICE_APP, stdio: 'pipe' });

  const dist = path.join(DEVICE_APP, 'dist');
  const target = path.join(uiDir, 'claude');
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(dist, target, { recursive: true });

  // graft the mode-switch chord into the music UI (mirrors inject-firmware.js)
  const rootIndex = path.join(uiDir, 'index.html');
  let html = fs.readFileSync(rootIndex, 'utf8');
  if (!html.includes('/claude/switch.js')) {
    html = html.replace('</body>', '<script src="/claude/switch.js"></script></body>');
    fs.writeFileSync(rootIndex, html);
  }
  console.log(`claude app grafted into ${path.relative(CACHE_DIR, target)}`);
}

async function startDaemon() {
  let pid = null;
  try { pid = parseInt(fs.readFileSync(DAEMON_PID, 'utf8').trim(), 10); } catch {}
  if (pid && pidAlive(pid)) {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(100);
    if (pidAlive(pid)) process.kill(pid, 'SIGKILL');
  }
  try { fs.unlinkSync(DAEMON_PID); } catch {}

  if (!fs.existsSync(path.join(DAEMON_DIR, 'node_modules'))) {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: DAEMON_DIR, stdio: 'pipe' });
  }
  fs.mkdirSync(path.join(DAEMON_DIR, 'logs'), { recursive: true });
  const logFd = fs.openSync(path.join(DAEMON_DIR, 'logs', 'boot.log'), 'w');
  const child = spawn(process.execPath, [path.join(DAEMON_DIR, 'src', 'index.js')], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
    cwd: DAEMON_DIR,
  });
  child.unref();
  fs.closeSync(logFd);

  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch('http://127.0.0.1:8790/status');
      if (r.ok) {
        const s = await r.json();
        console.log(`daemon up: v${s.daemonVersion} (sources: ${s.sources.join(', ')}, hooks ${s.hooks ? 'installed' : 'NOT installed'})`);
        return;
      }
    } catch {}
    await sleep(100);
  }
  console.log('warning: daemon did not report ready — check daemon/logs/daemon.log');
}

// --- main ---

console.log('resolving latest firmware…');
const fw = resolveFirmware();
console.log(`firmware: ${path.basename(fw.zipPath)}`);
console.log(`version:  ${fw.version.version || 'unknown'} (slot ${fw.slot}, ${fw.cached ? 'cached' : 'freshly extracted'})`);

buildAndGraftClaudeApp(fw.uiDir);
await startDaemon();
await stopPrevious();

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });
const logFd = fs.openSync(serverLog, 'w');
const child = spawn(process.execPath, [serverEntry], {
  detached: true,
  stdio: ['ignore', logFd, logFd],
});
child.unref();
fs.closeSync(logFd);

await waitReady();
console.log(`server up: http://${HOST}:${HTTP_PORT}/  ws://${HOST}:${WS_PORT}`);

// Chrome only applies --force-device-scale-factor / --window-size when the
// process starts, so close any window still running on the emulator's own
// profile first (never touches the user's normal Chrome).
try {
  execFileSync('pkill', ['-f', CHROME_PROFILE_DIR], { stdio: 'ignore' });
  await sleep(600);
} catch {}

const chromeArgs = [
  `--app=${EMULATOR_URL}`,
  // 1 CSS pixel = 1 physical pixel, so the 800×480 panel is rendered at its
  // true resolution instead of being supersampled by the display's HiDPI
  // scale factor. Without this the emulated screen shows more detail and
  // smoother edges than the real device ever can.
  '--force-device-scale-factor=1',
  `--window-size=${WINDOW_W},${WINDOW_H}`,
  `--user-data-dir=${CHROME_PROFILE_DIR}`,
  '--no-first-run',
  '--no-default-browser-check',
  // Device Chromium runs with pinch disabled and no smooth scrolling; the
  // panel is not color-managed, so pin sRGB to avoid wide-gamut Mac tint.
  '--disable-pinch',
  '--disable-smooth-scrolling',
  '--force-color-profile=srgb',
  // Lets the emulator server apply device-class CPU throttling over CDP.
  `--remote-debugging-port=${CDP_PORT}`,
];
if (JS_HEAP_MB > 0) chromeArgs.push(`--js-flags=--max-old-space-size=${JS_HEAP_MB}`);

try {
  if (process.env.EMU_CHROME_BIN) {
    // Seam for experimenting with alternate binaries (e.g. an old Chromium).
    spawn(process.env.EMU_CHROME_BIN, chromeArgs, { detached: true, stdio: 'ignore' }).unref();
  } else {
    execFileSync('open', ['-na', 'Google Chrome', '--args', ...chromeArgs]);
  }
  console.log(`emulator window opened: ${EMULATOR_URL}`);
  console.log(`(${WINDOW_W}×${WINDOW_H} physical px, screen rendered 1:1 at the device's true 800×480)`);
  console.log(`fidelity: cpu ${CPU_THROTTLE_RATE}x throttle, V8 heap ${JS_HEAP_MB || 'uncapped'}MB` +
    ` (EMU_CPU_THROTTLE=0 / EMU_JS_HEAP_MB=0 to disable)`);
} catch (err) {
  console.log(`could not launch Chrome (${err.message}); open ${EMULATOR_URL} manually`);
}

console.log(`logs: ${serverLog}  |  WS traffic: ${path.join(LOG_DIR, 'ws.log')}`);
