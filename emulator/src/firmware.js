import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  ZIP_SEARCH_DIRS, ZIP_PATTERN, CACHE_DIR,
  UI_PATH_IN_ROOTFS, VERSION_PATH_IN_ROOTFS, DEBUGFS_CANDIDATES,
} from './config.js';

function findDebugfs() {
  for (const cand of DEBUGFS_CANDIDATES) {
    if (cand.includes('/')) {
      if (fs.existsSync(cand)) return cand;
    } else {
      const r = spawnSync('which', [cand], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    }
  }
  throw new Error(
    'debugfs not found. Install e2fsprogs: brew install e2fsprogs\n' +
    '(keg-only; expected at /opt/homebrew/opt/e2fsprogs/sbin/debugfs)'
  );
}

function isFirmwareZip(zipPath) {
  const r = spawnSync('zipinfo', ['-1', zipPath], { encoding: 'utf8' });
  return r.status === 0 && /^system_[ab]\.ext2$/m.test(r.stdout);
}

export function findLatestZip() {
  const hits = [];
  for (const dir of ZIP_SEARCH_DIRS) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!ZIP_PATTERN.test(name)) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isFile()) hits.push({ path: full, mtimeMs: st.mtimeMs });
    }
  }
  hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const skipped = [];
  for (const hit of hits) {
    if (isFirmwareZip(hit.path)) {
      if (skipped.length) {
        console.log(`skipped non-firmware zip(s): ${skipped.join(', ')}`);
      }
      return hit;
    }
    skipped.push(path.basename(hit.path));
  }
  throw new Error(
    'No firmware zip (containing system_a.ext2/system_b.ext2) found. ' +
    'Searched for nocturne*.zip in:\n  ' + ZIP_SEARCH_DIRS.join('\n  ') +
    (skipped.length ? `\nSkipped (no rootfs inside): ${skipped.join(', ')}` : '')
  );
}

function extractSlot(debugfs, zipPath, slot, cacheDir) {
  const tmpDir = path.join(cacheDir, 'tmp');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const ext2Name = `system_${slot}.ext2`;

  execFileSync('unzip', ['-o', '-q', zipPath, ext2Name, '-d', tmpDir], { stdio: 'pipe' });
  const ext2 = path.join(tmpDir, ext2Name);

  const staging = path.join(tmpDir, 'staging');
  fs.mkdirSync(staging, { recursive: true });
  execFileSync(debugfs, ['-R', `rdump ${UI_PATH_IN_ROOTFS} ${staging}`, ext2], { stdio: 'pipe' });

  const uiStaged = path.join(staging, path.basename(UI_PATH_IN_ROOTFS));
  if (!fs.existsSync(path.join(uiStaged, 'index.html'))) {
    throw new Error(`no index.html in ${UI_PATH_IN_ROOTFS} of ${ext2Name}`);
  }
  const assets = path.join(uiStaged, 'assets');
  if (!fs.existsSync(assets) || fs.readdirSync(assets).length === 0) {
    throw new Error(`empty assets dir in ${ext2Name}`);
  }

  let version = null;
  try {
    const raw = execFileSync(debugfs, ['-R', `cat ${VERSION_PATH_IN_ROOTFS}`, ext2], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString('utf8');
    version = JSON.parse(raw.slice(raw.indexOf('{')));
  } catch {
    const m = path.basename(zipPath).match(/v\d+\.\d+\.\d+[\w.-]*/);
    version = { version: m ? m[0] : 'unknown', shortVersion: m ? m[0] : 'unknown' };
  }

  const uiDir = path.join(cacheDir, 'ui');
  fs.rmSync(uiDir, { recursive: true, force: true });
  fs.renameSync(uiStaged, uiDir);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { uiDir, version };
}

function pruneCache(keepDir) {
  let entries;
  try { entries = fs.readdirSync(CACHE_DIR, { withFileTypes: true }); } catch { return; }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const full = path.join(CACHE_DIR, e.name);
      return { full, mtimeMs: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = new Set([keepDir, ...dirs.slice(0, 2).map((d) => d.full)]);
  for (const d of dirs) {
    if (!keep.has(d.full)) fs.rmSync(d.full, { recursive: true, force: true });
  }
}

export function resolveFirmware() {
  const zip = findLatestZip();
  const cacheKey = `${path.basename(zip.path)}-${Math.round(zip.mtimeMs)}`;
  const cacheDir = path.join(CACHE_DIR, cacheKey);
  const metaPath = path.join(cacheDir, 'meta.json');

  if (fs.existsSync(metaPath) && fs.existsSync(path.join(cacheDir, 'ui', 'index.html'))) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return { ...meta, uiDir: path.join(cacheDir, 'ui'), cached: true };
  }

  const debugfs = findDebugfs();
  fs.mkdirSync(cacheDir, { recursive: true });

  let result;
  let slot = 'a';
  try {
    result = extractSlot(debugfs, zip.path, 'a', cacheDir);
  } catch (errA) {
    slot = 'b';
    try {
      result = extractSlot(debugfs, zip.path, 'b', cacheDir);
    } catch (errB) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      throw new Error(
        `Extraction failed for both slots of ${zip.path}\n` +
        `  slot a: ${errA.message}\n  slot b: ${errB.message}`
      );
    }
  }

  const meta = {
    zipPath: zip.path,
    zipMtime: zip.mtimeMs,
    slot,
    version: result.version,
    extractedAt: new Date().toISOString(),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  pruneCache(cacheDir);
  return { ...meta, uiDir: result.uiDir, cached: false };
}

if (process.argv.includes('--check')) {
  const fw = resolveFirmware();
  console.log(`zip:      ${fw.zipPath}`);
  console.log(`slot:     system_${fw.slot}`);
  console.log(`version:  ${fw.version.version || 'unknown'}`);
  console.log(`ui dir:   ${fw.uiDir}`);
  console.log(`cache:    ${fw.cached ? 'hit' : 'extracted fresh'}`);
}
