// Hardware input -> semantic actions, per the device contract:
// dial turn = wheel deltaX (dead-zone |dx|<10, drop ticks <15ms apart),
// dial press = Enter, back = Escape, preset 1 = allow, preset 4 = deny,
// settings key m: tap = ambient toggle, hold 600ms = bluetooth manager.
// Touch taps hit [data-action] elements, and a touch drag scrolls whatever the
// dial scrolls.

import { createDrag } from './gesture.js';

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
};

// The settings key does two jobs, split by hold time like nocturne's power
// menu: tap = ambient, hold 600ms = bluetooth. That forces ambient onto keyup
// — a tap can't be told from the start of a hold until the key comes back up.
var HOLD_MS = 600;
var mTimer = null;
var mHeld = false;

function clearHold() {
  if (mTimer) { clearTimeout(mTimer); mTimer = null; }
  mHeld = false;
}

window.addEventListener('keydown', function (e) {
  if (e.key === 'm' || e.key === 'M') {
    e.preventDefault();
    if (e.repeat || mTimer) return;
    mHeld = false;
    mTimer = setTimeout(function () {
      mTimer = null;
      mHeld = true;
      fire('bt-manage');
    }, HOLD_MS);
    return;
  }
  if (e.repeat) return;
  var action = KEYMAP[e.key];
  if (action) {
    e.preventDefault();
    fire(action);
  }
}, { capture: true });

window.addEventListener('keyup', function (e) {
  if (e.key !== 'm' && e.key !== 'M') return;
  e.preventDefault();
  var wasHeld = mHeld;
  clearHold();
  if (!wasHeld) fire('ambient');
}, { capture: true });

// a keyup lost to focus change must not strand a pending hold
window.addEventListener('blur', clearHold);

document.addEventListener('wheel', function (e) {
  e.preventDefault();
  var dx = e.deltaX;
  if (Math.abs(dx) < 10) return;          // hardware dead-zone
  var now = Date.now();
  if (now - lastTick < 15) return;        // debounce spurious ticks
  lastTick = now;
  fire('dial', dx > 0 ? 1 : -1);
}, { passive: false });

// ---- touch drag = dial ------------------------------------------------------
// The screen is the only input the Car Thing has that the dial doesn't
// duplicate, and every scrollable screen is already a dial-driven cursor. So a
// drag is fed straight into 'dial' instead of each screen growing its own touch
// handling: sessions, the queue and a question's options all scroll by finger
// for free, and stay in step with the wheel.

var drag = createDrag(function (dir) { fire('dial', dir); });

function primaryPoint(e) {
  if (e.touches) return e.touches.length === 1 ? e.touches[0] : null;
  if (e.isPrimary === false) return null;
  // buttons is 0 for a mouse moving with nothing held down; touch and pen
  // report 1 while in contact.
  if (e.pointerType === 'mouse' && e.type !== 'pointerdown' && !e.buttons) return null;
  return e;
}

function onDown(e) {
  var p = primaryPoint(e);
  if (!p) return drag.cancel();
  // Each tick re-renders the screen, which deletes the element the finger came
  // down on. Chrome's implicit capture lives on that element, so without moving
  // the capture to a node that survives, the first tick ends the gesture with a
  // pointercancel and the drag dies after one step.
  if (e.pointerId !== undefined && document.documentElement.setPointerCapture) {
    try { document.documentElement.setPointerCapture(e.pointerId); } catch (err) {}
  }
  drag.start(p.clientX, p.clientY, Date.now());
}

function onMove(e) {
  var p = primaryPoint(e);
  if (!p) return;
  // Once the drag owns the finger, stop the browser doing anything else with
  // it — text selection, rubber-banding, or a synthesised scroll.
  if (drag.move(p.clientX, p.clientY, Date.now()) && e.cancelable) e.preventDefault();
}

function onUp() { drag.end(Date.now()); }

if (window.PointerEvent) {
  document.addEventListener('pointerdown', onDown, { passive: false });
  document.addEventListener('pointermove', onMove, { passive: false });
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', function () { drag.cancel(); });
} else {
  // Fallback for a browser without pointer events. Touch events can't be
  // recaptured the way the branch above does, so a re-render under the finger
  // can cut a drag short; the device's Chromium has PointerEvent, so this path
  // is a safety net rather than the one that runs.
  document.addEventListener('touchstart', onDown, { passive: false });
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onUp);
  document.addEventListener('touchcancel', function () { drag.cancel(); });
  document.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove, { passive: false });
  document.addEventListener('mouseup', onUp);
}

// A scroll ends with the finger somewhere it never meant to press, so the click
// the browser synthesises from it must not open whatever it landed on. Runs in
// the capture phase to beat the tap handler below.
document.addEventListener('click', function (e) {
  if (!drag.scrolled()) return;
  e.stopPropagation();
  e.preventDefault();
}, { capture: true });

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
