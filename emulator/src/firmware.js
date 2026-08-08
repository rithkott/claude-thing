// Pulls the stock Nocturne UI out of a firmware zip so the emulator can serve
// the real device bundle rather than a mock.
//
// 4.1 changed the zip shape completely. 4.0.7 shipped flat system_[ab].ext2
// slots that debugfs could open directly; 4.1 ships a flashthing zip whose
// payload is superbird.wic — a 1.43 GB GPT whole-disk image — so the rootfs has
// to be carved out of it by partition offset first. Same carve the injector
// does (scripts/inject-firmware.js), minus the write-back.
//
// The carve streams: `unzip -p` into `tail -c`/`head -c` extracts exactly the
// partition's byte range and lets head close the pipe early, so we never
// materialise the whole 1.43 GB on disk.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  ZIP_SEARCH_DIRS, ZIP_PATTERN, CACHE_DIR,
  UI_PATH_IN_ROOTFS, FONTS_PATH_IN_ROOTFS,
  WIC_MEMBER, META_MEMBER, ROOT_PARTITIONS,
  DEBUGFS_CANDIDATES,
} from './config.js';

const SECTOR = 512;
// Enough to cover the GPT header at LBA 1 and the whole entry array after it.
const GPT_HEAD_BYTES = 1024 * 1024;

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
  if (r.status !== 0) return false;
  const members = r.stdout.split('\n');
  return members.includes(WIC_MEMBER) && members.includes(META_MEMBER);
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
    `No Nocturne 4.1 firmware zip (${WIC_MEMBER} + ${META_MEMBER}) found. ` +
    'Searched for nocturne*.zip in:\n  ' + ZIP_SEARCH_DIRS.join('\n  ') +
    (skipped.length ? `\nSkipped (not a 4.1 image): ${skipped.join(', ')}` : '') +
    '\nA 4.0.7-era zip of system_[ab].ext2 slots is no longer supported.'
  );
}

// --- GPT carve out of superbird.wic, without unpacking the whole member ---

function shPipe(cmd, opts = {}) {
  return execFileSync('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

// Reads the GPT header + entry array off the front of the wic stream. Only the
// first megabyte is decompressed; head closes the pipe and unzip stops there.
function readPartitions(zipPath) {
  const head = shPipe(
    `unzip -p ${JSON.stringify(zipPath)} ${WIC_MEMBER} | head -c ${GPT_HEAD_BYTES}`,
    { maxBuffer: GPT_HEAD_BYTES * 2 }
  );
  if (head.length < GPT_HEAD_BYTES) {
    throw new Error(`${WIC_MEMBER} in ${path.basename(zipPath)} is truncated (${head.length} bytes)`);
  }
  if (head.subarray(SECTOR, SECTOR + 8).toString('latin1') !== 'EFI PART') {
    throw new Error(`${WIC_MEMBER} has no GPT header at LBA 1`);
  }
  const entryLba = Number(head.readBigUInt64LE(SECTOR + 72));
  const entryCount = head.readUInt32LE(SECTOR + 80);
  const entrySize = head.readUInt32LE(SECTOR + 84);
  const tableStart = entryLba * SECTOR;
  if (tableStart + entryCount * entrySize > head.length) {
    throw new Error(`${WIC_MEMBER} GPT entry array extends past the ${GPT_HEAD_BYTES}-byte head read`);
  }

  const parts = [];
  for (let i = 0; i < entryCount; i++) {
    const e = head.subarray(tableStart + i * entrySize, tableStart + (i + 1) * entrySize);
    if (e.subarray(0, 16).every((b) => b === 0)) continue;   // unused slot
    const firstLba = Number(e.readBigUInt64LE(32));
    const lastLba = Number(e.readBigUInt64LE(40));           // inclusive
    parts.push({
      name: e.subarray(56, 128).toString('utf16le').replace(/\0+$/, ''),
      offset: firstLba * SECTOR,
      length: (lastLba - firstLba + 1) * SECTOR,
    });
  }
  return parts;
}

// `tail -c +N | head -c LEN` is byte-exact on a pipe (dd's block reads are
// not), and head closing early kills the rest of the 1.43 GB decompression.
function carvePartition(zipPath, part, destPath) {
  shPipe(
    `unzip -p ${JSON.stringify(zipPath)} ${WIC_MEMBER}` +
    ` | tail -c +${part.offset + 1}` +
    ` | head -c ${part.length}` +
    ` > ${JSON.stringify(destPath)}`
  );
  const got = fs.statSync(destPath).size;
  if (got !== part.length) {
    throw new Error(`carve of ${part.name} is ${got} bytes, expected ${part.length}`);
  }
}

// Version lives only in the filename now: 4.1 dropped /etc/nocturne/version.json
// (the floor carries /etc/nocturne/floor-version, which is a bare ordinal, not
// the release string the UI shows).
// Stops at the first `_`, because an injected zip is named
// nocturne_v4.1.0_claude_2.0.0.zip and the firmware version is the v4.1.0 part
// — the rest is our own release. A `-dev`-style prerelease suffix is kept.
function versionFromZipName(zipPath) {
  // basename minus ".zip" too, or a prerelease suffix swallows the extension.
  const base = path.basename(zipPath, path.extname(zipPath));
  const m = base.match(/v\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?/);
  const v = m ? m[0] : 'unknown';
  return { version: v, shortVersion: v };
}

function extractSlot(debugfs, zipPath, slot, cacheDir) {
  const tmpDir = path.join(cacheDir, 'tmp');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const partName = ROOT_PARTITIONS[slot];
  const part = readPartitions(zipPath).find((p) => p.name === partName);
  if (!part) throw new Error(`${partName} is not in ${WIC_MEMBER}'s partition table`);

  const rootfs = path.join(tmpDir, `${partName}.img`);
  carvePartition(zipPath, part, rootfs);

  const staging = path.join(tmpDir, 'staging');
  fs.mkdirSync(staging, { recursive: true });
  execFileSync(debugfs, ['-R', `rdump ${UI_PATH_IN_ROOTFS} ${staging}`, rootfs], { stdio: 'pipe' });

  const uiStaged = path.join(staging, path.basename(UI_PATH_IN_ROOTFS));
  if (!fs.existsSync(path.join(uiStaged, 'index.html'))) {
    throw new Error(`no index.html in ${UI_PATH_IN_ROOTFS} of ${partName}`);
  }
  const assets = path.join(uiStaged, 'assets');
  if (!fs.existsSync(assets) || fs.readdirSync(assets).length === 0) {
    throw new Error(`empty assets dir in ${partName}`);
  }

  rdumpFonts(debugfs, rootfs, staging, cacheDir);

  const uiDir = path.join(cacheDir, 'ui');
  fs.rmSync(uiDir, { recursive: true, force: true });
  fs.renameSync(uiStaged, uiDir);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { uiDir, version: versionFromZipName(zipPath) };
}

// Device text renders with the rootfs fonts (Inter, Circular, Noto), not
// whatever macOS falls back to — pull them out so the static server can
// declare them via @font-face. Fail-soft: a fontless rootfs just skips this.
function rdumpFonts(debugfs, rootfs, staging, cacheDir) {
  try {
    const fontStaging = path.join(staging, 'fonts-staging');
    fs.mkdirSync(fontStaging, { recursive: true });
    execFileSync(debugfs, ['-R', `rdump ${FONTS_PATH_IN_ROOTFS} ${fontStaging}`, rootfs], { stdio: 'pipe' });
    const dumped = path.join(fontStaging, path.basename(FONTS_PATH_IN_ROOTFS));
    if (!fs.existsSync(dumped)) return;
    const fontsDir = path.join(cacheDir, 'fonts');
    fs.rmSync(fontsDir, { recursive: true, force: true });
    fs.renameSync(dumped, fontsDir);
  } catch { /* no fonts in this rootfs */ }
}

// Older cache entries predate font extraction: re-carve just the rootfs to
// backfill cacheDir/fonts without invalidating the ui/ dir (which carries the
// grafted claude app until the next deploy).
function extractFontsOnly(zipPath, slot, cacheDir) {
  const debugfs = findDebugfs();
  const tmpDir = path.join(cacheDir, 'fonts-tmp');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const partName = ROOT_PARTITIONS[slot];
    const part = readPartitions(zipPath).find((p) => p.name === partName);
    if (!part) return;
    const rootfs = path.join(tmpDir, `${partName}.img`);
    carvePartition(zipPath, part, rootfs);
    rdumpFonts(debugfs, rootfs, tmpDir, cacheDir);
  } catch { /* fail-soft */ } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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
    const fontsDir = path.join(cacheDir, 'fonts');
    if (!fs.existsSync(fontsDir)) extractFontsOnly(meta.zipPath, meta.slot, cacheDir);
    return { ...meta, uiDir: path.join(cacheDir, 'ui'), fontsDir, cached: true };
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
        `Extraction failed for both root slots of ${zip.path}\n` +
        `  root_a: ${errA.message}\n  root_b: ${errB.message}`
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
  return { ...meta, uiDir: result.uiDir, fontsDir: path.join(cacheDir, 'fonts'), cached: false };
}

if (process.argv.includes('--check')) {
  const fw = resolveFirmware();
  console.log(`zip:      ${fw.zipPath}`);
  console.log(`slot:     ${ROOT_PARTITIONS[fw.slot]}`);
  console.log(`version:  ${fw.version.version || 'unknown'}`);
  console.log(`ui dir:   ${fw.uiDir}`);
  console.log(`cache:    ${fw.cached ? 'hit' : 'extracted fresh'}`);
}
