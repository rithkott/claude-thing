import { fmtClock } from '../clock.js';

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

export function fmtDuration(ms) {
  var mins = Math.floor(ms / 60000);
  if (mins < 60) return mins + 'm';
  return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
}

export function stateLabel(state, ended) {
  if (state === 'idle') return ended ? 'ENDED' : 'IDLE';
  return { busy: 'WORKING', attention: 'ATTENTION', celebrate: 'DONE' }[state] || 'IDLE';
}

// Permission mode, as the daemon reports it, shortened to something that fits
// a tile header. `auto` and `acceptEdits` stay distinct: they are two different
// modes, and the newer name replacing the older one is not a reason to draw
// them the same. Anything unrecognized — including a session no source has
// reported a mode for — returns null and the tile draws no badge.
var MODE_LABELS = {
  plan: 'PLAN',
  bypassPermissions: 'BYPASS',
  acceptEdits: 'EDITS',
  auto: 'AUTO',
  default: 'MANUAL',
};

export function modeLabel(mode) {
  return MODE_LABELS[mode] || null;
}

// Reasoning effort, as the daemon reports it. Whitelisted like the modes: the
// label doubles as a class name, and an unknown level draws neither label nor
// gait — the tile falls back to the plain working sprite. `ultrathink` renders
// as ULTRA: the full word was the only thing forcing the label under the 14px
// type floor; abbreviated, every label clears the meter and the tile edge.
var EFFORT_LABELS = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  xhigh: 'XHIGH',
  max: 'MAX',
  ultrathink: 'ULTRA',
};

export function effortLabel(effort) {
  return EFFORT_LABELS[effort] || null;
}

export function topbar(title, connected, count) {
  return '<div class="topbar"><span class="mark"></span>' +
    '<span class="title">' + esc(title) + '</span>' +
    (count ? '<span class="tcount">' + esc(count) + '</span>' : '') +
    '<span class="spacer"></span>' +
    '<span class="clock">' + fmtClock() + '</span>' +
    '<span class="conn' + (connected ? ' ok' : '') + '"></span></div>';
}
