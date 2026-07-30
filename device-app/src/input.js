// Hardware input -> semantic actions, per the device contract:
// dial turn = wheel deltaX (dead-zone |dx|<10, drop ticks <15ms apart),
// dial press = Enter, back = Escape, preset 1 = allow, preset 4 = deny,
// settings key m = ambient toggle. Touch taps hit [data-action] elements.

var handlers = {};   // action -> [fn]
var lastTick = 0;

export function onAction(action, fn) {
  (handlers[action] = handlers[action] || []).push(fn);
}

function fire(action, arg) {
  var fns = handlers[action] || [];
  for (var i = 0; i < fns.length; i++) fns[i](arg);
}

// Presets 1–3 are page buttons (sessions / queue / usage). Preset 4 is the
// one context action: deny. Deny is the recoverable choice of the two, so it
// is the one that gets a physical button — an accidental allow is not undoable.
var KEYMAP = {
  Enter: 'select',
  Escape: 'back',
  '1': 'page-sessions',
  '2': 'page-queue',
  '3': 'page-usage',
  '4': 'deny',
  m: 'ambient',
  M: 'ambient',
};

window.addEventListener('keydown', function (e) {
  if (e.repeat) return;
  var action = KEYMAP[e.key];
  if (action) {
    e.preventDefault();
    fire(action);
  }
}, { capture: true });

document.addEventListener('wheel', function (e) {
  e.preventDefault();
  var dx = e.deltaX;
  if (Math.abs(dx) < 10) return;          // hardware dead-zone
  var now = Date.now();
  if (now - lastTick < 15) return;        // debounce spurious ticks
  lastTick = now;
  fire('dial', dx > 0 ? 1 : -1);
}, { passive: false });

// touch / click on [data-action] elements
document.addEventListener('click', function (e) {
  var el = e.target;
  while (el && el !== document.body) {
    if (el.getAttribute && el.getAttribute('data-action')) {
      fire('tap', { action: el.getAttribute('data-action'), id: el.getAttribute('data-id') });
      return;
    }
    el = el.parentNode;
  }
});
