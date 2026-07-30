import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './config.js';

fs.mkdirSync(LOG_DIR, { recursive: true });
const stream = fs.createWriteStream(path.join(LOG_DIR, 'daemon.log'), { flags: 'w' });

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

export function log(tag, ...args) {
  const line = `${stamp()} ${tag} ${args.map(String).join(' ')}`.slice(0, 800);
  console.log(line);
  stream.write(line + '\n');
}
