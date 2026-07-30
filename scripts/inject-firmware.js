// Injects the Claude device app into an existing Nocturne firmware zip:
// writes device-app/dist into /etc/nocturne/ui/claude in BOTH rootfs slots,
// grafts the mode-switch script into the music UI's index.html, and writes a
// new zip named nocturne_<ver>_claude.zip (newest mtime, so the emulator and
// Terbium both pick it up).
//
// Usage:
//   node scripts/inject-firmware.js [--zip <path>] [--nocturned <binary>] [--out <path>]
//
// Requires: unzip, zip, and e2fsprogs' debugfs (brew install e2fsprogs).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEVICE_APP_DIST = path.join(PROJECT_ROOT, 'device-app', 'dist');
const UI_DIR = '/etc/nocturne/ui';

const DEBUGFS_CANDIDATES = [
  '/opt/homebrew/opt/e2fsprogs/sbin/debugfs',
  '/usr/local/opt/e2fsprogs/sbin/debugfs',
  '/usr/sbin/debugfs',
];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}

function findDebugfs() {
  for (const c of DEBUGFS_CANDIDATES) if (fs.existsSync(c)) return c;
  try {
    const p = execFileSync('which', ['debugfs'], { encoding: 'utf8' }).trim();
    if (p) return p;
  } catch {}
  throw new Error('debugfs not found — brew install e2fsprogs');
}

function findLatestZip() {
  const dirs = [
    path.join(PROJECT_ROOT, 'firmware'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Downloads'),
  ];
  const hits = [];
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!/^nocturne.*\.zip$/i.test(n) || /_claude\.zip$/i.test(n)) continue;
      const full = path.join(dir, n);
      try {
        const st = fs.statSync(full);
        const listing = execFileSync('zipinfo', ['-1', full], { encoding: 'utf8' });
        if (/^system_[ab]\.ext2$/m.test(listing)) hits.push({ path: full, mtimeMs: st.mtimeMs });
      } catch {}
    }
  }
  if (!hits.length) throw new Error(`no source firmware zip found in:\n  ${dirs.join('\n  ')}`);
  hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return hits[0].path;
}

function debugfsScript(debugfs, image, lines) {
  const scriptPath = path.join(os.tmpdir(), `claude-inject-${Date.now()}.debugfs`);
  fs.writeFileSync(scriptPath, lines.join('\n') + '\n');
  try {
    execFileSync(debugfs, ['-w', '-f', scriptPath, image], { stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    fs.unlinkSync(scriptPath);
  }
}

function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

function freeBytes(debugfs, image) {
  const out = execFileSync(debugfs, ['-R', 'features', image], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  void out;
  const stats = execFileSync(debugfs, ['-R', 'stats -h', image], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const free = /Free blocks:\s+(\d+)/.exec(stats);
  const size = /Block size:\s+(\d+)/.exec(stats);
  if (!free || !size) return null;
  return Number(free[1]) * Number(size[1]);
}

function injectSlot(debugfs, image, files, nocturnedBinary) {
  let total = files.reduce((n, f) => n + fs.statSync(path.join(DEVICE_APP_DIST, f)).size, 0);
  if (nocturnedBinary) total += fs.statSync(nocturnedBinary).size;
  const free = freeBytes(debugfs, image);
  if (free !== null && free < total * 1.3) {
    throw new Error(`not enough free space in ${path.basename(image)}: ` +
      `${(free / 1024 / 1024).toFixed(1)} MB free, need ~${(total * 1.3 / 1024 / 1024).toFixed(1)} MB`);
  }

  // fresh /claude tree
  const dirs = new Set(['claude']);
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`claude/${parts.slice(0, i).join('/')}`);
  }
  const script = [`rm ${UI_DIR}/claude`];   // no-op if absent
  for (const d of [...dirs].sort()) script.push(`mkdir ${UI_DIR}/${d}`);
  for (const f of files) script.push(`write ${path.join(DEVICE_APP_DIST, f)} ${UI_DIR}/claude/${f}`);

  // graft switch.js into the music UI's index.html
  const tmpIndex = path.join(os.tmpdir(), `claude-index-${Date.now()}.html`);
  execFileSync(debugfs, ['-R', `dump ${UI_DIR}/index.html ${tmpIndex}`, image], { stdio: 'pipe' });
  let html = fs.readFileSync(tmpIndex, 'utf8');
  if (!html.includes('/claude/switch.js')) {
    html = html.replace('</body>', '<script src="/claude/switch.js"></script></body>');
    fs.writeFileSync(tmpIndex, html);
    script.push(`rm ${UI_DIR}/index.html`, `write ${tmpIndex} ${UI_DIR}/index.html`);
  }

  if (nocturnedBinary) {
    // debugfs copies the source file's mode, so a binary that arrived without
    // +x would land unexecutable and the daemon would never come up. Set the
    // mode and ownership explicitly rather than inheriting whatever the build
    // host left behind.
    script.push(
      'rm /usr/bin/nocturned',
      `write ${nocturnedBinary} /usr/bin/nocturned`,
      'sif /usr/bin/nocturned mode 0100755',
      'sif /usr/bin/nocturned uid 0',
      'sif /usr/bin/nocturned gid 0'
    );
  }

  debugfsScript(debugfs, image, script);
  fs.unlinkSync(tmpIndex);
}

// --- main ---

const debugfs = findDebugfs();
const srcZip = arg('zip') || findLatestZip();
const nocturnedBinary = arg('nocturned');

if (!fs.existsSync(path.join(DEVICE_APP_DIST, 'index.html'))) {
  throw new Error('device-app/dist missing — run: cd device-app && npm run build');
}
const files = walk(DEVICE_APP_DIST);
console.log(`source zip:  ${srcZip}`);
console.log(`device app:  ${files.length} files from device-app/dist`);
if (nocturnedBinary) console.log(`nocturned:   ${nocturnedBinary}`);

const version = (/v\d+\.\d+\.\d+/.exec(path.basename(srcZip)) || ['unknown'])[0];
const outZip = arg('out') || path.join(path.dirname(srcZip), `nocturne_${version}_claude.zip`);
fs.copyFileSync(srcZip, outZip);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-inject-'));
try {
  for (const slot of ['a', 'b']) {
    const name = `system_${slot}.ext2`;
    try {
      execFileSync('unzip', ['-o', '-q', outZip, name, '-d', work], { stdio: 'pipe' });
    } catch {
      console.log(`slot ${slot}: not present in zip, skipping`);
      continue;
    }
    const image = path.join(work, name);
    process.stdout.write(`slot ${slot}: injecting… `);
    injectSlot(debugfs, image, files, nocturnedBinary);
    execFileSync('zip', ['-q', '-j', outZip, image], { stdio: 'pipe' });
    fs.rmSync(image, { force: true });
    console.log('done');
  }
  const size = (fs.statSync(outZip).size / 1024 / 1024).toFixed(0);
  console.log(`\nwrote ${outZip} (${size} MB)`);
  console.log('flash with Terbium, or run deploy-to-dev — the emulator picks the newest zip.');
  if (!nocturnedBinary) {
    console.log('\nreminder: this zip carries stock nocturned, which answers "Unknown method"');
    console.log('to every claude.* request, so the device loads no sessions. On hardware it');
    console.log('needs a nocturned built with patches/nocturned-claude-forward.patch.');
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
