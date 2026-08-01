import { esc, topbar, stateLabel, fmtDuration } from './helpers.js';
import { now } from '../clock.js';

// Sideways-scrolling grid: two rows, columns flow to the right without limit.
// The dial walks sessions in column-major order and the track slides so the
// selected tile stays on screen — any number of sessions fits.
var ROWS = 2;
var COLS_VISIBLE = 2;
var COL_STEP = 380;   // 372px tile + 8px gap (see .gridtrack)

var scrollCol = 0;   // leftmost visible column

export function renderList(state) {
  if (!state.sessions.length) {
    scrollCol = 0;
    return '<div class="screen">' + topbar('SESSIONS', state.daemonConnected) +
      '<div class="empty">NO SESSIONS — START CLAUDE ON YOUR MAC</div></div>';
  }

  var totalCols = Math.ceil(state.sessions.length / ROWS);
  var selCol = Math.floor(state.selectedIndex / ROWS);
  if (selCol < scrollCol) scrollCol = selCol;
  if (selCol > scrollCol + COLS_VISIBLE - 1) scrollCol = selCol - COLS_VISIBLE + 1;
  var maxScroll = Math.max(0, totalCols - COLS_VISIBLE);
  if (scrollCol > maxScroll) scrollCol = maxScroll;
  if (scrollCol < 0) scrollCol = 0;

  var tiles = '';
  for (var i = 0; i < state.sessions.length; i++) {
    tiles += tile(state.sessions[i], i === state.selectedIndex, state);
  }

  var offset = scrollCol * COL_STEP;
  // No scrollbar: the next column's edge peeking past the right bezel is the
  // affordance (see .gridwrap), and it costs no vertical space on a 480px panel.
  return '<div class="screen">' +
    topbar('SESSIONS', state.daemonConnected, String(state.sessions.length)) +
    '<div class="gridwrap"><div class="gridtrack" style="transform:translateX(-' + offset + 'px)">' +
    tiles + '</div></div></div>';
}

function tile(s, selected, state) {
  return '<div class="tile state-' + s.state + (selected ? ' selected' : '') +
    '" data-action="open" data-id="' + esc(s.id) + '">' +
    '<span class="cap"></span>' +
    '<div class="thead"><span class="lamp ' + s.state + '"></span>' +
    '<span class="slabel">' + stateLabel(s.state, s.ended) + '</span>' +
    (s.pendingPermission ? '<span class="badge">!</span>' : '') + '</div>' +
    // The name is measured after paint and only marquees if it actually
    // overflows; see marquee() in main.js.
    '<div class="tname"><span class="tnamei" data-marquee="1">' + esc(s.name) + '</span></div>' +
    '<div class="tsub">' + esc(subline(s, state)) + '</div>' +
    contextMeter(s.context) +
    '<span class="sprite"></span>' +
    '</div>';
}

// Neutral all the way up, red only near the top: a filling context window is
// normal and must not read as an alarm until it is actually close to
// compacting. Absent when the daemon can't work out the fraction.
function contextMeter(fraction) {
  if (fraction == null) return '';
  var pct = Math.max(0, Math.min(1, fraction));
  var hot = pct >= 0.8 ? ' hot' : '';
  return '<div class="ctx' + hot + '">' +
    '<div class="ctxrow"><span class="ctxpct">' + Math.round(pct * 100) + '%</span>' +
    '<span class="ctxlabel">context</span></div>' +
    '<div class="ctxtrack"><span class="ctxfill" style="width:' + (pct * 100).toFixed(1) + '%"></span></div>' +
    '</div>';
}

function subline(s, state) {
  var d = state.details[s.id];
  if (s.pendingPermission) return 'needs your answer';
  if (d && d.currentTool) return d.currentTool + ' · ' + (d.lastMessage || '');
  if (s.state === 'celebrate' && s.lastActivityTs) {
    return 'finished ' + fmtDuration(now() - s.lastActivityTs) + ' ago';
  }
  if (d && d.lastMessage) return d.lastMessage;
  return s.state === 'busy' ? 'working…' : '';
}
