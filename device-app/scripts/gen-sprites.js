// Generates the 8-bit Claude Code mascot sprite sheets used on the session
// tiles — the blocky little critter from the CLI welcome box, acting out each
// session state. Each state is one SVG strip of 16×16-pixel frames laid out
// left to right; the CSS steps through them with background-position.
// Editing the art means editing the ASCII grids below, then: npm run sprites
//
// Legend: '#' body, '+' shade (closed eyes / underside), 'z' accent
//         (exclamation, Zs, sparkles), '.' transparent — eye holes are
//         transparent so the tile shows through.
//
// Layout rule: the body never uses columns 14–15, so accessories (bang, Zs)
// always have clear air to the upper right.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sprites');
const S = 16;

// Standing, eyes open, feet together.
const STAND = [
  '................',
  '................',
  '................',
  '.....######.....',
  '...##########...',
  '..############..',
  '..##..####..##..',
  '..############..',
  '..############..',
  '..+##########+..',
  '...##########...',
  '....##....##....',
  '................',
  '................',
  '................',
  '................',
];

// Mid-stride: feet kicked apart.
const STRIDE = [
  '................',
  '................',
  '................',
  '.....######.....',
  '...##########...',
  '..############..',
  '..##..####..##..',
  '..############..',
  '..############..',
  '..+##########+..',
  '...##########...',
  '..##........##..',
  '................',
  '................',
  '................',
  '................',
];

// Squashed landing pose — sells the hop when it alternates with STAND.
const SQUASH = [
  '................',
  '................',
  '................',
  '................',
  '....########....',
  '..############..',
  '..##..####..##..',
  '..############..',
  '..+##########+..',
  '...##########...',
  '....########....',
  '...##......##...',
  '................',
  '................',
  '................',
  '................',
];

// Asleep: sitting low with legs tucked and eyes closed to shaded slits.
const SLEEP = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '.....######.....',
  '...##########...',
  '..############..',
  '..#++######++#..',
  '..############..',
  '..+##########+..',
  '...##########...',
  '....########....',
  '................',
  '................',
];

// Breathing out — one row shallower than SLEEP.
const SLEEP_IN = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '....########....',
  '..############..',
  '..#++######++#..',
  '..############..',
  '..+##########+..',
  '...##########...',
  '................',
  '................',
  '................',
];

// Overlays: sparse [x, y] pixel lists drawn in the accent colour.
const BANG = [
  [14, 0], [15, 0],
  [14, 1], [15, 1],
  [14, 2], [15, 2],
  [14, 4], [15, 4],
];

// A legible 3×3 "z" so the sleep frames read as sleep, not as dust.
function zAt(x, y) {
  return [
    [x, y], [x + 1, y], [x + 2, y],
    [x + 1, y + 1],
    [x, y + 2], [x + 1, y + 2], [x + 2, y + 2],
  ];
}
const Z_LOW = zAt(9, 3);
const Z_MID = zAt(11, 1);
const Z_HIGH = zAt(13, 0);

const SPARK_NEAR = [[1, 4], [14, 4], [2, 11], [13, 11]];
const SPARK_FAR = [[0, 2], [15, 2], [0, 13], [15, 13]];

// Usage-screen moods. Overlays live in columns 14–15 (or above the head) for
// the same reason the bang does: the body never reaches there.
const SWEAT_HIGH = [[14, 3], [15, 3]];
const SWEAT_LOW = [[14, 7], [15, 7]];
const SWEAT_SPLASH = [[13, 12], [15, 12]];

// Out of headroom: flattened, strained eyes, seeing stars.
const FLAT = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '....########....',
  '..############..',
  '..#++######++#..',
  '..############..',
  '...##########...',
  '................',
  '................',
];
const STARS_L = [[3, 6], [4, 7]];
const STARS_R = [[12, 6], [11, 7]];

const STATES = {
  // Working: a bouncing scuttle — hop, stride, land, stride.
  working: {
    colors: { '#': '#d77757', '+': '#8f4c30', z: '#efe7d6' },
    frames: [
      { grid: STAND, dy: 0 },
      { grid: STRIDE, dy: -1 },
      { grid: STAND, dy: -2 },
      { grid: STRIDE, dy: -1 },
    ],
  },
  // Attention: jumping on the spot and blinking an exclamation.
  attention: {
    colors: { '#': '#d77757', '+': '#8f4c30', z: '#ffb020' },
    frames: [
      { grid: SQUASH, dy: 1, overlay: BANG },
      { grid: STAND, dy: -2, overlay: BANG },
      { grid: SQUASH, dy: 1 },
      { grid: STAND, dy: -2, overlay: BANG },
    ],
  },
  // Sleeping: slow breathing with Zs drifting up and away.
  sleeping: {
    colors: { '#': '#6b5c4c', '+': '#3b332a', z: '#7d7160' },
    frames: [
      { grid: SLEEP, overlay: Z_LOW },
      { grid: SLEEP_IN, overlay: [...Z_LOW, ...Z_MID] },
      { grid: SLEEP, overlay: [...Z_MID, ...Z_HIGH] },
      { grid: SLEEP_IN, overlay: Z_HIGH },
    ],
  },
  // Usage screen moods, driven by the fullest bar.
  // Plenty left: an easy idle bob.
  'usage-calm': {
    colors: { '#': '#d77757', '+': '#8f4c30', z: '#3fd0a4' },
    frames: [
      { grid: STAND, dy: 0 },
      { grid: STAND, dy: -1 },
      { grid: STAND, dy: 0 },
      { grid: SQUASH, dy: 1 },
    ],
  },
  // Getting close: hurrying, with sweat beads falling.
  'usage-hot': {
    colors: { '#': '#d77757', '+': '#8f4c30', z: '#7fb2e8' },
    frames: [
      { grid: STRIDE, dy: 0, overlay: SWEAT_HIGH },
      { grid: SQUASH, dy: 1, overlay: SWEAT_LOW },
      { grid: STRIDE, dy: 0, overlay: SWEAT_SPLASH },
      { grid: STAND, dy: -1 },
    ],
  },
  // At the limit: flattened and seeing stars.
  'usage-max': {
    colors: { '#': '#c05a44', '+': '#6d3226', z: '#ffb020' },
    frames: [
      { grid: FLAT, overlay: STARS_L },
      { grid: FLAT, dy: -1, overlay: STARS_R },
      { grid: FLAT, overlay: STARS_L },
      { grid: FLAT, dy: -1 },
    ],
  },
  // Just finished: a happy hop with sparkles popping outward.
  celebrate: {
    colors: { '#': '#d77757', '+': '#8f4c30', z: '#8ae27a' },
    frames: [
      { grid: SQUASH, dy: 1, overlay: SPARK_NEAR },
      { grid: STAND, dy: -2, overlay: SPARK_FAR },
      { grid: STRIDE, dy: -1, overlay: SPARK_NEAR },
      { grid: STAND, dy: 0 },
    ],
  },
};

function frameRects(frame, colors, originX) {
  const dx = frame.dx || 0;
  const dy = frame.dy || 0;
  const out = [];
  frame.grid.forEach((row, y) => {
    // merge horizontal runs of one colour into a single rect
    let runStart = -1;
    let runChar = null;
    const flush = (endX) => {
      if (runStart < 0) return;
      const py = y + dy;
      if (py >= 0 && py < S) {
        out.push(`<rect x="${originX + runStart + dx}" y="${py}" width="${endX - runStart}" height="1" fill="${colors[runChar]}"/>`);
      }
      runStart = -1;
      runChar = null;
    };
    for (let x = 0; x < S; x++) {
      const c = row[x];
      if (c === '.' || !colors[c]) { flush(x); continue; }
      if (c !== runChar) { flush(x); runStart = x; runChar = c; }
    }
    flush(S);
  });
  for (const [x, y] of frame.overlay || []) {
    out.push(`<rect x="${originX + x}" y="${y}" width="1" height="1" fill="${colors.z}"/>`);
  }
  return out.join('');
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, def] of Object.entries(STATES)) {
  const width = S * def.frames.length;
  const body = def.frames.map((f, i) => frameRects(f, def.colors, i * S)).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${S}" ` +
    `viewBox="0 0 ${width} ${S}" shape-rendering="crispEdges">${body}</svg>`;
  fs.writeFileSync(path.join(OUT, `${name}.svg`), svg);
  console.log(`${name}.svg — ${def.frames.length} frames, ${svg.length} bytes`);
}
