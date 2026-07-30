import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOST, PORT, WEBPAGE_DIST, DAEMON_VERSION, DAEMON_ROOT } from './config.js';
import { log } from './log.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createHttpServer({ hub, store, permissionBridge, sources }) {
  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'POST') log('IN', `${req.method} ${req.url}`);

    // Hook ingestion: PermissionRequest is held; everything else is
    // acknowledged immediately and forwarded to session sources.
    // Accepts /hook/<event> (command hooks) and bare /hook (type:"http"
    // hooks — event read from the payload's hook_event_name).
    if (req.method === 'POST' && (url === '/hook' || url.startsWith('/hook/'))) {
      let payload = {};
      try { payload = JSON.parse(await readBody(req) || '{}'); } catch {}
      const event = url === '/hook'
        ? (payload.hook_event_name || 'unknown')
        : url.slice('/hook/'.length);

      if (event === 'PermissionRequest') {
        return permissionBridge.onHookRequest(payload, res);
      }
      sources.onHookEvent(event, payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }

    // Hook install/uninstall from the webpage's Settings page
    if (req.method === 'POST' && (url === '/api/hooks/install' || url === '/api/hooks/uninstall')) {
      const script = url.endsWith('install') ? 'install-hooks.js' : 'uninstall-hooks.js';
      try {
        const output = execFileSync(process.execPath, [path.join(DAEMON_ROOT, 'scripts', script)], {
          encoding: 'utf8',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, output: output.trim() }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, output: String(err.stderr || err.message) }));
      }
    }

    if (url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        daemonVersion: DAEMON_VERSION,
        sessions: store.count(),
        pendingPermissions: permissionBridge.pendingCount(),
        clients: hub.rolesOnline(),
        connector: hub.connectorStatus(),
        sources: sources.status(),
        hooks: sources.hooksInstalled(),
      }));
    }

    // Webpage static (built) with SPA fallback
    const root = path.resolve(WEBPAGE_DIST);
    let file = path.resolve(root, '.' + (url === '/' ? '/index.html' : decodeURIComponent(url)));
    if (file === root || file.startsWith(root + path.sep)) {
      try {
        if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
        const body = fs.readFileSync(file);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        return res.end(body);
      } catch {}
      try {
        const body = fs.readFileSync(path.join(root, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        return res.end(body);
      } catch {}
    }
    res.writeHead(404);
    res.end('claude-thing daemon: webpage not built (webpage/dist missing)');
  });

  server.on('upgrade', (req, socket, head) => {
    if ((req.url || '').split('?')[0] === '/ws') {
      hub.wss.handleUpgrade(req, socket, head, (ws) => {
        hub.wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => {
      log('--', `http+ws on http://${HOST}:${PORT}  (ws path /ws)`);
      resolve(server);
    });
  });
}
