// Finger drag -> dial ticks.
//
// Every scrollable screen already moves on 'dial' ticks (the hardware wheel),
// so touch scrolling is a translation into that same tick stream rather than a
// second, per-screen scrolling model. Content follows the finger: dragging
// left or up advances the cursor, the same direction the content would move.
//
// Pure state machine so it can be tested without a DOM; input.js feeds it
// coordinates from whichever pointer/touch events the browser offers.

export var SLOP = 10;        // px of travel before a touch is a drag, not a tap
export var STEP = 56;        // px of travel per tick
export var FLING_MIN = 0.7;  // px/ms at release before momentum adds ticks
export var FLING_MAX = 4;    // ticks a single fling may add
export var FLING_IDLE = 90;  // ms of stillness before release that kills momentum

export function createDrag(onTick, opts) {
  var o = opts || {};
  var slop = o.slop || SLOP;
  var step = o.step || STEP;
  var flingMin = o.flingMin || FLING_MIN;
  var flingMax = o.flingMax || FLING_MAX;
  var flingIdle = o.flingIdle || FLING_IDLE;

  var d = null;        // live gesture, null between gestures
  var dragged = false; // did the last gesture pass the slop (i.e. was a scroll)

  function emit(target) {
    while (d.emitted < target) { d.emitted++; onTick(1); }
    while (d.emitted > target) { d.emitted--; onTick(-1); }
  }

  return {
    // A gesture that never passed the slop is a tap and its click must land;
    // one that did is a scroll and the click that follows it must not.
    scrolled: function () { return dragged; },

    start: function (x, y, t) {
      dragged = false;
      d = { x0: x, y0: y, x: x, y: y, t: t, axis: null, emitted: 0, v: 0 };
    },

    // Returns true once the gesture owns the finger, so the caller can cancel
    // the browser's own default handling of the move.
    move: function (x, y, t) {
      if (!d) return false;
      var dx = x - d.x0;
      var dy = y - d.y0;
      if (!d.axis) {
        if (Math.abs(dx) < slop && Math.abs(dy) < slop) return false;
        // Axis is locked at the moment of commitment: a drag that starts
        // sideways stays sideways however much it wanders after.
        d.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
        dragged = true;
      }
      var travel = d.axis === 'x' ? dx : dy;
      // Ticks are counted against total travel, not per-move deltas, so a drag
      // reversed halfway back unwinds exactly the ticks it produced.
      emit(-Math.trunc(travel / step));

      var dt = t - d.t;
      var moved = d.axis === 'x' ? x - d.x : y - d.y;
      if (dt > 0) d.v = moved / dt;
      d.x = x; d.y = y; d.t = t;
      return true;
    },

    end: function (t) {
      if (!d) return;
      var g = d;
      d = null;
      if (!g.axis) return;
      // A finger parked before it lifted was aiming, not flinging.
      if (t - g.t > flingIdle) return;
      var speed = Math.abs(g.v);
      if (speed < flingMin) return;
      var extra = Math.min(flingMax, Math.round(speed / flingMin));
      var dir = g.v < 0 ? 1 : -1;
      for (var i = 0; i < extra; i++) onTick(dir);
    },

    cancel: function () { d = null; },
  };
}
