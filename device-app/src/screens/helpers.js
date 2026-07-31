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

// The Car Thing's clock runs UTC — the firmware ships no timezone data — so
// wall time comes from the daemon: the Mac's UTC offset arrives with every
// session snapshot. Until the first snapshot lands, local time is the only
// guess available (correct in the emulator, 4-5h off on hardware for a few
// seconds).
var tzOffsetMin = null;
export function setTzOffset(min) {
  tzOffsetMin = typeof min === 'number' && isFinite(min) ? min : null;
}

export function fmtClock(d) {
  d = d || new Date();
  var h, m;
  if (tzOffsetMin === null) {
    h = d.getHours();
    m = d.getMinutes();
  } else {
    var shifted = new Date(d.getTime() - tzOffsetMin * 60000);
    h = shifted.getUTCHours();
    m = shifted.getUTCMinutes();
  }
  var ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
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

export function topbar(title, connected, count) {
  return '<div class="topbar"><span class="mark"></span>' +
    '<span class="title">' + esc(title) + '</span>' +
    (count ? '<span class="tcount">' + esc(count) + '</span>' : '') +
    '<span class="spacer"></span>' +
    '<span class="clock">' + fmtClock() + '</span>' +
    '<span class="conn' + (connected ? ' ok' : '') + '"></span></div>';
}
