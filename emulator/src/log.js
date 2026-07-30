import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './config.js';

fs.mkdirSync(LOG_DIR, { recursive: true });
const wsLogPath = path.join(LOG_DIR, 'ws.log');
const wsStream = fs.createWriteStream(wsLogPath, { flags: 'w' });

const MAX_LINE = 500;

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function clip(s) {
  return s.length > MAX_LINE ? s.slice(0, MAX_LINE) + ` …(${s.length} bytes)` : s;
}

export function logWs(tag, text) {
  const line = `${stamp()} ${tag} ${clip(String(text))}`;
  console.log(line);
  wsStream.write(line + '\n');
}

export function logInfo(...args) {
  const line = `${stamp()} -- ${args.join(' ')}`;
  console.log(line);
  wsStream.write(line + '\n');
}
