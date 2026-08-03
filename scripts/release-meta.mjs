#!/usr/bin/env node
// Reads RELEASES.md and reports the version this merge releases: the highest
// row in the ledger. CI uses it to name the tag; run it locally to see what
// the next merge will publish.
//
// Usage:
//   node scripts/release-meta.mjs [--channel dev|prod] [--json]
//
// Default output is KEY=value lines, which is what GITHUB_OUTPUT wants:
//   node scripts/release-meta.mjs --channel dev >> "$GITHUB_OUTPUT"

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = path.join(PROJECT_ROOT, 'RELEASES.md');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}

const channel = arg('channel') || 'dev';
if (channel !== 'dev' && channel !== 'prod') {
  console.error(`ERROR: --channel must be dev or prod, got ${channel}`);
  process.exit(2);
}

// | 1.17.2 | 2026-08-02 | fix | semver-ledger | The ledger is semver end to end |
const ROW = /^\|\s*(\d+)\.(\d+)\.(\d+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*$/;

const rows = [];
for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
  const m = ROW.exec(line);
  if (!m) continue;
  const [, major, minor, patch, date, type, slug, summary] = m;
  rows.push({
    version: `${major}.${minor}.${patch}`,
    sort: [Number(major), Number(minor), Number(patch)],
    date,
    type,
    slug,
    summary,
  });
}

if (!rows.length) {
  console.error('ERROR: no version rows in RELEASES.md — the ledger is the claim mechanism, so a merge without a row has nothing to release');
  process.exit(1);
}

rows.sort((a, b) => b.sort[0] - a.sort[0] || b.sort[1] - a.sort[1] || b.sort[2] - a.sort[2]);
const top = rows[0];

// The dev channel tags X.Y.Z-dev; promoting that build retags the same commit
// as X.Y.Z, so a version never means two different builds.
const tag = channel === 'dev' ? `${top.version}-dev` : top.version;
const title =
  channel === 'dev'
    ? `${tag} — ${top.slug} (dev)`
    : `${top.version} — ${top.slug}`;

const out = {
  version: top.version,
  tag,
  channel,
  prerelease: channel === 'dev' ? 'true' : 'false',
  type: top.type,
  slug: top.slug,
  summary: top.summary,
  title,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
}
