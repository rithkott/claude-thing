// The clock-screen routine is data, so the parts that can silently break —
// a waypoint half off the panel, an act whose sheet or CSS was never added, a
// loop that ends somewhere other than where it starts — are checked here.
// Whether the dancing is any good is still a job for the emulator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACTS, START, W, H, SIZE } from '../src/mascot.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');

test('every waypoint keeps the whole sprite on the panel', () => {
  for (const act of ACTS) {
    if (!act.to) continue;
    const [x, y] = act.to;
    assert.ok(x >= 0 && x <= W - SIZE, `x ${x} off panel`);
    assert.ok(y >= 0 && y <= H - SIZE, `y ${y} off panel`);
  }
});

test('the routine ends where it starts, so the loop does not teleport', () => {
  let pos = START;
  for (const act of ACTS) if (act.to) pos = act.to;
  assert.deepEqual(pos, START);
});

test('every act has a sprite sheet and a rule to play it', () => {
  for (const act of ACTS) {
    const sheet = path.join(SRC, 'sprites', `dance-${act.sprite}.svg`);
    assert.ok(fs.existsSync(sheet), `missing sheet for ${act.sprite} — run npm run sprites`);
    assert.ok(css.includes(`.act-${act.sprite} .mascotart`), `no CSS for act ${act.sprite}`);
  }
});

test('moves say how fast and holds say how long', () => {
  for (const act of ACTS) {
    if (act.to) assert.ok(act.speed > 0, `${act.sprite} move has no speed`);
    else assert.ok(act.ms > 0, `${act.sprite} hold has no duration`);
  }
});
