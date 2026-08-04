// Is the daemon there? — asked continuously, never latched.
//
// The device's own socket goes to nocturned, one process away on the same
// board. It stays open whether or not the Mac at the far end of the Bluetooth
// link is running a daemon, so the socket cannot answer the question the banner
// asks. On the emulator a bridge synthesizes claude.daemon.status when its
// daemon connection comes and goes; on hardware nothing does — neither
// nocturned nor the Swift connector emits that topic. So daemonConnected was
// written exactly once per boot, from whether the first sessions.list came back
// inside its 10s, and never again: one slow first request (daemon not up yet,
// connector still inside its 30s reconnect backoff, Bluetooth still settling)
// left DAEMON OFFLINE on screen for the rest of the session while every later
// request worked fine. That is issue #55.
//
// Liveness is therefore measured, not remembered. Two signals:
//
//   seen()  — any claude.* frame off the wire. The daemon answering for itself
//             is the cheapest possible proof, and it re-emits its session
//             snapshot every 30s even when nothing changed, so a healthy link
//             is never quiet for long.
//   tick()  — the timer. Only when nothing has been heard for the quiet window
//             does it spend a claude.ping to ask outright, and that answer (or
//             its failure) is what flips the flag.
//
// Nothing else marks the link down. An ordinary request failing is not proof —
// it is exactly the evidence that was being trusted before, and it was wrong.
export function createLink(opts) {
  var ping = opts.ping;                       // () => Promise
  var onChange = opts.onChange;               // (connected: boolean, was) => void
  var now = opts.now || function () { return Date.now(); };
  var quietMs = opts.quietMs || 40000;        // 30s snapshot heartbeat + slack

  var connected = null;   // null = never answered either way
  var lastSeen = 0;       // 0 = nothing heard yet, so the first tick asks
  var probing = false;

  // `was` is null until the link has answered once, which is how a caller tells
  // a first answer at boot from a daemon that went away and came back.
  function set(next) {
    if (connected === next) return;
    var was = connected;
    connected = next;
    onChange(next, was);
  }

  function seen() {
    lastSeen = now();
    set(true);
  }

  function tick() {
    if (probing || (lastSeen && now() - lastSeen < quietMs)) return Promise.resolve();
    probing = true;
    return ping().then(function () {
      probing = false;
      seen();
    }, function () {
      probing = false;
      set(false);
    });
  }

  return {
    seen: seen,
    tick: tick,
    // The emulator's synthesized status event, routed through the same state so
    // the two sources cannot disagree about what the banner shows.
    report: function (up) { if (up) seen(); else set(false); },
    connected: function () { return connected; },
  };
}
