import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  HOST, HTTP_PORT, SHELL_DIR, SIM_PHONE, DIAL_TICK_DELTA, DIAL_MIN_TICK_MS,
  DIAL_DEG_PER_TICK, DIAL_SCROLL_PER_TICK, FORCE_LEGACY, DEVICE_FONTS,
  CPU_THROTTLE_RATE, JS_HEAP_MB, INPUT_POLL_MS,
} from './config.js';
import { logInfo } from './log.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveFile(res, filePath, transform) {
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  let body = fs.readFileSync(filePath);
  if (transform) body = transform(body.toString('utf8'));
  send(res, 200, body, type);
}

// Resolve a URL path inside rootDir; null if traversal or miss.
function resolveIn(rootDir, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const resolved = path.resolve(rootDir, '.' + decoded);
  if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) return null;
  let st;
  try { st = fs.statSync(resolved); } catch { return null; }
  if (st.isDirectory()) {
    const idx = path.join(resolved, 'index.html');
    return fs.existsSync(idx) ? idx : null;
  }
  return resolved;
}

// Rewrite Vite's module/nomodule split so the legacy (chrome69) chunks run —
// the exact code path the device's Chromium 69 takes. Modern module scripts
// (entries, the __vite_is_modern_browser detector, the SystemJS dynamic
// fallback) are stripped and the nomodule scripts promoted to always-run:
// vite-legacy-polyfill loads SystemJS synchronously, then the inline
// vite-legacy-entry System.import() fires, same as on the device.
function stripModernChunks(html) {
  return html
    .replace(/<script type="module"[^>]*>[\s\S]*?<\/script>\s*/g, '')
    .replace(/<link rel="modulepreload"[^>]*>\s*/g, '')
    .replace(/<script nomodule/g, '<script');
}

// Family names as the firmware CSS requests them (--font-* vars + Circular
// stacks), keyed by rootfs TTF filename prefix. Unmapped files (script
// subsets, NotoColorEmoji, Vera) are only reachable through fontconfig
// fallback on the device, which a browser @font-face cannot reproduce.
const DEVICE_FONT_FAMILIES = {
  Inter: 'Inter',
  CircularSpUIv3T: 'Circular Sp UI v3 T',
  NotoNaskhAR: 'Noto Naskh Arabic',
  NotoSansBN: 'Noto Sans Bengali',
  NotoSansDV: 'Noto Sans Devanagari',
  NotoSansGK: 'Noto Sans Gurmukhi',
  NotoSansHE: 'Noto Sans Hebrew',
  NotoSansJP: 'Noto Sans JP',
  NotoSansKR: 'Noto Sans KR',
  NotoSansSC: 'Noto Sans SC',
  NotoSansTA: 'Noto Sans Tamil',
  NotoSansTC: 'Noto Sans TC',
  NotoSansTH: 'Noto Sans Thai',
  NotoSerifJP: 'Noto Serif JP',
  NotoSerifKR: 'Noto Serif KR',
};
const FONT_WEIGHTS = { Book: 400, Regular: 400, Medium: 500, SemiBold: 600, Bold: 700, Black: 900 };

function buildFontCss(fontsDir) {
  const faces = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const sub = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), sub); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (ext !== '.ttf' && ext !== '.otf') continue;
      const base = path.basename(e.name, ext);
      const m = base.match(/^(.*?)-(Book|Regular|Medium|SemiBold|Bold|Black|VF)$/);
      const family = DEVICE_FONT_FAMILIES[m ? m[1] : base];
      if (!family) continue;
      const weight = m && m[2] === 'VF' ? '100 900' : (m ? FONT_WEIGHTS[m[2]] : 400);
      faces.push(
        `@font-face{font-family:"${family}";font-weight:${weight};` +
        `src:url("/__fonts__/${sub}") format("truetype");font-display:swap}`
      );
    }
  };
  walk(fontsDir, '');
  return faces.join('\n');
}

export function startHttpServer(firmware) {
  const shellRoot = path.resolve(SHELL_DIR);
  const uiRoot = path.resolve(firmware.uiDir);

  const fontsRoot = DEVICE_FONTS && firmware.fontsDir && fs.existsSync(firmware.fontsDir)
    ? path.resolve(firmware.fontsDir)
    : null;
  const fontCss = fontsRoot ? buildFontCss(fontsRoot) : '';
  if (DEVICE_FONTS && !fontsRoot) {
    logInfo('device fonts: none extracted (older cache?) — using macOS fallbacks');
  } else if (fontsRoot) {
    logInfo(`device fonts: serving ${fontCss.split('\n').length} faces from rootfs`);
  }
  logInfo(`legacy chunks: ${FORCE_LEGACY ? 'forced (device chrome69 code path)' : 'OFF — modern modules'}`);

  // Applied only to HTML served out of the firmware UI tree — never the shell.
  const transformUiHtml = (html) => {
    if (FORCE_LEGACY) html = stripModernChunks(html);
    if (fontCss) {
      html = html.replace('</head>',
        '<link rel="stylesheet" href="/__emulator__/device-fonts.css"></head>');
    }
    return html;
  };
  const uiTransform = (file) => (file.endsWith('.html') ? transformUiHtml : undefined);

  const configJson = JSON.stringify({
    version: firmware.version,
    zip: path.basename(firmware.zipPath),
    slot: firmware.slot,
    simPhone: SIM_PHONE,
    dial: {
      tickDelta: DIAL_TICK_DELTA,
      minTickMs: DIAL_MIN_TICK_MS,
      degPerTick: DIAL_DEG_PER_TICK,
      scrollPerTick: DIAL_SCROLL_PER_TICK,
    },
    fidelity: {
      cpuThrottle: CPU_THROTTLE_RATE,
      jsHeapMb: JS_HEAP_MB,
      inputPollMs: INPUT_POLL_MS,
      forceLegacy: FORCE_LEGACY,
      deviceFonts: Boolean(fontsRoot),
    },
  });

  const server = http.createServer((req, res) => {
    const urlPath = req.url || '/';

    if (urlPath.startsWith('/__emulator__')) {
      const sub = urlPath.slice('/__emulator__'.length) || '/';
      if (sub === '/config.json') return send(res, 200, configJson, MIME['.json']);
      if (sub === '/device-fonts.css') return send(res, 200, fontCss, MIME['.css']);
      const file = resolveIn(shellRoot, sub === '' ? '/' : sub);
      if (file) return serveFile(res, file);
      return send(res, 404, 'not found');
    }

    if (urlPath.startsWith('/__fonts__/')) {
      const file = fontsRoot && resolveIn(fontsRoot, urlPath.slice('/__fonts__'.length));
      if (file) return serveFile(res, file);
      return send(res, 404, 'not found');
    }

    const file = resolveIn(uiRoot, urlPath);
    if (file) return serveFile(res, file, uiTransform(file));

    // SPA fallback, mirrors nocturned's ServeDir-with-index-fallback
    const hasExt = path.extname(urlPath.split('?')[0]) !== '';
    const wantsHtml = (req.headers.accept || '').includes('text/html');
    if (!hasExt || wantsHtml) {
      const idx = path.join(uiRoot, 'index.html');
      return serveFile(res, idx, uiTransform(idx));
    }
    return send(res, 404, 'not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(HTTP_PORT, HOST, () => resolve(server));
  });
}
