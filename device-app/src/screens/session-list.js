import { esc, topbar, stateLabel, fmtTokens } from './helpers.js';

// Sideways-scrolling grid: two rows, columns flow to the right without limit.
// The dial walks sessions in column-major order and the track slides so the
// selected tile stays on screen — any number of sessions fits.
var ROWS = 2;
var COLS_VISIBLE = 3;

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
    var s = state.sessions[i];
    tiles +=
      '<div class="tile state-' + s.state + (i === state.selectedIndex ? ' selected' : '') +
      '" data-action="open" data-id="' + esc(s.id) + '">' +
      '<span class="cap"></span>' +
      '<div class="thead"><span class="lamp ' + s.state + '"></span>' +
      '<span class="slabel">' + stateLabel(s.state, s.ended) + '</span>' +
      (s.pendingPermission ? '<span class="badge">!</span>' : '') + '</div>' +
      '<div class="tname">' + esc(s.name) + '</div>' +
      '<div class="tsub">' + esc(subline(s, state)) + '</div>' +
      '<div class="ttok">' + fmtTokens(s.tokens.out) + ' out · ' + fmtTokens(s.tokens.in) + ' in</div>' +
      '<span class="sprite"></span>' +
      '</div>';
  }

  // 248px tile + 10px gap per column
  var offset = scrollCol * 258;
  // The rail is always in the layout so the bottom row keeps the same gap
  // whether or not the set scrolls; only the thumb comes and goes.
  var thumb = '';
  if (totalCols > COLS_VISIBLE) {
    var frac = COLS_VISIBLE / totalCols;
    var pos = scrollCol / totalCols;
    thumb = '<span class="gthumb" style="width:' + (frac * 100).toFixed(2) +
      '%;left:' + (pos * 100).toFixed(2) + '%"></span>';
  }
  var rail = '<div class="grail' + (thumb ? '' : ' blank') + '">' + thumb + '</div>';

  return '<div class="screen">' + topbar('SESSIONS', state.daemonConnected) +
    '<div class="gridwrap"><div class="gridtrack" style="transform:translateX(-' + offset + 'px)">' +
    tiles + '</div></div>' + rail + '</div>';
}

function subline(s, state) {
  var d = state.details[s.id];
  if (s.pendingPermission) return 'needs your answer';
  if (d && d.currentTool) return d.currentTool + (d.lastMessage ? ' · ' + d.lastMessage : '');
  if (d && d.lastMessage) return d.lastMessage;
  return s.state === 'busy' ? 'working…' : '';
}
