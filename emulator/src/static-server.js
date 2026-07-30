import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { HOST, HTTP_PORT, SHELL_DIR, SIM_PHONE, DIAL_TICK_DELTA, DIAL_MIN_TICK_MS, DIAL_DEG_PER_TICK, DIAL_SCROLL_PER_TICK } from './config.js';

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

function serveFile(res, filePath) {
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  send(res, 200, fs.readFileSync(filePath), type);
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

export function startHttpServer(firmware) {
  const shellRoot = path.resolve(SHELL_DIR);
  const uiRoot = path.resolve(firmware.uiDir);

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
  });

  const server = http.createServer((req, res) => {
    const urlPath = req.url || '/';

    if (urlPath.startsWith('/__emulator__')) {
      const sub = urlPath.slice('/__emulator__'.length) || '/';
      if (sub === '/config.json') return send(res, 200, configJson, MIME['.json']);
      const file = resolveIn(shellRoot, sub === '' ? '/' : sub);
      if (file) return serveFile(res, file);
      return send(res, 404, 'not found');
    }

    const file = resolveIn(uiRoot, urlPath);
    if (file) return serveFile(res, file);

    // SPA fallback, mirrors nocturned's ServeDir-with-index-fallback
    const hasExt = path.extname(urlPath.split('?')[0]) !== '';
    const wantsHtml = (req.headers.accept || '').includes('text/html');
    if (!hasExt || wantsHtml) {
      return serveFile(res, path.join(uiRoot, 'index.html'));
    }
    return send(res, 404, 'not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(HTTP_PORT, HOST, () => resolve(server));
  });
}
