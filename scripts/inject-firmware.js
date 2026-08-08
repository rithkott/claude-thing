// Injects the Claude device app into an existing Nocturne 4.1 firmware zip.
//
// 4.1 ships a flashthing zip — superbird-boot.bin, superbird.wic (a 1.43 GB GPT
// whole-disk image), bandaid.ext4 and meta.json — not the flat system_[ab].ext2
// slots 4.0.7 had. So we open the .wic, carve the root_a/root_b partitions out
// of it by GPT offset, drive debugfs against each carved ext4, and write the
// results back at the same offsets before repacking.
//
// WHERE the app has to land, and why it is the rootfs and not bandaid:
//
//   /opt/nocturne is a bind-mount of the bandaid partition (opt-overlay-bind),
//   seeded from the rootfs floor /usr/lib/nocturne only when it is missing. But
//   nocturne-floor-sync runs on every boot and copies the rootfs floor over
//   bandaid whenever /etc/nocturne/floor-version outranks bandaid's own
//   .floor-version — and bandaid-image.bbclass ships no .floor-version at all.
//   So the FIRST boot after any flash always overwrites bandaid from the rootfs
//   floor. Injecting only into bandaid.ext4 would be wiped before the user ever
//   saw it. The rootfs floor is the real target; bandaid is belt and braces.
//
// Note the .wic contains a bandaid partition too, but meta.json overwrites it
// with the standalone bandaid.ext4 member at LBA 2400256, so injecting into the
// wic's copy would be thrown away. We patch the standalone member instead.
//
// Usage:
//   node scripts/inject-firmware.js [--zip <path>] [--out <path>]
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

const WIC_MEMBER = 'superbird.wic';
const BANDAID_MEMBER = 'bandaid.ext4';
const META_MEMBER = 'meta.json';

// The webapp root nocturned serves on 127.0.0.1:8080. Inside the rootfs this is
// the Yocto floor; inside bandaid the same tree is rooted at the vendor name,
// because opt-overlay binds <bandaid>/nocturne to /opt/nocturne.
const ROOTFS_UI = '/usr/lib/nocturne/webapps/ui';
const BANDAID_UI = '/nocturne/webapps/ui';

const ROOT_PARTITIONS = ['root_a', 'root_b'];
const SECTOR = 512;

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
        const members = listing.split('\n');
        if (members.includes(WIC_MEMBER) && members.includes(META_MEMBER)) {
          hits.push({ path: full, mtimeMs: st.mtimeMs });
        }
      } catch {}
    }
  }
  if (!hits.length) {
    throw new Error(
      `no Nocturne 4.1 firmware zip (${WIC_MEMBER} + ${META_MEMBER}) found in:\n  ${dirs.join('\n  ')}\n` +
      'A 4.0.7-era zip of system_[ab].ext2 slots is no longer supported — 2.0.0 targets 4.1 only.'
    );
  }
  hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return hits[0].path;
}

// --- GPT ---

// The wks pins the layout (env/boot_a/root_a/boot_b/root_b/bandaid) but we read
// the real table rather than trusting it, so a resized slot fails loudly here
// instead of corrupting a neighbouring partition.
function readPartitions(imagePath) {
  const fd = fs.openSync(imagePath, 'r');
  try {
    const header = Buffer.alloc(SECTOR);
    fs.readSync(fd, header, 0, SECTOR, SECTOR);
    if (header.subarray(0, 8).toString('latin1') !== 'EFI PART') {
      throw new Error(`${path.basename(imagePath)} has no GPT header at LBA 1`);
    }
    const entryLba = Number(header.readBigUInt64LE(72));
    const entryCount = header.readUInt32LE(80);
    const entrySize = header.readUInt32LE(84);

    const table = Buffer.alloc(entryCount * entrySize);
    fs.readSync(fd, table, 0, table.length, entryLba * SECTOR);

    const parts = [];
    for (let i = 0; i < entryCount; i++) {
      const e = table.subarray(i * entrySize, (i + 1) * entrySize);
      if (e.subarray(0, 16).every((b) => b === 0)) continue;   // unused slot
      const firstLba = Number(e.readBigUInt64LE(32));
      const lastLba = Number(e.readBigUInt64LE(40));   // inclusive
      const name = e.subarray(56, 128).toString('utf16le').replace(/\0+$/, '');
      parts.push({
        name,
        offset: firstLba * SECTOR,
        length: (lastLba - firstLba + 1) * SECTOR,
      });
    }
    return parts;
  } finally {
    fs.closeSync(fd);
  }
}

function copyRange(srcPath, srcOffset, length, destPath, destOffset = 0) {
  const src = fs.openSync(srcPath, 'r');
  const dest = fs.openSync(destPath, destOffset ? 'r+' : 'w');
  try {
    const buf = Buffer.alloc(8 * 1024 * 1024);
    let moved = 0;
    while (moved < length) {
      const want = Math.min(buf.length, length - moved);
      const read = fs.readSync(src, buf, 0, want, srcOffset + moved);
      if (read <= 0) throw new Error(`short read from ${path.basename(srcPath)} at ${srcOffset + moved}`);
      fs.writeSync(dest, buf, 0, read, destOffset + moved);
      moved += read;
    }
  } finally {
    fs.closeSync(src);
    fs.closeSync(dest);
  }
}

// --- debugfs ---

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
  const stats = execFileSync(debugfs, ['-R', 'stats -h', image], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const free = /Free blocks:\s+(\d+)/.exec(stats);
  const size = /Block size:\s+(\d+)/.exec(stats);
  if (!free || !size) return null;
  return Number(free[1]) * Number(size[1]);
}

// The rootfs floor is root:root; the bandaid tree is built from the same ipks
// but lands owned by the build user (1000:1000). Mirror whatever the existing
// UI directory uses so the injected tree does not stand out from its neighbours.
function ownerOf(debugfs, image, dir) {
  try {
    const out = execFileSync(debugfs, ['-R', `ls -l ${dir}`, image], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    // "   1528   40755 (2)      0      0    4096  5-Apr-2011 19:00 ."
    const self = out.split('\n').find((l) => /\s\.$/.test(l));
    const m = self && /^\s*\d+\s+\d+\s+\(\d+\)\s+(\d+)\s+(\d+)\s/.exec(self);
    if (m) return { uid: Number(m[1]), gid: Number(m[2]) };
  } catch {}
  return { uid: 0, gid: 0 };
}

function injectUi(debugfs, image, uiDir, files, label) {
  const payload = files.reduce((n, f) => n + fs.statSync(path.join(DEVICE_APP_DIST, f)).size, 0);
  const free = freeBytes(debugfs, image);
  if (free !== null && free < payload * 1.3) {
    throw new Error(
      `not enough free space in ${label}: ${(free / 1024 / 1024).toFixed(1)} MB free, ` +
      `need ~${(payload * 1.3 / 1024 / 1024).toFixed(1)} MB. The prod rootfs is sized exactly to ` +
      'its 516 MiB slot (IMAGE_OVERHEAD_FACTOR=1.0, -m 0), so there is no reserve to borrow.'
    );
  }

  const { uid, gid } = ownerOf(debugfs, image, uiDir);

  const dirs = new Set(['claude']);
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`claude/${parts.slice(0, i).join('/')}`);
  }

  const script = [`rm ${uiDir}/claude`];   // no-op when absent
  const sortedDirs = [...dirs].sort();
  for (const d of sortedDirs) script.push(`mkdir ${uiDir}/${d}`);
  for (const f of files) script.push(`write ${path.join(DEVICE_APP_DIST, f)} ${uiDir}/claude/${f}`);

  // debugfs copies the host file's mode and leaves new dirs owned by root, so
  // set both explicitly rather than inheriting whatever the build machine used.
  for (const d of sortedDirs) {
    script.push(`sif ${uiDir}/${d} mode 040755`, `sif ${uiDir}/${d} uid ${uid}`, `sif ${uiDir}/${d} gid ${gid}`);
  }
  for (const f of files) {
    const p = `${uiDir}/claude/${f}`;
    script.push(`sif ${p} mode 0100644`, `sif ${p} uid ${uid}`, `sif ${p} gid ${gid}`);
  }

  // graft switch.js into the music UI's index.html — this is what the preset
  // 1 + 4 chord hooks, and the only reason the stock UI knows /claude/ exists.
  const tmpIndex = path.join(os.tmpdir(), `claude-index-${Date.now()}.html`);
  execFileSync(debugfs, ['-R', `dump ${uiDir}/index.html ${tmpIndex}`, image], { stdio: 'pipe' });
  const html = fs.readFileSync(tmpIndex, 'utf8');
  if (!html.includes('</body>')) {
    throw new Error(`${label}: ${uiDir}/index.html has no </body> to graft the switch script into`);
  }
  if (!html.includes('/claude/switch.js')) {
    fs.writeFileSync(tmpIndex, html.replace('</body>', '<script src="/claude/switch.js"></script></body>'));
    script.push(
      `rm ${uiDir}/index.html`,
      `write ${tmpIndex} ${uiDir}/index.html`,
      `sif ${uiDir}/index.html mode 0100644`,
      `sif ${uiDir}/index.html uid ${uid}`,
      `sif ${uiDir}/index.html gid ${gid}`
    );
  }

  debugfsScript(debugfs, image, script);
  fs.unlinkSync(tmpIndex);
}

// --- main ---

const debugfs = findDebugfs();
const srcZip = arg('zip') || findLatestZip();

if (!fs.existsSync(path.join(DEVICE_APP_DIST, 'index.html'))) {
  throw new Error('device-app/dist missing — run: cd device-app && npm run build');
}
const files = walk(DEVICE_APP_DIST);
const payloadKb = (files.reduce((n, f) => n + fs.statSync(path.join(DEVICE_APP_DIST, f)).size, 0) / 1024).toFixed(0);
console.log(`source zip:  ${srcZip}`);
console.log(`device app:  ${files.length} files, ${payloadKb} KB from device-app/dist`);

const version = (/v\d+\.\d+\.\d+/.exec(path.basename(srcZip)) || ['unknown'])[0];
const outZip = arg('out') || path.join(path.dirname(srcZip), `nocturne_${version}_claude.zip`);
// --out names a directory that may not exist. In CI it is dist/, which used to
// be created as a side effect of the nocturned cross-build; 2.0.0 deleted that
// job and copyFileSync started failing with a bare ENOENT naming the source.
fs.mkdirSync(path.dirname(path.resolve(outZip)), { recursive: true });
fs.copyFileSync(srcZip, outZip);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-inject-'));
try {
  execFileSync('unzip', ['-o', '-q', outZip, WIC_MEMBER, BANDAID_MEMBER, '-d', work], { stdio: 'pipe' });
  const wic = path.join(work, WIC_MEMBER);
  const bandaid = path.join(work, BANDAID_MEMBER);

  const parts = readPartitions(wic);
  console.log(`\n${WIC_MEMBER}: ${parts.map((p) => p.name).join(', ')}`);

  // 1. the rootfs floor, in both A/B slots — this is what floor-sync propagates
  //    into /opt/nocturne on first boot.
  for (const name of ROOT_PARTITIONS) {
    const part = parts.find((p) => p.name === name);
    if (!part) {
      console.log(`  ${name}: not in the partition table, skipping`);
      continue;
    }
    const carved = path.join(work, `${name}.img`);
    process.stdout.write(`  ${name}: carving ${(part.length / 1048576).toFixed(0)} MiB… `);
    copyRange(wic, part.offset, part.length, carved);
    process.stdout.write('injecting… ');
    injectUi(debugfs, carved, ROOTFS_UI, files, name);
    process.stdout.write('writing back… ');
    copyRange(carved, 0, part.length, wic, part.offset);
    fs.rmSync(carved, { force: true });
    console.log('done');
  }

  // 2. bandaid, so the app is present even if floor-sync is skipped. The wic's
  //    own bandaid partition is NOT patched — meta.json overwrites it with this
  //    member at flash time.
  process.stdout.write(`  ${BANDAID_MEMBER}: injecting… `);
  injectUi(debugfs, bandaid, BANDAID_UI, files, BANDAID_MEMBER);
  console.log('done');

  // zip -j replaces the existing members in place; meta.json resolves its
  // writeBootPartition/writeUserArea steps by name, so order does not matter.
  execFileSync('zip', ['-q', '-j', outZip, wic, bandaid], { stdio: 'pipe' });

  const size = (fs.statSync(outZip).size / 1024 / 1024).toFixed(0);
  console.log(`\nwrote ${outZip} (${size} MB)`);
  console.log('flash with flashthing, or run deploy-to-dev — the emulator picks the newest zip.');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
