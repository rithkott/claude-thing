// The clock screen's mascot: the 8-bit Claude wanders the panel, stopping to
// do something silly, then wanders somewhere else. One long loop, ~50 seconds.
//
// It lives next to #app rather than inside it because the ambient screen
// re-renders on every store update and on the 15-second clock tick — a mascot
// inside that subtree would be thrown away mid-stride and restart from the
// corner four times a minute.
//
// The act sheets (dance-*.svg) only ever loop on the spot. Getting somewhere is
// this file's job: it tweens the wrapper's transform while the sprite plays.

export var W = 800;
export var H = 480;
export var SIZE = 96;

// The clock is the point of this screen, so the routine keeps to the edges:
// a top lane above the digits, a bottom lane under the caption, and the
// margins either side of the centre column. Coordinates are the sprite box's
// top-left corner, so the usable range is 0..W-SIZE by 0..H-SIZE.
var TOP = 8;
var BOTTOM = 366;
var MID = 180;

// { to: [x, y], sprite, speed } walks somewhere at speed px/s.
// { sprite, ms } stays put and performs for ms. The routine has to end where
// it started, or the loop teleports him back on the seam.
export var START = [40, BOTTOM];
export var ACTS = [
  { sprite: 'look', ms: 1400 },
  { to: [250, BOTTOM], sprite: 'walk', speed: 120 },
  { sprite: 'shimmy', ms: 2600 },
  { to: [470, BOTTOM], sprite: 'walk', speed: 120 },
  { sprite: 'spin', ms: 1800 },
  { sprite: 'boogie', ms: 3200 },
  { to: [690, BOTTOM], sprite: 'walk', speed: 120 },
  { sprite: 'kick', ms: 2400 },
  { sprite: 'split', ms: 1800 },
  { to: [700, MID], sprite: 'hop', speed: 150 },
  { sprite: 'wave', ms: 2200 },
  { to: [668, TOP], sprite: 'hop', speed: 140 },
  { to: [380, TOP], sprite: 'walk', speed: 120 },
  { sprite: 'headstand', ms: 2600 },
  { sprite: 'look', ms: 1200 },
  { to: [120, TOP], sprite: 'walk', speed: 120 },
  { sprite: 'startle', ms: 1200 },
  { to: [40, MID], sprite: 'roll', speed: 260 },
  { sprite: 'idle', ms: 1200 },
  { sprite: 'wave', ms: 1800 },
  { to: [40, BOTTOM], sprite: 'walk', speed: 110 },
  { sprite: 'nap', ms: 6000 },
  { sprite: 'startle', ms: 1400 },
];

var el = null;
var timer = null;
var visible = false;
var next = 0;                 // index of the act to run when the timer fires
var pos = START.slice();
var sprite = 'idle';
var flip = false;             // sheets face right; mirror to walk left

function build() {
  el = document.createElement('div');
  el.className = 'mascot';
  var art = document.createElement('div');
  art.className = 'mascotart';
  el.appendChild(art);
  document.body.appendChild(el);
  paint(0);
}

function paint(ms) {
  el.className = 'mascot act-' + sprite + (flip ? ' flip' : '') + (visible ? ' show' : '');
  el.style.transitionDuration = ms + 'ms';
  el.style.transform = 'translate(' + pos[0] + 'px,' + pos[1] + 'px)';
}

function run() {
  var act = ACTS[next % ACTS.length];
  next = (next + 1) % ACTS.length;
  sprite = act.sprite;

  var ms;
  if (act.to) {
    var dx = clamp(act.to[0], 0, W - SIZE) - pos[0];
    var dy = clamp(act.to[1], 0, H - SIZE) - pos[1];
    ms = Math.max(200, Math.round((Math.sqrt(dx * dx + dy * dy) / act.speed) * 1000));
    // A step or two sideways isn't a change of direction worth turning for.
    if (Math.abs(dx) > 6) flip = dx < 0;
    pos = [pos[0] + dx, pos[1] + dy];
  } else {
    ms = act.ms || 1500;
  }
  paint(act.to ? ms : 0);
  timer = setTimeout(run, ms);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Shown only on the clock screen. Everywhere else the element is display:none,
// which stops the sprite animation as well — the Car Thing's CPU has better
// things to do while you're answering a prompt.
export function show() {
  if (!el) build();
  if (visible) return;
  visible = true;
  run();
}

export function hide() {
  if (!el || !visible) return;
  visible = false;
  if (timer) clearTimeout(timer);
  timer = null;
  // Resume with the act that was interrupted rather than skipping it.
  next = (next + ACTS.length - 1) % ACTS.length;
  paint(0);
}
