// Small on-disk store for daemon state that must survive a restart.
//
// Everything the daemon knows is otherwise rebuilt from live sources, which is
// right for sessions — they are gone when the process is gone. Usage is not:
// the figures stay true across a restart, and the only cost of forgetting them
// is a screen that reads "READING USAGE…" for the better part of a minute while
// it re-learns something it already knew.
//
// Writes are atomic (temp file + rename) so a crash mid-write can never leave a
// half-written file that fails to parse on the next boot.

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.js';
import { log } from './log.js';

function fileFor(name) {
  return path.join(STATE_DIR, `${name}.json`);
}

// Missing or corrupt file is not an error — it just means "nothing saved yet".
export function readState(name, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(name), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log('ST', `could not read ${name} state: ${err.message}`);
    return fallback;
  }
}

export function writeState(name, value) {
  const target = fileFor(name);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    log('ST', `could not write ${name} state: ${err.message}`);
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return false;
  }
}
