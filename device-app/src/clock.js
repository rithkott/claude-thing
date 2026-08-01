// Wall time on the Car Thing, which owns neither half of a correct clock.
//
// It has no battery-backed RTC and never reaches an NTP server, so its epoch is
// whatever the last boot left behind — minutes, hours or years off. And its
// firmware ships no timezone data, so Date always runs UTC. Both are corrected
// from the daemon, which stamps every session snapshot with the Mac's epoch
// (serverNowMs) and UTC offset (tzOffsetMin).
//
// This matters beyond the topbar clock: every timestamp the device compares
// against — a permission's createdTs, a session's startedTs — was stamped by
// the Mac. Subtracting a skewed device Date.now() from those turns countdowns
// and durations into nonsense, so every screen reads now() rather than
// Date.now().
//
// The frame-level server_timestamp_ms is deliberately NOT used: nocturned
// re-emits relayed events with its own (device) clock, so on hardware that
// field carries the very time we are correcting.

var skewMs = 0;
var tzOffsetMin = null;

// Small corrections are ignored so the clock does not jitter across a minute
// boundary on relay latency alone; anything real is orders of magnitude bigger.
var RESYNC_THRESHOLD_MS = 2000;

export function setServerNow(serverMs) {
  if (typeof serverMs !== 'number' || !isFinite(serverMs)) return;
  var next = serverMs - Date.now();
  if (Math.abs(next - skewMs) >= RESYNC_THRESHOLD_MS) skewMs = next;
}

export function setTzOffset(min) {
  tzOffsetMin = typeof min === 'number' && isFinite(min) ? min : null;
}

// Mac epoch time. Falls back to the device's own clock until the first
// snapshot lands, or against a daemon too old to send serverNowMs.
export function now() {
  return Date.now() + skewMs;
}

export function fmtClock(d) {
  d = d || new Date(now());
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

// Tests only: forget both corrections.
export function resetClock() {
  skewMs = 0;
  tzOffsetMin = null;
}
