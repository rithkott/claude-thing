/* claude-thing mode switch. Plain ES5 — this file is ALSO injected verbatim
   into the built nocturne (music) index.html, which gets no transpilation.

   Chord: hold preset 1 + preset 4 together for 1s -> toggle / <-> /claude/.
   Sticky: localStorage['claude-mode']==='1' makes the root redirect to
   /claude/ on boot (device power-cycles return to Claude mode). The claude
   app's "Exit to Music" action clears the flag; the chord from Claude mode
   also clears it so music mode survives a reboot. */
(function () {
  var IN_CLAUDE = window.location.pathname.indexOf('/claude') === 0;

  // Boot redirect (root app only), guarded so an explicit exit isn't bounced.
  if (!IN_CLAUDE) {
    try {
      if (window.localStorage.getItem('claude-mode') === '1' &&
          window.sessionStorage.getItem('claude-exit') !== '1') {
        window.location.replace('/claude/');
        return;
      }
      window.sessionStorage.removeItem('claude-exit');
    } catch (e) {}
  }

  var down = {};
  var timer = null;

  function toggle() {
    try {
      if (IN_CLAUDE) {
        window.localStorage.setItem('claude-mode', '0');
        window.sessionStorage.setItem('claude-exit', '1');
        window.location.href = '/';
      } else {
        window.localStorage.setItem('claude-mode', '1');
        window.location.href = '/claude/';
      }
    } catch (e) {
      window.location.href = IN_CLAUDE ? '/' : '/claude/';
    }
  }

  function check() {
    if (down['1'] && down['4']) {
      if (!timer) timer = window.setTimeout(toggle, 1000);
    } else if (timer) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  window.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k === '1' || k === '4') { down[k] = true; check(); }
  }, true);
  window.addEventListener('keyup', function (e) {
    var k = e.key;
    if (k === '1' || k === '4') { down[k] = false; check(); }
  }, true);
})();
