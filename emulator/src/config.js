import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const EMULATOR_ROOT = path.resolve(__dirname, '..');
export const PROJECT_ROOT = path.resolve(EMULATOR_ROOT, '..');

export const HTTP_PORT = 8080; // hardcoded in firmware (nocturned webapp_server)
export const WS_PORT = 5000;   // hardcoded in firmware (useNocturned.js)
export const HOST = '127.0.0.1';

export const ZIP_SEARCH_DIRS = [
  path.join(PROJECT_ROOT, 'firmware'),
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Downloads'),
];
export const ZIP_PATTERN = /^nocturne.*\.zip$/i;

export const CACHE_DIR = path.join(EMULATOR_ROOT, '.cache');
export const LOG_DIR = path.join(EMULATOR_ROOT, 'logs');
export const SHELL_DIR = path.join(EMULATOR_ROOT, 'shell');
export const PID_FILE = path.join(CACHE_DIR, 'emulator.pid');

export const UI_PATH_IN_ROOTFS = '/etc/nocturne/ui';
export const VERSION_PATH_IN_ROOTFS = '/etc/nocturne/version.json';

export const DEBUGFS_CANDIDATES = [
  '/opt/homebrew/opt/e2fsprogs/sbin/debugfs',
  '/usr/local/opt/e2fsprogs/sbin/debugfs',
  '/usr/sbin/debugfs',
  'debugfs',
];

// Dial synthesis: clear the UI's |deltaX|<10 dead-zone and <15ms tick drop;
// <60ms spacing lands in its rapid-scroll mode when spun fast.
export const DIAL_TICK_DELTA = 90;
export const DIAL_MIN_TICK_MS = 20;
export const DIAL_DEG_PER_TICK = 15;
export const DIAL_SCROLL_PER_TICK = 50;

export const SIM_PHONE = process.env.SIM_PHONE !== '0';
export const SPOTIFY_SKIPPED = process.env.SPOTIFY_SKIPPED !== '0';

export const CHROME_PROFILE_DIR = path.join(os.homedir(), '.cache', 'carthing-emulator-chrome');
export const EMULATOR_URL = `http://${HOST}:${HTTP_PORT}/__emulator__/`;

// The Chrome window is launched with --force-device-scale-factor=1 so the
// 800×480 panel maps 1:1 onto physical pixels (no HiDPI supersampling — the
// emulated screen should never look sharper than the real LCD). These sizes
// are the measured faceplate (1074×585) plus the top-button overhang and a
// small margin, in physical pixels.
export const WINDOW_W = 1120;
export const WINDOW_H = 700;
