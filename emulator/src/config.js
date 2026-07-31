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
export const FONTS_PATH_IN_ROOTFS = '/usr/share/fonts';

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

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// Hardware fidelity. Each 0 disables that feature.
// CPU: one Cortex-A53 @1.8GHz is roughly 8-10x slower than an Apple Silicon
// core on single-thread JS; 8x lands in device-class territory while staying
// usable. Set EMU_CPU_THROTTLE=0 for fast dev iteration.
// Heap: the device's 512MB is shared by kernel, Weston, nocturned and the
// whole Chromium tree (with a 256MB swapfile); the renderer's V8 old space
// realistically gets ~200MB before swap thrash. Caps V8 heap only, not
// DOM/GPU/image memory.
export const CPU_THROTTLE_RATE = num(process.env.EMU_CPU_THROTTLE, 8);
export const JS_HEAP_MB = num(process.env.EMU_JS_HEAP_MB, 200);
export const CDP_PORT = num(process.env.EMU_CDP_PORT, 9223);

// Serve the chrome69 legacy chunks (the code path the device's Chromium 69
// actually executes) instead of the modern module build.
export const FORCE_LEGACY = process.env.EMU_FORCE_LEGACY !== '0';

// Serve fonts extracted from the firmware rootfs so text renders with the
// device families (Inter, Noto) instead of macOS fallbacks.
export const DEVICE_FONTS = process.env.EMU_DEVICE_FONTS !== '0';

// The seven physical buttons go through gpio-keys-polled at 40ms on hardware:
// press/release timing is quantized and taps shorter than one poll window are
// dropped. The rotary encoder is event-driven (libinput) and NOT quantized.
export const INPUT_POLL_MS = num(process.env.EMU_INPUT_POLL_MS, 40);

export const CHROME_PROFILE_DIR = path.join(os.homedir(), '.cache', 'carthing-emulator-chrome');
export const EMULATOR_URL = `http://${HOST}:${HTTP_PORT}/__emulator__/`;

// The Chrome window is launched with --force-device-scale-factor=1 so the
// 800×480 panel maps 1:1 onto physical pixels (no HiDPI supersampling — the
// emulated screen should never look sharper than the real LCD).
//
// Faceplate geometry is true to hardware: the 3.97" 800×480 panel is 86.4mm
// wide, giving 9.259 px/mm, and the 124×64mm device face scales to 1148×593px
// (must match --mm in shell/faceplate.css). Window = face + stage margins +
// top-button overhang + status strip.
export const FACE_W = 1148;
export const FACE_H = 593;
export const WINDOW_W = FACE_W + 48;
export const WINDOW_H = FACE_H + 118;
